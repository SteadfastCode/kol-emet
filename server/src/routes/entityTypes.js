import { Router } from 'express';
import mongoose from 'mongoose';
import EntityType from '../models/EntityType.js';
import Entity from '../models/Entity.js';
import RelationshipType from '../models/RelationshipType.js';
import { similarity, findSimilar } from '../lib/similarity.js';
import { requireActor } from '../middleware/auth.js';
import { logUpdate } from '../lib/changeLogger.js';
import { broadcast } from '../lib/broadcaster.js';

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
 *   - **A rename leaves a trail, and it is bounded** (KOL-151). It is the
 *     largest single write the product can make to a workspace's entities, and
 *     for six months it made that write with three unbounded `updateMany`s and
 *     nothing else: no `ChangeLog`, so every rewritten entity read as untouched
 *     through `GET /entities/:id/history` and nothing could be rolled back, and
 *     no broadcast, so the new name never reached another tab — which went on
 *     rendering the old pill and filtering on a category name no entity had any
 *     more, a pill that matched nothing and a sidebar that silently emptied.
 *     KOL-053 had already settled the shape for the same problem on the same
 *     documents (`routes/tags.js`), so this is that shape one route over:
 *       · the entities that will move are **read first and the batch bounded**
 *         at `MAX_AFFECTED`, past which the rename is **413** naming the count
 *         and the limit and writing nothing at all — not the type, not an
 *         entity, not a changelog row. An unbounded `updateMany` cannot be the
 *         answer: a workspace-wide rename would otherwise write an unbounded
 *         burst of changelog documents and SSE frames.
 *       · **one `ChangeLog` entry per moved entity**, through the same
 *         `logUpdate` a single edit uses, so a rename is exactly as reversible
 *         as the edit it replaces — each entity rolls back from its own
 *         snapshot, which holds the category as it was spelled before. Awaited,
 *         so the response is only sent once the trail exists (what the bound
 *         above bounds the cost of).
 *       · the frames that follow from it: the per-entity `entity:updated` that
 *         logger already emits, plus **one `entity-type:updated`** so a
 *         listening tab can repaint its pills, filters and pickers from the
 *         frame without refetching the workspace. Both are workspace-scoped and
 *         both exclude the writing client by the `X-SSE-Client-Id` it echoed —
 *         a header the browser has sent on this write since KOL-104 and which
 *         nothing here read until now.
 *     Relationship-type ends keep moving as they do today, with no entry of
 *     their own: that collection has no history anywhere (see
 *     `lib/relationshipEvents.js` for the same note one collection over).
 *   - **A create and a delete each send their own frame** (KOL-158), on the
 *     rename frame's terms: the whole row, workspace-scoped, and excluding the
 *     tab that asked. KOL-151 left these out because neither can strand a name
 *     a tab is filtering on — true, and beside the point once the registry has
 *     a *screen* (`client/src/components/EntityTypeSettings.vue`): a tab loads
 *     the registry on mount and nothing else fetches it, so a type added or
 *     removed elsewhere leaves a picker missing an option and a pill for a type
 *     that is gone. Sent after the write, so every refusal below sends nothing.
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
 *             or the step it failed at; every rename refused over the bound,
 *             with the count and the limit; every `entity-type:*` frame and the
 *             client excluded from it; and any entity left on the old name
 *             by a write that landed mid-cascade
 *   normal  — light, plus each create and delete, and the per-entity changelog
 *             pass with its failures
 *   verbose — normal, plus every entity the cascade will move, by id and title
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
 * How many entities one rename may move. Past this the rename is refused
 * rather than writing a changelog entry and an SSE frame per entity — the
 * bound `routes/tags.js` sets on the same documents, for the same reason.
 */
export const MAX_AFFECTED = 200;

/**
 * The entities in `workspaceId` whose category is `name`, or a ready-made
 * refusal. Returns `{ docs }` or `{ status, body }`.
 *
 * Read *before* the type is renamed, so each document is the before-state its
 * changelog entry pairs with the state it ends up in — and so a refusal
 * happens before anything at all is written.
 */
async function movedBy(workspaceId, name, source) {
  const docs = await Entity.find({ workspaceId, category: name }).lean();

  if (docs.length > MAX_AFFECTED) {
    log('light', `rename of "${name}" refused 413 — ${docs.length} entities, limit ${MAX_AFFECTED} (source: ${source})`);
    return {
      status: 413,
      body: {
        error: `"${name}" is the entity type of ${docs.length} entities; one rename may move at most ${MAX_AFFECTED}.`,
        affected: docs.length,
        limit: MAX_AFFECTED,
      },
    };
  }

  log('verbose', `renaming "${name}" will move: ${docs.map(d => `${d._id} "${d.title}"`).join(', ') || '(no entity)'} (source: ${source})`);
  return { docs };
}

/**
 * Moves every name `from` in the workspace to `to`: the entity categories of
 * the documents `movedBy` already read, then relationship types' source and
 * target categories. Runs after the type itself is renamed, so the writes name
 * a registered type; they skip the validators for that reason. Returns what
 * moved.
 *
 * The entity write is scoped to the ids read before the rename rather than to
 * `category: from`, which is what makes the batch the same one the bound was
 * checked against and the changelog paired against. The window that opens is
 * the one the ordering note above already covers — an entity created with the
 * old name while the cascade runs — and it is reported rather than silent: see
 * the straggler count in the route.
 */
async function relabel(workspaceId, ids, from, to) {
  const entities = ids.length
    ? await Entity.updateMany({ _id: { $in: ids }, workspaceId }, { $set: { category: to } })
    : { modifiedCount: 0 };
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

/**
 * Writes one `ChangeLog` entry — and with it one `entity:updated` broadcast —
 * per entity the cascade moved, pairing each before-state with the state it is
 * now in. `logUpdate` is the same call a single edit goes through, so the diff
 * names `category` and the snapshot is a version a rollback understands; no new
 * `changeType` is invented for the cascade, because each row of it *is* an
 * update.
 *
 * Awaited rather than fired and forgotten, so the response is only sent once
 * the trail exists — which is what `MAX_AFFECTED` bounds the cost of.
 *
 * A failed entry is reported and skipped: the entity has already moved, and a
 * missing history row must not turn a write that landed into a 500.
 */
async function logEach(before, actor, clientId, source) {
  if (!before.length) return 0;

  const after = await Entity.find({ _id: { $in: before.map(d => d._id) } }).lean();
  const afterById = new Map(after.map(d => [String(d._id), d]));

  let logged = 0;
  for (const doc of before) {
    const now = afterById.get(String(doc._id));
    if (!now) continue;   // deleted between the write and here; nothing to log
    try {
      await logUpdate(doc, now, actor, clientId);
      logged++;
    } catch (err) {
      log('normal', `changelog failed for entity ${doc._id} (source: ${source}): ${err.message}`);
    }
  }
  log('normal', `${logged}/${before.length} changelog entries written, each with its own entity:updated (source: ${source})`);
  return logged;
}

/**
 * A registry row as every frame below carries it: the whole of what the client
 * renders a pill, a picker entry and a settings row from, so a listening tab
 * patches its copy of the registry rather than refetching it.
 */
function typeRow(type) {
  return {
    _id: String(type._id),
    name: type.name,
    icon: type.icon ?? null,
    color: { bg: type.color?.bg ?? null, text: type.color?.text ?? null },
    order: type.order,
  };
}

/**
 * The one frame a rename sends for the type itself: enough for a listening tab
 * to repaint its pills, its filters and its category pickers from the payload
 * alone. `from` and `to` are both there because the *old* name is what a tab
 * has on screen — it is what an active category filter is set to, and a
 * listener that only learned the new name could not tell which pill had moved.
 *
 * Workspace-scoped, like every broadcast (`lib/broadcaster.js` delivers to
 * nobody rather than everybody when a caller forgets), and excluding the tab
 * that asked for the rename — it has the response.
 */
function broadcastTypeRenamed(type, { workspaceId, from, to, relabelled, actor, excludeClientId, source }) {
  broadcast('entity-type:updated', {
    entityType: typeRow(type),
    from,
    to,
    relabelled,
    actor: { label: actor.label, type: actor.type },
  }, { workspaceId, excludeClientId });
  log('light', `entity-type:updated ${type._id} "${from}" → "${to}" → workspace ${workspaceId}${excludeClientId ? `, excluding client ${excludeClientId}` : ' (no client excluded)'} (source: ${source})`);
}

/**
 * The other two frames of the registry's own vocabulary (KOL-158).
 *
 * KOL-151 added the rename frame and left these out, on the reasoning that
 * "neither can strand a name a tab is filtering on" — true of the name, and
 * beside the point once a *screen* exists. Until KOL-158 the only client that
 * could add or remove a type was an MCP connector, so the registry a tab had
 * loaded on mount could only ever go stale by a rename. `EntityTypeSettings`
 * makes a create and a delete ordinary browser writes, and without these two
 * frames they leave exactly the failure the rename frame closed: the other tab
 * renders a pill for a type that is gone and offers a picker that is missing
 * the one just added, and only a reload repairs it — the registry is loaded
 * once, on mount (`client/src/composables/useEntityTypes.js`).
 *
 * On the rename frame's terms exactly, because it is the same list being
 * patched: the whole row, workspace-scoped, and excluding the tab that asked —
 * it has the response. A delete carries `entityTypeId` beside the row, the way
 * `entity:deleted` and `group:deleted` do: the id is what a listener drops, and
 * the row is what it can say about what went.
 *
 * Both are sent *after* the write, so every refusal above them — the duplicate
 * name, the in-use 409, the last-type 409 — broadcasts nothing at all.
 */
function broadcastTypeCreated(type, { workspaceId, actor, excludeClientId, source }) {
  broadcast('entity-type:created', {
    entityType: typeRow(type),
    actor: { label: actor.label, type: actor.type },
  }, { workspaceId, excludeClientId });
  log('light', `entity-type:created ${type._id} "${type.name}" → workspace ${workspaceId}${excludeClientId ? `, excluding client ${excludeClientId}` : ' (no client excluded)'} (source: ${source})`);
}

function broadcastTypeDeleted(type, { workspaceId, actor, excludeClientId, source }) {
  broadcast('entity-type:deleted', {
    entityTypeId: String(type._id),
    entityType: typeRow(type),
    actor: { label: actor.label, type: actor.type },
  }, { workspaceId, excludeClientId });
  log('light', `entity-type:deleted ${type._id} "${type.name}" → workspace ${workspaceId}${excludeClientId ? `, excluding client ${excludeClientId}` : ' (no client excluded)'} (source: ${source})`);
}

/** Loads a type in the caller's workspace, or null for a foreign/malformed/missing id. */
function findOwn(req) {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  return EntityType.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
}

// GET /entity-types
router.get('/', async (req, res, next) => {
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
    next(err);
  }
});

// POST /entity-types
//
// `requireActor` for the frame's sake, as on the two writes below and in
// routes/tags.js: `entity-type:created` names who added the type, because the
// other tab shows it in a toast beside the row it just gained.
router.post('/', requireActor, async (req, res, next) => {
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
    broadcastTypeCreated(type, {
      workspaceId: req.workspaceId,
      actor: req.actor,
      excludeClientId: req.headers['x-sse-client-id'] ?? null,
      source: `POST /entity-types by ${req.actor.label} in workspace ${req.workspaceId}`,
    });

    const response = { ...type.toObject() };
    // The near-duplicate warning is for the caller that chose the name, not for
    // another tab: the row it warns about is in the frame either way.
    if (similar.length) response.warning = `Similar types exist: ${similar.join(', ')}`;
    res.status(201).json(response);
  } catch (err) {
    if (isDuplicateKey(err)) return res.status(409).json({ error: 'Entity type already exists' });
    next(err);
  }
});

// PUT /entity-types/:id
//
// `requireActor` here on the route rather than at the mount, exactly as the two
// writes in routes/tags.js carry it: a rename writes a `ChangeLog` entry per
// moved entity and an entry names an actor, while the mount gives this router
// only `requireAuth` + `resolveWorkspace` + `requireWriteRole`, which is all a
// GET needs.
router.put('/:id', requireActor, async (req, res, next) => {
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

    const source = `PUT /entity-types/${type._id} by ${req.actor.label} in workspace ${req.workspaceId}`;

    // The bound, and the before-states the trail is written from — both before
    // anything is written, so a refusal leaves the type and every entity
    // exactly as they were. A colour or icon in the same body is refused with
    // it: a 413 means nothing happened.
    let moving = [];
    if (update.name !== undefined) {
      const { docs, status, body } = await movedBy(req.workspaceId, type.name, source);
      if (!docs) return res.status(status).json(body);
      moving = docs;
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
    let relabelled;
    try {
      relabelled = await relabel(req.workspaceId, moving.map(d => d._id), from, to);
    } catch (err) {
      log('light', `renamed entity type "${from}" → "${to}" but relabelling what used it failed: ${err.message} (source: ${source}; rename it back to repair)`);
      // A deliberate 500 with a sentence the route wrote, kept as it is: the
      // workspace is half-renamed and the only useful answer is how to repair
      // it. Only `err.message` goes (KOL-075) — the reason the relabel failed
      // is the driver's, and it is on the log line above with the same facts.
      return res.status(500).json({
        error: `Renamed "${from}" to "${to}", but moving what used "${from}" failed. Rename it back to "${from}" to restore a consistent state, then retry.`,
      });
    }
    log('light', `renamed entity type "${from}" → "${to}": relabelled ${relabelled.entities} entities, ${relabelled.sourceCategories} relationship-type source and ${relabelled.targetCategories} target categories (source: ${source})`);

    // An entity written with the old name after `movedBy` read the batch and
    // before the type was renamed is outside the cascade's id list and is now
    // on a name the registry no longer has. The window is the ordering note at
    // the top of this file; the count is here so it is reported rather than
    // found later as drift.
    const stranded = await Entity.countDocuments({ workspaceId: req.workspaceId, category: from });
    if (stranded) {
      log('light', `${stranded} entit${stranded === 1 ? 'y is' : 'ies are'} still on "${from}", which workspace ${req.workspaceId} no longer has (source: written between the cascade's read and the rename; rename the type back and forward to move them)`);
    }

    const clientId = req.headers['x-sse-client-id'] ?? null;
    await logEach(moving, req.actor, clientId, source);
    broadcastTypeRenamed(updated, {
      workspaceId: req.workspaceId,
      from,
      to,
      relabelled,
      actor: req.actor,
      excludeClientId: clientId,
      source,
    });

    res.json({ ...updated.toObject(), relabelled });
  } catch (err) {
    if (isDuplicateKey(err)) return res.status(409).json({ error: 'Entity type already exists' });
    next(err);
  }
});

// DELETE /entity-types/:id
//
// `requireActor` for the frame, as on the two writes above.
router.delete('/:id', requireActor, async (req, res, next) => {
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
    broadcastTypeDeleted(type, {
      workspaceId: req.workspaceId,
      actor: req.actor,
      excludeClientId: req.headers['x-sse-client-id'] ?? null,
      source: `DELETE /entity-types/${type._id} by ${req.actor.label} in workspace ${req.workspaceId}`,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
