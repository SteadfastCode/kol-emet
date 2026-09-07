/**
 * Turns a Draft into one JSONL training record.
 *
 * This file exists as *proof the capture is complete*. If exporting a draft
 * needed a database join, the schema would be wrong — the fine-tune triple
 * would be spread across collections that expire, get pruned, or drift. So the
 * hard rule here is: `exportDraft` takes one draft document and runs zero
 * queries. It is a pure function. If that ever stops being possible, the fix
 * belongs in the Draft schema, not here.
 *
 * Two transformations happen on the way out:
 *
 *   - **Pseudonymisation.** Every ObjectId becomes a keyed HMAC. Deterministic,
 *     so the same entity keeps the same pseudonym across every export and the
 *     corpus can still be joined on it — but the corpus never holds a real id,
 *     a real workspace, or a real user.
 *   - **Local-ref rewriting.** A reference that points at something created by
 *     a sibling item in the same draft becomes `local:<localKey>` instead of a
 *     pseudonym. That is the form a model should learn to emit: relationships
 *     reference entities that do not exist yet by local key, and the training
 *     data should say so rather than showing an id the model could never guess.
 */

import crypto from 'crypto';

export const EXPORT_SCHEMA = 'kol-emet/draft-export@1';

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
// Used by the tripwire below to find a leaked id anywhere in the finished
// record, including embedded inside a longer string.
const OBJECT_ID_ANYWHERE_RE = /\b[0-9a-f]{24}\b/i;

/**
 * Builds the id → pseudonym mapper.
 *
 * The secret is required with no default. A hardcoded fallback would make the
 * mapping reproducible by anyone holding the source, and ObjectIds are partly
 * a timestamp and a counter — guessable enough that a known key would let
 * someone confirm whether a particular record is in the corpus. That is the
 * whole property pseudonymisation is meant to provide.
 */
export function makePseudonymizer(secret) {
  if (!secret) {
    throw new Error(
      'EXPORT_HMAC_SECRET is not set. Export refuses to run without it — a ' +
      'default key would make the pseudonyms linkable back to real ids.'
    );
  }
  const cache = new Map();
  return function pseudonym(id, kind = 'id') {
    if (id === null || id === undefined) return null;
    const raw = String(id);
    if (!cache.has(raw)) {
      // The kind is cosmetic and deliberately NOT part of the HMAC input, so
      // the same id referenced as an entity in one place and a generic ref in
      // another still lands on the same pseudonym.
      cache.set(raw, crypto.createHmac('sha256', secret).update(raw).digest('hex').slice(0, 16));
    }
    return `${kind}_${cache.get(raw)}`;
  };
}

const iso = d => (d ? new Date(d).toISOString() : null);

/**
 * Exports one draft. Pure: no I/O, no queries.
 *
 * @param {object} draft      a Draft document or lean object
 * @param {object} opts
 * @param {(id: any, kind?: string) => string|null} opts.pseudonym
 * @param {boolean} [opts.includeRawOutput]  include the unparsed model output
 *   (large, and only useful for debugging the parse ladder — off by default)
 * @returns {object} one JSONL record
 */
export function exportDraft(draft, { pseudonym, includeRawOutput = false } = {}) {
  if (typeof pseudonym !== 'function') throw new Error('exportDraft requires a pseudonym function');

  const d = typeof draft.toObject === 'function' ? draft.toObject() : draft;
  const items = d.items ?? [];

  // In-memory index over the SAME items array — an entity created by item `e1`
  // is referenced elsewhere in this draft by its real id, and the export should
  // say `local:e1`. Built from the draft itself, so this adds no query.
  const resultToLocal = new Map();
  for (const it of items) {
    if (it.resultId && it.localKey) resultToLocal.set(String(it.resultId), it.localKey);
  }

  // The single mapping used for every reference in the record: local first,
  // pseudonym otherwise.
  const ref = (id, kind = 'ent') => {
    if (id === null || id === undefined) return null;
    const raw = String(id);
    const local = resultToLocal.get(raw);
    return local ? `local:${local}` : pseudonym(raw, kind);
  };

  return {
    schema: EXPORT_SCHEMA,
    draftId: pseudonym(d._id, 'drf'),
    workspace: pseudonym(d.workspaceId, 'ws'),
    createdBy: pseudonym(d.createdBy, 'usr'),
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),

    // Kept verbatim: a discarded draft is still a complete training example,
    // and status is the label that says which kind.
    status: d.status,

    source: {
      producer: d.source?.producer ?? null,
      producerVersion: d.source?.producerVersion ?? null,
      text: d.source?.text ?? '',
      textHash: d.source?.textHash ?? null,
    },

    // Exactly what the model was shown, so an example is reproducible.
    grounding: {
      promptVersion: d.grounding?.promptVersion ?? null,
      categories: d.grounding?.categories ?? [],
      relationshipTypes: d.grounding?.relationshipTypes ?? [],
      rosterCount: d.grounding?.rosterCount ?? 0,
      rosterTruncated: d.grounding?.rosterTruncated ?? false,
      systemPrompt: d.grounding?.systemPrompt ?? null,
    },

    route: {
      provider: d.route?.provider ?? null,
      model: d.route?.model ?? null,
      strategy: d.route?.strategy ?? null,
    },

    diagnostics: {
      parsedVia: d.diagnostics?.parsedVia ?? [],
      repairAttempted: d.diagnostics?.repairAttempted ?? false,
      dropReasons: d.diagnostics?.dropReasons ?? [],
      passes: d.diagnostics?.passes ?? 0,
      generationMs: d.diagnostics?.generationMs ?? null,
      usage: {
        promptTokens: d.diagnostics?.usage?.promptTokens ?? 0,
        completionTokens: d.diagnostics?.usage?.completionTokens ?? 0,
        calls: d.diagnostics?.usage?.calls ?? 0,
      },
      ...(includeRawOutput ? { rawOutput: d.diagnostics?.rawOutput ?? null } : {}),
    },

    counts: d.counts?.toObject?.() ?? d.counts ?? {},

    items: items.map(it => exportItem(it, { pseudonym, ref })),
  };
}

function exportItem(it, { pseudonym, ref }) {
  return {
    localKey: it.localKey,
    seq: it.seq,
    kind: it.kind,
    op: it.op,

    // ── part 1: INPUT ────────────────────────────────────────────────────────
    input: {
      evidence: {
        quote: it.input?.evidence?.quote ?? '',
        charStart: it.input?.evidence?.charStart ?? null,
        charEnd: it.input?.evidence?.charEnd ?? null,
        chunkIndex: it.input?.evidence?.chunkIndex ?? 0,
      },
      contextEntityIds: (it.input?.contextEntityIds ?? []).map(id => ref(id)),
    },

    // ── part 2: PROPOSED ─────────────────────────────────────────────────────
    proposed: exportPayload(it.kind, it.proposed, ref),

    // ── part 3: ACCEPTED ─────────────────────────────────────────────────────
    // null on a rejection, and that null IS the label — the negative example is
    // the most valuable one in the set and the easiest to lose.
    accepted: it.accepted ? exportPayload(it.kind, it.accepted, ref) : null,

    // ── the human label ──────────────────────────────────────────────────────
    decision: it.decision,
    decisionVia: it.decisionVia ?? null,
    decisionNote: it.decisionNote ?? null,
    decidedBy: pseudonym(it.decidedBy, 'usr'),
    decidedAt: iso(it.decidedAt),

    // ── targeting / dedup ────────────────────────────────────────────────────
    targetEntityId: ref(it.targetEntityId),
    baseUpdatedAt: iso(it.baseUpdatedAt),
    matchedBy: it.matchedBy ?? 'none',
    duplicateOf: ref(it.duplicateOf),
    duplicateScore: it.duplicateScore ?? null,
    dependsOn: it.dependsOn ?? [],
    flags: it.flags ?? [],
    confidence: it.confidence ?? null,

    // ── the system outcome, kept distinct from the human label ───────────────
    outcome: {
      applyState: it.applyState,
      resultId: ref(it.resultId),
      changeLogId: pseudonym(it.changeLogId, 'chg'),
      applyError: it.applyError ?? null,
      appliedAt: iso(it.appliedAt),
    },
  };
}

/**
 * Maps one `proposed`/`accepted` payload.
 *
 * Kind-aware rather than a generic deep walk, because the shapes are known and
 * an unrecognised one should be caught by the tripwire rather than silently
 * half-scrubbed.
 */
function exportPayload(kind, payload, ref) {
  if (!payload || typeof payload !== 'object') return payload ?? null;
  const p = typeof payload.toObject === 'function' ? payload.toObject() : payload;

  if (kind === 'entity') {
    return {
      title: p.title,
      category: p.category,
      summary: p.summary ?? '',
      tags: p.tags ?? [],
      // Block `_id` is a mongoose subdocument id with no training value, so it
      // is dropped outright rather than pseudonymised into noise.
      blocks: (p.blocks ?? []).map(({ _id, ...b }) => b),
      ...(p.normalizedCategory ? { normalizedCategory: p.normalizedCategory } : {}),
    };
  }

  if (kind === 'relationship') {
    return {
      label: p.label ?? null,
      members: (p.members ?? []).map(m => ({
        // A member is either local to this draft or an existing entity. Both
        // come out as a ref string, so the two cases read the same downstream.
        ref: m.localKey ? `local:${m.localKey}` : ref(m.refId),
        refModel: m.refModel ?? 'Entity',
        name: m.name,
        label: m.label ?? null,
        notes: m.notes ?? null,
      })),
    };
  }

  if (kind === 'open_question') {
    return {
      question: p.question,
      entry_ids: (p.entry_ids ?? []).map(id => ref(id)),
    };
  }

  return p;
}

/**
 * Verbatim-content paths: text the user or the model actually wrote, which is
 * the training input and must not be altered or rejected. A braindump that
 * happens to contain 24 hex characters is not a leaked id, and refusing to
 * export it would be the tripwire firing on the very data it exists to protect.
 *
 * Everything else — every reference field — is checked.
 */
const VERBATIM_PATHS = [
  /^\$\.source\.text$/,
  /^\$\.grounding\.systemPrompt$/,
  /^\$\.diagnostics\.rawOutput$/,
  /^\$\.items\[\d+\]\.input\.evidence\.quote$/,
];

/**
 * Tripwire. Walks the finished record and throws if any raw ObjectId survived.
 *
 * Deliberately a separate assertion rather than a blanket regex scrub of the
 * output: a scrub would quietly paper over a field the mapper above forgot,
 * and the failure would only show up as an unexplained id in the corpus months
 * later. This fails the export instead, loudly, at the moment the schema and
 * the mapper disagree.
 *
 * @throws {Error} naming the path that leaked
 */
export function assertScrubbed(record, path = '$') {
  if (record === null || record === undefined) return;

  if (typeof record === 'string') {
    if (VERBATIM_PATHS.some(re => re.test(path))) return;
    if (OBJECT_ID_ANYWHERE_RE.test(record)) {
      throw new Error(`Unscrubbed ObjectId at ${path}: ${record.slice(0, 120)}`);
    }
    return;
  }

  if (Array.isArray(record)) {
    record.forEach((v, i) => assertScrubbed(v, `${path}[${i}]`));
    return;
  }

  if (typeof record === 'object') {
    // A mongoose ObjectId that escaped mapping stringifies to 24 hex chars.
    const asString = String(record);
    if (OBJECT_ID_RE.test(asString)) throw new Error(`Unscrubbed ObjectId at ${path}: ${asString}`);
    for (const [k, v] of Object.entries(record)) assertScrubbed(v, `${path}.${k}`);
  }
}

/** One JSONL line, scrubbed and verified. */
export function toJsonl(draft, opts) {
  const record = exportDraft(draft, opts);
  assertScrubbed(record);
  return JSON.stringify(record);
}
