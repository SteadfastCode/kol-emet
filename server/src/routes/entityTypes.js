import { Router } from 'express';
import mongoose from 'mongoose';
import EntityType from '../models/EntityType.js';
import Entity from '../models/Entity.js';
import RelationshipType from '../models/RelationshipType.js';
import { CATEGORIES } from '../config/categories.js';
import { canonicalCategory } from '../lib/entityTypeRegistry.js';
import { similarity, findSimilar } from '../lib/similarity.js';

/**
 * The entity-type registry — see models/EntityType.js.
 *
 * Mirrors routes/relationshipTypes.js, with differences that come from entities
 * pointing at a type by NAME. Together with the write-time check in
 * lib/entityTypeRegistry.js, these keep the registry and the data from
 * drifting apart while the Entity enum stands:
 *
 *   - A type's name must be one of the enum's categories (matched
 *     case-insensitively, stored in the enum's spelling), so every registered
 *     type is one an entity can actually use. Other names wait for Phase 6
 *     step 2, which drops the enum.
 *   - A type that anything in the workspace still names — an entity's
 *     category, or a relationship type's source/target category — cannot be
 *     renamed or deleted (409, with the counts). The build plan's answer is a
 *     rename that cascades, but while the enum stands a cascade could only
 *     write names the schema rejects.
 *   - A workspace's last type cannot be deleted (409). An empty registry is
 *     how a workspace that predates the registry is recognised, and it is
 *     checked against the enum alone — so emptying one would switch the
 *     registry check off.
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

function notACategory(name) {
  return {
    error: `"${name}" is not one of the built-in categories. Until entity types are fully user-defined, a type must be one of: ${CATEGORIES.join(', ')}`,
    categories: CATEGORIES,
  };
}

/** How many entities and relationship types in the workspace name `name`. */
async function usesOf(workspaceId, name) {
  const [entities, relationshipTypes] = await Promise.all([
    Entity.countDocuments({ workspaceId, category: name }),
    RelationshipType.countDocuments({ workspaceId, $or: [{ sourceCategory: name }, { targetCategory: name }] }),
  ]);
  return { entities, relationshipTypes, inUse: entities + relationshipTypes };
}

function inUseBody({ entities, relationshipTypes, inUse }, name, action) {
  const parts = [];
  if (entities) parts.push(`${entities} ${entities === 1 ? 'entity' : 'entities'}`);
  if (relationshipTypes) parts.push(`${relationshipTypes} relationship ${relationshipTypes === 1 ? 'type' : 'types'}`);
  return {
    error: `Cannot ${action}: ${parts.join(' and ')} ${inUse === 1 ? 'uses' : 'use'} "${name}"`,
    inUse,
    entities,
    relationshipTypes,
  };
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

    const canonical = canonicalCategory(name);
    if (!canonical) return res.status(400).json(notACategory(name.trim()));

    const existing = await EntityType.find({ workspaceId: req.workspaceId });

    const exact = existing.find(t => sameName(t.name, canonical));
    if (exact) return res.status(409).json({ error: 'Entity type already exists', existing: exact });

    // Near-duplicate warning (still creates, but warns)
    const similar = findSimilar(canonical, existing);
    const type = await EntityType.create({
      name: canonical,
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
      const canonical = canonicalCategory(name);
      if (!canonical) return res.status(400).json(notACategory(name.trim()));
      if (canonical !== type.name) {
        const others = await EntityType.find({ workspaceId: req.workspaceId, _id: { $ne: type._id } });
        const clash = others.find(t => sameName(t.name, canonical));
        if (clash) return res.status(409).json({ error: 'Entity type already exists', existing: clash });

        const uses = await usesOf(req.workspaceId, type.name);
        if (uses.inUse) return res.status(409).json(inUseBody(uses, type.name, 'rename'));
        update.name = canonical;
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

    const uses = await usesOf(req.workspaceId, type.name);
    if (uses.inUse) return res.status(409).json(inUseBody(uses, type.name, 'delete'));

    if (await EntityType.countDocuments({ workspaceId: req.workspaceId }) <= 1) {
      return res.status(409).json({ error: `Cannot delete "${type.name}": a workspace keeps at least one entity type` });
    }

    await EntityType.deleteOne({ _id: type._id, workspaceId: req.workspaceId });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
