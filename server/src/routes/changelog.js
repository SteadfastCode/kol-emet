import { Router } from 'express';
import ChangeLog from '../models/ChangeLog.js';
import Entry from '../models/Entry.js';
import { requireActor } from '../middleware/auth.js';
import { logUpdate } from '../lib/changeLogger.js';

const router = Router({ mergeParams: true });

// GET /entries/:id/history — list change log for an entry, newest first
router.get('/entries/:id/history', async (req, res) => {
  try {
    const logs = await ChangeLog.find({ entryId: req.params.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /entries/:id/rollback/:logId — restore entry from a snapshot
router.post('/entries/:id/rollback/:logId', requireActor, async (req, res) => {
  try {
    const log = await ChangeLog.findById(req.params.logId).lean();
    if (!log || String(log.entryId) !== req.params.id) {
      return res.status(404).json({ error: 'Change log entry not found' });
    }
    if (!log.snapshot) {
      return res.status(400).json({ error: 'No snapshot available for this log entry' });
    }

    const before = await Entry.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ error: 'Entry not found' });

    const { _id, __v, createdAt, updatedAt, ...snapshotData } = log.snapshot;
    const after = await Entry.findByIdAndUpdate(req.params.id, snapshotData, {
      new: true,
      runValidators: true,
    }).populate('open_questions', 'question status');

    if (!after) return res.status(404).json({ error: 'Entry not found' });

    logUpdate(before, after.toObject(), req.actor).catch(err =>
      console.error('[changelog] logUpdate (rollback) failed:', err)
    );

    res.json(after);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
