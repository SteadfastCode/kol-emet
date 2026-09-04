/**
 * Turns raw model output into validated proposal items.
 *
 * Everything here is defensive on purpose: this is the boundary between an
 * unpredictable model and a collection that is meant to be a clean training
 * corpus. The rules are
 *
 *   - drop bad items rather than failing the run, and COUNT the drops so the
 *     UI can say "3 items couldn't be used" instead of silently showing 8 of 11;
 *   - never trust an id the model emitted — localKeys are server-assigned;
 *   - never trust a character offset — evidence spans are located server-side.
 */

import { z } from 'zod';
import { normalizeTitle, similarity } from './similarity.js';

const DUPLICATE_THRESHOLD = 0.72;
export const MAX_ITEMS = 60;

const rawEntitySchema = z.object({
  title:    z.string().min(1).max(200),
  category: z.string().min(1),
  summary:  z.string().max(400).optional().default(''),
  body:     z.string().optional().default(''),
  tags:     z.array(z.string()).optional().default([]),
  quote:    z.string().optional().default(''),
});

const rawRelationshipSchema = z.object({
  label:   z.string().nullable().optional().default(null),
  members: z.array(z.object({
    name: z.string().min(1),
    role: z.string().optional().default(''),
  })).min(2),
  quote:   z.string().optional().default(''),
});

/**
 * Models routinely emit a near-miss category ("Character", "world",
 * "Organisation"). Coerce where the intent is unambiguous, but record the flag
 * AND keep the uncoerced value in `proposed` — a coercion must not record a
 * success the model did not earn.
 */
function coerceCategory(raw, categories) {
  const exact = categories.find(c => c === raw);
  if (exact) return { category: exact, coerced: false };

  const norm = String(raw ?? '').toLowerCase().trim().replace(/s$/, '');
  const match = categories.find(c => {
    const cn = c.toLowerCase().replace(/s$/, '');
    return cn === norm || cn.replace(/z/g, 's') === norm.replace(/z/g, 's');
  });
  if (match) return { category: match, coerced: true };
  return { category: null, coerced: false };
}

/**
 * Builds a whitespace-collapsed copy of the source plus a map from each
 * collapsed offset back to the original one.
 *
 * Necessary because authors' notes are usually hard-wrapped, so a sentence in
 * the source contains newlines while the model emits the same sentence with
 * single spaces. A plain indexOf therefore fails on almost every real quote,
 * which silently destroys the provenance feature.
 */
function buildSearchIndex(sourceText) {
  let flat = '';
  const map = [];
  let prevWasSpace = false;
  for (let i = 0; i < sourceText.length; i++) {
    const ch = sourceText[i];
    if (/\s/.test(ch)) {
      if (prevWasSpace) continue;
      flat += ' ';
      map.push(i);
      prevWasSpace = true;
    } else {
      flat += ch;
      map.push(i);
      prevWasSpace = false;
    }
  }
  return { flat: flat.toLowerCase(), map, raw: sourceText };
}

/**
 * Locate a model-supplied quote in the source. Models get character offsets
 * wrong but can copy text, so the span is found server-side.
 *
 * Falls back through: exact match → whitespace-insensitive match → a prefix
 * anchor (models often trail off or append their own words). A quote that
 * matches none of these is kept as provenance text with null offsets rather
 * than being given a fabricated position.
 */
function locateEvidence(quote, index, chunkIndex = 0) {
  const q = String(quote ?? '').trim();
  if (!q) return { quote: '', charStart: null, charEnd: null, chunkIndex };

  const exact = index.raw.indexOf(q);
  if (exact !== -1) return { quote: q, charStart: exact, charEnd: exact + q.length, chunkIndex };

  const flatQ = q.replace(/\s+/g, ' ').toLowerCase();
  const at = index.flat.indexOf(flatQ);
  if (at !== -1) {
    const start = index.map[at];
    const end = index.map[Math.min(at + flatQ.length - 1, index.map.length - 1)] + 1;
    return { quote: index.raw.slice(start, end), charStart: start, charEnd: end, chunkIndex };
  }

  // Prefix anchor: match on the first several words only.
  const words = flatQ.split(' ').filter(Boolean);
  for (const n of [8, 6, 4]) {
    if (words.length < n) continue;
    const anchor = words.slice(0, n).join(' ');
    const hit = index.flat.indexOf(anchor);
    if (hit !== -1) {
      const start = index.map[hit];
      const end = index.map[Math.min(hit + anchor.length - 1, index.map.length - 1)] + 1;
      return { quote: index.raw.slice(start, end), charStart: start, charEnd: end, chunkIndex };
    }
  }

  return { quote: q, charStart: null, charEnd: null, chunkIndex };
}

/**
 * @param {object[]} rawEntities      parsed pass-1 output
 * @param {object[]} rawRelationships parsed pass-2 output
 * @param {object}   ctx  { categories, sourceText, existingEntities }
 *                        existingEntities: [{_id, title, updatedAt}]
 */
export function normalizeProposal(rawEntities, rawRelationships, ctx) {
  const { categories, sourceText, existingEntities = [] } = ctx;
  const items = [];
  const dropReasons = [];

  const searchIndex = buildSearchIndex(sourceText);
  const existingByKey = new Map(existingEntities.map(e => [normalizeTitle(e.title), e]));
  const seenKeys = new Set();
  const keyToLocal = new Map();   // normalized title -> localKey (this run)
  const nameToLocal = new Map();  // exact emitted name -> localKey

  // ── entities ───────────────────────────────────────────────────────────────
  let e = 0;
  for (const raw of Array.isArray(rawEntities) ? rawEntities : []) {
    if (items.length >= MAX_ITEMS) { dropReasons.push('item cap reached'); break; }

    const parsed = rawEntitySchema.safeParse(raw);
    if (!parsed.success) {
      dropReasons.push(`entity failed validation: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
      continue;
    }
    const v = parsed.data;

    const { category, coerced } = coerceCategory(v.category, categories);
    if (!category) {
      dropReasons.push(`entity "${v.title}" had unusable category "${v.category}"`);
      continue;
    }

    const key = normalizeTitle(v.title);
    if (!key) { dropReasons.push('entity had an empty title'); continue; }
    if (seenKeys.has(key)) { dropReasons.push(`duplicate entity "${v.title}" within the same run`); continue; }
    seenKeys.add(key);

    const flags = [];
    if (coerced) flags.push('category_coerced');
    if (!v.quote) flags.push('no_evidence');

    // Blocks: a single text block wrapping the flat body the model returned.
    const blocks = v.body?.trim()
      ? [{ type: 'text', order: 0, data: { markdown: v.body.trim() } }]
      : [];

    const localKey = `e${++e}`;
    const existing = existingByKey.get(key);

    // Exact normalized-title match becomes an update against the live entity
    // rather than a second copy of it.
    let op = 'create', targetEntityId = null, baseUpdatedAt = null, matchedBy = 'none';
    if (existing) {
      op = 'update';
      targetEntityId = existing._id;
      baseUpdatedAt = existing.updatedAt ?? null;
      matchedBy = 'exact-normalized-title';
    }

    // Fuzzy near-miss: flagged for the human, never auto-merged.
    // Compared on NORMALIZED titles: on raw ones a leading article alone sinks
    // the score ("The Iron Gate" vs "Iron Gates"), which is precisely the
    // near-miss this is meant to catch.
    let duplicateOf = null, duplicateScore = null;
    if (!existing) {
      let best = null, bestScore = 0;
      for (const cand of existingEntities) {
        const s = similarity(key, normalizeTitle(cand.title));
        if (s > bestScore) { bestScore = s; best = cand; }
      }
      if (best && bestScore >= DUPLICATE_THRESHOLD) {
        duplicateOf = best._id;
        duplicateScore = Number(bestScore.toFixed(3));
        flags.push('duplicate_candidate');
      }
    }

    keyToLocal.set(key, localKey);
    nameToLocal.set(v.title, localKey);

    items.push({
      localKey,
      seq: items.length,
      kind: 'entity',
      op,
      input: { evidence: locateEvidence(v.quote, searchIndex), contextEntityIds: [] },
      proposed: {
        title: v.title.trim(),
        // The uncoerced value is preserved here deliberately.
        category: v.category,
        normalizedCategory: category,
        summary: (v.summary || '').trim(),
        tags: v.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12),
        blocks,
      },
      targetEntityId,
      baseUpdatedAt,
      matchedBy,
      duplicateOf,
      duplicateScore,
      dependsOn: [],
      flags,
    });
  }

  // ── relationships ──────────────────────────────────────────────────────────
  // Resolvable against either an item proposed in this run or an entity that
  // already exists. A member that resolves to neither is dropped; a group left
  // with fewer than two members is dropped whole, matching the <2-member rule
  // the relationship routes already enforce.
  let r = 0;
  for (const raw of Array.isArray(rawRelationships) ? rawRelationships : []) {
    if (items.length >= MAX_ITEMS) { dropReasons.push('item cap reached'); break; }

    const parsed = rawRelationshipSchema.safeParse(raw);
    if (!parsed.success) {
      dropReasons.push(`relationship failed validation: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
      continue;
    }
    const v = parsed.data;

    const members = [];
    const dependsOn = [];
    const flags = [];

    for (const m of v.members) {
      const key = normalizeTitle(m.name);
      const local = nameToLocal.get(m.name) ?? keyToLocal.get(key);
      const existing = existingByKey.get(key);

      if (local) {
        members.push({ localKey: local, refId: null, refModel: 'Entity', name: m.name, label: m.role || null, notes: null });
        if (!dependsOn.includes(local)) dependsOn.push(local);
      } else if (existing) {
        members.push({ localKey: null, refId: existing._id, refModel: 'Entity', name: m.name, label: m.role || null, notes: null });
      } else {
        flags.push('member_dropped');
        dropReasons.push(`relationship member "${m.name}" matched no entity`);
      }
    }

    if (members.length < 2) {
      dropReasons.push(`relationship "${v.label ?? '(unlabelled)'}" dropped — fewer than 2 resolvable members`);
      continue;
    }

    items.push({
      localKey: `r${++r}`,
      seq: items.length,
      kind: 'relationship',
      op: 'create',
      input: { evidence: locateEvidence(v.quote, searchIndex), contextEntityIds: [] },
      proposed: { label: v.label ?? null, members },
      dependsOn,
      flags,
    });
  }

  return { items, dropReasons };
}
