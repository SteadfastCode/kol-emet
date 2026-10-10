import { Router } from 'express';
import mongoose from 'mongoose';
import Entity, { BLOCK_TYPES } from '../models/Entity.js';
import RelationshipGroup from '../models/RelationshipGroup.js';
import { requireActor } from '../middleware/auth.js';
import { logCreate, logUpdate, logDelete } from '../lib/changeLogger.js';
import { resolveGroupLabels } from '../lib/relationshipResolver.js';
import { openQuestionsIn } from '../lib/scopedPopulate.js';
import { searchTerm, keywordFilter, boundedInteger } from '../lib/searchFilter.js';

const router = Router();

/**
 * ─── Tiered debug logging ───────────────────────────────────────────────────
 * ENTITY_LIST_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — every page of `GET /entities`: the limit and cursor it ran with,
 *             how many rows came back, the total, the cursor it hands out next,
 *             and the query string all of that was read from. A page boundary
 *             that drops or repeats a row leaves no other trace — the client
 *             concatenates pages and shows a list, so a missing entity looks
 *             like a missing entity. Also every refused cursor.
 *   normal  — light, plus the unpaged (bare array) reads, with their row count
 *   verbose — normal, plus the first and last title on each page, which is
 *             what a boundary bug is visible in
 */
const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.ENTITY_LIST_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[entities:${level}] ${msg}`);
}

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

/**
 * The page sizes this route will serve. Below the minimum is no page size at
 * all (see `boundedInteger`); above the maximum is clamped to it.
 *
 * 200 is a page the client can render in one frame and a response that
 * serializes in well under a millisecond, which is the whole point of the cap:
 * the work this route does lands on the single event loop every tenant of this
 * API shares, so an unbounded `JSON.stringify` of one workspace's entire row
 * set is time nobody else's request can run in. A caller who wants the whole
 * workspace still gets it — by asking for pages, not by asking for one.
 */
export const LIST_LIMIT_MIN = 1;
export const LIST_LIMIT_MAX = 200;

/**
 * Reads `?after=` — the keyset cursor, the `title` and `_id` of the previous
 * page's last row, exactly as that page's `nextAfter` handed it over. Sent as
 * `?after[title]=…&after[_id]=…`, which the extended query parser (the one
 * `searchTerm` exists to defend the filters against) delivers as the object the
 * response shape already describes.
 *
 * Keyset and not `skip`: pages of a collection that is being written to while
 * it is read are the common case here, and `skip` answers them wrongly — an
 * entity created before page 2 shifts every later row forward one place, so a
 * row that was page 2's first is served twice and the one the shift pushed past
 * the boundary is never served at all. A cursor names a position in the sort
 * rather than a count of rows, so an insert anywhere does not move it.
 *
 * Titles are not unique (nothing in the schema says they are, and "Chapter 1"
 * in two workspaces' worth of real content says they are not), so `title`
 * alone is not a position: the two rows sharing a title would straddle the
 * boundary and one of them would be lost. The cursor therefore carries `_id`
 * as the tie-break and the sort carries it too.
 *
 * A present-but-unusable cursor is refused rather than ignored. Dropping it
 * would answer page 1 to a request for page 2 — and a client that pages until
 * `nextAfter` is null would then never stop, since page 1 always has a next.
 * Loud and once is better than silent and forever. (An empty `?after=` is the
 * exception: that is a client that built a query string around a value it does
 * not have, which is no cursor.)
 *
 * @returns {{ after: {title: string, _id: string}|null } | { error: string }}
 */
function listCursor(raw) {
  if (raw === undefined || raw === '') return { after: null };

  const error = {
    error: "after must be the previous page's nextAfter, as after[title]=<title>&after[_id]=<id>",
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return error;

  // Not through `searchTerm`: a cursor's title has to be the row's title
  // byte for byte, and trimming or capping it would move the boundary.
  const { title, _id: id } = raw;
  if (typeof title !== 'string' || !title) return error;
  if (typeof id !== 'string' || !mongoose.isValidObjectId(id)) return error;

  return { after: { title, _id: id } };
}

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

    // `?limit=` goes through searchFilter's integer counterpart for the reason
    // the filters go through `searchTerm`: `?limit[$gt]=1` arrives as an object
    // and `?limit=1&limit=2` as an array, and either one reaching `.limit()`
    // is a 500 rather than a page. Absent, unusable, or below the minimum all
    // mean *no limit* — today's unpaged bare array, unchanged.
    const limit = boundedInteger(req.query.limit, { min: LIST_LIMIT_MIN, max: LIST_LIMIT_MAX });

    const source = req.originalUrl.includes('?') ? `?${req.originalUrl.split('?').slice(1).join('?')}` : '(no query string)';
    const cursor = listCursor(req.query.after);
    if (cursor.error) {
      log('light', `refused 400 — ${cursor.error} (source: ${source}, after=${JSON.stringify(req.query.after)})`);
      return res.status(400).json({ error: cursor.error });
    }
    const after = cursor.after;

    // The cursor clause goes under `$and` rather than beside the filter's own
    // keys, because `?q=` has already put an `$or` there (keywordFilter) and an
    // object has one `$or`: assigning a second would silently drop whichever
    // was written first — the keyword clause, or the page boundary.
    const pageFilter = after
      ? {
        ...filter,
        $and: [
          ...(filter.$and ?? []),
          { $or: [{ title: { $gt: after.title } }, { title: after.title, _id: { $gt: after._id } }] },
        ],
      }
      : filter;

    // `_id` joins the sort unconditionally: it is the cursor's tie-break, and
    // an unpaged read is no worse for having a defined order among equal
    // titles instead of whatever order the storage engine happened to answer.
    const query = Entity.find(pageFilter).sort({ title: 1, _id: 1 });
    if (!include.includes('blocks')) query.select(LIST_FIELDS);
    // One row past the page. Whether a next page exists is then a fact about
    // what came back, rather than something inferred from `total` — which
    // counts the unpaged filter and can change between the two queries.
    if (limit) query.limit(limit + 1);

    const rows = await query
      .populate(openQuestionsIn(req.workspaceId))
      .lean();

    // No `limit` is no envelope: the response stays the bare array it has
    // always been, so the MCP tools, the chat tool, the graph view and any
    // script outside this repo are untouched by this change. The envelope —
    // the breaking part — is what asking for a page opts into.
    if (!limit) {
      log('normal', `unpaged list → ${rows.length} row(s), bare array (source: ${source})`);
      return res.json(rows);
    }

    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const nextAfter = rows.length > limit && last ? { title: last.title, _id: String(last._id) } : null;
    // `filter`, not `pageFilter`: the total is the size of the set being paged
    // through, which is what a "page 2 of 7" is counted against. Counting the
    // rows after the cursor instead would shrink it with every page.
    const total = await Entity.countDocuments(filter);

    const describe = (c) => (c ? `${JSON.stringify(c.title)}/${c._id}` : '(none)');
    log('light', `page → limit ${limit}, after ${describe(after)}, ${items.length} row(s) of ${total} total, next ${describe(nextAfter)} (source: ${source})`);
    log('verbose', `page titles: ${items.length ? `${JSON.stringify(items[0].title)} … ${JSON.stringify(last.title)}` : '(empty)'}`);

    res.json({ items, nextAfter, total });
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
