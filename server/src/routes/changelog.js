/**
 * Change history and rollback for an entity.
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
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * CHANGELOG_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — every rollback refused for a stale snapshot category, and every
 *             one that restored under a category the caller chose, naming where
 *             the category came from
 *   normal  — light, plus each rollback that needed no choice, and each history
 *             page that flagged an entry
 *   verbose — normal, plus every history page read
 */

import { Router } from 'express';
import ChangeLog from '../models/ChangeLog.js';
import Entity from '../models/Entity.js';
import { requireActor } from '../middleware/auth.js';
import { logUpdate } from '../lib/changeLogger.js';
import { openQuestionsIn } from '../lib/scopedPopulate.js';
import { registeredCategories } from '../lib/entityTypeRegistry.js';

const router = Router({ mergeParams: true });

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so a test can change it.
  const active = LEVELS[process.env.CHANGELOG_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[changelog:${level}] ${msg}`);
}

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

    const before = await Entity.findOne(scope).lean();
    if (!before) return res.status(404).json({ error: 'Entity not found' });

    // workspaceId is stripped along with the immutable fields: snapshots taken
    // before tenancy carry workspaceId null, and restoring that would orphan
    // the entity out of every workspace.
    const { _id, __v, createdAt, updatedAt, workspaceId, ...snapshotData } = entry.snapshot;

    const source = `POST /entities/${req.params.id}/rollback/${req.params.logId} by ${req.actor.label}`;
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
    res.status(500).json({ error: err.message });
  }
});

export default router;
