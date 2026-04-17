import { Router } from 'express';
import RelationshipGroup from '../models/RelationshipGroup.js';
import Entity from '../models/Entity.js';
import { requireActor } from '../middleware/auth.js';

const router = Router();

// Populate helper — returns group with member entry titles resolved
function populateGroup(query) {
  return query.populate({
    path: 'members.entityId',
    select: 'title',
  });
}

// GET /relationship-groups/:id
router.get('/:id', async (req, res) => {
  try {
    const group = await populateGroup(RelationshipGroup.findById(req.params.id));
    if (!group) return res.status(404).json({ error: 'Not found' });
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /relationship-groups — create group with initial members
// Body: { label?, members: [{ entityId, label?, notes? }] }
router.post('/', requireActor, async (req, res) => {
  try {
    const { label = null, members = [] } = req.body;

    if (!Array.isArray(members) || members.length < 2) {
      return res.status(400).json({ error: 'A relationship group requires at least 2 members' });
    }

    const group = await RelationshipGroup.create({ label, members });

    // Push groupId onto each member's entry
    await Entity.updateMany(
      { _id: { $in: members.map(m => m.entityId) } },
      { $addToSet: { relationships: group._id } }
    );

    const populated = await populateGroup(RelationshipGroup.findById(group._id));
    res.status(201).json(populated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /relationship-groups/:id — update group label
router.patch('/:id', requireActor, async (req, res) => {
  try {
    const { label } = req.body;
    const group = await populateGroup(
      RelationshipGroup.findByIdAndUpdate(req.params.id, { label }, { new: true, runValidators: true })
    );
    if (!group) return res.status(404).json({ error: 'Not found' });
    res.json(group);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /relationship-groups/:id/members — add one or more members to an existing group
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

    const group = await RelationshipGroup.findById(req.params.id);
    if (!group) return res.status(404).json({ error: 'Not found' });

    const existingIds = new Set(group.members.map(m => String(m.entityId)));
    const duplicates = members.filter(m => existingIds.has(String(m.entityId)));
    if (duplicates.length) {
      return res.status(409).json({ error: `Already a member: ${duplicates.map(m => m.entityId).join(', ')}` });
    }

    for (const m of members) {
      group.members.push({ entityId: m.entityId, label: m.label ?? null, notes: m.notes ?? null });
    }
    await group.save();

    await Entity.updateMany(
      { _id: { $in: members.map(m => m.entityId) } },
      { $addToSet: { relationships: group._id } }
    );

    const populated = await populateGroup(RelationshipGroup.findById(group._id));
    res.status(201).json(populated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /relationship-groups/:id/members/:entityId — update a member's label or notes
router.patch('/:id/members/:entityId', requireActor, async (req, res) => {
  try {
    const { label, notes } = req.body;
    const group = await RelationshipGroup.findById(req.params.id);
    if (!group) return res.status(404).json({ error: 'Not found' });

    const member = group.members.find(m => String(m.entityId) === req.params.entityId);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    if (label !== undefined) member.label = label;
    if (notes !== undefined) member.notes = notes;
    await group.save();

    const populated = await populateGroup(RelationshipGroup.findById(group._id));
    res.json(populated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /relationship-groups/:id/members/:entityId — remove a member
router.delete('/:id/members/:entityId', requireActor, async (req, res) => {
  try {
    const group = await RelationshipGroup.findById(req.params.id);
    if (!group) return res.status(404).json({ error: 'Not found' });

    group.members = group.members.filter(m => String(m.entityId) !== req.params.entityId);
    await Entity.findByIdAndUpdate(req.params.entityId, { $pull: { relationships: group._id } });

    // If fewer than 2 members remain, the group is orphaned — delete it and clean up
    if (group.members.length < 2) {
      await Entity.updateMany(
        { _id: { $in: group.members.map(m => m.entityId) } },
        { $pull: { relationships: group._id } }
      );
      await RelationshipGroup.findByIdAndDelete(group._id);
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

    const parent = await RelationshipGroup.findById(req.params.id);
    if (!parent) return res.status(404).json({ error: 'Parent group not found' });

    const child = await RelationshipGroup.findById(groupId);
    if (!child) return res.status(404).json({ error: 'Sub-group not found' });

    if (String(parent._id) === String(child._id)) {
      return res.status(400).json({ error: 'A group cannot be its own sub-group' });
    }

    const alreadyLinked = parent.relationships.some(r => String(r.groupId) === String(groupId));
    if (alreadyLinked) return res.status(409).json({ error: 'Group is already a sub-group' });

    parent.relationships.push({ groupId, label: label || null });
    await parent.save();

    const populated = await populateGroup(RelationshipGroup.findById(parent._id));
    res.status(201).json(populated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /relationship-groups/:id/subgroups/:subGroupId — unlink a sub-group
// Any members of the sub-group that are not already in the parent are re-added.
router.delete('/:id/subgroups/:subGroupId', requireActor, async (req, res) => {
  try {
    const parent = await RelationshipGroup.findById(req.params.id);
    if (!parent) return res.status(404).json({ error: 'Parent group not found' });

    const linked = parent.relationships.some(r => String(r.groupId) === req.params.subGroupId);
    if (!linked) return res.status(404).json({ error: 'Sub-group link not found' });

    // Remove the sub-group link
    parent.relationships = parent.relationships.filter(r => String(r.groupId) !== req.params.subGroupId);

    // Re-add sub-group members to the parent if they're not already there
    const subGroup = await RelationshipGroup.findById(req.params.subGroupId);
    if (subGroup) {
      for (const subMember of subGroup.members) {
        const alreadyInParent = parent.members.some(
          m => String(m.entityId) === String(subMember.entityId)
        );
        if (!alreadyInParent) {
          parent.members.push({
            entityId: subMember.entityId,
            label:    subMember.label,
            notes:    subMember.notes,
          });
          await Entity.findByIdAndUpdate(subMember.entityId, { $addToSet: { relationships: parent._id } });
        }
      }
    }

    await parent.save();
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /relationship-groups/:id — delete entire group and clean up all member entries
router.delete('/:id', requireActor, async (req, res) => {
  try {
    const group = await RelationshipGroup.findByIdAndDelete(req.params.id);
    if (!group) return res.status(404).json({ error: 'Not found' });

    await Entity.updateMany(
      { _id: { $in: group.members.map(m => m.entityId) } },
      { $pull: { relationships: group._id } }
    );

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
