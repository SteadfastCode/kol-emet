import { Router } from 'express';
import mongoose from 'mongoose';
import EntityType from '../models/EntityType.js';
import Entity from '../models/Entity.js';
import RelationshipType from '../models/RelationshipType.js';
import { similarity, findSimilar } from '../lib/similarity.js';

/**
 * The entity-type registry — see models/EntityType.js.
 *
 * Mirrors routes/relationshipTypes.js, with differences that come from entities
 * pointing at a type by NAME. Together with the write-time check in
 * lib/entityTypeRegistry.js — the only gate on category names since Phase 6
 * step 2 dropped the Entity enum — these keep the registry and the data from
 * drifting apart:
 *
 *   - Any non-blank name can be a type (trimmed, unique per workspace
 *     case-insensitively), and an entity can use it at once.
 *   - A rename cascades. The type is renamed first, which is what opens the new
 *     name to writes, and then every entity's category and relationship type's
 *     source/target category in the workspace that held the old name is moved
 *     to the new one. The response counts what moved (`relabelled`). The steps
 *     are ordered, not transactional (transactions need a replica set); if the
 *     cascade fails part-way the type keeps its new name and the response is
 *     500 — renaming it back runs the cascade the other way and restores a
 *     consistent state.
 *   - A type that anything in the workspace still names — an entity's
 *     category, or a relationship type's source/target category — cannot be
 *     deleted (409, with the counts): deleting would strand those names.
 *   - A workspace's last type cannot be deleted (409). An empty registry is
 *     how a workspace that predates the registry is recognised, and it is
 *     checked against the built-in categories instead — so emptying one would
 *     switch the registry check off.
 *   - A foreign or malformed id is 404, never 403 or 400, as in
 *     routes/entities.js: nothing may confirm that an id exists elsewhere.
 *
 * Only name, icon, color and order are ever read from a body, so a forged
 * workspaceId there is ignored.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * ENTITY_TYPE_LOG_LEVEL = off | light | normal | verbose (default light), shared
 * with lib/entityTypeRegistry.js
 *   off     — nothing
 *   light   — every rename cascade: who renamed what, and what it relabelled,
 *             or the step it failed at
 *   normal  — light, plus each create and delete
 */

const router = Router();

// E11000: the unique (workspaceId, name) index caught a duplicate the
// pre-check missed — two concurrent creates, or a rename racing a create.
const isDuplicateKey = err => err?.code === 11000;

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so a test can change it.
  const active = LEVELS[process.env.ENTITY_TYPE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[entityTypes:${level}] ${msg}`);
}

function sameName(a, b) {
  return a.toLowerCase() === b.toLowerCase();
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

/**
 * Moves every name `from` in the workspace to `to`: entity categories, then
 * relationship types' source and target categories. Runs after the type itself
 * is renamed, so the writes name a registered type; they skip the validators
 * for that reason. Returns what moved.
 */
async function relabel(workspaceId, from, to) {
  const entities = await Entity.updateMany({ workspaceId, category: from }, { $set: { category: to } });
  // One pass per end: a relationship type can name the type on both, so these
  // count ends moved, not relationship types.
  const sources = await RelationshipType.updateMany({ workspaceId, sourceCategory: from }, { $set: { sourceCategory: to } });
  const targets = await RelationshipType.updateMany({ workspaceId, targetCategory: from }, { $set: { targetCategory: to } });
  return {
    entities: entities.modifiedCount,
    sourceCategories: sources.modifiedCount,
    targetCategories: targets.modifiedCount,
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

    log('normal', `created entity type ${type._id} "${type.name}" in workspace ${req.workspaceId} (source: POST /entity-types)`);
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
      // Exact comparison: entities store the name as spelled, so a change of
      // case alone is a rename and cascades like any other.
      if (trimmed !== type.name) {
        const others = await EntityType.find({ workspaceId: req.workspaceId, _id: { $ne: type._id } });
        const clash = others.find(t => sameName(t.name, trimmed));
        if (clash) return res.status(409).json({ error: 'Entity type already exists', existing: clash });
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
    if (update.name === undefined) return res.json(updated);

    const from = type.name;
    const to = updated.name;
    const source = `PUT /entity-types/${type._id} in workspace ${req.workspaceId}`;
    let relabelled;
    try {
      relabelled = await relabel(req.workspaceId, from, to);
    } catch (err) {
      log('light', `renamed entity type "${from}" → "${to}" but relabelling what used it failed: ${err.message} (source: ${source}; rename it back to repair)`);
      return res.status(500).json({
        error: `Renamed "${from}" to "${to}", but moving what used "${from}" failed: ${err.message}. Rename it back to "${from}" to restore a consistent state, then retry.`,
      });
    }
    log('light', `renamed entity type "${from}" → "${to}": relabelled ${relabelled.entities} entities, ${relabelled.sourceCategories} relationship-type source and ${relabelled.targetCategories} target categories (source: ${source})`);
    res.json({ ...updated.toObject(), relabelled });
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
    log('normal', `deleted entity type ${type._id} "${type.name}" in workspace ${req.workspaceId} (source: DELETE /entity-types)`);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
