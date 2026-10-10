/**
 * Change history, rollback, and putting a deleted entity back.
 *
 * ─── Snapshots hold the category name as it was spelled then ────────────────
 *
 * `Entity.category` names an entity type by name, and renaming a type cascades
 * to everything that used it (routes/entityTypes.js) but writes no `ChangeLog`:
 * every snapshot taken before the rename still holds the old name, and the
 * registry no longer has it. That is deliberate — a snapshot is the audit
 * trail, and rewriting history so a restore succeeds is the wrong trade (see
 * the KOL-059 Decision Log entry) — so the restore is what has to cope.
 *
 * It does so by asking rather than failing. `POST .../rollback/:logId` checks
 * the snapshot's category against the registry before the write: a name that is
 * gone is a **409** naming it and the workspace's current types, and the caller
 * restores that version by sending back `{ category: '<one of them>' }`, which
 * is the only field of a snapshot a rollback will override. Before this the
 * validator refused the write and the catch turned it into a 500 — a permanent,
 * unfixable failure reported as a server fault, with no way to get the version
 * back at all.
 *
 * `GET .../history` marks the same condition ahead of the click:
 * `snapshotCategoryMissing: true` on each entry whose snapshot names a type the
 * workspace no longer has, from ONE registry read for the whole page.
 *
 * ─── A delete is recoverable for as long as its snapshot lives (KOL-060) ────
 *
 * `logDelete` (lib/changeLogger.js) keeps the whole document in the `deleted`
 * entry's snapshot for the `ChangeLog` TTL's 30 days, and the delete broadcast
 * carries it so another open tab can open a read-only `[DELETED]` panel. But
 * the rollback read the live entity first and answered 404 when it was gone, so
 * that snapshot could be looked at and never put back — and once the toast was
 * dismissed nothing in the client could reach it at all.
 *
 * So a `deleted` entry whose entity is gone **recreates** it: the snapshot's
 * fields at the original `_id`, under `req.workspaceId` — never the snapshot's
 * own `workspaceId`, which is null for one taken before tenancy — with a
 * `created` entry attributed to the caller and an `entity:created` broadcast.
 * **409** when that id is live again, so a restore never silently overwrites
 * one. A stale snapshot category is refused exactly as above, and the same
 * `{ category }` resolves it.
 *
 * `relationships` comes back empty. The delete pruned the groups this entity
 * was in (routes/entities.js), so the ids the snapshot holds name groups that
 * are gone or that no longer list it; re-deriving those edges is drift
 * detection, not a restore, and the UI says so.
 *
 * `GET /deleted` is the way back in that outlives the toast: this workspace's
 * `deleted` entries, newest first, skipping ids that are live again — what the
 * "Recently deleted" group in Settings lists.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * CHANGELOG_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — every rollback refused for a stale snapshot category, every one
 *             that restored under a category the caller chose, and every
 *             deleted entity recreated or refused — each naming where the
 *             decision came from
 *   normal  — light, plus each rollback that needed no choice, each history page
 *             that flagged an entry, and each GET /deleted
 *   verbose — normal, plus every history page read
 */

import { Router } from 'express';
import ChangeLog from '../models/ChangeLog.js';
import Entity from '../models/Entity.js';
import { requireActor } from '../middleware/auth.js';
import { logCreate, logUpdate } from '../lib/changeLogger.js';
import { openQuestionsIn } from '../lib/scopedPopulate.js';
import { registeredCategories } from '../lib/entityTypeRegistry.js';
import { objectIdParam } from '../middleware/objectId.js';

const router = Router({ mergeParams: true });

// A malformed id is 400 INVALID_ID, not a CastError the catch turns into a 500.
// Registered here rather than per handler so a later route inherits it.
router.param('id', objectIdParam('id'));
router.param('logId', objectIdParam('logId'));

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so a test can change it.
  const active = LEVELS[process.env.CHANGELOG_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[changelog:${level}] ${msg}`);
}

/** How many deleted entities `GET /deleted` offers at once. */
const DELETED_LIMIT = 50;

// GET /entities/:id/history — list change log for an entity, newest first
router.get('/entities/:id/history', async (req, res) => {
  try {
    const logs = await ChangeLog.find({
      entityId: req.params.id,
      workspaceId: req.workspaceId,
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    // One read for the page, not one per entry: a 50-entry history would
    // otherwise be 50 identical registry queries.
    const available = await registeredCategories(req.workspaceId, `GET /entities/${req.params.id}/history`);
    let flagged = 0;
    for (const entry of logs) {
      // Only an entry that HAS a snapshot can be restored, so only one of
      // those can be blocked by a stale name. A 'created' entry has none.
      const category = entry.snapshot?.category;
      if (category && !available.includes(category)) {
        entry.snapshotCategoryMissing = true;
        flagged++;
      }
    }

    log(flagged ? 'normal' : 'verbose', `GET /entities/${req.params.id}/history → ${logs.length} entr${logs.length === 1 ? 'y' : 'ies'}, ${flagged} with a snapshot category the workspace no longer has (source: registry read for workspace ${req.workspaceId})`);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /deleted — the deleted entities this workspace can still put back
router.get('/deleted', async (req, res) => {
  try {
    const entries = await ChangeLog.find({
      workspaceId: req.workspaceId,
      changeType: 'deleted',
      snapshot: { $ne: null },
    })
      .sort({ createdAt: -1 })
      .limit(DELETED_LIMIT)
      // The snapshot is a whole entity, blocks and all; only its category is
      // read here, and projecting keeps a page of 50 from carrying 50 of them.
      .select('entityId entityTitle actorLabel actorType createdAt snapshot.category')
      .lean();

    // One query for the page: an id that is live again cannot be restored
    // (the rollback answers 409 rather than overwrite it), so it is not offered.
    const live = new Set(
      (await Entity.find({
        _id: { $in: entries.map(e => e.entityId) },
        workspaceId: req.workspaceId,
      }).select('_id').lean()).map(e => String(e._id))
    );

    // One registry read for the page, as the history route does.
    const available = await registeredCategories(req.workspaceId, 'GET /deleted');

    const seen = new Set();
    const deleted = [];
    for (const entry of entries) {
      const entityId = String(entry.entityId);
      if (live.has(entityId)) continue;
      // Deleted, restored and deleted again: every entry restores to the same
      // `_id`, so only the newest can succeed and only it is listed.
      if (seen.has(entityId)) continue;
      seen.add(entityId);

      const category = entry.snapshot?.category ?? null;
      deleted.push({
        _id: String(entry._id),
        entityId,
        entityTitle: entry.entityTitle,
        actorLabel: entry.actorLabel,
        actorType: entry.actorType,
        createdAt: entry.createdAt,
        category,
        // As on a history entry: the type it was saved under is gone, so the
        // restore needs a category chosen before the click, not a 409 after it.
        ...(category && !available.includes(category) ? { snapshotCategoryMissing: true } : {}),
      });
    }

    log('normal', `GET /deleted → ${deleted.length} restorable of ${entries.length} deleted entr${entries.length === 1 ? 'y' : 'ies'} in workspace ${req.workspaceId} (source: ${live.size} id(s) live again, ${deleted.filter(d => d.snapshotCategoryMissing).length} with a snapshot category the workspace no longer has)`);
    res.json(deleted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /entities/:id/rollback/:logId — restore entity from a snapshot
router.post('/entities/:id/rollback/:logId', requireActor, async (req, res) => {
  try {
    const entry = await ChangeLog.findOne({
      _id: req.params.logId,
      workspaceId: req.workspaceId,
    }).lean();
    if (!entry || String(entry.entityId) !== req.params.id) {
      return res.status(404).json({ error: 'Change log entry not found' });
    }
    if (!entry.snapshot) {
      return res.status(400).json({ error: 'No snapshot available for this log entry' });
    }

    const scope = { _id: req.params.id, workspaceId: req.workspaceId };
    const source = `POST /entities/${req.params.id}/rollback/${req.params.logId} by ${req.actor.label}`;

    const before = await Entity.findOne(scope).lean();
    // A 'deleted' entry is the one kind with nothing to update: its snapshot is
    // the whole document, and restoring it means writing that document back.
    const restoring = entry.changeType === 'deleted';

    if (restoring && before) {
      // Deleted, then an entity created at the same id again — restoring would
      // replace whatever is there now, so it is refused rather than silent.
      log('light', `refused restore: entity ${req.params.id} is live again as "${before.title}", so putting the deleted version back would overwrite it (source: ${source})`);
      return res.status(409).json({
        error: 'This entity exists again, so restoring the deleted version would overwrite it. Open it and roll it back from its own history instead.',
        entityId: req.params.id,
      });
    }
    if (!restoring && !before) {
      // An 'updated' entry's snapshot is one version of a live entity, not the
      // delete's record of the whole document. A deleted entity comes back
      // through its own 'deleted' entry — the one GET /deleted offers.
      return res.status(404).json({ error: 'Entity not found' });
    }

    // workspaceId is stripped along with the immutable fields: snapshots taken
    // before tenancy carry workspaceId null, and restoring that would orphan
    // the entity out of every workspace.
    const { _id, __v, createdAt, updatedAt, workspaceId, ...snapshotData } = entry.snapshot;

    const snapshotCategory = snapshotData.category;
    const chosen = req.body?.category;

    // `category` is the one field of a snapshot a rollback will override, and
    // only with a name the workspace has: the caller's decision about a type
    // that was renamed or deleted since the snapshot was taken. Everything
    // else restores exactly as recorded.
    if (chosen !== undefined) {
      if (typeof chosen !== 'string' || !chosen.trim()) {
        return res.status(400).json({ error: 'category must be a non-empty string' });
      }
      const available = await registeredCategories(req.workspaceId, source);
      if (!available.includes(chosen)) {
        log('light', `refused rollback: the caller chose "${chosen}", which is not an entity type in workspace ${req.workspaceId} (source: ${source}; snapshot holds "${snapshotCategory}")`);
        return res.status(400).json({
          error: `"${chosen}" is not an entity type in this workspace`,
          snapshotCategory,
          availableCategories: available,
        });
      }
      snapshotData.category = chosen;
      log('light', `restoring under "${chosen}" (source: request body; the snapshot holds "${snapshotCategory}") for ${source}`);
    } else if (snapshotCategory !== undefined) {
      const available = await registeredCategories(req.workspaceId, source);
      if (!available.includes(snapshotCategory)) {
        // Unfixable by retrying, so it is the caller's decision to make, not a
        // server fault: 409 names the stale type and what is there instead.
        log('light', `refused rollback: the snapshot holds "${snapshotCategory}", which workspace ${req.workspaceId} no longer has — renamed or deleted since (source: ${source}; resend with { category } to choose)`);
        return res.status(409).json({
          error: `This version was saved under "${snapshotCategory}", which is no longer an entity type in this workspace. Resend with { "category": "<one of availableCategories>" } to restore it under a type that exists.`,
          snapshotCategory,
          availableCategories: available,
        });
      }
      log('normal', `rollback needs no choice: "${snapshotCategory}" is still an entity type in workspace ${req.workspaceId} (source: ${source})`);
    }

    const clientId = req.headers['x-sse-client-id'] ?? null;

    if (restoring) {
      const restored = await Entity.create({
        ...snapshotData,
        // The original id, so every reference anything else still holds — an
        // open question's entry_ids, a bookmarked URL — resolves again.
        _id: entry.entityId,
        // The caller's workspace, never the snapshot's: see above.
        workspaceId: req.workspaceId,
        // The delete pruned the relationship groups this entity was in, so the
        // snapshot's ids name groups that are gone or that no longer list it.
        // An empty cache is honest; rebuilding the edges is a different job.
        relationships: [],
      });
      await restored.populate(openQuestionsIn(req.workspaceId));

      // Awaited, unlike the entity routes' fire-and-forget logging: this is
      // both the audit trail for the restore and the entity:created broadcast
      // that puts the entity back in every other open tab's list.
      await logCreate(restored.toObject(), req.actor, clientId);

      log('light', `restored entity ${req.params.id} "${restored.title}" into workspace ${req.workspaceId} from deleted entry ${req.params.logId} (source: ${source}; category "${restored.category}" from ${chosen !== undefined ? 'the request body' : 'the snapshot'}; relationships NOT rebuilt)`);
      return res.status(201).json(restored);
    }

    const after = await Entity.findOneAndUpdate(scope, snapshotData, {
      new: true,
      runValidators: true,
    }).populate(openQuestionsIn(req.workspaceId));

    if (!after) return res.status(404).json({ error: 'Entity not found' });

    logUpdate(before, after.toObject(), req.actor).catch(err =>
      console.error('[changelog] logUpdate (rollback) failed:', err)
    );

    res.json(after);
  } catch (err) {
    // The unique `_id` is the real guard behind the live-again check above: two
    // restores of the same entry racing each other land here.
    if (err?.code === 11000) {
      log('light', `refused restore: entity ${req.params.id} was created by something else between the check and the write (source: duplicate key on Entity._id)`);
      return res.status(409).json({
        error: 'This entity exists again, so restoring the deleted version would overwrite it. Open it and roll it back from its own history instead.',
        entityId: req.params.id,
      });
    }
    res.status(500).json({ error: err.message });
  }
});

export default router;
