/**
 * Source coverage: "here is the text I did not use".
 *
 * Every draft item already stores the quote it was built from, located back
 * into `source.text` as charStart/charEnd (server/src/lib/draftNormalizer.js).
 * These pin the derivation of the complement — merge the located spans, and
 * what is left is what no proposal cites — plus the two things that make the
 * number honest rather than decorative:
 *
 *   - the segments cover the source exactly once, so the in-context view can
 *     never lose or repeat a character of what the person wrote;
 *   - a quote that never located is counted and said out loud, because it
 *     leaves its span looking unused and would otherwise be read as the
 *     generator having skipped that passage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import SourceCoverage from './SourceCoverage.vue';
import DraftReview from './DraftReview.vue';
import { coverageOf } from '../../lib/sourceCoverage.js';

const FIRST  = 'The Iron Gate stands at the end of the line.';
const MIDDLE = 'Nobody remembers who built it, and the maps that named it burned.';
const LAST   = 'The Conductor keeps the key on a chain at her belt.';
const SOURCE = [FIRST, MIDDLE, LAST].join('\n\n');

/** The shape locateEvidence stores: the quote, plus where it was found. */
function evidenceFor(quote) {
  const at = SOURCE.indexOf(quote);
  if (at === -1) throw new Error(`fixture quote is not in the source: ${quote}`);
  return { quote, charStart: at, charEnd: at + quote.length, chunkIndex: 0 };
}

const item = (localKey, evidence) => ({
  _id: `id-${localKey}`,
  localKey,
  seq: Number(localKey.slice(1)),
  kind: 'entity',
  op: 'create',
  input: { evidence, contextEntityIds: [] },
  proposed: { title: `Item ${localKey}`, category: 'Characters', summary: '', tags: [], blocks: [] },
  accepted: null,
  decision: 'pending',
  applyState: 'pending',
  flags: [],
});

const draftWith = (items, { _id = 'draft1', text = SOURCE, producer = 'braindump' } = {}) => ({
  _id,
  status: 'ready',
  source: { producer, producerVersion: 'braindump@1', text },
  items,
  counts: { proposed: items.length, pending: items.length, dropped: 0 },
});

beforeEach(() => { localStorage.setItem('SOURCE_COVERAGE_LOG_LEVEL', 'off'); });
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

describe('coverageOf', () => {
  it('marks everything outside the one evidence span as uncovered', () => {
    const c = coverageOf(draftWith([item('e1', evidenceFor(FIRST))]));

    expect(c.hasSource).toBe(true);
    expect(c.locatedCount).toBe(1);
    expect(c.spanCount).toBe(1);

    // used first sentence, then one unused run to the end of the notes
    expect(c.segments.map(s => s.used)).toEqual([true, false]);
    expect(c.segments[0]).toMatchObject({ start: 0, end: FIRST.length, used: true, text: FIRST });
    expect(c.segments[1]).toMatchObject({ start: FIRST.length, end: SOURCE.length, used: false });

    expect(c.unused).toHaveLength(1);
    expect(c.unused[0].text).toContain(MIDDLE);
    expect(c.unused[0].text).toContain(LAST);
    expect(c.unused[0].start).toBe(FIRST.length);
    expect(c.unused[0].line).toBe(3);   // where the unused text starts reading

    expect(c.usedPct).toBeGreaterThan(0);
    expect(c.usedPct).toBeLessThan(100);
  });

  it('covers the source exactly once, in order', () => {
    const c = coverageOf(draftWith([
      item('e1', evidenceFor(LAST)),
      item('e2', evidenceFor(FIRST)),
    ]));
    expect(c.segments.map(s => s.text).join('')).toBe(SOURCE);
    for (let i = 1; i < c.segments.length; i++) {
      expect(c.segments[i].start).toBe(c.segments[i - 1].end);
    }
    // the middle paragraph is the only thing nothing cites
    expect(c.unused.map(p => p.text.trim())).toEqual([MIDDLE]);
    expect(c.unused[0].line).toBe(3);
  });

  it('merges overlapping and touching spans rather than double-counting them', () => {
    const text = 'abcdefghij';
    const spans = [[0, 4], [2, 6], [6, 8]].map(([charStart, charEnd], i) =>
      item(`e${i + 1}`, { quote: text.slice(charStart, charEnd), charStart, charEnd, chunkIndex: 0 }));
    const c = coverageOf(draftWith(spans, { text, _id: 'draft-merge' }));

    expect(c.spanCount).toBe(1);
    expect(c.usedChars).toBe(8);
    expect(c.segments).toHaveLength(2);
    expect(c.segments[1]).toMatchObject({ start: 8, end: 10, used: false });
    expect(c.usedPct).toBe(80);
  });

  it('counts a quote that never located instead of inventing a span for it', () => {
    const c = coverageOf(draftWith([
      item('e1', evidenceFor(FIRST)),
      item('e2', { quote: 'a line the model paraphrased', charStart: null, charEnd: null, chunkIndex: 0 }),
      item('e3', { quote: '', charStart: null, charEnd: null, chunkIndex: 0 }),
    ], { _id: 'draft-unlocated' }));

    expect(c.locatedCount).toBe(1);
    expect(c.unlocatedCount).toBe(1);
    expect(c.noEvidenceCount).toBe(1);
    expect(c.spanCount).toBe(1);
  });

  it('clamps an offset that points outside the stored source', () => {
    const c = coverageOf(draftWith([
      item('e1', { quote: FIRST, charStart: -5, charEnd: FIRST.length, chunkIndex: 0 }),
      item('e2', { quote: LAST, charStart: SOURCE.length - 4, charEnd: SOURCE.length + 900, chunkIndex: 0 }),
      item('e3', { quote: 'past the end', charStart: SOURCE.length + 10, charEnd: SOURCE.length + 22, chunkIndex: 0 }),
    ], { _id: 'draft-clamp' }));

    expect(c.segments[0]).toMatchObject({ start: 0, end: FIRST.length, used: true });
    expect(c.segments.at(-1)).toMatchObject({ start: SOURCE.length - 4, end: SOURCE.length, used: true });
    expect(c.segments.map(s => s.text).join('')).toBe(SOURCE);
    // A span wholly outside the text located nowhere, which is what the
    // caveat line in the pane is about.
    expect(c.unlocatedCount).toBe(1);
  });

  it('measures non-whitespace, so blank lines cannot drag the percentage down', () => {
    const text = `${FIRST}\n\n\n\n\n\n`;
    const c = coverageOf(draftWith([
      item('e1', { quote: FIRST, charStart: 0, charEnd: FIRST.length, chunkIndex: 0 }),
    ], { text, _id: 'draft-ws' }));

    expect(c.usedPct).toBe(100);
    expect(c.unused).toEqual([]);          // trailing newlines are not a passage
    expect(c.segments.map(s => s.text).join('')).toBe(text);
  });

  it('never rounds "nearly all of it" up to all of it', () => {
    const text = `${'a'.repeat(20000)} ${MIDDLE}`;
    const c = coverageOf(draftWith([
      item('e1', { quote: 'a'.repeat(20000), charStart: 0, charEnd: 20000, chunkIndex: 0 }),
    ], { text, _id: 'draft-round' }));

    expect(c.usedPct).toBe(99);
    expect(c.unused.map(p => p.text.trim())).toEqual([MIDDLE]);
  });

  it('ignores the glue between two adjacent quotes', () => {
    const text = `${FIRST} and ${LAST}`;
    const c = coverageOf(draftWith([
      item('e1', { quote: FIRST, charStart: 0, charEnd: FIRST.length, chunkIndex: 0 }),
      item('e2', { quote: LAST, charStart: text.indexOf(LAST), charEnd: text.length, chunkIndex: 0 }),
    ], { text, _id: 'draft-glue' }));

    expect(c.segments.filter(s => !s.used)).toHaveLength(1);   // " and " is still rendered
    expect(c.unused).toEqual([]);                              // but it is not a passage you skipped
  });

  it('reports nothing for a draft with no stored source', () => {
    const c = coverageOf(draftWith([], { text: '', _id: 'draft-empty' }));
    expect(c.hasSource).toBe(false);
    expect(c.usedPct).toBe(0);
    expect(c.unused).toEqual([]);
  });

  it('calls a file a file', () => {
    expect(coverageOf(draftWith([], { producer: 'docker-compose', _id: 'draft-compose' })).label).toBe('this file');
    expect(coverageOf(draftWith([], { _id: 'draft-notes' })).label).toBe('your notes');
  });

  it('light tier names the draft and what asked for the measurement', () => {
    localStorage.setItem('SOURCE_COVERAGE_LOG_LEVEL', 'light');
    const logged = [];
    vi.stubGlobal('console', { ...console, log: (m) => logged.push(m) });

    coverageOf(draftWith([item('e1', evidenceFor(FIRST))], { _id: 'draft-log' }), { source: 'a test' });

    const light = logged.find(l => l.startsWith('[coverage:light]'));
    expect(light).toBeTruthy();
    expect(light).toContain('draft-log');
    expect(light).toContain('a test');
    expect(light).toContain('1 passage(s) unused');
    expect(logged.some(l => l.startsWith('[coverage:normal]'))).toBe(false);
  });
});

describe('SourceCoverage pane', () => {
  const paneFor = (draft) => mount(SourceCoverage, { props: { draft } });

  it('leads with the headline and opens onto the unused passages', async () => {
    const wrapper = paneFor(draftWith([item('e1', evidenceFor(FIRST))]));

    const head = wrapper.get('.cov-head');
    expect(head.text()).toContain('went into this draft');
    expect(head.text()).toContain('1 passage unused');
    expect(head.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('.cov-body').exists()).toBe(false);

    await head.trigger('click');
    expect(head.attributes('aria-expanded')).toBe('true');
    const passages = wrapper.findAll('.cov-passage');
    expect(passages).toHaveLength(1);
    expect(passages[0].text()).toContain(MIDDLE);
    expect(passages[0].text()).toContain(LAST);
  });

  it('shows the whole source in context, with the used spans marked apart', async () => {
    const wrapper = paneFor(draftWith([item('e1', evidenceFor(FIRST))]));
    await wrapper.get('.cov-head').trigger('click');
    await wrapper.findAll('.mode')[1].trigger('click');

    const pre = wrapper.get('.cov-text');
    expect(pre.text()).toBe(SOURCE);
    expect(pre.findAll('.seg-used')).toHaveLength(1);
    expect(pre.get('.seg-used').text()).toBe(FIRST);
    expect(pre.findAll('.seg-unused')).toHaveLength(1);
    expect(wrapper.find('.cov-list').exists()).toBe(false);
  });

  it('says so when a quote could not be found, rather than letting the number stand alone', async () => {
    const wrapper = paneFor(draftWith([
      item('e1', evidenceFor(FIRST)),
      item('e2', { quote: 'paraphrased', charStart: null, charEnd: null, chunkIndex: 0 }),
    ], { _id: 'draft-pane-caveat' }));
    await wrapper.get('.cov-head').trigger('click');

    expect(wrapper.get('.cov-caveat').text()).toContain("couldn't be found in your notes");
    expect(wrapper.get('.cov-foot').text()).toContain('1 of 2 located');
  });

  it('says plainly when nothing was left out', async () => {
    const wrapper = paneFor(draftWith([
      item('e1', evidenceFor(FIRST)),
      item('e2', evidenceFor(MIDDLE)),
      item('e3', evidenceFor(LAST)),
    ], { _id: 'draft-pane-full' }));

    expect(wrapper.get('.cov-head').text()).toContain('nothing substantial was left out');
    await wrapper.get('.cov-head').trigger('click');
    expect(wrapper.get('.cov-empty').text()).toContain('at least one proposal');
  });

  it('renders nothing for a draft whose source was not stored', () => {
    expect(paneFor(draftWith([], { text: '', _id: 'draft-pane-empty' })).find('.coverage').exists()).toBe(false);
    expect(paneFor(null).find('.coverage').exists()).toBe(false);
  });
});

describe('DraftReview', () => {
  it('carries the pane for the draft it loaded', async () => {
    const draft = draftWith([item('e1', evidenceFor(FIRST))], { _id: 'draft-review' });
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      expect(new URL(url, 'http://localhost').pathname).toBe('/drafts/draft-review');
      return new Response(JSON.stringify(draft), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }));

    const wrapper = mount(DraftReview, { props: { draftId: 'draft-review' } });
    await flushPromises();

    const head = wrapper.get('.coverage .cov-head');
    expect(head.text()).toContain('1 passage unused');
    await head.trigger('click');
    expect(wrapper.get('.cov-passage').text()).toContain(MIDDLE);
  });
});
