import { Router } from 'express';
import Entity, { BLOCK_TYPES } from '../models/Entity.js';
import RelationshipGroup from '../models/RelationshipGroup.js';
import { requireActor } from '../middleware/auth.js';
import { logCreate, logUpdate, logDelete } from '../lib/changeLogger.js';
import { resolveGroupLabels } from '../lib/relationshipResolver.js';

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
 */
function stripTenancy(body) {
  const { workspaceId, ...rest } = body;
  return rest;
}

// GET /entities
router.get('/', async (req, res) => {
  try {
    const filter = { workspaceId: req.workspaceId };
    if (req.query.category) filter.category = req.query.category;
    if (req.query.tag) filter.tags = req.query.tag;
    if (req.query.q) {
      const re = new RegExp(req.query.q, 'i');
      filter.$or = [
        { title: re },
        { summary: re },
        { blocks: { $elemMatch: { 'data.markdown': re } } },
      ];
    }
    const entities = await Entity.find(filter)
      .sort({ title: 1 })
      .populate('open_questions', 'question status');
    res.json(entities);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /entities/:id
router.get('/:id', async (req, res) => {
  try {
    const entity = await Entity.findOne({ _id: req.params.id, workspaceId: req.workspaceId })
      .populate('open_questions', 'question status')
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
    }).populate('open_questions', 'question status');
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
