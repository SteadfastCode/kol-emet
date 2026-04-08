import { Router } from 'express';
import Entry from '../models/Entry.js';

const router = Router();

// GET /open-questions — entries with a non-empty open_question
router.get('/', async (req, res) => {
  try {
    const entries = await Entry.find({ open_question: { $ne: '' } }).sort({ title: 1 });
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
