/**
 * Unit tests for the draft → JSONL exporter in src/lib/draftExporter.js.
 *
 * An export is built to leave the app — into a training corpus, a fine-tune
 * job, a bug report — and what makes that safe is that it carries no real id.
 * Every ObjectId becomes a keyed HMAC pseudonym, and a tripwire walks the
 * finished record and refuses to return it if a raw id survived. Both halves
 * are tested here because the failure each one prevents is silent: a leaked id
 * in a JSONL line looks exactly like a correct one until someone goes looking,
 * by which point it has been copied into a corpus.
 *
 * What each group defends:
 *
 *   `makePseudonymizer` refuses to run without a secret. A default key would
 *   make the mapping reproducible by anyone holding the source, and ObjectIds
 *   (a timestamp and a counter) are guessable enough that a known key lets
 *   someone confirm whether a record is in the corpus. Given a secret it must
 *   be deterministic across calls, instances and processes — the corpus is
 *   joined on these pseudonyms from one export to the next — which is why one
 *   test pins the output to an independently computed HMAC rather than only
 *   comparing the function with itself.
 *
 *   `assertScrubbed` throws, naming the path, when a raw id survives — as a
 *   string, embedded in a longer string, or as an ObjectId object the mapper
 *   forgot. It must stay quiet on the verbatim-content paths (the braindump,
 *   the system prompt, the raw model output, an evidence quote), which are the
 *   training input and may legitimately contain hex, and on the things that
 *   only look similar: 16-hex pseudonyms and a 64-hex text hash.
 *
 *   `toJsonl` on a realistic draft — every id-bearing field populated with a
 *   real ObjectId — yields one line tagged `EXPORT_SCHEMA` with no id in it.
 *   "No id" alone would also be satisfied by an exporter that nulled every
 *   reference, so the same group checks the references were *mapped*: a local
 *   key where a sibling item created the entity, the expected pseudonym
 *   otherwise. It also runs the draft through as an unsaved mongoose document,
 *   because the two real callers differ: the route passes a `.lean()` object
 *   and the export script iterates a cursor of full documents.
 *
 * Falsification checks for this suite, all run red against a deliberately
 * broken exporter:
 *   - Give `makePseudonymizer` a hardcoded fallback secret and the
 *     refuses-without-a-secret test fails.
 *   - Salt the HMAC with a per-process random value and the pinned-HMAC test
 *     fails; the in-process determinism tests alone would not notice.
 *   - Fold the kind into the HMAC input and the cosmetic-kind test fails.
 *   - Pass any one id field through unmapped (`resultId: it.resultId`), or keep
 *     block `_id`s, and the no-ObjectId test fails — the tripwire aborts it.
 *   - Delete the `assertScrubbed(record)` call from `toJsonl` and the
 *     refuses-to-return test fails.
 *   - Delete the ObjectId check on objects in `assertScrubbed` and the
 *     unmapped-ObjectId test fails.
 *   - Drop the `$` anchor from the `source.text` verbatim path and the
 *     exact-path test fails; delete the verbatim exemption and both verbatim
 *     tests fail.
 *   - Turn off local-ref rewriting, or make `ref()` return null for everything,
 *     and the references-are-mapped test fails. The null version still passes
 *     the no-ObjectId test, which is the reason the mapping test exists.
 *
 * Known gap, not asserted: the tripwire's pattern is `\b[0-9a-f]{24}\b`, and
 * `_` is a word character, so an id glued to an underscore (`ent_65f0…`) slips
 * past it. No current mapper produces that shape, and the no-ObjectId test also
 * checks every fixture id by plain substring, so such a leak from this exporter
 * would still fail here — but the tripwire itself would not catch it.
 * Tightening the pattern is a change to the exporter, not to this suite.
 *
 * Out of scope: `normalizeDraft` (KOL-016), and the export route and script,
 * which need a database.
 *
 * Pure: mongoose is imported only to mint ObjectIds and to build an unsaved
 * Draft document. Nothing connects.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

import { EXPORT_SCHEMA, makePseudonymizer, assertScrubbed, toJsonl } from '../../src/lib/draftExporter.js';
import Draft from '../../src/models/Draft.js';

const { ObjectId } = mongoose.Types;

/** A test-only key. Real exports read EXPORT_HMAC_SECRET, which this file never touches. */
const SECRET = 'test-only-export-secret';

/** A fixed id, for the tests that need to know its exact string. */
const HEX = '65f0000000000000000000aa';

/** Asserts that `fn` trips the tripwire, and that the error names exactly `path`. */
function assertTrips(fn, path) {
  assert.throws(fn, (err) => {
    // The trailing colon makes this an exact match: `$.a` must not pass for `$.ab`.
    assert.ok(
      err.message.startsWith(`Unscrubbed ObjectId at ${path}:`),
      `expected the tripwire to name ${path}, got: ${err.message}`,
    );
    return true;
  });
}

/**
 * A draft as generation, review and a partial apply leave it. Every id-bearing
 * field the Draft schema has is populated with a real ObjectId, so any field
 * the mapper forgets shows up as a leak. Returns the draft and every raw id in
 * it, by name. Built fresh per call, since some tests modify it.
 *
 * Four items cover the three kinds and both targeting modes:
 *   e1  a created entity, accepted and applied — siblings refer to its result
 *       id, which should therefore export as `local:e1`
 *   r1  a relationship between e1 and an existing entity, edited, then applied
 *   q1  an open question linking both, rejected (the null `accepted` is the label)
 *   e2  an update to the existing entity, still pending
 *
 * Every item sets every field the exporter reads, at the schema's own default
 * where the item has nothing to say, so the lean object and a mongoose
 * document built from it should export identically.
 */
function buildDraft() {
  const ids = {
    draft: new ObjectId(),
    workspace: new ObjectId(),
    user: new ObjectId(),
    existing: new ObjectId(),
    duplicate: new ObjectId(),
    created: new ObjectId(),
    group: new ObjectId(),
    block: new ObjectId(),
    changeLogE1: new ObjectId(),
    changeLogR1: new ObjectId(),
  };
  const text = 'The Iron Gate is guarded by the Conductor. Nobody remembers who built it.';
  const at = new Date('2026-09-01T12:00:00Z');

  const evidence = (quote) => ({
    quote,
    charStart: text.indexOf(quote),
    charEnd: text.indexOf(quote) + quote.length,
    chunkIndex: 0,
  });

  const item = (fields) => ({
    input: { evidence: { quote: '', charStart: null, charEnd: null, chunkIndex: 0 }, contextEntityIds: [] },
    accepted: null,
    decision: 'pending', decisionVia: null, decisionNote: null, decidedBy: null, decidedAt: null,
    targetEntityId: null, baseUpdatedAt: null, matchedBy: 'none', duplicateOf: null, duplicateScore: null,
    dependsOn: [], flags: [], confidence: null,
    applyState: 'pending', resultId: null, changeLogId: null, applyError: null, appliedAt: null,
    ...fields,
  });

  const gate = {
    title: 'Iron Gate',
    category: 'Worlds',
    summary: 'The only way into the eastern districts.',
    tags: ['gate'],
    blocks: [{ _id: ids.block, type: 'text', order: 0, data: { text: 'Iron, and older than the line.' } }],
    normalizedCategory: 'Places',
  };

  const guards = (label) => ({
    label,
    members: [
      { localKey: 'e1', refId: null, refModel: 'Entity', name: 'Iron Gate', label: null, notes: null },
      { localKey: null, refId: ids.existing, refModel: 'Entity', name: 'The Conductor', label: 'keeper', notes: null },
    ],
  });

  const items = [
    item({
      localKey: 'e1', seq: 0, kind: 'entity', op: 'create',
      input: { evidence: evidence('The Iron Gate'), contextEntityIds: [ids.existing] },
      proposed: gate, accepted: gate,
      decision: 'accepted', decisionVia: 'individual', decidedBy: ids.user, decidedAt: at,
      duplicateOf: ids.duplicate, duplicateScore: 0.41, confidence: 0.9,
      applyState: 'applied', resultId: ids.created, changeLogId: ids.changeLogE1, appliedAt: at,
    }),
    item({
      localKey: 'r1', seq: 1, kind: 'relationship', op: 'create',
      input: { evidence: evidence('guarded by the Conductor'), contextEntityIds: [ids.existing] },
      proposed: guards('guards'), accepted: guards('guarded by'),
      decision: 'edited', decisionVia: 'individual', decisionNote: 'passive reads better here',
      decidedBy: ids.user, decidedAt: at,
      dependsOn: ['e1'],
      applyState: 'applied', resultId: ids.group, changeLogId: ids.changeLogR1, appliedAt: at,
    }),
    item({
      localKey: 'q1', seq: 2, kind: 'open_question', op: 'create',
      input: { evidence: evidence('Nobody remembers who built it.'), contextEntityIds: [] },
      proposed: { question: 'Who built the Iron Gate?', entry_ids: [ids.created, ids.existing] },
      decision: 'rejected', decisionVia: 'bulk', decidedBy: ids.user, decidedAt: at,
      applyState: 'skipped',
    }),
    item({
      localKey: 'e2', seq: 3, kind: 'entity', op: 'update',
      proposed: { title: 'The Conductor', category: 'Characters', summary: 'Keeps the Iron Gate.', tags: [], blocks: [] },
      targetEntityId: ids.existing, baseUpdatedAt: at, matchedBy: 'exact-normalized-title',
      flags: ['possible-duplicate'],
    }),
  ];

  const draft = {
    _id: ids.draft,
    workspaceId: ids.workspace,
    createdBy: ids.user,
    title: 'Iron Gate braindump',
    status: 'partially_applied',
    source: {
      producer: 'braindump',
      producerVersion: 'braindump@1',
      text,
      textHash: `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`,
    },
    grounding: {
      promptVersion: 'v3',
      categories: ['Characters', 'Worlds'],
      relationshipTypes: ['guards'],
      rosterCount: 2,
      rosterTruncated: false,
      systemPrompt: 'Extract entities, relationships and open questions from the text.',
    },
    route: { provider: 'anthropic', model: 'claude-haiku-4-5', strategy: 'single' },
    items,
    counts: { proposed: 4, accepted: 1, edited: 1, rejected: 1, pending: 1, dropped: 0, applied: 2, failed: 0 },
    diagnostics: {
      parsedVia: ['json'],
      repairAttempted: false,
      dropReasons: [],
      rawOutput: '{"items":[]}',
      passes: 1,
      error: null,
      generationMs: 1840,
      usage: { promptTokens: 2100, completionTokens: 640, calls: 1 },
    },
    applyingAt: null,
    appliedAt: at,
    createdAt: at,
    updatedAt: at,
  };

  return { draft, ids };
}

describe('makePseudonymizer', () => {
  test('refuses to build without a secret', () => {
    // Every falsy shape an unset environment variable can arrive as.
    for (const secret of [undefined, null, '']) {
      assert.throws(
        () => makePseudonymizer(secret),
        /EXPORT_HMAC_SECRET/,
        `built a pseudonymizer with secret ${JSON.stringify(secret)}`,
      );
    }
  });

  test('maps the same id to the same pseudonym across calls and instances', () => {
    const id = new ObjectId();
    const a = makePseudonymizer(SECRET);
    const b = makePseudonymizer(SECRET);
    assert.equal(a(id, 'ent'), a(id, 'ent'));
    assert.equal(a(id, 'ent'), b(id, 'ent'), 'two pseudonymizers with one secret disagreed');
  });

  test('treats an ObjectId and its hex string as the same id', () => {
    // Callers pass both: a lean document yields ObjectIds, and the exporter's
    // own `ref()` stringifies before it looks anything up.
    const id = new ObjectId();
    const p = makePseudonymizer(SECRET);
    assert.equal(p(id, 'ent'), p(id.toHexString(), 'ent'));
  });

  test('is the keyed HMAC-SHA256 of the id, truncated to 16 hex', () => {
    // Pinned against an independent computation, not against the function
    // itself: a per-process salt would pass the test above and still make
    // every export unjoinable with the last one.
    const expected = crypto.createHmac('sha256', SECRET).update(HEX).digest('hex').slice(0, 16);
    assert.equal(makePseudonymizer(SECRET)(HEX, 'ent'), `ent_${expected}`);
  });

  test('a different secret gives a different pseudonym', () => {
    assert.notEqual(makePseudonymizer(SECRET)(HEX), makePseudonymizer(`${SECRET}-rotated`)(HEX));
  });

  test('the kind is a cosmetic prefix, not part of the hash', () => {
    // The same entity referenced as `ent` in one field and via a generic ref in
    // another must still join. A fresh instance per call, so the per-instance
    // cache cannot mask a kind that leaked into the hash input.
    const hashOf = (pseudonym) => pseudonym.slice(pseudonym.indexOf('_') + 1);
    const asEntity = makePseudonymizer(SECRET)(HEX, 'ent');
    assert.equal(hashOf(makePseudonymizer(SECRET)(HEX, 'usr')), hashOf(asEntity));
    assert.equal(hashOf(makePseudonymizer(SECRET)(HEX)), hashOf(asEntity));
  });

  test('is 16 hex under its kind prefix, so it cannot trip the tripwire itself', () => {
    const out = makePseudonymizer(SECRET)(HEX, 'ent');
    assert.match(out, /^ent_[0-9a-f]{16}$/);
    assert.doesNotThrow(() => assertScrubbed({ ref: out }));
  });

  test('passes null and undefined through as null', () => {
    // An unset optional ref must stay null. Hashing it would give every unset
    // ref in the corpus one shared pseudonym — the HMAC of "null" — and make
    // them all look like the same entity.
    const p = makePseudonymizer(SECRET);
    assert.equal(p(null, 'ent'), null);
    assert.equal(p(undefined, 'ent'), null);
  });
});

describe('assertScrubbed', () => {
  test('throws naming the path of a surviving id string', () => {
    assertTrips(() => assertScrubbed({ items: [{ outcome: { resultId: HEX } }] }), '$.items[0].outcome.resultId');
  });

  test('names array positions, not just field names', () => {
    const pseudonym = makePseudonymizer(SECRET)(new ObjectId(), 'ent');
    assertTrips(
      () => assertScrubbed({ items: [{}, { input: { contextEntityIds: [pseudonym, HEX] } }] }),
      '$.items[1].input.contextEntityIds[1]',
    );
  });

  test('catches an id embedded in a longer string', () => {
    // The shape a broken local-ref rewrite would produce: the right prefix
    // glued to the real id instead of the local key.
    assertTrips(
      () => assertScrubbed({ items: [{ proposed: { members: [{ ref: `local:${HEX}` }] } }] }),
      '$.items[0].proposed.members[0].ref',
    );
  });

  test('catches an ObjectId object that was never mapped', () => {
    // The likeliest real leak: an id field added to the Draft schema and copied
    // through by the mapper without a pseudonym() call.
    assertTrips(() => assertScrubbed({ workspace: new ObjectId() }), '$.workspace');
    assertTrips(() => assertScrubbed({ items: [{ dependsOn: ['e1', new ObjectId()] }] }), '$.items[0].dependsOn[1]');
  });

  test('passes a clean record, including values that only look like ids', () => {
    const p = makePseudonymizer(SECRET);
    const record = {
      schema: EXPORT_SCHEMA,
      workspace: p(new ObjectId(), 'ws'),
      // sha256 is 64 hex: long enough to contain 24, but one unbroken run, so
      // the bounded pattern must not fire on it.
      source: { textHash: `sha256:${crypto.createHash('sha256').update('x').digest('hex')}` },
      items: [{ outcome: { resultId: 'local:e1' }, targetEntityId: null, flags: [] }],
      counts: { proposed: 1 },
    };
    assert.doesNotThrow(() => assertScrubbed(record));
  });

  test('leaves the verbatim-content paths alone', () => {
    // A braindump that happens to contain 24 hex characters is not a leaked id.
    // Refusing to export it would be the tripwire firing on the very data it
    // exists to protect.
    const text = `Ticket ${HEX} says the gate was rebuilt.`;
    const record = {
      source: { text },
      grounding: { systemPrompt: text },
      diagnostics: { rawOutput: text },
      items: [{}, { input: { evidence: { quote: text } } }],
    };
    assert.doesNotThrow(() => assertScrubbed(record));
  });

  test('exempts the exact verbatim path, not its neighbours', () => {
    // `textHash` sits next to the exempt `source.text` and shares its prefix,
    // but it is a system field: an id there is a leak.
    assertTrips(
      () => assertScrubbed({ source: { text: `mentions ${HEX}`, textHash: HEX } }),
      '$.source.textHash',
    );
  });
});

describe('toJsonl', () => {
  test('the fixture really does carry every raw id', () => {
    // Guards the tests below against passing vacuously: if the fixture lost an
    // id, "no id in the output" would prove nothing about that field.
    const { draft, ids } = buildDraft();
    const serialized = JSON.stringify(draft);
    for (const [name, id] of Object.entries(ids)) {
      assert.ok(serialized.includes(id.toHexString()), `the fixture is missing the ${name} id`);
    }
  });

  test('yields one line tagged EXPORT_SCHEMA with no ObjectId anywhere', () => {
    const { draft, ids } = buildDraft();
    const line = toJsonl(draft, { pseudonym: makePseudonymizer(SECRET) });

    assert.equal(typeof line, 'string');
    assert.ok(!line.includes('\n'), 'a JSONL record must be exactly one line');
    const record = JSON.parse(line);
    assert.equal(record.schema, EXPORT_SCHEMA);
    assert.equal(record.items.length, 4);

    // Plain substring per fixture id first — stricter than the tripwire's own
    // pattern, so it also catches the `ent_<id>` shape that pattern misses —
    // then a sweep for any id-shaped token at all.
    for (const [name, id] of Object.entries(ids)) {
      assert.ok(!line.includes(id.toHexString()), `the raw ${name} id leaked into the export`);
    }
    assert.doesNotMatch(line, /\b[0-9a-f]{24}\b/i);
  });

  test('maps references rather than dropping them', () => {
    const { draft, ids } = buildDraft();
    const record = JSON.parse(toJsonl(draft, { pseudonym: makePseudonymizer(SECRET) }));
    // A second instance computes the expectations, which also re-checks that
    // pseudonyms agree across instances.
    const p = makePseudonymizer(SECRET);
    const [e1, r1, q1, e2] = record.items;

    assert.equal(record.draftId, p(ids.draft, 'drf'));
    assert.equal(record.workspace, p(ids.workspace, 'ws'));
    assert.equal(record.createdBy, p(ids.user, 'usr'));

    // An entity a sibling item created is referenced by its local key — the
    // form a model has to learn to emit, since it could never guess the id.
    assert.equal(e1.outcome.resultId, 'local:e1');
    assert.equal(r1.outcome.resultId, 'local:r1');
    assert.equal(r1.proposed.members[0].ref, 'local:e1');
    assert.equal(r1.accepted.members[0].ref, 'local:e1');
    assert.equal(q1.proposed.entry_ids[0], 'local:e1');

    // Anything else is pseudonymised.
    const existing = p(ids.existing, 'ent');
    assert.equal(r1.proposed.members[1].ref, existing);
    assert.deepEqual(e1.input.contextEntityIds, [existing]);
    assert.equal(q1.proposed.entry_ids[1], existing);
    assert.equal(e2.targetEntityId, existing);
    assert.equal(e1.duplicateOf, p(ids.duplicate, 'ent'));
    assert.equal(e1.decidedBy, p(ids.user, 'usr'));
    assert.equal(e1.outcome.changeLogId, p(ids.changeLogE1, 'chg'));

    // A block's subdocument id has no training value and is dropped outright.
    assert.deepEqual(Object.keys(e1.proposed.blocks[0]).sort(), ['data', 'order', 'type']);

    // A rejection keeps its item, with a null `accepted` as the label.
    assert.equal(q1.decision, 'rejected');
    assert.equal(q1.accepted, null);
  });

  test('exports a mongoose document exactly as it exports the lean object', () => {
    // The route hands toJsonl a `.lean()` object; the export script iterates a
    // cursor of full documents. Both must produce the same record.
    const { draft } = buildDraft();
    const opts = { pseudonym: makePseudonymizer(SECRET) };
    const fromLean = JSON.parse(toJsonl(draft, opts));
    const fromDocument = JSON.parse(toJsonl(new Draft(draft), opts));
    assert.deepEqual(fromDocument, fromLean);
  });

  test('keeps verbatim content intact, hex and all', () => {
    // The end-to-end half of the verbatim exemption: text containing an
    // id-shaped string exports unaltered rather than aborting the record.
    const { draft } = buildDraft();
    const note = `See ticket ${HEX}.`;
    draft.source.text += ` ${note}`;
    draft.grounding.systemPrompt += ` ${note}`;
    draft.diagnostics.rawOutput += ` ${note}`;
    draft.items[0].input.evidence.quote = note;

    const record = JSON.parse(toJsonl(draft, { pseudonym: makePseudonymizer(SECRET), includeRawOutput: true }));
    assert.equal(record.source.text, draft.source.text);
    assert.equal(record.grounding.systemPrompt, draft.grounding.systemPrompt);
    assert.equal(record.diagnostics.rawOutput, draft.diagnostics.rawOutput);
    assert.equal(record.items[0].input.evidence.quote, note);
  });

  test('refuses to return a record when an id survives mapping', () => {
    // An item kind the mapper does not recognise has its payload passed through
    // as-is — by design, so the tripwire decides rather than a guess. This is
    // the proof the tripwire is wired into toJsonl: without the assertScrubbed
    // call, this record would come back with the id in it.
    const { draft } = buildDraft();
    draft.items.push({ ...draft.items[3], localKey: 'd1', seq: 4, kind: 'drift', proposed: { entityId: HEX } });
    assertTrips(() => toJsonl(draft, { pseudonym: makePseudonymizer(SECRET) }), '$.items[4].proposed.entityId');
  });

  test('refuses to run without a pseudonym function', () => {
    const { draft } = buildDraft();
    assert.throws(() => toJsonl(draft), /pseudonym/);
    assert.throws(() => toJsonl(draft, { pseudonym: SECRET }), /pseudonym/);
  });
});
