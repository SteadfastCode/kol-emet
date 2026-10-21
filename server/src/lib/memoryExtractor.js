/**
 * Fire-and-forget memory extraction.
 * After each exchange, runs the newest user+assistant pair through a cheap
 * AI call to pull out facts worth remembering. Only the latest pair is sent
 * to avoid re-processing older messages and generating duplicates.
 */

import { makeClient, PROVIDERS, isConfigured } from './aiProviders.js';
import { getCheapestExtractionModel } from './cheapModelFinder.js';
import UserMemory from '../models/UserMemory.js';
import { personalScope } from './personalScope.js';
import { recordSpend } from './usageMeter.js';
import { OwnerGoneError } from './ownerGuard.js';

// ─── Tiered debug logging ─────────────────────────────────────────────────────
// Extraction runs unattended after every exchange, so it needs to be
// diagnosable after the fact rather than only reproducible live.
//   off     — nothing
//   light   — route chosen (and why), the workspace the facts are stamped with
//             and where that came from, fact count, errors. Cheap; on by default.
//   normal  — light, plus the facts themselves, per-attempt timing, and what
//             each turn's prompt was loaded with (how many facts, how many of
//             them pre-KOL-091 rows read as this workspace's).
//   verbose — normal, plus raw model output. Noisy; short opt-in sessions only.
const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.MEMORY_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[memoryExtractor:${level}] ${msg}`);
}

const EXTRACTION_SYSTEM =
  'You extract memorable facts from a single conversation exchange for a personal wiki assistant. ' +
  'Identify facts worth remembering across future sessions: user preferences, opinions, ' +
  'explicitly stated requests to remember something, important project context, ' +
  'or personal details relevant to future assistance. ' +
  'Be selective — only extract genuinely notable facts, not summaries of routine exchanges. ' +
  'Return a JSON array of concise, self-contained fact strings. ' +
  'Return [] if nothing is worth remembering. Return ONLY the JSON array, no other text.';

// Native-provider fallbacks when neither self-hosted nor OpenRouter is configured
const NATIVE_CHEAP_MODELS = {
  claude: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  xai:    'grok-4-1-fast-reasoning',
};

// Small self-hosted model for extraction. Picked over qwen2.5:3b and
// granite3.3:2b on fact phrasing: it returns self-contained statements and
// parses as JSON directly, where granite needed the regex fallback.
const STEADFAST_EXTRACTION_MODEL = 'llama3.2:3b';

/**
 * Extraction is background, high-volume, and failure-tolerant — exactly the
 * work the self-hosted box is for. Prefer it when reachable, then the cheapest
 * OpenRouter model, then a cheap native default.
 */
function pickExtractionRoute(provider) {
  if (isConfigured('steadfast')) {
    return { provider: 'steadfast', model: STEADFAST_EXTRACTION_MODEL, why: 'self-hosted configured' };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return { provider: 'openrouter', model: null, why: 'openrouter configured, no self-hosted' };
  }
  return {
    provider,
    model: NATIVE_CHEAP_MODELS[provider] ?? PROVIDERS[provider]?.defaultModel,
    why: 'fell back to chat provider; neither self-hosted nor openrouter configured',
  };
}

export async function extractAndSaveMemories(userId, conversationId, lastUserMsg, lastAssistantMsg, provider, workspaceId) {
  try {
    const route = pickExtractionRoute(provider);
    const extractionProvider = route.provider;
    const model = route.model ?? (await getCheapestExtractionModel());

    log('light', `route=${extractionProvider}/${model} (${route.why}) user=${userId} workspace=${workspaceId ?? 'none'}`);

    const client = makeClient(extractionProvider);

    const exchangeText =
      `User: ${lastUserMsg}\n\nAssistant: ${lastAssistantMsg}`;

    const startedAt = Date.now();
    const response = await client.chat.completions.create({
      model,
      // Extraction is a classification task, not a creative one. Left to a
      // sampling default, small models invent filler facts from routine
      // exchanges ("Country: France.") that then pollute the memory store.
      temperature: 0,
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM },
        { role: 'user',   content: exchangeText },
      ],
    });
    log('normal', `model responded in ${Date.now() - startedAt}ms`);

    // Charged against the same allowance as chat and generation. Extraction
    // picks its own (cheap) route, so it is billed at that route's rate rather
    // than the chat provider's — usually self-hosted, and near-free.
    if (workspaceId && response.usage) {
      await recordSpend(workspaceId, {
        provider: extractionProvider,
        model,
        promptTokens: response.usage.prompt_tokens ?? 0,
        completionTokens: response.usage.completion_tokens ?? 0,
        reason: 'memory extraction',
      }).catch(e => console.error('[memoryExtractor] could not record spend:', e.message));
    }

    const raw = response.choices?.[0]?.message?.content?.trim() ?? '[]';
    log('verbose', `raw output: ${raw}`);

    let facts;
    let parsedVia = 'direct';
    try {
      facts = JSON.parse(raw);
    } catch {
      const match = raw.match(/\[[\s\S]*\]/);
      facts = match ? JSON.parse(match[0]) : [];
      parsedVia = match ? 'regex-fallback' : 'unparseable';
    }

    if (!Array.isArray(facts) || facts.length === 0) {
      log('light', `no facts extracted (parse=${parsedVia})`);
      return;
    }

    const docs = facts
      .filter(f => typeof f === 'string' && f.trim())
      // Stamped with the workspace the exchange happened in (KOL-091), so a
      // fact from one wiki cannot reach another's system prompt. `workspaceId`
      // is the one resolveWorkspace set for the turn that produced it.
      .map(f => ({ userId, workspaceId: workspaceId ?? null, fact: f.trim(), sourceId: conversationId }));

    if (docs.length > 0) {
      const saved = await UserMemory.insertMany(docs);
      log('light', `saved ${saved.length} fact(s) in workspace ${workspaceId ?? 'none'} (source: the chat turn's resolved workspace, parse=${parsedVia}) ids=${saved.map(d => d._id).join(',')}`);
      log('normal', `facts: ${docs.map(d => d.fact).join(' | ')}`);
    }
  } catch (err) {
    // Expected, not a failure: the account was deleted while the model call ran,
    // and the insert removed itself.
    if (err instanceof OwnerGoneError) {
      log('light', `facts discarded: user ${userId} or workspace ${workspaceId ?? 'none'} was deleted during extraction (source: owner guard on UserMemory, missing ${err.missing.join(', ')})`);
      return;
    }
    console.error('[memoryExtractor] failed:', err.message);
  }
}

/**
 * The facts to put in this turn's system prompt: the caller's own, from the
 * workspace they are acting in, newest first.
 *
 * Scoped on the workspace as well as the user since KOL-091 — see
 * lib/personalScope.js, which also explains why a row written before that item
 * (`workspaceId: null`) still counts as the caller's current workspace.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {string|import('mongoose').Types.ObjectId} workspaceId req.workspaceId
 */
export async function loadMemories(userId, workspaceId) {
  const records = await UserMemory.find(personalScope(userId, workspaceId))
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  const legacy = records.filter(r => r.workspaceId == null).length;
  log('normal', `loaded ${records.length} fact(s) for user ${userId} in workspace ${workspaceId ?? 'none'}${legacy ? `, ${legacy} of them written before KOL-091 and read as this workspace's` : ''}`);
  return records.map(r => r.fact);
}
