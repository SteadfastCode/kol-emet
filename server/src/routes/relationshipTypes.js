import { Router } from 'express';
import RelationshipType from '../models/RelationshipType.js';

const router = Router();

// Trigram similarity — used for near-duplicate detection
function trigrams(str) {
  const s = str.toLowerCase().trim();
  const set = new Set();
  for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
  return set;
}

function similarity(a, b) {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  const intersection = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return intersection / union;
}

function findSimilar(name, existing, threshold = 0.4) {
  return existing
    .map(t => ({ type: t, score: similarity(name, t.name) }))
    .filter(({ score, type }) => score >= threshold && type.name.toLowerCase() !== name.toLowerCase())
    .sort((a, b) => b.score - a.score)
    .map(({ type }) => type.name);
}

// GET /relationship-types
router.get('/', async (req, res) => {
  try {
    const filter = { workspaceId: null };
    const types = await RelationshipType.find(filter).sort({ name: 1 });

    // If ?q= provided, fuzzy-filter the results
    if (req.query.q) {
      const q = req.query.q.toLowerCase().trim();
      const scored = types
        .map(t => ({ t, score: similarity(q, t.name) }))
        .filter(({ score, t }) =>
          score >= 0.3 || t.name.toLowerCase().includes(q)
        )
        .sort((a, b) => b.score - a.score);
      return res.json(scored.map(({ t }) => t));
    }

    res.json(types);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /relationship-types
router.post('/', async (req, res) => {
  try {
    const { name, sourceCategory = null, targetCategory = null } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

    const trimmed = name.trim();
    const existing = await RelationshipType.find({ workspaceId: null });

    // Exact match check
    const exact = existing.find(t => t.name.toLowerCase() === trimmed.toLowerCase());
    if (exact) return res.status(409).json({ error: 'Relationship type already exists', existing: exact });

    // Near-duplicate warning (still creates, but warns)
    const similar = findSimilar(trimmed, existing);
    const type = await RelationshipType.create({ name: trimmed, sourceCategory, targetCategory });

    const response = { ...type.toObject() };
    if (similar.length) response.warning = `Similar types exist: ${similar.join(', ')}`;
    res.status(201).json(response);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /relationship-types/:id
router.put('/:id', async (req, res) => {
  try {
    const { name, sourceCategory, targetCategory } = req.body;
    const update = {};
    if (name !== undefined) update.name = name.trim();
    if (sourceCategory !== undefined) update.sourceCategory = sourceCategory;
    if (targetCategory !== undefined) update.targetCategory = targetCategory;

    const type = await RelationshipType.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!type) return res.status(404).json({ error: 'Not found' });
    res.json(type);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /relationship-types/:id
router.delete('/:id', async (req, res) => {
  try {
    const type = await RelationshipType.findByIdAndDelete(req.params.id);
    if (!type) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
