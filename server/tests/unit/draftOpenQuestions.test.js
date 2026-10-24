/**
 * Unit tests for the open-question half of `normalizeDraft`
 * (src/lib/draftNormalizer.js), added with KOL-016.
 *
 * Pass 3 of generation asks the model for the questions an author's notes leave
 * unanswered, and this is where that raw output becomes draft items. Everything
 * asserted here is a boundary between an unpredictable model and a collection
 * that has to stay a clean training corpus, so the suite is built around the
 * four things that boundary is for:
 *
 *   - the shape. `proposed` is the frozen payload the edit validator checks and
 *     the applier writes, so every item this produces is run through
 *     `validateItemPayload('open_question', …)` — the same check an edited
 *     payload gets. An item the normalizer can emit but an edit could not
 *     round-trip is a bug that would only surface at apply time.
 *   - the links. A question about an entity this same run proposes cannot carry
 *     an id yet, so it carries that item's localKey and lists it in
 *     `dependsOn`; a question about an entity the workspace already has carries
 *     the id as a STRING, like every other reference in `proposed`. Both forms
 *     end up in one flat `entry_ids` array, which is the shape
 *     `OpenQuestion.entry_ids` and `POST /open-questions` take.
 *   - what must not reach the review queue. A question the workspace already
 *     holds (there is no 'update' op for one — `applyOpenQuestion` only
 *     creates, so the alternative is a second copy), a question repeated within
 *     the run, and anything past the per-run cap. Each one is DROPPED WITH A
 *     REASON rather than silently skipped, because the count is what lets the
 *     UI say "1 item couldn't be used" instead of showing one fewer than it
 *     found.
 *   - the model's small slips, coerced where the intent is unambiguous: one
 *     name as a bare string where an array was asked for.
 *
 * Falsification checks, both run red against a deliberately broken normalizer:
 * remove the dedup and cap gates and exactly three tests fail — the question
 * the workspace already holds, the one repeated within the run, and the cap —
 * while the shape, link and coercion tests still pass; hand the existing
 * entity's `_id` through without `String()` and three fail — the edit validator
 * rejects an ObjectId where a string is required, and both link tests see the
 * wrong type — which is why the type is asserted and not only the value.
 *
 * Pure: no database, no provider. mongoose is imported only to mint an
 * ObjectId, and `validateItemPayload` queries only for an entity payload,
 * never for this kind.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { normalizeDraft } from '../../src/lib/draftNormalizer.js';
import { validateItemPayload } from '../../src/lib/draftItemSchema.js';
import { MAX_QUESTIONS } from '../../src/lib/generatorPrompts.js';

const CATEGORIES = ['Characters', 'Worlds'];

// Hard-wrapped on purpose: the quotes below span a line break, so locating
// evidence goes through the whitespace-insensitive path a real braindump needs.
const SOURCE = [
  'The Iron Gate stands at the edge of the world. Mira keeps it, though nobody',
  'remembers who built it. Maybe it was the Conductor — not sure yet.',
].join('\n');

// A real ObjectId, because the normalizer has to stringify it: `proposed` is
// JSON the edit validator checks, not a document.
const IRON_GATE = {
  _id: new mongoose.Types.ObjectId(),
  title: 'The Iron Gate',
  updatedAt: new Date('2026-01-02T03:04:05.000Z'),
};

/** Pass 1 output: one entity that does not exist yet, so it gets a localKey. */
const RAW_ENTITIES = [{ title: 'Mira', category: 'Characters', summary: 'Keeps the gate.' }];

/**
 * Pass 3 output as a model actually returns it — the fixture the suite is
 * named for. Each element is one of the cases the normalizer has to tell
 * apart, so the drop tests below can use it whole rather than re-stating it.
 */
const RAW_QUESTIONS = [
  {
    question: 'Who built the Iron Gate?',
    entities: ['Mira', 'The Iron Gate'],
    quote: 'nobody remembers who built it',
  },
  // One name as a bare string, which small models emit constantly.
  { question: 'Is the Conductor still alive?', entities: 'The Iron Gate', quote: 'Maybe it was the Conductor' },
  // Grounded in the notes as a whole rather than in any one entity.
  { question: 'How far does the world extend past the gate?', entities: [], quote: 'the edge of the world' },
];

function run(rawQuestions, { existingQuestions = [], existingEntities = [IRON_GATE] } = {}) {
  return normalizeDraft(RAW_ENTITIES, [], rawQuestions, {
    categories: CATEGORIES,
    sourceText: SOURCE,
    existingEntities,
    existingQuestions,
  });
}

const questions = items => items.filter(i => i.kind === 'open_question');

describe('normalizeDraft — open questions', () => {
  test('emits one item per question, after the entities, in the kind the applier knows', () => {
    const { items } = run(RAW_QUESTIONS);
    const qs = questions(items);

    assert.equal(qs.length, 3);
    assert.deepEqual(qs.map(q => q.localKey), ['q1', 'q2', 'q3']);
    // Entities first: a question's localKey resolves against them.
    assert.deepEqual(items.map(i => i.kind), ['entity', 'open_question', 'open_question', 'open_question']);
    assert.deepEqual(items.map(i => i.seq), [0, 1, 2, 3]);

    for (const q of qs) {
      assert.equal(q.kind, 'open_question');
      // A question is never matched against one that exists — it is dropped
      // when the workspace already holds it — so there is no update op here.
      assert.equal(q.op, 'create');
      assert.equal(q.matchedBy, 'none');
    }
  });

  test('`proposed` is exactly what the edit validator accepts', async () => {
    const { items } = run(RAW_QUESTIONS);

    for (const q of questions(items)) {
      const res = await validateItemPayload('open_question', q.proposed, null);
      assert.ok(res.ok, `the normalizer emitted a payload an edit could not: ${res.error}`);
      assert.deepEqual(Object.keys(q.proposed).sort(), ['entry_ids', 'question']);
    }
  });

  test('links an entity from this run by localKey and declares the dependency', () => {
    const [q1] = questions(run(RAW_QUESTIONS).items);

    assert.equal(q1.proposed.question, 'Who built the Iron Gate?');
    assert.deepEqual(q1.proposed.entry_ids, ['e1', String(IRON_GATE._id)]);
    // Only the local one is a dependency: the existing entity is already there.
    assert.deepEqual(q1.dependsOn, ['e1']);
    assert.deepEqual(q1.flags, []);
    // Every reference in `proposed` is a string, not an ObjectId: this payload
    // is JSON the edit validator checks and the exporter carries out.
    for (const id of q1.proposed.entry_ids) assert.equal(typeof id, 'string');
  });

  test('locates the evidence span server-side, across the line break', () => {
    const [q1] = questions(run(RAW_QUESTIONS).items);

    const ev = q1.input.evidence;
    assert.ok(ev.charStart !== null, 'the quote was not located');
    assert.equal(SOURCE.slice(ev.charStart, ev.charEnd).replace(/\s+/g, ' '), 'nobody remembers who built it');
  });

  test('coerces one name given as a bare string, rather than dropping the question', () => {
    const [, q2] = questions(run(RAW_QUESTIONS).items);

    assert.equal(q2.proposed.question, 'Is the Conductor still alive?');
    assert.deepEqual(q2.proposed.entry_ids, [String(IRON_GATE._id)]);
    assert.deepEqual(q2.dependsOn, []);
  });

  test('keeps a question that is tied to no entity at all', () => {
    const [, , q3] = questions(run(RAW_QUESTIONS).items);

    assert.deepEqual(q3.proposed.entry_ids, []);
    assert.deepEqual(q3.dependsOn, []);
    assert.deepEqual(q3.flags, []);
  });

  test('flags a question whose quote is missing, and keeps it', () => {
    const { items } = run([{ question: 'Where does the line end?', entities: [] }]);
    const [q1] = questions(items);

    assert.ok(q1.flags.includes('no_evidence'));
    assert.equal(q1.input.evidence.quote, '');
    assert.equal(q1.input.evidence.charStart, null);
  });

  test('drops a name that matches no entity, flags the item, and keeps the question', () => {
    const { items, dropReasons } = run([
      { question: 'Who built the Iron Gate?', entities: ['Mira', 'Silas'], quote: 'nobody remembers who built it' },
    ]);
    const [q1] = questions(items);

    assert.deepEqual(q1.proposed.entry_ids, ['e1'], 'the resolvable link survives');
    assert.ok(q1.flags.includes('link_dropped'));
    assert.ok(dropReasons.some(r => r.includes('"Silas"')), dropReasons.join('; '));
  });

  test('drops a question the workspace already holds, ignoring case and the question mark', () => {
    const { items, dropReasons } = run(RAW_QUESTIONS, {
      existingQuestions: [{ _id: 'oq-1', question: 'who built the iron gate' }],
    });
    const qs = questions(items);

    assert.deepEqual(qs.map(q => q.proposed.question), [
      'Is the Conductor still alive?',
      'How far does the world extend past the gate?',
    ]);
    // Renumbered from q1: the keys are the server's, not the model's.
    assert.deepEqual(qs.map(q => q.localKey), ['q1', 'q2']);
    assert.ok(dropReasons.some(r => r.includes('already in this workspace')), dropReasons.join('; '));
  });

  test('a question the workspace holds in a different wording is a different question', () => {
    const { items } = run(RAW_QUESTIONS, {
      existingQuestions: [{ _id: 'oq-1', question: 'Who built the gate?' }],
    });

    assert.equal(questions(items).length, 3, 'nothing fuzzier than exact wording may drop a question');
  });

  test('drops a question repeated within the same run', () => {
    const { items, dropReasons } = run([
      RAW_QUESTIONS[0],
      { ...RAW_QUESTIONS[0], question: '  WHO BUILT THE IRON GATE  ' },
    ]);

    assert.equal(questions(items).length, 1);
    assert.ok(dropReasons.some(r => r.includes('duplicate open question')), dropReasons.join('; '));
  });

  test('drops a malformed question rather than failing the run', () => {
    const { items, dropReasons } = run([
      { entities: [], quote: 'the edge of the world' },           // no question at all
      { question: '', entities: [] },                             // empty
      RAW_QUESTIONS[0],                                           // the good one still lands
    ]);

    assert.deepEqual(questions(items).map(q => q.localKey), ['q1']);
    assert.equal(dropReasons.filter(r => r.startsWith('open question failed validation')).length, 2);
  });

  test('enforces the per-run cap the prompt asks for, and says so', () => {
    const many = Array.from({ length: MAX_QUESTIONS + 4 }, (_, i) => ({
      question: `Open question number ${i}?`,
      entities: [],
    }));
    const { items, dropReasons } = run(many);

    assert.equal(questions(items).length, MAX_QUESTIONS);
    assert.ok(dropReasons.some(r => r.includes('open-question cap reached')), dropReasons.join('; '));
  });

  test('a run with no questions is unchanged (positive control)', () => {
    const { items, dropReasons } = run([]);

    assert.deepEqual(questions(items), []);
    assert.equal(items.length, 1, 'the entity item still lands');
    assert.deepEqual(dropReasons, []);
  });
});
