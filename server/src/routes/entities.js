import { Router } from 'express';
import Entity, { BLOCK_TYPES } from '../models/Entity.js';
import RelationshipGroup from '../models/RelationshipGroup.js';
import { requireActor } from '../middleware/auth.js';
import { logCreate, logUpdate, logDelete } from '../lib/changeLogger.js';
import { resolveGroupLabels } from '../lib/relationshipResolver.js';
import { openQuestionsIn } from '../lib/scopedPopulate.js';
import { searchTerm, keywordFilter } from '../lib/searchFilter.js';

const router = Router();

function validateBlocks(blocks) {
  if (!Array.isArray(blocks)) return 'blocks must be an array';
  for (const block of blocks) {
    if (!BLOCK_TYPES.includes(block.type)) return `Invalid block type: ${block.type}`;
    if (typeof block.order !== 'number') return 'Each block must have a numeric order';
    if (!block.data || typeof block.data !== 'object') return 'Each block must have a data object';
  }
  return null;
}

function normalizeBlockOrder(blocks) {
  return [...blocks]
    .sort((a, b) => a.order - b.order)
    .map((block, i) => ({ ...block, order: i }));
}

/**
 * Strips any client-supplied tenancy key. Without this a caller could set
 * workspaceId in the request body and write into someone else's workspace —
 * the workspace is the server's to decide, never the client's.
 *
 * `open_questions` and `relationships` go too: both are back-references the
 * server maintains (open-question and relationship-group routes, the draft
 * applier, the seeder), and a client-written array is how another workspace's
 * id would get planted in one.
 */
function stripTenancy(body) {
  const { workspaceId, open_questions, relationships, ...rest } = body;
  return rest;
}

/**
 * The fields `GET /entities` sends for a list — `blocks` deliberately absent.
 *
 * This is the first request a new workspace makes and the one every reload,
 * second tab and SSE reconnect repeats, and nothing on the list path reads
 * block content: the sidebar card shows a title, a category badge and a
 * summary, `useFilters` searches titles, summaries and tags, and the detail
 * panel and the editor both re-read the entity through `GET /entities/:id`
 * (which does its own `.lean()` read). Sending every block of every entity
 * here put the entire text of the wiki — megabytes for a workspace of a few
 * hundred real entities — on the one request that decides how long a workspace
 * takes to open, for nothing that gets rendered.
 *
 * `?include=blocks` asks for the old, unprojected shape, so a caller outside
 * this repo is not cut off by the change.
 *
 * `?q=` is unaffected. Its third clause matches `blocks.data.markdown` in the
 * *query* (lib/searchFilter.js), and a projection changes what comes back, not
 * what is searched — `tests/http/entityList.test.js` pins that.
 */
const LIST_FIELDS = 'title category summary tags open_questions relationships createdAt updatedAt';

// GET /entities
router.get('/', async (req, res) => {
  try {
    const filter = { workspaceId: req.workspaceId };
    // Every filter value goes through searchTerm: the extended query parser
    // turns `?category[$ne]=Characters` into an object and `?q=a&q=b` into an
    // array, and a non-string must be no filter rather than a filter the caller
    // wrote. The keyword is escaped before it is compiled. See lib/searchFilter.js.
    const category = searchTerm(req.query.category);
    const tag = searchTerm(req.query.tag);
    const q = searchTerm(req.query.q);
    if (category) filter.category = category;
    if (tag) filter.tags = tag;
    if (q) Object.assign(filter, keywordFilter(q));

    // `include` is typed through searchTerm for the same reason the filters
    // above are: an operator object or a repeated parameter must be no opt-in
    // rather than one the caller never wrote. Comma-separated so a later
    // projection opt-in joins it instead of adding a second parameter.
    const include = (searchTerm(req.query.include) ?? '').split(',').map(part => part.trim());

    const query = Entity.find(filter).sort({ title: 1 });
    if (!include.includes('blocks')) query.select(LIST_FIELDS);

    const entities = await query
      .populate(openQuestionsIn(req.workspaceId))
      .lean();
    res.json(entities);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /entities/:id
router.get('/:id', async (req, res) => {
  try {
    const entity = await Entity.findOne({ _id: req.params.id, workspaceId: req.workspaceId })
      .populate(openQuestionsIn(req.workspaceId))
      .lean();
    // 404 rather than 403 for a foreign id — don't confirm it exists elsewhere.
    if (!entity) return res.status(404).json({ error: 'Not found' });

    // Query groups dynamically — source of truth is the group's members array, not the back-reference on Entity
    const rawGroups = await RelationshipGroup.find({
      workspaceId: req.workspaceId,
      members: { $elemMatch: { refId: req.params.id, refModel: 'Entity' } },
    }).lean();

    const relationships = await resolveGroupLabels(rawGroups, req.params.id, req.workspaceId);

    res.json({ ...entity, relationships });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /entities
router.post('/', requireActor, async (req, res) => {
  try {
    const data = stripTenancy(req.body);

    if (data.blocks) {
      const err = validateBlocks(data.blocks);
      if (err) return res.status(400).json({ error: err });
      data.blocks = normalizeBlockOrder(data.blocks);
    }

    const entity = await Entity.create({ ...data, workspaceId: req.workspaceId });
    const clientId = req.headers['x-sse-client-id'] ?? null;
    logCreate(entity.toObject(), req.actor, clientId).catch(err => console.error('[changelog] logCreate failed:', err));
    res.status(201).json(entity);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /entities/:id
router.put('/:id', requireActor, async (req, res) => {
  try {
    const data = stripTenancy(req.body);

    if (data.blocks) {
      const err = validateBlocks(data.blocks);
      if (err) return res.status(400).json({ error: err });
      data.blocks = normalizeBlockOrder(data.blocks);
    }

    const scope = { _id: req.params.id, workspaceId: req.workspaceId };

    const before = await Entity.findOne(scope).lean();
    if (!before) return res.status(404).json({ error: 'Not found' });

    const after = await Entity.findOneAndUpdate(scope, data, {
      new: true,
      runValidators: true,
    }).populate(openQuestionsIn(req.workspaceId));
    if (!after) return res.status(404).json({ error: 'Not found' });

    const clientId = req.headers['x-sse-client-id'] ?? null;
    logUpdate(before, after.toObject(), req.actor, clientId).catch(err => console.error('[changelog] logUpdate failed:', err));
    res.json(after);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /entities/:id
router.delete('/:id', requireActor, async (req, res) => {
  try {
    const entity = await Entity.findOneAndDelete({
      _id: req.params.id,
      workspaceId: req.workspaceId,
    });
    if (!entity) return res.status(404).json({ error: 'Not found' });

    // Clean up relationship groups: query dynamically so we catch all groups regardless of back-reference state
    const groups = await RelationshipGroup.find({
      workspaceId: req.workspaceId,
      members: { $elemMatch: { refId: entity._id, refModel: 'Entity' } },
    });
    for (const group of groups) {
      group.members = group.members.filter(
        m => !(m.refModel === 'Entity' && String(m.refId) === String(entity._id))
      );
      const entityMembers = group.members.filter(m => m.refModel === 'Entity');
      if (entityMembers.length < 2) {
        await Entity.updateMany(
          { _id: { $in: entityMembers.map(m => m.refId) } },
          { $pull: { relationships: group._id } }
        );
        await RelationshipGroup.findByIdAndDelete(group._id);
      } else {
        await group.save();
      }
    }

    const clientId = req.headers['x-sse-client-id'] ?? null;
    logDelete(entity.toObject(), req.actor, clientId).catch(err => console.error('[changelog] logDelete failed:', err));
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
