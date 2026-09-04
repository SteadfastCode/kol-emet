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

export function similarity(a, b) {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  const intersection = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return intersection / union;
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
 * stripped, leading article dropped, whitespace collapsed. "The Iron Gate" and
 * "iron gate" collapse to the same key.
 */
export function normalizeTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
