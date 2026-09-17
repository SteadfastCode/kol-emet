import { Router } from 'express';
import OpenQuestion from '../models/OpenQuestion.js';
import Entity from '../models/Entity.js';
import { entriesIn, ownEntryIds } from '../lib/scopedPopulate.js';

const router = Router();

// GET /open-questions — all questions, optional ?status=open|resolved
router.get('/', async (req, res) => {
  try {
    const filter = { workspaceId: req.workspaceId };
    if (req.query.status) filter.status = req.query.status;
    const questions = await OpenQuestion.find(filter)
      .sort({ createdAt: -1 })
      .populate(entriesIn(req.workspaceId));
    res.json(questions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /open-questions/:id
router.get('/:id', async (req, res) => {
  try {
    const q = await OpenQuestion.findOne({ _id: req.params.id, workspaceId: req.workspaceId })
      .populate(entriesIn(req.workspaceId));
    if (!q) return res.status(404).json({ error: 'Not found' });
    res.json(q);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /open-questions
router.post('/', async (req, res) => {
  try {
    const { question, entry_ids: requested = [] } = req.body;
    // Only this workspace's entities are kept, so another tenant's entity id is
    // never stored — nor back-linked below.
    const entry_ids = await ownEntryIds(requested, req.workspaceId);
    const oq = await OpenQuestion.create({
      question,
      entry_ids,
      workspaceId: req.workspaceId,
    });

    // Back-link on each entry. Still scoped, as a second line behind the
    // filter above.
    if (entry_ids.length) {
      await Entity.updateMany(
        { _id: { $in: entry_ids }, workspaceId: req.workspaceId },
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
    const { question, status, entry_ids: requested } = req.body;
    const scope = { _id: req.params.id, workspaceId: req.workspaceId };
    const update = {};
    if (question !== undefined) update.question = question;
    if (status !== undefined) update.status = status;

    if (requested !== undefined) {
      // Sync back-links: remove from old entries, add to new
      const existing = await OpenQuestion.findOne(scope);
      if (!existing) return res.status(404).json({ error: 'Not found' });

      // Same rule as POST: another tenant's entity ids are dropped, not stored.
      const entry_ids = await ownEntryIds(requested, req.workspaceId);

      const oldIds = existing.entry_ids.map(id => id.toString());
      const newIds = entry_ids.map(id => id.toString());
      const removed = oldIds.filter(id => !newIds.includes(id));
      const added = newIds.filter(id => !oldIds.includes(id));

      if (removed.length) {
        await Entity.updateMany(
          { _id: { $in: removed }, workspaceId: req.workspaceId },
          { $pull: { open_questions: existing._id } }
        );
      }
      if (added.length) {
        await Entity.updateMany(
          { _id: { $in: added }, workspaceId: req.workspaceId },
          { $addToSet: { open_questions: existing._id } }
        );
      }

      update.entry_ids = entry_ids;
    }

    const oq = await OpenQuestion.findOneAndUpdate(scope, update, { new: true })
      .populate(entriesIn(req.workspaceId));
    if (!oq) return res.status(404).json({ error: 'Not found' });
    res.json(oq);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /open-questions/:id
router.delete('/:id', async (req, res) => {
  try {
    const oq = await OpenQuestion.findOneAndDelete({
      _id: req.params.id,
      workspaceId: req.workspaceId,
    });
    if (!oq) return res.status(404).json({ error: 'Not found' });

    // Remove back-links from entries
    await Entity.updateMany(
      { _id: { $in: oq.entry_ids }, workspaceId: req.workspaceId },
      { $pull: { open_questions: oq._id } }
    );

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
