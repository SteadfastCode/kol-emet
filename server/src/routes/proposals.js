import { Router } from 'express';
import crypto from 'crypto';
import Proposal from '../models/Proposal.js';
import { generateProposal, MAX_CHARS } from '../lib/generator.js';
import { resolveUserId } from '../middleware/workspace.js';
import { getBudget, checkBudget, recordSpend, reserveGeneration, releaseGeneration } from '../lib/usageMeter.js';
import { FREE_PROVIDERS } from '../config/pricing.js';
import { isConfigured } from '../lib/aiProviders.js';

const router = Router();

/**
 * Minimum budget required to START a run, in micro-dollars.
 *
 * A floor, not a prediction. Measured runs land between $0.011 and ~$0.15, so
 * a workspace with a tenth of a cent left should not be allowed to begin one
 * it certainly cannot pay for.
 */
const MIN_RUN_MICROS = Number(process.env.GENERATOR_MIN_RUN_MICROS ?? 15_000); // $0.015

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

// GET /proposals/quota — remaining AI allowance for this workspace.
router.get('/quota', async (req, res) => {
  try {
    res.json(await getBudget(req.workspaceId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /proposals — generate a proposal, streaming progress over SSE.
 *
 * The Proposal row is persisted with status 'generating' BEFORE the first
 * model call, so a run is never invisible: if the connection drops or the
 * process restarts, the row is already there to be found and (by the lazy
 * sweep in GET /) eventually marked failed.
 *
 * Generation deliberately continues after a client disconnect. The provider
 * has already been paid for the tokens by then, so abandoning the work would
 * bill the user for nothing.
 */
router.post('/', async (req, res) => {
  const { text, provider, roleStyle } = req.body ?? {};

  // Validate before opening the stream, so failures are ordinary JSON errors
  // rather than an SSE frame the client has to special-case.
  const source = String(text ?? '').trim();
  if (!source) return res.status(400).json({ error: 'text is required' });
  if (source.length > MAX_CHARS) {
    return res.status(400).json({
      error: `Input is ${source.length.toLocaleString()} characters; the limit is ${MAX_CHARS.toLocaleString()}.`,
    });
  }

  // A run explicitly routed to a self-hosted model costs nothing, so the
  // allowance — which exists solely to bound real spend — must not gate it.
  // This is also the shape of a useful fallback: when the trial runs out,
  // generation can continue on the slower free model rather than stopping dead.
  const isFree = FREE_PROVIDERS.has(provider) && isConfigured(provider);

  const budget = await checkBudget(req.workspaceId, MIN_RUN_MICROS);
  if (!isFree && !budget.allowed) {
    return res.status(402).json({
      error: budget.exhausted
        ? `Your AI allowance is used up (${budget.granted} total).`
        : `Not enough AI allowance left to start a run (${budget.remaining} remaining).`,
      ...budget,
    });
  }

  // One generation at a time per workspace. Cost is only known after a run
  // finishes, so without this N simultaneous requests all pass the same budget
  // check and spend N times the allowance.
  if (!(await reserveGeneration(req.workspaceId))) {
    return res.status(409).json({ error: 'A generation is already running for this workspace.' });
  }

  const userId = await resolveUserId(req);

  let proposal;
  try {
    proposal = await Proposal.create({
      workspaceId: req.workspaceId,
      createdBy: userId,
      title: source.slice(0, 60).replace(/\s+/g, ' ').trim(),
      status: 'generating',
      source: {
        producer: 'braindump',
        text: source,
        textHash: `sha256:${crypto.createHash('sha256').update(source).digest('hex')}`,
      },
    });
  } catch (err) {
    // The lock is already held at this point; releasing it here stops a failed
    // create from locking the workspace out until the 10-minute staleness sweep.
    await releaseGeneration(req.workspaceId);
    return res.status(500).json({ error: `Could not start generation: ${err.message}` });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let open = true;
  req.on('close', () => { open = false; });
  const send = (obj) => { if (open) { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { open = false; } } };

  send({ type: 'created', proposalId: String(proposal._id) });

  try {
    const result = await generateProposal({
      text: source,
      workspaceId: req.workspaceId,
      provider,
      roleStyle,
      onStage: (stage) => send({ type: 'stage', ...stage }),
    });

    proposal.items = result.items;
    proposal.route = result.route;
    proposal.grounding = result.grounding;
    proposal.diagnostics = {
      ...result.diagnostics,
      dropReasons: result.diagnostics.dropReasons ?? [],
    };
    proposal.counts = {
      ...proposal.counts,
      dropped: result.diagnostics.dropReasons?.length ?? 0,
    };
    proposal.status = 'ready';
    proposal.recountItems();
    await proposal.save();

    await recordSpend(req.workspaceId, {
      provider: result.route.provider,
      model: result.route.model,
      promptTokens: result.diagnostics.usage?.promptTokens ?? 0,
      completionTokens: result.diagnostics.usage?.completionTokens ?? 0,
      reason: `proposal ${proposal._id}`,
    });

    send({
      type: 'done',
      proposalId: String(proposal._id),
      counts: proposal.counts,
      route: proposal.route,
      budget: await getBudget(req.workspaceId),
    });
  } catch (err) {
    console.error('[proposals] generation failed:', err.message);
    proposal.status = 'failed';
    proposal.diagnostics = { ...(proposal.diagnostics ?? {}), error: err.message };
    // A failed save here would strand the row on 'generating'; the lazy sweep
    // in GET / is the backstop for exactly that.
    await proposal.save().catch(e => console.error('[proposals] could not record failure:', e.message));

    // Charge for whatever completed before the failure. Those tokens were paid
    // for regardless, and a run that dies on its last call is the expensive case.
    if (err.spend?.usage?.calls > 0) {
      await recordSpend(req.workspaceId, {
        provider: err.spend.provider,
        model: err.spend.model,
        promptTokens: err.spend.usage.promptTokens,
        completionTokens: err.spend.usage.completionTokens,
        reason: `failed proposal ${proposal._id}`,
      }).catch(e => console.error('[proposals] could not charge failed run:', e.message));
    }

    send({ type: 'error', message: err.message, proposalId: String(proposal._id) });
  } finally {
    await releaseGeneration(req.workspaceId);
    if (open) res.end();
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
