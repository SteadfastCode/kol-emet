import { Router } from 'express';
import RelationshipGroup from '../models/RelationshipGroup.js';
import Entity from '../models/Entity.js';
import { requireActor } from '../middleware/auth.js';

const router = Router();

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

// GET /relationship-groups — all groups (lean, for graph construction)
router.get('/', async (req, res) => {
  try {
    const groups = await RelationshipGroup.find({ workspaceId: req.workspaceId }).lean();
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /relationship-groups/:id
router.get('/:id', async (req, res) => {
  try {
    const group = await fetchPopulated(req.params.id, req.workspaceId);
    if (!group) return res.status(404).json({ error: 'Not found' });
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /relationship-groups — create group with initial entity members
// Body: { label?, members: [{ entityId, label?, notes? }] }
router.post('/', requireActor, async (req, res) => {
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
    res.status(400).json({ error: err.message });
  }
});

// PATCH /relationship-groups/:id — update group label
router.patch('/:id', requireActor, async (req, res) => {
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
    res.status(400).json({ error: err.message });
  }
});

// POST /relationship-groups/:id/members — add one or more entity members
// Body: { members: [{ entityId, label?, notes? }] }
router.post('/:id/members', requireActor, async (req, res) => {
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
    res.status(400).json({ error: err.message });
  }
});

// PATCH /relationship-groups/:id/members/reorder — reorder all members
// Must be defined BEFORE /:id/members/:entityId to prevent "reorder" matching as entityId.
// Body: { orderedMembers: [{ refModel, refId }] } — full list in new order
router.patch('/:id/members/reorder', requireActor, async (req, res) => {
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
    res.status(400).json({ error: err.message });
  }
});

// PATCH /relationship-groups/:id/members/:entityId — update an entity member's label or notes
router.patch('/:id/members/:entityId', requireActor, async (req, res) => {
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
    res.status(400).json({ error: err.message });
  }
});

// DELETE /relationship-groups/:id/members/:entityId — remove an entity member
router.delete('/:id/members/:entityId', requireActor, async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

// POST /relationship-groups/:id/subgroups — link an existing group as a sub-group
// Body: { groupId, label? }
router.post('/:id/subgroups', requireActor, async (req, res) => {
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
    res.status(400).json({ error: err.message });
  }
});

// DELETE /relationship-groups/:id/subgroups/:subGroupId — unlink a sub-group
// Any entity members of the sub-group not already in the parent are re-added.
router.delete('/:id/subgroups/:subGroupId', requireActor, async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

// DELETE /relationship-groups/:id — delete entire group and clean up all entity member entries
router.delete('/:id', requireActor, async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

export default router;
