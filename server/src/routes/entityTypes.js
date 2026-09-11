import { Router } from 'express';
import mongoose from 'mongoose';
import EntityType from '../models/EntityType.js';
import Entity from '../models/Entity.js';
import { similarity, findSimilar } from '../lib/similarity.js';

/**
 * The entity-type registry — see models/EntityType.js.
 *
 * Mirrors routes/relationshipTypes.js, with differences that come from entities
 * pointing at a type by NAME:
 *
 *   - A type that some entity in the workspace still uses cannot be renamed or
 *     deleted (409, with the count). The build plan's answer is a rename that
 *     cascades to Entity.category, but while the Entity enum stands a cascade
 *     could only write names the schema rejects on those entities' next save.
 *     Refusing keeps the registry and the data consistent until Phase 6 step 2
 *     drops the enum and brings the cascade.
 *   - A foreign or malformed id is 404, never 403 or 400, as in
 *     routes/entities.js: nothing may confirm that an id exists elsewhere.
 *
 * Only name, icon, color and order are ever read from a body, so a forged
 * workspaceId there is ignored.
 */

const router = Router();

// E11000: the unique (workspaceId, name) index caught a duplicate the
// pre-check missed — two concurrent creates, or a rename racing a create.
const isDuplicateKey = err => err?.code === 11000;

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function sameName(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

function inUseMessage(count, name, action) {
  return `Cannot ${action}: ${count} ${count === 1 ? 'entity uses' : 'entities use'} "${name}"`;
}

/** Loads a type in the caller's workspace, or null for a foreign/malformed/missing id. */
function findOwn(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return EntityType.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
}

// GET /entity-types
router.get('/', async (req, res) => {
  try {
    const types = await EntityType.find({ workspaceId: req.workspaceId }).sort({ order: 1, name: 1 });

    // If ?q= provided, fuzzy-filter the results
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase().trim();
      const scored = types
        .map(t => ({ t, score: similarity(q, t.name) }))
        .filter(({ score, t }) => score >= 0.3 || t.name.toLowerCase().includes(q))
        .sort((a, b) => b.score - a.score);
      return res.json(scored.map(({ t }) => t));
    }

    res.json(types);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /entity-types
router.post('/', async (req, res) => {
  try {
    const { name, icon = null, color = null, order } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (color !== null && !isPlainObject(color)) return res.status(400).json({ error: 'color must be { bg, text }' });

    const trimmed = name.trim();
    const existing = await EntityType.find({ workspaceId: req.workspaceId });

    const exact = existing.find(t => sameName(t.name, trimmed));
    if (exact) return res.status(409).json({ error: 'Entity type already exists', existing: exact });

    // Near-duplicate warning (still creates, but warns)
    const similar = findSimilar(trimmed, existing);
    const type = await EntityType.create({
      name: trimmed,
      icon,
      color: { bg: color?.bg ?? null, text: color?.text ?? null },
      // Appended after the existing types unless the caller placed it.
      order: order ?? existing.reduce((max, t) => Math.max(max, t.order), -1) + 1,
      workspaceId: req.workspaceId,
    });

    const response = { ...type.toObject() };
    if (similar.length) response.warning = `Similar types exist: ${similar.join(', ')}`;
    res.status(201).json(response);
  } catch (err) {
    if (isDuplicateKey(err)) return res.status(409).json({ error: 'Entity type already exists' });
    res.status(400).json({ error: err.message });
  }
});

// PUT /entity-types/:id
router.put('/:id', async (req, res) => {
  try {
    const type = await findOwn(req);
    if (!type) return res.status(404).json({ error: 'Not found' });

    const { name, icon, color, order } = req.body ?? {};
    const update = {};

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required' });
      const trimmed = name.trim();
      if (trimmed !== type.name) {
        const others = await EntityType.find({ workspaceId: req.workspaceId, _id: { $ne: type._id } });
        const clash = others.find(t => sameName(t.name, trimmed));
        if (clash) return res.status(409).json({ error: 'Entity type already exists', existing: clash });

        const inUse = await Entity.countDocuments({ workspaceId: req.workspaceId, category: type.name });
        if (inUse) return res.status(409).json({ error: inUseMessage(inUse, type.name, 'rename'), inUse });
        update.name = trimmed;
      }
    }
    if (icon !== undefined) update.icon = icon;
    if (order !== undefined) update.order = order;
    // Each half of the pair is optional, so a partial colour update keeps the other.
    if (color === null) {
      update['color.bg'] = null;
      update['color.text'] = null;
    } else if (color !== undefined) {
      if (!isPlainObject(color)) return res.status(400).json({ error: 'color must be { bg, text }' });
      if (color.bg !== undefined) update['color.bg'] = color.bg;
      if (color.text !== undefined) update['color.text'] = color.text;
    }

    const updated = await EntityType.findOneAndUpdate(
      { _id: type._id, workspaceId: req.workspaceId },
      { $set: update },
      { new: true, runValidators: true }
    );
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (err) {
    if (isDuplicateKey(err)) return res.status(409).json({ error: 'Entity type already exists' });
    res.status(400).json({ error: err.message });
  }
});

// DELETE /entity-types/:id
router.delete('/:id', async (req, res) => {
  try {
    const type = await findOwn(req);
    if (!type) return res.status(404).json({ error: 'Not found' });

    const inUse = await Entity.countDocuments({ workspaceId: req.workspaceId, category: type.name });
    if (inUse) return res.status(409).json({ error: inUseMessage(inUse, type.name, 'delete'), inUse });

    await EntityType.deleteOne({ _id: type._id, workspaceId: req.workspaceId });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
