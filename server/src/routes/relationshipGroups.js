import { Router } from 'express';
import RelationshipGroup from '../models/RelationshipGroup.js';
import Entry from '../models/Entry.js';
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
    await Entry.updateMany(
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

// POST /relationship-groups/:id/members — add a member to an existing group
router.post('/:id/members', requireActor, async (req, res) => {
  try {
    const { entityId, label = null, notes = null } = req.body;
    if (!entityId) return res.status(400).json({ error: 'entityId is required' });

    const group = await RelationshipGroup.findById(req.params.id);
    if (!group) return res.status(404).json({ error: 'Not found' });

    // Prevent duplicate members
    const alreadyMember = group.members.some(m => String(m.entityId) === String(entityId));
    if (alreadyMember) return res.status(409).json({ error: 'Entity is already a member of this group' });

    group.members.push({ entityId, label, notes });
    await group.save();

    await Entry.findByIdAndUpdate(entityId, { $addToSet: { relationships: group._id } });

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
    await Entry.findByIdAndUpdate(req.params.entityId, { $pull: { relationships: group._id } });

    // If fewer than 2 members remain, the group is orphaned — delete it and clean up
    if (group.members.length < 2) {
      await Entry.updateMany(
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

// DELETE /relationship-groups/:id — delete entire group and clean up all member entries
router.delete('/:id', requireActor, async (req, res) => {
  try {
    const group = await RelationshipGroup.findByIdAndDelete(req.params.id);
    if (!group) return res.status(404).json({ error: 'Not found' });

    await Entry.updateMany(
      { _id: { $in: group.members.map(m => m.entityId) } },
      { $pull: { relationships: group._id } }
    );

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
