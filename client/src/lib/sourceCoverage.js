/**
 * Source coverage for a draft: which parts of the text a generation was run
 * over actually ended up behind a proposal, and — the point of it — which
 * parts did not.
 *
 * Every draft item stores the quote it was built from, located back into
 * `source.text` server-side as `charStart`/`charEnd` (lib/draftNormalizer.js
 * locateEvidence; the producers do the same for a file). So the uncovered
 * spans are already derivable and need no new server field: merge the located
 * spans, and what is left over is "here is the text I did not use".
 *
 * Two sets of spans, not one. An entity update the graph already satisfies is
 * dropped before the draft is stored (server/src/lib/draftTarget.js), and the
 * passage it quoted goes on the draft as `source.droppedSpans` because there is
 * no item left to carry it. Those passages WERE read — that is how the entity
 * got into the graph — so they count as used, and on the workflow where the
 * drop earns its keep, re-generating over the same notes, they are most of the
 * text. The two are merged together and counted apart, so the pane can say
 * which number came from where.
 *
 * A review's failure mode is believing the generator read everything. A span
 * nothing cites is the one thing the item list cannot show you, because the
 * item that would have shown it is the item that was never proposed.
 *
 * Offsets are against the WHOLE of `source.text` (normalizeDraft is handed the
 * full source, not a chunk), so `chunkIndex` plays no part here.
 *
 * Tiered debug logging: set localStorage.SOURCE_COVERAGE_LOG_LEVEL to
 * off | light | normal | verbose (default light). Coverage is only as good as
 * the offsets upstream produced, and a model-supplied quote that never located
 * is invisible in the UI beyond one caveat line, so the tiers exist to tell
 * "the generator ignored half the notes" from "the quotes did not locate".
 *   light   — one line per draft measured, naming which draft and what asked
 *             for it, how many items carried a usable span, how many did not,
 *             and how many spans came from items dropped before storage
 *   normal  — light, plus the merged span count and each item whose quote
 *             never located, by localKey
 *   verbose — normal, plus every unused passage's offsets and opening words
 *
 * Re-logged only when the measurement changes: the computed re-runs on every
 * decision a reviewer makes, and none of those change coverage.
 */

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  let setting = null;
  try { setting = localStorage.getItem('SOURCE_COVERAGE_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((LEVELS[setting] ?? LEVELS.light) >= LEVELS[level]) console.log(`[coverage:${level}] ${msg}`);
}

let lastLogged = null;

/**
 * A gap counts as a passage you did not use only if there is something in it to
 * read. The glue between two adjacent quotes — a comma, a newline, "and" — is
 * not text that was skipped, and listing it would bury the paragraphs that
 * were. The in-context view still shows every character either way, so this
 * threshold governs the list and the headline count, never what is rendered.
 */
const MIN_PASSAGE_CHARS = 12;
const isPassage = (text) => {
  const t = text.trim();
  return t.length >= MIN_PASSAGE_CHARS && /\p{L}{2,}/u.test(t);
};

/** Non-whitespace characters, so blank lines in a note cannot drag the percentage down. */
const substance = (text) => (text.match(/\S/gu) ?? []).length;

/** What to call the source in the UI — notes were written, a file was handed over. */
function labelFor(producer) {
  return producer && producer !== 'braindump' ? 'this file' : 'your notes';
}

/**
 * Clamps one stored span to the text it indexes, or returns nothing when it
 * indexes none of it.
 *
 * Clamp rather than trust: the offsets were computed against a `source.text`
 * that is stored next to them, but a redaction pass or an edited fixture can
 * leave a span pointing past the end, and `slice` would silently return ''.
 */
function clampSpan(charStart, charEnd, textLength) {
  if (!Number.isFinite(charStart) || !Number.isFinite(charEnd)) return null;
  const start = Math.max(0, Math.min(Math.trunc(charStart), textLength));
  const end = Math.max(0, Math.min(Math.trunc(charEnd), textLength));
  return end > start ? [start, end] : null;
}

/**
 * Merges the located evidence spans of `items` and the draft's own
 * `droppedSpans`, clamped to `textLength`.
 * Returns `[start, end]` pairs, sorted, non-overlapping, none empty.
 */
function mergeSpans(items, textLength, droppedSpans = []) {
  const spans = [];
  const unlocated = [];
  let noEvidence = 0;

  for (const item of items) {
    const ev = item?.input?.evidence ?? {};
    const { charStart, charEnd } = ev;
    const quote = String(ev.quote ?? '');

    const span = clampSpan(charStart, charEnd, textLength);
    if (span) { spans.push(span); continue; }
    // Offsets that clamped to nothing point outside the stored text, so that
    // quote located nowhere either. A quote with no offsets at all is the same
    // failure; no quote at all is an item the generator never grounded (the
    // `no_evidence` flag already says so on the card). The last is counted
    // apart because only the other two understate coverage.
    if ((Number.isFinite(charStart) && Number.isFinite(charEnd)) || quote.trim()) {
      unlocated.push(item.localKey ?? item._id ?? '?');
    } else {
      noEvidence++;
    }
  }

  // The items' own spans, before the draft's are added: this is the count the
  // pane reports against the item list, and there is no item behind the rest.
  const located = spans.length;

  // Items dropped before the draft was stored have no item left to carry their
  // span, so the draft carries it (server/src/lib/draftTarget.js). A span here
  // is one the generator read and proposed from; the proposal was dropped only
  // because the graph already held it.
  let droppedLocated = 0;
  for (const s of Array.isArray(droppedSpans) ? droppedSpans : []) {
    const span = clampSpan(s?.charStart, s?.charEnd, textLength);
    if (!span) continue;
    spans.push(span);
    droppedLocated++;
  }

  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  return { merged, unlocated, noEvidence, located, droppedLocated };
}

/**
 * Measures one draft (as GET /drafts/:id returns it).
 *
 * `source` names the caller, for the log.
 */
export function coverageOf(draft, { source = 'unknown' } = {}) {
  const text = String(draft?.source?.text ?? '');
  const items = Array.isArray(draft?.items) ? draft.items : [];
  const label = labelFor(draft?.source?.producer);

  const { merged, unlocated, noEvidence, located, droppedLocated } =
    mergeSpans(items, text.length, draft?.source?.droppedSpans);

  // Alternating used/unused segments covering the whole text exactly once, so
  // the in-context view can render the source with nothing lost or repeated.
  const segments = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ start: cursor, end: start, used: false, text: text.slice(cursor, start) });
    segments.push({ start, end, used: true, text: text.slice(start, end) });
    cursor = end;
  }
  if (cursor < text.length) {
    segments.push({ start: cursor, end: text.length, used: false, text: text.slice(cursor) });
  }

  const unused = segments
    .filter(s => !s.used && isPassage(s.text))
    .map((s) => {
      // The line of the first thing there is to read, not of the gap's first
      // character: a gap starts at the newline that ended the quote before it,
      // which would point a line short of the passage every time.
      const at = s.start + (s.text.length - s.text.trimStart().length);
      return { ...s, line: 1 + (text.slice(0, at).match(/\n/g) ?? []).length };
    });

  const totalChars = substance(text);
  const usedChars = merged.reduce((n, [start, end]) => n + substance(text.slice(start, end)), 0);
  let usedPct = totalChars ? Math.round((usedChars / totalChars) * 100) : 0;
  // Never round away the distinction the pane exists to make: "all of it" and
  // "nearly all of it" must not read the same.
  if (usedPct === 100 && usedChars < totalChars) usedPct = 99;
  if (usedPct === 0 && usedChars > 0) usedPct = 1;

  const coverage = {
    hasSource: text.length > 0,
    label,
    text,
    segments,
    unused,
    usedPct,
    usedChars,
    totalChars,
    spanCount: merged.length,
    locatedCount: located,
    unlocatedCount: unlocated.length,
    noEvidenceCount: noEvidence,
    droppedSpanCount: droppedLocated,
  };

  const signature = [
    draft?._id ?? '?', text.length, items.length,
    located, droppedLocated, unlocated.length, noEvidence, usedPct, unused.length,
  ].join(':');
  if (signature !== lastLogged) {
    lastLogged = signature;
    log('light', `measured draft ${draft?._id ?? '(unsaved)'} for ${source}: `
      + `${located}/${items.length} item(s) carried a usable span, ${unlocated.length} quote(s) never located, `
      + `${noEvidence} item(s) had no quote, ${droppedLocated} span(s) came from the draft itself `
      + `(source: items dropped as already in the graph before it was stored); `
      + `${usedPct}% of ${label} used, ${unused.length} passage(s) unused`);
    log('normal', `${merged.length} merged span(s) over ${text.length} char(s)`
      + (unlocated.length ? `; quotes that never located: ${unlocated.join(', ')}` : ''));
    for (const p of unused) {
      log('verbose', `unused ${p.start}-${p.end} (line ${p.line}): ${JSON.stringify(p.text.trim().slice(0, 60))}`);
    }
  }

  return coverage;
}
