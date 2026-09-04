import { Router } from 'express';
import ChangeLog from '../models/ChangeLog.js';
import Entity from '../models/Entity.js';
import { requireActor } from '../middleware/auth.js';
import { logUpdate } from '../lib/changeLogger.js';

const router = Router({ mergeParams: true });

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
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /entities/:id/rollback/:logId — restore entity from a snapshot
router.post('/entities/:id/rollback/:logId', requireActor, async (req, res) => {
  try {
    const log = await ChangeLog.findOne({
      _id: req.params.logId,
      workspaceId: req.workspaceId,
    }).lean();
    if (!log || String(log.entityId) !== req.params.id) {
      return res.status(404).json({ error: 'Change log entry not found' });
    }
    if (!log.snapshot) {
      return res.status(400).json({ error: 'No snapshot available for this log entry' });
    }

    const scope = { _id: req.params.id, workspaceId: req.workspaceId };

    const before = await Entity.findOne(scope).lean();
    if (!before) return res.status(404).json({ error: 'Entity not found' });

    // workspaceId is stripped along with the immutable fields: snapshots taken
    // before tenancy carry workspaceId null, and restoring that would orphan
    // the entity out of every workspace.
    const { _id, __v, createdAt, updatedAt, workspaceId, ...snapshotData } = log.snapshot;
    const after = await Entity.findOneAndUpdate(scope, snapshotData, {
      new: true,
      runValidators: true,
    }).populate('open_questions', 'question status');

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
