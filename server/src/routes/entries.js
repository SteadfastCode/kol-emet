import { Router } from 'express';
import Entry, { BLOCK_TYPES } from '../models/Entry.js';
import { requireActor } from '../middleware/auth.js';
import { logCreate, logUpdate, logDelete } from '../lib/changeLogger.js';

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

// GET /entries
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
    const entries = await Entry.find(filter)
      .sort({ title: 1 })
      .populate('open_questions', 'question status');
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /entries/:id
router.get('/:id', async (req, res) => {
  try {
    const entry = await Entry.findById(req.params.id)
      .populate('open_questions', 'question status');
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /entries
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

    const entry = await Entry.create(data);
    logCreate(entry.toObject(), req.actor).catch(err => console.error('[changelog] logCreate failed:', err));
    res.status(201).json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /entries/:id
router.put('/:id', requireActor, async (req, res) => {
  try {
    const data = { ...req.body };

    if (data.blocks) {
      const err = validateBlocks(data.blocks);
      if (err) return res.status(400).json({ error: err });
      data.blocks = normalizeBlockOrder(data.blocks);
    }

    const before = await Entry.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ error: 'Not found' });

    const after = await Entry.findByIdAndUpdate(req.params.id, data, {
      new: true,
      runValidators: true,
    }).populate('open_questions', 'question status');
    if (!after) return res.status(404).json({ error: 'Not found' });

    logUpdate(before, after.toObject(), req.actor).catch(err => console.error('[changelog] logUpdate failed:', err));
    res.json(after);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /entries/:id
router.delete('/:id', requireActor, async (req, res) => {
  try {
    const entry = await Entry.findByIdAndDelete(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    logDelete(entry.toObject(), req.actor).catch(err => console.error('[changelog] logDelete failed:', err));
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
