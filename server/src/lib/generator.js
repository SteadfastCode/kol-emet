/**
 * Braindump -> proposed graph.
 *
 * Deliberately does NOT use forced tool_choice or response_format. The provider
 * registry routes `claude` through Anthropic's OpenAI-compat shim and `gemini`
 * through Google's, and both handle forced structured output unevenly. Plain
 * JSON prompting plus the parse ladder that memoryExtractor already relies on
 * in production is the one path that runs everywhere, which is what the
 * model-agnostic constraint actually requires.
 *
 * Nothing here writes to the graph. It returns items for review.
 */

import { makeClient, PROVIDERS, isConfigured } from './aiProviders.js';
import { entityPrompt, relationshipPrompt, PROMPT_VERSION, ROLE_STYLES, DEFAULT_ROLE_STYLE } from './generatorPrompts.js';
import { normalizeDraft } from './draftNormalizer.js';
import { getCategories } from '../config/categories.js';
import Entity from '../models/Entity.js';
import RelationshipType from '../models/RelationshipType.js';

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };
function log(level, msg) {
  const active = LEVELS[process.env.GENERATOR_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[generator:${level}] ${msg}`);
}

export const MAX_CHARS = Number(process.env.GENERATOR_MAX_CHARS ?? 25000);
const CHUNK_CHARS = Number(process.env.GENERATOR_CHUNK_CHARS ?? 6000);
const ROSTER_LIMIT = 400;

/**
 * Frontier by default: this is the user-facing demo, and a 1080 Ti would look
 * hung. Self-hosted is opt-in per request via `provider`.
 */
export function pickRoute(requested) {
  if (requested && PROVIDERS[requested] && isConfigured(requested)) {
    return { provider: requested, model: PROVIDERS[requested].defaultModel };
  }
  for (const p of ['openrouter', 'claude', 'openai', 'xai', 'gemini', 'steadfast']) {
    if (isConfigured(p)) return { provider: p, model: PROVIDERS[p].defaultModel };
  }
  return null;
}

/** Split on paragraph boundaries so an entity is rarely cut in half. */
export function chunkText(text, size = CHUNK_CHARS) {
  const paras = text.split(/\n\s*\n/);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > size) { chunks.push(cur); cur = ''; }
    // A single paragraph longer than the chunk size gets hard-split.
    if (p.length > size) {
      if (cur) { chunks.push(cur); cur = ''; }
      for (let i = 0; i < p.length; i += size) chunks.push(p.slice(i, i + size));
      continue;
    }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [''];
}

/**
 * The parse ladder. Same shape memoryExtractor uses, plus fence stripping,
 * which small models emit constantly despite being told not to.
 */
export function parseJsonArray(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { value: [], via: 'empty' };

  try { const v = JSON.parse(text); if (Array.isArray(v)) return { value: v, via: 'direct' }; } catch {}

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) {
    try { const v = JSON.parse(fenced[1]); if (Array.isArray(v)) return { value: v, via: 'fence' }; } catch {}
  }

  const bracket = text.match(/\[[\s\S]*\]/);
  if (bracket) {
    try { const v = JSON.parse(bracket[0]); if (Array.isArray(v)) return { value: v, via: 'bracket' }; } catch {}
  }

  // A single object where an array was asked for — common on small models.
  try { const v = JSON.parse(text); if (v && typeof v === 'object') return { value: [v], via: 'single-object' }; } catch {}

  return { value: null, via: 'failed' };
}

async function callModel(client, model, system, user, diag) {
  const res = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  // Accumulated so cost per draft is a stored fact rather than an estimate.
  // Every provider in the registry is OpenAI-shaped and reports usage here.
  if (diag && res.usage) {
    diag.usage.promptTokens     += res.usage.prompt_tokens ?? 0;
    diag.usage.completionTokens += res.usage.completion_tokens ?? 0;
    diag.usage.calls            += 1;
  }
  return res.choices?.[0]?.message?.content ?? '';
}

/** One repair turn: hand the model its own unparseable output back. */
async function callWithRepair(client, model, system, user, diag) {
  const raw = await callModel(client, model, system, user, diag);
  let { value, via } = parseJsonArray(raw);
  diag.parsedVia.push(via);
  if (value) return { value, raw };

  log('normal', 'first parse failed — attempting one repair turn');
  diag.repairAttempted = true;
  const repaired = await callModel(
    client, model,
    'You fix malformed JSON. Return ONLY a valid JSON array. No prose, no fences.',
    `This was supposed to be a JSON array but could not be parsed. Return the corrected array:\n\n${raw}`,
    diag
  );
  const second = parseJsonArray(repaired);
  diag.parsedVia.push(`repair:${second.via}`);
  return { value: second.value ?? [], raw };
}

/**
 * @param {object} opts { text, workspaceId, provider?, onStage? }
 * @returns draft payload — never persisted here, never written to the graph
 */
export async function generateDraft(opts) {
  // Shared handle so a thrown error can still report what was spent. Tokens
  // consumed before a failure were still paid for; dropping them on the floor
  // would let a run that dies on its last call go entirely uncharged.
  const spend = { provider: null, model: null, usage: null };
  try {
    return await runGeneration({ ...opts, __spend: spend });
  } catch (err) {
    err.spend = spend;
    throw err;
  }
}

async function runGeneration({ text, workspaceId, provider, roleStyle, onStage = () => {}, __spend }) {
  const started = Date.now();
  const source = String(text ?? '').trim();
  if (!source) throw new Error('No text supplied');
  if (source.length > MAX_CHARS) {
    throw new Error(`Input is ${source.length} characters; the limit is ${MAX_CHARS}.`);
  }

  const style = ROLE_STYLES.includes(roleStyle) ? roleStyle : DEFAULT_ROLE_STYLE;

  const route = pickRoute(provider);
  if (!route) throw new Error('No AI provider is configured on the server');
  if (__spend) { __spend.provider = route.provider; __spend.model = route.model; }
  log('light', `generating for workspace ${workspaceId} via ${route.provider}/${route.model} (${source.length} chars)`);

  const client = makeClient(route.provider);
  const categories = getCategories(workspaceId);

  // Grounding: the existing graph, so the model does not re-propose what is
  // already there and can point relationships at live entities.
  const existingEntities = await Entity.find({ workspaceId })
    .select('_id title updatedAt')
    .sort({ updatedAt: -1 })
    .limit(ROSTER_LIMIT)
    .lean();
  const totalExisting = await Entity.countDocuments({ workspaceId });
  const relTypes = await RelationshipType.find({ workspaceId }).select('name scope').lean();
  const groupLabels = relTypes.filter(t => t.scope === 'group').map(t => t.name);
  const memberRoles = relTypes.filter(t => t.scope !== 'group').map(t => t.name);

  const diag = {
    parsedVia: [], repairAttempted: false, dropReasons: [], passes: 0, rawOutput: null,
    usage: { promptTokens: 0, completionTokens: 0, calls: 0 },
  };
  // Same object reference, so it stays current as calls accumulate.
  if (__spend) __spend.usage = diag.usage;
  const chunks = chunkText(source);
  log('normal', `split into ${chunks.length} chunk(s)`);

  // ── pass 1: entities, per chunk ────────────────────────────────────────────
  const rawEntities = [];
  const seenTitles = new Set(existingEntities.map(e => e.title));
  for (let i = 0; i < chunks.length; i++) {
    onStage({ stage: 'entities', chunk: i + 1, of: chunks.length });
    const system = entityPrompt({ categories, existingTitles: [...seenTitles].slice(0, ROSTER_LIMIT) });
    const { value, raw } = await callWithRepair(client, route.model, system, chunks[i], diag);
    diag.passes++;
    if (i === 0) diag.rawOutput = String(raw).slice(0, 20000);
    for (const item of value ?? []) {
      rawEntities.push(item);
      // Feed names forward so later chunks don't re-propose earlier ones.
      if (item?.title) seenTitles.add(item.title);
    }
    log('normal', `chunk ${i + 1}/${chunks.length}: ${(value ?? []).length} raw entities`);
  }

  // ── pass 2: relationships over the closed name list ────────────────────────
  let rawRelationships = [];
  const names = [
    ...new Set([...rawEntities.map(e => e?.title).filter(Boolean), ...existingEntities.map(e => e.title)]),
  ].slice(0, ROSTER_LIMIT);

  if (names.length >= 2) {
    onStage({ stage: 'relationships' });
    const system = relationshipPrompt({ names, groupLabels, memberRoles, roleStyle: style });
    const { value } = await callWithRepair(client, route.model, system, source.slice(0, MAX_CHARS), diag);
    diag.passes++;
    rawRelationships = value ?? [];
    log('normal', `${rawRelationships.length} raw relationships`);
  } else {
    log('normal', 'skipping relationship pass — fewer than 2 names available');
  }

  // ── normalize ──────────────────────────────────────────────────────────────
  onStage({ stage: 'normalizing' });
  const { items, dropReasons } = normalizeDraft(rawEntities, rawRelationships, {
    categories, sourceText: source, existingEntities,
  });
  diag.dropReasons = dropReasons;
  diag.generationMs = Date.now() - started;

  log('light',
    `produced ${items.length} item(s) from ${rawEntities.length} raw entities + ` +
    `${rawRelationships.length} raw relationships; ${dropReasons.length} dropped; ${diag.generationMs}ms`);

  return {
    items,
    route: { provider: route.provider, model: route.model, strategy: 'json-prompt+ladder' },
    grounding: {
      promptVersion: PROMPT_VERSION,
      categories,
      relationshipTypes: relTypes.map(t => t.name),
      groupLabels,
      memberRoles,
      roleStyle: style,
      rosterCount: existingEntities.length,
      rosterTruncated: totalExisting > existingEntities.length,
      systemPrompt: entityPrompt({ categories, existingTitles: [] }),
    },
    diagnostics: diag,
    counts: { proposed: items.length, dropped: dropReasons.length },
  };
}
