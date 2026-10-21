import { Router } from 'express';
import RelationshipGroup from '../models/RelationshipGroup.js';
import Entity from '../models/Entity.js';
import { requireActor } from '../middleware/auth.js';
import { objectIdParam } from '../middleware/objectId.js';
import { boundedInteger, idCursor } from '../lib/searchFilter.js';

const router = Router();

/**
 * ─── Tiered debug logging ───────────────────────────────────────────────────
 * GROUP_LIST_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — every page of `GET /relationship-groups`: the limit and cursor it
 *             ran with, how many rows came back, the cursor it hands out next,
 *             and the query string all of that was read from. A page boundary
 *             that drops or repeats a group leaves no other trace — the graph
 *             concatenates pages and draws edges, so a missing group is a
 *             missing edge between two nodes that are both still there. Also
 *             every refused cursor.
 *   normal  — light, plus the unpaged (bare array) reads, with their row count
 *   verbose — normal, plus the first and last id on each page, which is what a
 *             boundary bug is visible in
 */
const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.GROUP_LIST_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[relationshipGroups:${level}] ${msg}`);
}

/**
 * The page sizes `GET /relationship-groups` will serve. Below the minimum is no
 * page size at all (see `boundedInteger`); above the maximum is clamped to it.
 *
 * The same 200 `GET /entities` serves, and for the same reason: the work this
 * route does lands on the single event loop every tenant of this API shares,
 * and a group carries its whole `members` array, so an unbounded
 * `JSON.stringify` of one workspace's entire group set is time nobody else's
 * request can run in. The graph view asks for every group the moment it opens,
 * which is exactly the request that has to stop being unbounded. A caller who
 * wants the whole workspace still gets it — by asking for pages, not by asking
 * for one.
 */
export const GROUP_LIMIT_MIN = 1;
export const GROUP_LIMIT_MAX = 200;

// A malformed id is 400 INVALID_ID, not a CastError the catch turns into a 500.
// Registered here rather than per handler so a later route inherits it.
router.param('id', objectIdParam('id'));
router.param('entityId', objectIdParam('entityId'));
router.param('subGroupId', objectIdParam('subGroupId'));

// ─── Population helper ────────────────────────────────────────────────────────

/**
 * Manually populate `ref` on each member of a lean group document.
 *   Entity members:            ref = { _id, title }
 *   RelationshipGroup members: ref = { _id, label }
 *
 * Lookups are workspace-scoped, so a member pointing outside the workspace
 * resolves to the same placeholder as a deleted one rather than leaking a
 * title or label across the tenancy boundary.
 */
async function populateMembers(group, workspaceId) {
  if (!group) return null;

  const entityIds = group.members.filter(m => m.refModel === 'Entity').map(m => m.refId);
  const groupIds  = group.members.filter(m => m.refModel === 'RelationshipGroup').map(m => m.refId);

  const [entities, groups] = await Promise.all([
    entityIds.length
      ? Entity.find({ _id: { $in: entityIds }, workspaceId }).select('title').lean()
      : Promise.resolve([]),
    groupIds.length
      ? RelationshipGroup.find({ _id: { $in: groupIds }, workspaceId }).select('label').lean()
      : Promise.resolve([]),
  ]);

  const entityMap = new Map(entities.map(e => [String(e._id), e]));
  const groupMap  = new Map(groups.map(g => [String(g._id), g]));

  return {
    ...group,
    members: group.members.map(m => ({
      ...m,
      ref: m.refModel === 'Entity'
        ? (entityMap.get(String(m.refId)) ?? { _id: m.refId, title: '(deleted)' })
        : (groupMap.get(String(m.refId))  ?? { _id: m.refId, label: null }),
    })),
  };
}

async function fetchPopulated(id, workspaceId) {
  const group = await RelationshipGroup.findOne({ _id: id, workspaceId }).lean();
  return populateMembers(group, workspaceId);
}

/**
 * Returns the subset of `ids` that exist in this workspace. Callers reject the
 * request when anything is missing — otherwise a foreign entity id in the body
 * would be silently linked into this workspace's graph.
 */
async function existingEntityIds(ids, workspaceId) {
  const found = await Entity.find({ _id: { $in: ids }, workspaceId }).select('_id').lean();
  return new Set(found.map(e => String(e._id)));
}

function rejectForeign(ids, present) {
  const missing = ids.filter(id => !present.has(String(id)));
  return missing.length ? `Unknown entity: ${missing.join(', ')}` : null;
}

/**
 * GET /relationship-groups — the workspace's groups (lean, for graph
 * construction), a page at a time when a page is asked for.
 *
 * The contract is the one `GET /entities` answers (KOL-067), with the single
 * difference that this sort is `_id` alone, so the cursor is a bare id rather
 * than a title and a tie-break:
 *
 *   `?limit=` opts into the envelope `{ items, nextAfter }`. No `?limit=` — and
 *   anything that is not a page size, so `0`, `-1`, `abc`, a repeated parameter
 *   or `?limit[$gt]=1` — is the unbounded bare array this route has always
 *   answered, which is what keeps the cap from being a breaking change: the
 *   import and tenancy suites, and any script outside this repo, read the array.
 *
 *   `?after=` is the previous page's `nextAfter` verbatim. Keyset and not
 *   `skip`, for the reason KOL-067 gives: a group created while a client is
 *   paging shifts every later row forward one place under `skip`, so one row is
 *   served twice and the one the shift pushed past the boundary never at all.
 *   A cursor names a position in the sort instead, so an insert anywhere does
 *   not move it. A present-but-unusable cursor is 400 rather than a silent
 *   first page.
 *
 * `_id` is the sort because it is already unique (no tie-break to lose a row
 * at a boundary) and because every collection indexes it — so this needs no new
 * index on a live Atlas collection, which KOL-067 recorded as the cost of
 * sorting `/entities` by title. Ascending `_id` is also insertion order, which
 * is the order this route answered in before it sorted at all.
 *
 * `members` is *not* populated here, as it was not before: the graph resolves
 * member ids against the entity list it already holds, and `GET
 * /relationship-groups/:id` is where a labelled, populated group comes from.
 */
router.get('/', async (req, res, next) => {
  try {
    const filter = { workspaceId: req.workspaceId };
    // `?limit=` through the same typing rule the entity filters use: the
    // extended query parser hands `?limit[$gt]=1` to the route as an object
    // and `?limit=1&limit=2` as an array, and either reaching `.limit()` is a
    // 500 rather than a page. Absent, unusable, or below the minimum all mean
    // *no limit* — today's unpaged bare array, unchanged.
    const limit = boundedInteger(req.query.limit, { min: GROUP_LIMIT_MIN, max: GROUP_LIMIT_MAX });

    const source = req.originalUrl.includes('?') ? `?${req.originalUrl.split('?').slice(1).join('?')}` : '(no query string)';
    const cursor = idCursor(req.query.after);
    if (cursor.error) {
      log('light', `refused 400 — ${cursor.error} (source: ${source}, after=${JSON.stringify(req.query.after)})`);
      return res.status(400).json({ error: cursor.error });
    }
    const after = cursor.after;

    const query = RelationshipGroup.find(after ? { ...filter, _id: { $gt: after } } : filter)
      .sort({ _id: 1 });
    // One row past the page, so whether a next page exists is a fact about what
    // came back rather than something inferred from a second count query.
    if (limit) query.limit(limit + 1);

    const rows = await query.lean();

    if (!limit) {
      log('normal', `unpaged list → ${rows.length} group(s), bare array (source: ${source})`);
      return res.json(rows);
    }

    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const nextAfter = rows.length > limit && last ? String(last._id) : null;

    log('light', `page → limit ${limit}, after ${after ?? '(none)'}, ${items.length} group(s), next ${nextAfter ?? '(none)'} (source: ${source})`);
    log('verbose', `page ids: ${items.length ? `${items[0]._id} … ${last._id}` : '(empty)'}`);

    res.json({ items, nextAfter });
  } catch (err) {
    next(err);
  }
});

// GET /relationship-groups/:id
router.get('/:id', async (req, res, next) => {
  try {
    const group = await fetchPopulated(req.params.id, req.workspaceId);
    if (!group) return res.status(404).json({ error: 'Not found' });
    res.json(group);
  } catch (err) {
    next(err);
  }
});

// POST /relationship-groups — create group with initial entity members
// Body: { label?, members: [{ entityId, label?, notes? }] }
router.post('/', requireActor, async (req, res, next) => {
  try {
    const { label = null, members = [] } = req.body;

    if (!Array.isArray(members) || members.length < 2) {
      return res.status(400).json({ error: 'A relationship group requires at least 2 members' });
    }

    const entityIds = members.map(m => m.entityId);
    const foreign = rejectForeign(entityIds, await existingEntityIds(entityIds, req.workspaceId));
    if (foreign) return res.status(400).json({ error: foreign });

    const unifiedMembers = members.map(m => ({
      refId:    m.entityId,
      refModel: 'Entity',
      label:    m.label ?? null,
      notes:    m.notes ?? null,
    }));

    const group = await RelationshipGroup.create({
      label,
      members: unifiedMembers,
      workspaceId: req.workspaceId,
    });

    await Entity.updateMany(
      { _id: { $in: entityIds }, workspaceId: req.workspaceId },
      { $addToSet: { relationships: group._id } }
    );

    const populated = await fetchPopulated(group._id, req.workspaceId);
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
});

// PATCH /relationship-groups/:id — update group label
router.patch('/:id', requireActor, async (req, res, next) => {
  try {
    const { label } = req.body;
    const updated = await RelationshipGroup.findOneAndUpdate(
      { _id: req.params.id, workspaceId: req.workspaceId },
      { label },
      { new: true, runValidators: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: 'Not found' });
    const populated = await populateMembers(updated, req.workspaceId);
    res.json(populated);
  } catch (err) {
    next(err);
  }
});

// POST /relationship-groups/:id/members — add one or more entity members
// Body: { members: [{ entityId, label?, notes? }] }
router.post('/:id/members', requireActor, async (req, res, next) => {
  try {
    const { members } = req.body;
    if (!Array.isArray(members) || members.length === 0) {
      return res.status(400).json({ error: 'members must be a non-empty array' });
    }
    if (members.some(m => !m.entityId)) {
      return res.status(400).json({ error: 'each member must have an entityId' });
    }

    const group = await RelationshipGroup.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
    if (!group) return res.status(404).json({ error: 'Not found' });

    const entityIds = members.map(m => m.entityId);
    const foreign = rejectForeign(entityIds, await existingEntityIds(entityIds, req.workspaceId));
    if (foreign) return res.status(400).json({ error: foreign });

    const existingMemberIds = new Set(
      group.members.filter(m => m.refModel === 'Entity').map(m => String(m.refId))
    );
    const duplicates = members.filter(m => existingMemberIds.has(String(m.entityId)));
    if (duplicates.length) {
      return res.status(409).json({ error: `Already a member: ${duplicates.map(m => m.entityId).join(', ')}` });
    }

    for (const m of members) {
      group.members.push({ refId: m.entityId, refModel: 'Entity', label: m.label ?? null, notes: m.notes ?? null });
    }
    await group.save();

    await Entity.updateMany(
      { _id: { $in: entityIds }, workspaceId: req.workspaceId },
      { $addToSet: { relationships: group._id } }
    );

    const populated = await fetchPopulated(group._id, req.workspaceId);
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
});

// PATCH /relationship-groups/:id/members/reorder — reorder all members
// Must be defined BEFORE /:id/members/:entityId to prevent "reorder" matching as entityId.
// Body: { orderedMembers: [{ refModel, refId }] } — full list in new order
router.patch('/:id/members/reorder', requireActor, async (req, res, next) => {
  try {
    const { orderedMembers } = req.body;
    if (!Array.isArray(orderedMembers)) {
      return res.status(400).json({ error: 'orderedMembers must be an array' });
    }

    const group = await RelationshipGroup.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
    if (!group) return res.status(404).json({ error: 'Not found' });

    if (
      orderedMembers.length !== group.members.length ||
      !orderedMembers.every(om =>
        group.members.some(m => m.refModel === om.refModel && String(m.refId) === String(om.refId))
      )
    ) {
      return res.status(400).json({ error: 'orderedMembers must contain all existing members exactly once' });
    }

    const memberMap = new Map(group.members.map(m => [`${m.refModel}:${String(m.refId)}`, m]));
    group.members = orderedMembers.map(om => memberMap.get(`${om.refModel}:${String(om.refId)}`));
    await group.save();

    const populated = await fetchPopulated(group._id, req.workspaceId);
    res.json(populated);
  } catch (err) {
    next(err);
  }
});

// PATCH /relationship-groups/:id/members/:entityId — update an entity member's label or notes
router.patch('/:id/members/:entityId', requireActor, async (req, res, next) => {
  try {
    const { label, notes } = req.body;
    const group = await RelationshipGroup.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
    if (!group) return res.status(404).json({ error: 'Not found' });

    const member = group.members.find(
      m => m.refModel === 'Entity' && String(m.refId) === req.params.entityId
    );
    if (!member) return res.status(404).json({ error: 'Member not found' });

    if (label !== undefined) member.label = label;
    if (notes !== undefined) member.notes = notes;
    await group.save();

    const populated = await fetchPopulated(group._id, req.workspaceId);
    res.json(populated);
  } catch (err) {
    next(err);
  }
});

// DELETE /relationship-groups/:id/members/:entityId — remove an entity member
router.delete('/:id/members/:entityId', requireActor, async (req, res, next) => {
  try {
    const group = await RelationshipGroup.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
    if (!group) return res.status(404).json({ error: 'Not found' });

    group.members = group.members.filter(
      m => !(m.refModel === 'Entity' && String(m.refId) === req.params.entityId)
    );
    await Entity.findOneAndUpdate(
      { _id: req.params.entityId, workspaceId: req.workspaceId },
      { $pull: { relationships: group._id } }
    );

    const entityMembers = group.members.filter(m => m.refModel === 'Entity');

    // If fewer than 2 entity members remain, the group is orphaned — delete it and clean up
    if (entityMembers.length < 2) {
      await Entity.updateMany(
        { _id: { $in: entityMembers.map(m => m.refId) }, workspaceId: req.workspaceId },
        { $pull: { relationships: group._id } }
      );
      await RelationshipGroup.findOneAndDelete({ _id: group._id, workspaceId: req.workspaceId });
      return res.status(204).send();
    }

    await group.save();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// POST /relationship-groups/:id/subgroups — link an existing group as a sub-group
// Body: { groupId, label? }
router.post('/:id/subgroups', requireActor, async (req, res, next) => {
  try {
    const { groupId, label = null } = req.body;
    if (!groupId) return res.status(400).json({ error: 'groupId is required' });

    const parent = await RelationshipGroup.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
    if (!parent) return res.status(404).json({ error: 'Parent group not found' });

    // Scoped, so a group from another workspace cannot be nested into this one.
    const child = await RelationshipGroup.findOne({ _id: groupId, workspaceId: req.workspaceId });
    if (!child) return res.status(404).json({ error: 'Sub-group not found' });

    if (String(parent._id) === String(child._id)) {
      return res.status(400).json({ error: 'A group cannot be its own sub-group' });
    }

    const alreadyLinked = parent.members.some(
      m => m.refModel === 'RelationshipGroup' && String(m.refId) === String(groupId)
    );
    if (alreadyLinked) return res.status(409).json({ error: 'Group is already a sub-group' });

    parent.members.push({ refId: groupId, refModel: 'RelationshipGroup', label: label || null, notes: null });
    await parent.save();

    const populated = await fetchPopulated(parent._id, req.workspaceId);
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
});

// DELETE /relationship-groups/:id/subgroups/:subGroupId — unlink a sub-group
// Any entity members of the sub-group not already in the parent are re-added.
router.delete('/:id/subgroups/:subGroupId', requireActor, async (req, res, next) => {
  try {
    const parent = await RelationshipGroup.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
    if (!parent) return res.status(404).json({ error: 'Parent group not found' });

    const linked = parent.members.some(
      m => m.refModel === 'RelationshipGroup' && String(m.refId) === req.params.subGroupId
    );
    if (!linked) return res.status(404).json({ error: 'Sub-group link not found' });

    // Remove the sub-group link
    parent.members = parent.members.filter(
      m => !(m.refModel === 'RelationshipGroup' && String(m.refId) === req.params.subGroupId)
    );

    // Re-add sub-group's entity members to the parent if not already there
    const subGroup = await RelationshipGroup.findOne({
      _id: req.params.subGroupId,
      workspaceId: req.workspaceId,
    });
    if (subGroup) {
      const existingIds = new Set(
        parent.members.filter(m => m.refModel === 'Entity').map(m => String(m.refId))
      );
      for (const m of subGroup.members.filter(m => m.refModel === 'Entity')) {
        if (!existingIds.has(String(m.refId))) {
          parent.members.push({ refId: m.refId, refModel: 'Entity', label: m.label, notes: m.notes });
          await Entity.findOneAndUpdate(
            { _id: m.refId, workspaceId: req.workspaceId },
            { $addToSet: { relationships: parent._id } }
          );
        }
      }
    }

    await parent.save();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// DELETE /relationship-groups/:id — delete entire group and clean up all entity member entries
router.delete('/:id', requireActor, async (req, res, next) => {
  try {
    const group = await RelationshipGroup.findOneAndDelete({
      _id: req.params.id,
      workspaceId: req.workspaceId,
    });
    if (!group) return res.status(404).json({ error: 'Not found' });

    const entityIds = group.members.filter(m => m.refModel === 'Entity').map(m => m.refId);
    await Entity.updateMany(
      { _id: { $in: entityIds }, workspaceId: req.workspaceId },
      { $pull: { relationships: group._id } }
    );

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
