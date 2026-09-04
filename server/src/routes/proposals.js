import { Router } from 'express';
import Proposal from '../models/Proposal.js';

const router = Router();

// A generation that was interrupted — a server restart mid-run, say — would
// otherwise leave a row spinning on 'generating' forever. Listing lazily ages
// those out, which costs no cron.
const STALE_GENERATING_MS = 10 * 60 * 1000;

async function expireStuckGenerations(workspaceId) {
  const cutoff = new Date(Date.now() - STALE_GENERATING_MS);
  await Proposal.updateMany(
    { workspaceId, status: 'generating', createdAt: { $lt: cutoff } },
    {
      $set: {
        status: 'failed',
        'diagnostics.error': 'Generation did not complete (interrupted or timed out).',
      },
    }
  );
}

// GET /proposals — newest first. Items are omitted; the list view only needs
// counts, and a proposal's items can be large.
router.get('/', async (req, res) => {
  try {
    await expireStuckGenerations(req.workspaceId);
    const proposals = await Proposal.find({
      workspaceId: req.workspaceId,
      status: { $ne: 'discarded' },
    })
      .select('-items -source.text -diagnostics.rawOutput -grounding.systemPrompt')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json(proposals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /proposals/:id — the full proposal including items and source text.
router.get('/:id', async (req, res) => {
  try {
    const proposal = await Proposal.findOne({
      _id: req.params.id,
      workspaceId: req.workspaceId,
    }).lean();
    // 404 rather than 403 for a foreign id, matching the entities routes: the
    // API should not confirm that an id exists in someone else's workspace.
    if (!proposal) return res.status(404).json({ error: 'Not found' });
    res.json(proposal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /proposals/:id — soft. The row is the training corpus; discarding is
// a UI concern, and a discarded proposal that was reviewed still carries a
// complete set of human labels.
router.delete('/:id', async (req, res) => {
  try {
    const proposal = await Proposal.findOneAndUpdate(
      { _id: req.params.id, workspaceId: req.workspaceId },
      { $set: { status: 'discarded' } },
      { new: true }
    ).select('_id status').lean();
    if (!proposal) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
