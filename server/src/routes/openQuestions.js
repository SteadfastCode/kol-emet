import { Router } from 'express';
import OpenQuestion from '../models/OpenQuestion.js';
import Entity from '../models/Entity.js';

const router = Router();

// GET /open-questions — all questions, optional ?status=open|resolved
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    const questions = await OpenQuestion.find(filter)
      .sort({ createdAt: -1 })
      .populate('entry_ids', 'title category');
    res.json(questions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /open-questions/:id
router.get('/:id', async (req, res) => {
  try {
    const q = await OpenQuestion.findById(req.params.id)
      .populate('entry_ids', 'title category');
    if (!q) return res.status(404).json({ error: 'Not found' });
    res.json(q);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /open-questions
router.post('/', async (req, res) => {
  try {
    const { question, entry_ids = [] } = req.body;
    const oq = await OpenQuestion.create({ question, entry_ids });

    // Back-link on each entry
    if (entry_ids.length) {
      await Entity.updateMany(
        { _id: { $in: entry_ids } },
        { $addToSet: { open_questions: oq._id } }
      );
    }

    res.status(201).json(oq);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /open-questions/:id
router.put('/:id', async (req, res) => {
  try {
    const { question, status, entry_ids } = req.body;
    const update = {};
    if (question !== undefined) update.question = question;
    if (status !== undefined) update.status = status;

    if (entry_ids !== undefined) {
      // Sync back-links: remove from old entries, add to new
      const existing = await OpenQuestion.findById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });

      const oldIds = existing.entry_ids.map(id => id.toString());
      const newIds = entry_ids.map(id => id.toString());
      const removed = oldIds.filter(id => !newIds.includes(id));
      const added = newIds.filter(id => !oldIds.includes(id));

      if (removed.length) {
        await Entity.updateMany(
          { _id: { $in: removed } },
          { $pull: { open_questions: existing._id } }
        );
      }
      if (added.length) {
        await Entity.updateMany(
          { _id: { $in: added } },
          { $addToSet: { open_questions: existing._id } }
        );
      }

      update.entry_ids = entry_ids;
    }

    const oq = await OpenQuestion.findByIdAndUpdate(req.params.id, update, { new: true })
      .populate('entry_ids', 'title category');
    if (!oq) return res.status(404).json({ error: 'Not found' });
    res.json(oq);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /open-questions/:id
router.delete('/:id', async (req, res) => {
  try {
    const oq = await OpenQuestion.findByIdAndDelete(req.params.id);
    if (!oq) return res.status(404).json({ error: 'Not found' });

    // Remove back-links from entries
    await Entity.updateMany(
      { _id: { $in: oq.entry_ids } },
      { $pull: { open_questions: oq._id } }
    );

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
