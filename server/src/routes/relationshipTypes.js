import { Router } from 'express';
import RelationshipType from '../models/RelationshipType.js';
import { similarity, findSimilar } from '../lib/similarity.js';

const router = Router();

// GET /relationship-types
router.get('/', async (req, res) => {
  try {
    const filter = { workspaceId: req.workspaceId };
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
    const existing = await RelationshipType.find({ workspaceId: req.workspaceId });

    // Exact match check
    const exact = existing.find(t => t.name.toLowerCase() === trimmed.toLowerCase());
    if (exact) return res.status(409).json({ error: 'Relationship type already exists', existing: exact });

    // Near-duplicate warning (still creates, but warns)
    const similar = findSimilar(trimmed, existing);
    const type = await RelationshipType.create({
      name: trimmed,
      sourceCategory,
      targetCategory,
      workspaceId: req.workspaceId,
    });

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

    const type = await RelationshipType.findOneAndUpdate(
      { _id: req.params.id, workspaceId: req.workspaceId },
      update,
      { new: true }
    );
    if (!type) return res.status(404).json({ error: 'Not found' });
    res.json(type);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /relationship-types/:id
router.delete('/:id', async (req, res) => {
  try {
    const type = await RelationshipType.findOneAndDelete({
      _id: req.params.id,
      workspaceId: req.workspaceId,
    });
    if (!type) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
