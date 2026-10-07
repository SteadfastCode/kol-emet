import { Router } from 'express';
import Entity from '../models/Entity.js';
import { requireActor } from '../middleware/auth.js';
import { logUpdate } from '../lib/changeLogger.js';

/**
 * Workspace-wide tag operations (KOL-053).
 *
 * Tags live nowhere but the `tags` array on each entity, so until now the only
 * way to fix a workspace holding `train`, `Train` and `trains` was to open
 * every entity and edit its comma-separated field. These two routes do it in
 * one request:
 *
 *   PUT /tags/:tag { to }  — rename, merging into `to` when an entity already
 *                            carries it. `$addToSet` then `$pull`, in that
 *                            order and as two writes (Mongo refuses both
 *                            operators on one field in one update), so an
 *                            entity that held both ends up with exactly one
 *                            copy and never with none.
 *   DELETE /tags/:tag      — remove it from every entity that carries it.
 *
 * Both are writes, so both take `requireActor` per route the way the write
 * routes in routes/entities.js do — the mount gives this router only
 * `requireAuth` + `resolveWorkspace`, which is all a GET needs.
 *
 * Every changed entity gets its own `logUpdate`: a bulk rename is then exactly
 * as reversible as the single edit it replaces (each entity rolls back from its
 * own snapshot through the existing history route), and each one broadcasts
 * `entity:updated` so open clients follow without a refetch. That is also why
 * the batch is bounded — `MAX_AFFECTED` entities, 413 past it, naming the
 * count. An unbounded rename across a large workspace would write an unbounded
 * burst of changelog documents and SSE frames, the same reasoning that bounded
 * the compose import in KOL-045.
 *
 * Every query carries `workspaceId`, so an identically-named tag in another
 * workspace is a different tag and is never touched.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TAG_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — every rename and removal: who asked, which tag, how many entities
 *             it changed, and every refusal with the reason
 *   normal  — light, plus the per-entity changelog pass and its failures
 *   verbose — normal, plus each entity id and title the operation touched
 */

const router = Router();

/**
 * How many entities one tag operation may change. Past this the route refuses
 * rather than writing a changelog entry and an SSE frame per entity.
 */
export const MAX_AFFECTED = 200;

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so a test can change it.
  const active = LEVELS[process.env.TAG_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tags:${level}] ${msg}`);
}

/**
 * The entities in the caller's workspace carrying `tag`, or a ready-made
 * refusal. Returns `{ docs }` or `{ status, body }`.
 */
async function affectedBy(req, tag, action) {
  const docs = await Entity.find({ workspaceId: req.workspaceId, tags: tag }).lean();

  if (!docs.length) {
    log('light', `${action} "${tag}" refused 404 — no entity in workspace ${req.workspaceId} carries it (source: ${req.actor.label})`);
    return { status: 404, body: { error: `No entity is tagged "${tag}"` } };
  }

  if (docs.length > MAX_AFFECTED) {
    log('light', `${action} "${tag}" refused 413 — ${docs.length} entities, limit ${MAX_AFFECTED} (source: ${req.actor.label})`);
    return {
      status: 413,
      body: {
        error: `"${tag}" is on ${docs.length} entities; one tag operation may change at most ${MAX_AFFECTED}.`,
        affected: docs.length,
        limit: MAX_AFFECTED,
      },
    };
  }

  log('verbose', `${action} "${tag}" will touch: ${docs.map(d => `${d._id} "${d.title}"`).join(', ')}`);
  return { docs };
}

/**
 * Writes one ChangeLog entry (and one `entity:updated` broadcast) per entity,
 * pairing each before-state with the state it is now in. Awaited rather than
 * fired and forgotten, so the response is only sent once the trail exists —
 * which is what `MAX_AFFECTED` bounds the cost of.
 */
async function logEach(req, before, action, tag) {
  const after = await Entity.find({ _id: { $in: before.map(d => d._id) } }).lean();
  const afterById = new Map(after.map(d => [String(d._id), d]));
  const clientId = req.headers['x-sse-client-id'] ?? null;

  let logged = 0;
  for (const doc of before) {
    const now = afterById.get(String(doc._id));
    if (!now) continue;   // deleted between the write and here; nothing to log
    try {
      await logUpdate(doc, now, req.actor, clientId);
      logged++;
    } catch (err) {
      // A missing history entry must not fail a write that already landed.
      log('normal', `changelog failed for entity ${doc._id} (source: ${action} "${tag}"): ${err.message}`);
    }
  }
  log('normal', `${logged}/${before.length} changelog entries written (source: ${action} "${tag}")`);
  return logged;
}

// GET /tags — all unique tags across entries
router.get('/', async (req, res) => {
  try {
    const tags = await Entity.distinct('tags', { workspaceId: req.workspaceId });
    res.json(tags.sort());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /tags/:tag — rename a tag everywhere in the workspace, merging into an
// existing one. Body: { to }.
router.put('/:tag', requireActor, async (req, res) => {
  try {
    const from = req.params.tag;
    const raw = req.body?.to;

    if (typeof raw !== 'string' || !raw.trim()) {
      log('light', `rename "${from}" refused 400 — \`to\` was ${typeof raw === 'string' ? 'blank' : typeof raw} (source: ${req.actor.label})`);
      return res.status(400).json({ error: '`to` must be a non-empty string' });
    }
    const to = raw.trim();

    // A rename to itself changes nothing, so it is a no-op rather than a
    // changelog entry per entity — and it must not reach the $pull below,
    // which with from === to would strip the tag it just added.
    if (to === from) {
      log('light', `rename "${from}" → itself is a no-op (source: ${req.actor.label})`);
      return res.json({ renamed: 0, from, to });
    }

    const { docs, status, body } = await affectedBy(req, from, 'rename');
    if (!docs) return res.status(status).json(body);

    const ids = docs.map(d => d._id);
    const scope = { _id: { $in: ids }, workspaceId: req.workspaceId };
    // Add before removing: an entity already carrying `to` is unchanged by the
    // first write and loses only `from` in the second, so it keeps one copy.
    await Entity.updateMany(scope, { $addToSet: { tags: to } });
    await Entity.updateMany(scope, { $pull: { tags: from } });

    await logEach(req, docs, 'rename', from);

    log('light', `renamed "${from}" → "${to}" on ${docs.length} ${docs.length === 1 ? 'entity' : 'entities'} in workspace ${req.workspaceId} (source: ${req.actor.label})`);
    res.json({ renamed: docs.length, from, to });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /tags/:tag — remove a tag from every entity in the workspace.
router.delete('/:tag', requireActor, async (req, res) => {
  try {
    const tag = req.params.tag;

    const { docs, status, body } = await affectedBy(req, tag, 'remove');
    if (!docs) return res.status(status).json(body);

    await Entity.updateMany(
      { _id: { $in: docs.map(d => d._id) }, workspaceId: req.workspaceId },
      { $pull: { tags: tag } },
    );

    await logEach(req, docs, 'remove', tag);

    log('light', `removed "${tag}" from ${docs.length} ${docs.length === 1 ? 'entity' : 'entities'} in workspace ${req.workspaceId} (source: ${req.actor.label})`);
    res.json({ removed: docs.length, tag });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
