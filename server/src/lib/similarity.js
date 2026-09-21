/**
 * Trigram similarity, used for near-duplicate detection.
 *
 * Lifted verbatim out of routes/relationshipTypes.js so the generator's
 * entity-dedup pass and the relationship-type picker share one implementation
 * rather than drifting apart. The route now imports from here.
 */

export function trigrams(str) {
  const s = str.toLowerCase().trim();
  const set = new Set();
  for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
  return set;
}

/** Jaccard overlap of two already-built trigram sets. */
function jaccard(ta, tb) {
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  // |A ∪ B| = |A| + |B| - |A ∩ B|, so the union set never has to be built.
  return intersection / (ta.size + tb.size - intersection);
}

export function similarity(a, b) {
  return jaccard(trigrams(a), trigrams(b));
}

/**
 * A near-duplicate matcher over a FIXED candidate set, for the callers that
 * scan many proposed titles against the same workspace roster.
 *
 * `similarity(key, normalizeTitle(c.title))` in a nested loop rebuilds every
 * candidate's normalized title and trigram set once per proposal: N proposals
 * over M candidates cost N×M string normalizations and 2×N×M trigram sets.
 * This builds the candidates' side once — M — and leaves only the set
 * intersections in the inner loop. The scores are identical, vacuous
 * sub-trigram matches included.
 *
 * @param {{title: string}[]} candidates
 * @returns {(key: string) => { match: object|null, score: number }} called with
 *   an already-normalized key; `match` is null when nothing scored above 0.
 */
export function nearestTitle(candidates) {
  const index = (candidates ?? []).map(candidate => ({ candidate, grams: trigrams(normalizeTitle(candidate.title)) }));
  return key => {
    const grams = trigrams(key);
    let match = null;
    let score = 0;
    for (const entry of index) {
      const s = jaccard(grams, entry.grams);
      if (s > score) { score = s; match = entry.candidate; }
    }
    return { match, score };
  };
}

export function findSimilar(name, existing, threshold = 0.4) {
  return existing
    .map(t => ({ type: t, score: similarity(name, t.name) }))
    .filter(({ score, type }) => score >= threshold && type.name.toLowerCase() !== name.toLowerCase())
    .sort((a, b) => b.score - a.score)
    .map(({ type }) => type.name);
}

/**
 * Normalised title key for exact-match dedup: case-folded, punctuation
 * stripped, whitespace collapsed and trimmed, leading article dropped. "The
 * Iron Gate" and "iron gate" collapse to the same key.
 *
 * Order matters: the whitespace pass runs BEFORE the article strip so that a
 * padded title keys the same as a clean one. With it the other way round a
 * leading space defeated the `^` anchor, '  The Iron Gate' kept its article,
 * and a generated title with stray padding missed the exact match against an
 * existing entity (and scored below the fuzzy threshold too) — so it was
 * written as a duplicate entity instead of an update.
 */
export function normalizeTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|a|an)\s+/, '');
}
