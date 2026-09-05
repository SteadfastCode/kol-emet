import { Router } from 'express';
import crypto from 'crypto';
import Draft from '../models/Draft.js';
import { generateDraft, MAX_CHARS } from '../lib/generator.js';
import { resolveUserId } from '../middleware/workspace.js';
import { getBudget, checkBudget, recordSpend, reserveGeneration, releaseGeneration } from '../lib/usageMeter.js';
import { FREE_PROVIDERS } from '../config/pricing.js';
import { isConfigured } from '../lib/aiProviders.js';
import { validateItemPayload } from '../lib/draftItemSchema.js';
import Entity from '../models/Entity.js';

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
  await Draft.updateMany(
    { workspaceId, status: 'generating', createdAt: { $lt: cutoff } },
    {
      $set: {
        status: 'failed',
        'diagnostics.error': 'Generation did not complete (interrupted or timed out).',
      },
    }
  );
}

// GET /drafts — newest first. Items are omitted; the list view only needs
// counts, and a draft's items can be large.
router.get('/', async (req, res) => {
  try {
    await expireStuckGenerations(req.workspaceId);
    const drafts = await Draft.find({
      workspaceId: req.workspaceId,
      status: { $ne: 'discarded' },
    })
      .select('-items -source.text -diagnostics.rawOutput -grounding.systemPrompt')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json(drafts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /drafts/quota — remaining AI allowance for this workspace.
router.get('/quota', async (req, res) => {
  try {
    res.json(await getBudget(req.workspaceId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /drafts — generate a draft, streaming progress over SSE.
 *
 * The Draft row is persisted with status 'generating' BEFORE the first
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

  // Escape hatch for a provider that genuinely costs nothing. FREE_PROVIDERS is
  // empty today — self-hosted moved to its own (cheap) rate once electricity
  // was accounted for — so this is currently always false. Kept as the hook a
  // sponsored or post-trial free tier would use.
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

  let draft;
  try {
    draft = await Draft.create({
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

  send({ type: 'created', draftId: String(draft._id) });

  try {
    const result = await generateDraft({
      text: source,
      workspaceId: req.workspaceId,
      provider,
      roleStyle,
      onStage: (stage) => send({ type: 'stage', ...stage }),
    });

    draft.items = result.items;
    draft.route = result.route;
    draft.grounding = result.grounding;
    draft.diagnostics = {
      ...result.diagnostics,
      dropReasons: result.diagnostics.dropReasons ?? [],
    };
    draft.counts = {
      ...draft.counts,
      dropped: result.diagnostics.dropReasons?.length ?? 0,
    };
    draft.status = 'ready';
    draft.recountItems();
    await draft.save();

    await recordSpend(req.workspaceId, {
      provider: result.route.provider,
      model: result.route.model,
      promptTokens: result.diagnostics.usage?.promptTokens ?? 0,
      completionTokens: result.diagnostics.usage?.completionTokens ?? 0,
      reason: `draft ${draft._id}`,
    });

    send({
      type: 'done',
      draftId: String(draft._id),
      counts: draft.counts,
      route: draft.route,
      budget: await getBudget(req.workspaceId),
    });
  } catch (err) {
    console.error('[drafts] generation failed:', err.message);
    draft.status = 'failed';
    draft.diagnostics = { ...(draft.diagnostics ?? {}), error: err.message };
    // A failed save here would strand the row on 'generating'; the lazy sweep
    // in GET / is the backstop for exactly that.
    await draft.save().catch(e => console.error('[drafts] could not record failure:', e.message));

    // Charge for whatever completed before the failure. Those tokens were paid
    // for regardless, and a run that dies on its last call is the expensive case.
    if (err.spend?.usage?.calls > 0) {
      await recordSpend(req.workspaceId, {
        provider: err.spend.provider,
        model: err.spend.model,
        promptTokens: err.spend.usage.promptTokens,
        completionTokens: err.spend.usage.completionTokens,
        reason: `failed draft ${draft._id}`,
      }).catch(e => console.error('[drafts] could not charge failed run:', e.message));
    }

    send({ type: 'error', message: err.message, draftId: String(draft._id) });
  } finally {
    await releaseGeneration(req.workspaceId);
    if (open) res.end();
  }
});

// ─── Decision routes ─────────────────────────────────────────────────────────
//
// These record the HUMAN LABEL and write nothing to the graph. Applying is a
// separate, explicit step. The split is deliberate: a person reviewing 30 items
// and then abandoning the draft has still produced 30 labelled examples, and
// those are the point of the corpus.

// Written only by the applier. Accepting them from a request body would let a
// client forge the record of what happened to a change.
const SYSTEM_KEYS = ['applyState', 'resultId', 'changeLogId', 'applyError', 'appliedAt'];

/**
 * PATCH /drafts/:id/items/:itemId — accept, edit or reject one item.
 *
 * Guarded on applyState 'pending' in the query itself rather than checked
 * first: a decision must not be able to change out from under an item that is
 * already being applied.
 */
router.patch('/:id/items/:itemId', async (req, res) => {
  try {
    const { decision, payload, note } = req.body ?? {};

    if (!['accepted', 'edited', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: "decision must be 'accepted', 'edited' or 'rejected'" });
    }
    const forged = SYSTEM_KEYS.filter(k => k in (req.body ?? {}));
    if (forged.length) {
      return res.status(400).json({ error: `These are set by the applier, not the client: ${forged.join(', ')}` });
    }

    const draft = await Draft.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
    if (!draft) return res.status(404).json({ error: 'Not found' });

    const item = draft.items.id(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.applyState !== 'pending') {
      return res.status(409).json({
        error: `This item was already applied (${item.applyState}) and cannot be re-decided.`,
      });
    }

    let accepted = null;
    if (decision === 'accepted') {
      // Copied verbatim rather than left null so the exporter stays a
      // single-pass map, and stays correct even if the normalizer changes.
      accepted = JSON.parse(JSON.stringify(item.proposed));
    } else if (decision === 'edited') {
      if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'An edited item requires a payload' });
      }
      const check = validateItemPayload(item.kind, payload, req.workspaceId);
      if (!check.ok) return res.status(400).json({ error: check.error });
      accepted = check.value;
    }

    item.decision = decision;
    item.decisionVia = 'individual';
    item.decisionNote = typeof note === 'string' ? note : null;
    item.decidedBy = await resolveUserId(req);
    item.decidedAt = new Date();
    item.accepted = accepted;   // null for a rejection — the row itself survives

    draft.recountItems();
    await draft.save();

    res.json({ item: draft.items.id(req.params.itemId), counts: draft.counts });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /drafts/:id/items/:itemId/retarget — point a create at an existing
 * entity instead, turning it into an update.
 *
 * This is the manual resolution of a `duplicate_candidate`: fuzzy matches are
 * flagged and never merged automatically, so a person decides.
 */
router.post('/:id/items/:itemId/retarget', async (req, res) => {
  try {
    const { targetEntityId } = req.body ?? {};

    const draft = await Draft.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
    if (!draft) return res.status(404).json({ error: 'Not found' });

    const item = draft.items.id(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.kind !== 'entity') return res.status(400).json({ error: 'Only entity items can be retargeted' });
    if (item.applyState !== 'pending') {
      return res.status(409).json({ error: `Already applied (${item.applyState}).` });
    }

    if (targetEntityId === null) {
      item.op = 'create';
      item.targetEntityId = null;
      item.baseUpdatedAt = null;
      item.matchedBy = 'none';
    } else {
      // Scoped: an id from another workspace must not become a merge target.
      const target = await Entity.findOne({ _id: targetEntityId, workspaceId: req.workspaceId })
        .select('_id updatedAt').lean();
      if (!target) return res.status(404).json({ error: 'Target entity not found' });

      item.op = 'update';
      item.targetEntityId = target._id;
      item.baseUpdatedAt = target.updatedAt;   // staleness baseline for the applier
      item.matchedBy = 'manual';
    }

    // The duplicate flag has been resolved either way; the candidate reference
    // stays for the record.
    item.flags = item.flags.filter(f => f !== 'duplicate_candidate');
    await draft.save();

    res.json({ item: draft.items.id(req.params.itemId) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /drafts/:id/decide-clean — accept every unflagged pending item.
 *
 * Deliberately refuses flagged items and reports how many it skipped. A bulk
 * action that swept up duplicates, coerced categories and dropped members would
 * be a rubber stamp, which is exactly what the human-approval requirement
 * exists to prevent.
 */
router.post('/:id/decide-clean', async (req, res) => {
  try {
    const draft = await Draft.findOne({ _id: req.params.id, workspaceId: req.workspaceId });
    if (!draft) return res.status(404).json({ error: 'Not found' });

    const decidedBy = await resolveUserId(req);
    const now = new Date();
    let accepted = 0, skippedFlagged = 0, skippedApplied = 0;

    for (const item of draft.items) {
      if (item.decision !== 'pending') continue;
      if (item.applyState !== 'pending') { skippedApplied++; continue; }
      if (item.flags?.length) { skippedFlagged++; continue; }

      item.decision = 'accepted';
      item.decisionVia = 'bulk';
      item.decidedBy = decidedBy;
      item.decidedAt = now;
      item.accepted = JSON.parse(JSON.stringify(item.proposed));
      accepted++;
    }

    draft.recountItems();
    await draft.save();

    res.json({
      accepted,
      skippedFlagged,
      skippedApplied,
      counts: draft.counts,
      message: skippedFlagged
        ? `Accepted ${accepted}. ${skippedFlagged} item(s) need a look — they were flagged.`
        : `Accepted ${accepted}.`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /drafts/:id — the full draft including items and source text.
router.get('/:id', async (req, res) => {
  try {
    const draft = await Draft.findOne({
      _id: req.params.id,
      workspaceId: req.workspaceId,
    }).lean();
    // 404 rather than 403 for a foreign id, matching the entities routes: the
    // API should not confirm that an id exists in someone else's workspace.
    if (!draft) return res.status(404).json({ error: 'Not found' });
    res.json(draft);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /drafts/:id — soft. The row is the training corpus; discarding is
// a UI concern, and a discarded draft that was reviewed still carries a
// complete set of human labels.
router.delete('/:id', async (req, res) => {
  try {
    const draft = await Draft.findOneAndUpdate(
      { _id: req.params.id, workspaceId: req.workspaceId },
      { $set: { status: 'discarded' } },
      { new: true }
    ).select('_id status').lean();
    if (!draft) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
