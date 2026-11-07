/**
 * The create / update / nothing-left decision, over the braindump path
 * (src/lib/draftTarget.js, driven through src/lib/draftNormalizer.js exactly as
 * src/lib/generator.js drives it).
 *
 * The applier appends and never overwrites (draftApplier.js, rule 2), so a
 * proposed block the target entity already carries lands as a SECOND copy of
 * it. The file producers had been defended against that since the compose one
 * shipped — the route fetches the matched targets and prunes — and the
 * braindump path had nothing: `normalizeDraft` turns the model's body into one
 * text block and marks the item `op: 'update'` on an exact normalized-title
 * match, and nothing compared it against what the entity held. So generating
 * twice over the same notes, or over a superset of them (add a paragraph,
 * re-generate — the workflow the overlay invites), appended a byte-identical
 * text block to every entity it matched.
 *
 * The second half is what makes the first worth fixing properly: once the known
 * blocks come off, an item can be left proposing NOTHING — no block, no tag the
 * entity lacks, and a summary the applier will not write over — and such an
 * item was still queued as a decision, unflagged, so `decide-clean` accepted it
 * and the apply wrote a `ChangeLog` row with an empty diff. It is dropped here
 * instead, counted in `diagnostics.dropReasons`.
 *
 * Dropping an item is the part with teeth, which is what most of this suite is
 * about: a relationship member and an open question's `entry_ids` can name the
 * dropped item by localKey, and nothing may be left pointing at an item that is
 * gone — the apply would block it, and the evidence line it was located in
 * would vanish from the draft, which is where source coverage is derived from
 * (client/src/lib/sourceCoverage.js). `mergedSpans` below is that derivation,
 * mirrored over the server-side items.
 *
 * Falsification check: run against the pre-fix path (`entityTarget` without the
 * prune and `pruneAgainstTargets` returning its input untouched), 7 of these 14
 * fail — every case that asserts a block the target already holds came off, or
 * that an item writing nothing is gone and nothing is left pointing at it —
 * while the controls pass: a create, a target holding none of it, a tag and a
 * summary and a block the target lacks, and a target that came back absent. So
 * the suite fails for the stated reason rather than by construction.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeDraft } from '../../src/lib/draftNormalizer.js';
import { entityTarget, withoutKnownBlocks, pruneAgainstTargets } from '../../src/lib/draftTarget.js';

const CATEGORIES = ['Characters', 'Worlds'];
const SOURCE = 'The Iron Gate stands at the edge of the world.\nMira keeps it.';

const MIRA = { _id: 'entity-mira', title: 'Mira', updatedAt: new Date('2026-01-02T03:04:05.000Z') };

const BODY = 'Mira keeps the gate, and has since the second age.';
const TEXT_BLOCK = { type: 'text', order: 0, data: { markdown: BODY } };

const rawMira = {
  title: 'Mira', category: 'Characters', summary: 'The keeper of the gate.',
  body: BODY, tags: ['keeper'], quote: 'Mira keeps it.',
};
const rawGate = {
  title: 'The Iron Gate', category: 'Worlds', summary: 'A gate.',
  body: 'It stands at the edge.', tags: [], quote: 'The Iron Gate stands at the edge of the world.',
};
const rawRelationship = {
  label: 'Guardianship',
  members: [{ name: 'Mira', role: 'Keeper' }, { name: 'The Iron Gate', role: 'Kept' }],
  quote: 'Mira keeps it.',
};
const rawQuestion = {
  question: 'Who built the gate?', entities: ['Mira'],
  quote: 'The Iron Gate stands at the edge of the world.',
};

/** What generateDraft does: normalize against the roster, then prune against
 *  the entities the run matched, fetched by id with their blocks/tags/summary. */
function generate(target, { raw = [rawMira, rawGate], relationships = [rawRelationship], questions = [rawQuestion] } = {}) {
  const { items, dropReasons } = normalizeDraft(raw, relationships, questions, {
    categories: CATEGORIES, sourceText: SOURCE, existingEntities: [MIRA],
  });
  const pruned = pruneAgainstTargets(items, target ? new Map([[String(MIRA._id), target]]) : new Map());
  return { items: pruned.items, dropReasons: [...dropReasons, ...pruned.dropReasons] };
}

const entityItem = (items, title) => items.find(i => i.kind === 'entity' && i.proposed.title === title);
const only = (items, kind) => items.filter(i => i.kind === kind);

/** The client's coverage derivation, over these items: merged located spans. */
function mergedSpans(items) {
  const spans = items
    .map(i => i.input.evidence)
    .filter(ev => Number.isFinite(ev.charStart) && Number.isFinite(ev.charEnd) && ev.charEnd > ev.charStart)
    .map(ev => [ev.charStart, ev.charEnd])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
const covers = (merged, [start, end]) => merged.some(([s, e]) => s <= start && e >= end);

describe('entityTarget — the decision itself', () => {
  test('no match is a create, and the blocks pass through', () => {
    const blocks = [TEXT_BLOCK];
    assert.deepEqual(entityTarget(null, blocks), {
      op: 'create', targetEntityId: null, baseUpdatedAt: null, matchedBy: 'none', blocks,
    });
  });

  test('a match is an update against the live entity, on the title it matched', () => {
    const out = entityTarget(MIRA, [TEXT_BLOCK]);
    assert.equal(out.op, 'update');
    assert.equal(out.targetEntityId, MIRA._id);
    assert.equal(out.baseUpdatedAt, MIRA.updatedAt);
    assert.equal(out.matchedBy, 'exact-normalized-title');
  });

  test('a match whose blocks the caller has prunes them there and then', () => {
    // A caller matching against an enriched roster needs no second pass; one
    // matching against `_id title updatedAt` gets the same result from
    // pruneAgainstTargets. The two must not disagree.
    const out = entityTarget({ ...MIRA, blocks: [TEXT_BLOCK] }, [TEXT_BLOCK]);
    assert.deepEqual(out.blocks, []);
    assert.deepEqual(withoutKnownBlocks([TEXT_BLOCK], [TEXT_BLOCK]), []);
  });

  test('a target with no blocks loaded is not read as a target with none', () => {
    assert.deepEqual(entityTarget(MIRA, [TEXT_BLOCK]).blocks, [TEXT_BLOCK]);
  });
});

describe('the braindump path, over an entity the workspace already has', () => {
  test('a text block the target already holds is not proposed a second time', () => {
    const { items } = generate({ blocks: [TEXT_BLOCK], tags: [], summary: '' });
    const mira = entityItem(items, 'Mira');
    assert.equal(mira.op, 'update');
    assert.equal(String(mira.targetEntityId), String(MIRA._id));
    assert.deepEqual(mira.proposed.blocks, [], 'the one block the model produced is the one the entity holds');
  });

  test('an update left proposing nothing is absent from the items and named in dropReasons', () => {
    const { items, dropReasons } = generate({ blocks: [TEXT_BLOCK], tags: ['keeper'], summary: 'Written by hand' });
    assert.equal(entityItem(items, 'Mira'), undefined);
    assert.ok(dropReasons.includes('entity "Mira" is already in this workspace and unchanged'),
      `dropReasons were ${JSON.stringify(dropReasons)}`);
    // The run still proposed the entity it had not seen before.
    assert.equal(entityItem(items, 'The Iron Gate').op, 'create');
    assert.deepEqual(items.map(i => i.seq), items.map((_, i) => i), 'seq is closed up');
  });

  test('a dropped item does not blank the source span it was located in', () => {
    const { items: before } = generate(null);
    const dropped = entityItem(before, 'Mira');
    const span = [dropped.input.evidence.charStart, dropped.input.evidence.charEnd];
    assert.ok(Number.isFinite(span[0]), 'fixture must locate the quote it is about to lose');

    const { items } = generate({ blocks: [TEXT_BLOCK], tags: ['keeper'], summary: 'Written by hand' });
    assert.equal(entityItem(items, 'Mira'), undefined);
    assert.ok(covers(mergedSpans(items), span),
      `the span ${span} the dropped item cited is no longer covered by ${JSON.stringify(mergedSpans(items))}`);
  });

  test('a relationship that named the dropped item points at the entity by id instead', () => {
    const { items } = generate({ blocks: [TEXT_BLOCK], tags: ['keeper'], summary: 'Written by hand' });
    const [rel] = only(items, 'relationship');
    assert.ok(rel, 'the link survives — the entity is in the graph, which is why its item went away');

    const mira = rel.proposed.members.find(m => m.name === 'Mira');
    assert.equal(mira.localKey, null);
    assert.equal(String(mira.refId), String(MIRA._id));
    assert.equal(mira.label, 'Keeper', 'the role the model gave it is untouched');
    // The gate is still a sibling item, so it is still a localKey dependency.
    assert.deepEqual(rel.dependsOn, ['e2']);
    assert.ok(rel.dependsOn.every(k => items.some(i => i.localKey === k)),
      'nothing depends on an item that is gone');
  });

  test("an open question's entry_ids carry the entity id, not the key of a dropped item", () => {
    const { items } = generate({ blocks: [TEXT_BLOCK], tags: ['keeper'], summary: 'Written by hand' });
    const [question] = only(items, 'open_question');
    assert.deepEqual(question.proposed.entry_ids, [String(MIRA._id)]);
    assert.deepEqual(question.dependsOn, []);
  });
});

describe('an update that still writes something survives', () => {
  test('a target holding none of it is proposed in full', () => {
    const { items, dropReasons } = generate({ blocks: [], tags: [], summary: 'Written by hand' });
    const mira = entityItem(items, 'Mira');
    assert.deepEqual(mira.proposed.blocks, [{ type: 'text', order: 0, data: { markdown: BODY } }]);
    assert.deepEqual(dropReasons, []);
    const [rel] = only(items, 'relationship');
    assert.equal(rel.proposed.members.find(m => m.name === 'Mira').localKey, 'e1',
      'an item that stayed keeps the localKey its dependents were given');
  });

  test('one tag the target lacks is a write, so the item is still a decision', () => {
    const { items, dropReasons } = generate({ blocks: [TEXT_BLOCK], tags: [], summary: 'Written by hand' });
    const mira = entityItem(items, 'Mira');
    assert.deepEqual(mira.proposed.blocks, []);
    assert.deepEqual(mira.proposed.tags, ['keeper']);
    assert.deepEqual(dropReasons, []);
  });

  test('a summary the applier would fill in is a write too', () => {
    // applyEntityUpdate writes the summary only when the entity has none, so
    // this is the one case where a proposal with no blocks and no new tag still
    // changes the graph.
    const { items, dropReasons } = generate({ blocks: [TEXT_BLOCK], tags: ['keeper'], summary: '' });
    assert.equal(entityItem(items, 'Mira').proposed.summary, 'The keeper of the gate.');
    assert.deepEqual(dropReasons, []);
  });

  test('a block the target does not hold is a write', () => {
    const { items, dropReasons } = generate(
      { blocks: [{ type: 'text', order: 0, data: { markdown: 'Something else entirely.' } }], tags: ['keeper'], summary: 'Written by hand' },
    );
    assert.deepEqual(entityItem(items, 'Mira').proposed.blocks, [{ type: 'text', order: 0, data: { markdown: BODY } }]);
    assert.deepEqual(dropReasons, []);
  });

  test('an entity no longer in the graph is left alone rather than read as empty', () => {
    // The target was fetched by id and came back with nothing: deleted between
    // the parse and the pass. No evidence is not evidence of nothing.
    const { items, dropReasons } = generate(null);
    assert.equal(entityItem(items, 'Mira').op, 'update');
    assert.deepEqual(entityItem(items, 'Mira').proposed.blocks, [{ type: 'text', order: 0, data: { markdown: BODY } }]);
    assert.deepEqual(dropReasons, []);
  });
});
