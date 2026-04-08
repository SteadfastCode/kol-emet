import { Router } from 'express';
import Entry from '../models/Entry.js';

const router = Router();

// GET /entries
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.category) filter.category = req.query.category;
    if (req.query.tag) filter.tags = req.query.tag;
    if (req.query.q) {
      const re = new RegExp(req.query.q, 'i');
      filter.$or = [{ title: re }, { summary: re }, { body: re }];
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
router.post('/', async (req, res) => {
  try {
    const entry = await Entry.create(req.body);
    res.status(201).json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /entries/:id
router.put('/:id', async (req, res) => {
  try {
    const entry = await Entry.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    }).populate('open_questions', 'question status');
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /entries/:id
router.delete('/:id', async (req, res) => {
  try {
    const entry = await Entry.findByIdAndDelete(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
