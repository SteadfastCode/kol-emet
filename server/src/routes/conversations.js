/**
 * Saved AI chats: the asker's own rows, inside one workspace.
 *
 * A conversation belongs to a user *and* to the workspace it was held in
 * (KOL-091). Until that item every query here filtered on `userId` alone, even
 * though the router is mounted behind `resolveWorkspace` and `POST /chat`
 * answers out of `req.workspaceId` — so a chat about one wiki was listed,
 * readable and continuable from another, its graph tools reading the wrong
 * workspace and its spend billed there. Nothing showed while every user had one
 * workspace; KOL-090's switcher is what made two of them ordinary.
 *
 * Every lookup below therefore goes through `personalScope` (lib/personalScope.js),
 * which returns both halves of the filter in one call — the forgotten half was
 * the bug — and which reads a pre-KOL-091 `workspaceId: null` as the caller's
 * current workspace, so nobody loses their history.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * CONVERSATION_LOG_LEVEL = off | light | normal | verbose (default light)
 * The visible change this item makes is a 404 where there used to be a 200, and
 * afterwards a 404 says nothing about *why* — a chat missing from the sidebar
 * after a workspace switch looks identical to one that was deleted. So the light
 * tier names the source of every miss: whether the row exists at all, and which
 * workspace it is in versus the one the request acted in. Ids and counts only,
 * never message content — these logs outlive the chat.
 *   off     — nothing, and no extra query on a miss
 *   light   — every by-id miss, saying whether the row exists elsewhere and in
 *             which workspace, and every legacy (`workspaceId: null`) row read
 *             as the current workspace's
 *   normal  — light, plus one line per list and per resolved lookup
 *   verbose — normal, plus the filter each query ran with
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import Conversation from '../models/Conversation.js';
import { PROVIDERS, makeClient } from '../lib/aiProviders.js';
import { personalScope } from '../lib/personalScope.js';
import { objectIdParam } from '../middleware/objectId.js';

const router = Router();

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

/** Resolved per call, not at module load, so it can't depend on import order. */
function active() {
  return LEVELS[process.env.CONVERSATION_LOG_LEVEL] ?? LEVELS.light;
}

function log(level, msg) {
  if (active() >= LEVELS[level]) console.log(`[conversations:${level}] ${msg}`);
}

// A malformed id is 400 INVALID_ID, not a CastError the catch turns into a 500.
// Registered here rather than per handler so a later route inherits it.
router.param('id', objectIdParam('id'));

// All routes require a session user (not bearer-token / MCP).
function sessionUserId(req, res) {
  const id = req.session?.userId;
  if (!id) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return id;
}

/**
 * The filter every by-id route here runs, logged.
 *
 * One helper rather than five call sites, so a route added later inherits the
 * workspace half of the filter instead of having to remember it.
 */
function scopeById(req, userId) {
  const filter = { _id: req.params.id, ...personalScope(userId, req.workspaceId) };
  log('verbose', `${req.method} ${req.originalUrl} filter: ${JSON.stringify(filter)}`);
  return filter;
}

/**
 * Reports what a by-id lookup found, and — on a miss — where the row actually
 * is, which is the one thing a 404 cannot say for itself.
 *
 * The extra query runs only when it will be logged, so `off` costs nothing and
 * every other tier pays for it on a miss only.
 *
 * @param {object} req
 * @param {object|null} conv the document the route found, or null
 */
async function logLookup(req, userId, conv) {
  if (conv) {
    if (conv.workspaceId == null) {
      log('light', `${req.method} ${req.originalUrl} resolved conversation ${conv._id}, which carries no workspace (written before KOL-091) and is read as the caller's current workspace ${req.workspaceId} (source: lib/personalScope.js)`);
    } else {
      log('normal', `${req.method} ${req.originalUrl} resolved conversation ${conv._id} in workspace ${conv.workspaceId}`);
    }
    return;
  }
  if (active() < LEVELS.light) return;

  // Deliberately unscoped, and deliberately only reaching the ids: this is the
  // diagnostic for a 404, and nothing it reads leaves the process.
  const row = await Conversation.findById(req.params.id).select('_id userId workspaceId').lean().catch(() => null);
  if (!row) {
    log('light', `${req.method} ${req.originalUrl} → 404: no conversation ${req.params.id} exists at all (source: deleted, or never created)`);
  } else if (String(row.userId) !== String(userId)) {
    log('light', `${req.method} ${req.originalUrl} → 404: conversation ${req.params.id} belongs to another user (source: userId half of the scope)`);
  } else {
    log('light', `${req.method} ${req.originalUrl} → 404: conversation ${req.params.id} is the caller's own but lives in workspace ${row.workspaceId}, and the request acted in ${req.workspaceId} (source: workspaceId half of the scope — a chat is reachable only from the workspace it was created in)`);
  }
}

// ─── GET /conversations ───────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res, next) => {
  const userId = sessionUserId(req, res);
  if (!userId) return;
  try {
    const filter = personalScope(userId, req.workspaceId);
    log('verbose', `GET /conversations filter: ${JSON.stringify(filter)}`);
    const list = await Conversation.find(filter)
      .sort({ updatedAt: -1 })
      .select('_id title autoTitle provider model workspaceId createdAt updatedAt')
      .lean();
    const legacy = list.filter(c => c.workspaceId == null).length;
    log('normal', `GET /conversations listed ${list.length} chat(s) for user ${userId} in workspace ${req.workspaceId}`);
    if (legacy) log('light', `GET /conversations included ${legacy} chat(s) with no workspace (written before KOL-091), read as workspace ${req.workspaceId}'s (source: lib/personalScope.js)`);
    // include message count without sending full content. `workspaceId` is
    // selected for the log above and then dropped: the list shape is unchanged
    // by this item, and every row in it is the caller's current workspace by
    // construction, so carrying the id would tell a client nothing it can use.
    const withCount = list.map(({ workspaceId, ...c }) => ({ ...c, messageCount: undefined }));
    res.json(withCount);
  } catch (err) {
    next(err);
  }
});

// ─── POST /conversations ──────────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res, next) => {
  const userId = sessionUserId(req, res);
  if (!userId) return;
  const { provider, model } = req.body;
  if (!provider || !model) return res.status(400).json({ error: 'provider and model are required' });
  if (!PROVIDERS[provider]) return res.status(400).json({ error: `Unknown provider: ${provider}` });
  try {
    // The workspace stamped here is the one every route above and `POST /chat`
    // then filter on, so a chat is reachable only from where it was created.
    const conv = await Conversation.create({ userId, provider, model, workspaceId: req.workspaceId });
    log('normal', `POST /conversations created ${conv._id} in workspace ${conv.workspaceId} for user ${userId}`);
    res.status(201).json(conv);
  } catch (err) {
    next(err);
  }
});

// ─── GET /conversations/:id ───────────────────────────────────────────────────

router.get('/:id', requireAuth, async (req, res, next) => {
  const userId = sessionUserId(req, res);
  if (!userId) return;
  try {
    const conv = await Conversation.findOne(scopeById(req, userId)).lean();
    await logLookup(req, userId, conv);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    res.json(conv);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /conversations/:id ─────────────────────────────────────────────────
// Allows renaming. Setting title manually locks autoTitle = false.

router.patch('/:id', requireAuth, async (req, res, next) => {
  const userId = sessionUserId(req, res);
  if (!userId) return;
  const { title } = req.body;
  if (typeof title !== 'string') return res.status(400).json({ error: 'title is required' });
  try {
    const conv = await Conversation.findOneAndUpdate(
      scopeById(req, userId),
      { title: title.trim(), autoTitle: false },
      { new: true }
    ).lean();
    await logLookup(req, userId, conv);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    res.json({ _id: conv._id, title: conv.title, autoTitle: conv.autoTitle });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /conversations/:id ────────────────────────────────────────────────

router.delete('/:id', requireAuth, async (req, res, next) => {
  const userId = sessionUserId(req, res);
  if (!userId) return;
  try {
    const conv = await Conversation.findOneAndDelete(scopeById(req, userId));
    await logLookup(req, userId, conv);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ─── POST /conversations/:id/title ───────────────────────────────────────────
// Ask the AI to generate (or refresh) a short title from the conversation history.
// No-ops if the user has manually renamed (autoTitle === false).

// Prompt used when there is no title yet — generate unconditionally.
const TITLE_INITIAL_PROMPT =
  'Generate a short title (3–7 words, no quotes, no trailing punctuation) that ' +
  'captures the topic of this conversation. Respond with ONLY the title.';

// Prompt used when a title already exists (10+ messages) — only update if the
// topic has shifted significantly; otherwise respond with the sentinel "KEEP".
function titleRefreshPrompt(existingTitle) {
  return (
    `This conversation is currently titled: "${existingTitle}". ` +
    'Only suggest a new title if the conversation has meaningfully changed topic since then. ' +
    'If the current title still fits, respond with exactly: KEEP\n' +
    'Otherwise generate a short title (3–7 words, no quotes, no trailing punctuation). ' +
    'Respond with ONLY the new title or KEEP.'
  );
}

router.post('/:id/title', requireAuth, async (req, res, next) => {
  const userId = sessionUserId(req, res);
  if (!userId) return;
  try {
    const conv = await Conversation.findOne(scopeById(req, userId));
    await logLookup(req, userId, conv);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    // If the user manually renamed, honour that.
    if (!conv.autoTitle) return res.json({ title: conv.title });

    // Need at least one exchange to generate a meaningful title.
    if (conv.messages.length < 2) return res.json({ title: conv.title });

    const hasTitle  = !!conv.title;
    const msgCount  = conv.messages.length;

    // If the conversation already has a title, only reconsider after 10+ messages.
    if (hasTitle && msgCount < 10) return res.json({ title: conv.title });

    const systemPrompt = hasTitle
      ? titleRefreshPrompt(conv.title)
      : TITLE_INITIAL_PROMPT;

    // Build a trimmed history (avoid sending huge conversations for a title)
    const history = conv.messages.slice(0, 20).map(m => ({
      role: m.role, content: m.content,
    }));

    let title = conv.title;
    try {
      const client = makeClient(conv.provider);
      const response = await client.chat.completions.create({
        model:    conv.model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history,
        ],
        max_tokens: 30,
        stream:     false,
      });
      const raw = (response.choices?.[0]?.message?.content?.trim() ?? '').replace(/^["']|["']$/g, '').trim();
      if (raw && raw.toUpperCase() !== 'KEEP') title = raw;
    } catch {
      // If the AI call fails, keep the existing title — don't surface the error.
    }

    if (title !== conv.title) {
      conv.title = title;
      await conv.save();
    }

    res.json({ title: conv.title });
  } catch (err) {
    next(err);
  }
});

export default router;
