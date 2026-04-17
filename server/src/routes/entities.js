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

// GET /entities
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.category) filter.category = req.query.category;
    if (req.query.tag) filter.tags = req.query.tag;
    if (req.query.q) {
      const re = new RegExp(req.query.q, 'i');
      filter.$or = [
        { title: re },
        { summary: re },
        { body: re },
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
    const entity = await Entity.findById(req.params.id)
      .populate('open_questions', 'question status')
      .lean();
    if (!entity) return res.status(404).json({ error: 'Not found' });

    // Query groups dynamically — source of truth is the group's members array, not the back-reference on Entity
    const rawGroups = await RelationshipGroup.find({
      members: { $elemMatch: { refId: req.params.id, refModel: 'Entity' } },
    }).lean();

    const relationships = await resolveGroupLabels(rawGroups, req.params.id);

    res.json({ ...entity, relationships });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /entities
router.post('/', requireActor, async (req, res) => {
  try {
    const data = { ...req.body };

    if (data.blocks) {
      const err = validateBlocks(data.blocks);
      if (err) return res.status(400).json({ error: err });
      data.blocks = normalizeBlockOrder(data.blocks);
    } else if (data.body) {
      // Bridge: if client sends body but no blocks, auto-create a text block
      data.blocks = [{ type: 'text', order: 0, data: { markdown: data.body } }];
    }

    const entity = await Entity.create(data);
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
    const data = { ...req.body };

    if (data.blocks) {
      const err = validateBlocks(data.blocks);
      if (err) return res.status(400).json({ error: err });
      data.blocks = normalizeBlockOrder(data.blocks);
    }

    const before = await Entity.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ error: 'Not found' });

    const after = await Entity.findByIdAndUpdate(req.params.id, data, {
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
    const entity = await Entity.findByIdAndDelete(req.params.id);
    if (!entity) return res.status(404).json({ error: 'Not found' });

    // Clean up relationship groups: query dynamically so we catch all groups regardless of back-reference state
    const groups = await RelationshipGroup.find({
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
