import { Router } from 'express';
import Entry from '../models/Entry.js';

const router = Router();

// GET /tags — all unique tags across entries
router.get('/', async (req, res) => {
  try {
    const tags = await Entry.distinct('tags');
    res.json(tags.sort());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
