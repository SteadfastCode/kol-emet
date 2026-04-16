import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import Conversation from '../models/Conversation.js';
import { PROVIDERS, makeClient } from '../lib/aiProviders.js';

const router = Router();

// All routes require a session user (not bearer-token / MCP).
function sessionUserId(req, res) {
  const id = req.session?.userId;
  if (!id) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return id;
}

// ─── GET /conversations ───────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  const userId = sessionUserId(req, res);
  if (!userId) return;
  try {
    const list = await Conversation.find({ userId })
      .sort({ updatedAt: -1 })
      .select('_id title autoTitle provider model createdAt updatedAt')
      .lean();
    // include message count without sending full content
    const withCount = list.map(c => ({ ...c, messageCount: undefined }));
    res.json(withCount);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /conversations ──────────────────────────────────────────────────────

router.post('/', requireAuth, async (req, res) => {
  const userId = sessionUserId(req, res);
  if (!userId) return;
  const { provider, model } = req.body;
  if (!provider || !model) return res.status(400).json({ error: 'provider and model are required' });
  if (!PROVIDERS[provider]) return res.status(400).json({ error: `Unknown provider: ${provider}` });
  try {
    const conv = await Conversation.create({ userId, provider, model });
    res.status(201).json(conv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /conversations/:id ───────────────────────────────────────────────────

router.get('/:id', requireAuth, async (req, res) => {
  const userId = sessionUserId(req, res);
  if (!userId) return;
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, userId }).lean();
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    res.json(conv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /conversations/:id ─────────────────────────────────────────────────
// Allows renaming. Setting title manually locks autoTitle = false.

router.patch('/:id', requireAuth, async (req, res) => {
  const userId = sessionUserId(req, res);
  if (!userId) return;
  const { title } = req.body;
  if (typeof title !== 'string') return res.status(400).json({ error: 'title is required' });
  try {
    const conv = await Conversation.findOneAndUpdate(
      { _id: req.params.id, userId },
      { title: title.trim(), autoTitle: false },
      { new: true }
    ).lean();
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    res.json({ _id: conv._id, title: conv.title, autoTitle: conv.autoTitle });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /conversations/:id ────────────────────────────────────────────────

router.delete('/:id', requireAuth, async (req, res) => {
  const userId = sessionUserId(req, res);
  if (!userId) return;
  try {
    const conv = await Conversation.findOneAndDelete({ _id: req.params.id, userId });
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
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

router.post('/:id/title', requireAuth, async (req, res) => {
  const userId = sessionUserId(req, res);
  if (!userId) return;
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, userId });
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
    res.status(500).json({ error: err.message });
  }
});

export default router;
