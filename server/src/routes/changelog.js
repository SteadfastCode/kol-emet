import { Router } from 'express';
import ChangeLog from '../models/ChangeLog.js';
import Entity from '../models/Entity.js';
import { requireActor } from '../middleware/auth.js';
import { logUpdate } from '../lib/changeLogger.js';

const router = Router({ mergeParams: true });

// GET /entities/:id/history — list change log for an entity, newest first
router.get('/entities/:id/history', async (req, res) => {
  try {
    const logs = await ChangeLog.find({ entityId: req.params.id })
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
    const log = await ChangeLog.findById(req.params.logId).lean();
    if (!log || String(log.entityId) !== req.params.id) {
      return res.status(404).json({ error: 'Change log entry not found' });
    }
    if (!log.snapshot) {
      return res.status(400).json({ error: 'No snapshot available for this log entry' });
    }

    const before = await Entity.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ error: 'Entity not found' });

    const { _id, __v, createdAt, updatedAt, ...snapshotData } = log.snapshot;
    const after = await Entity.findByIdAndUpdate(req.params.id, snapshotData, {
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
