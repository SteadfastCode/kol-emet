/**
 * Unit tests for the draft-item payload validator in src/lib/draftItemSchema.js.
 *
 * `validateItemPayload` is the only gate between a person's edit to a generated
 * item and that edit being stored as the item's `accepted` payload. An edited
 * item is the most valuable example in the training corpus — a preference pair,
 * what the model proposed against what a person actually wanted — so the
 * failure worth defending against is not a crash but an edit that gets *stored*
 * in a shape the applier cannot write and the exporter cannot read. Nothing
 * complains at save time; it surfaces much later as a failed apply or a corrupt
 * training row.
 *
 * What each group defends:
 *
 *   Minimal payloads are accepted and come back with every default filled in.
 *   That is what keeps an edit in exactly the shape the normalizer gives
 *   `proposed`, so the two halves of the pair line up. This group is also the
 *   positive control for every rejection below: each rejection fixture is one
 *   of these payloads with exactly one thing changed.
 *
 *   Unknown keys are rejected, not stripped (`.strict()`). A client sending
 *   `body` — the field entities no longer have — or a misspelt `entryIds` is
 *   sending an edit the person believes was saved. Stripping the key would
 *   quietly record a different edit from the one they made.
 *
 *   The relationship rules mirror the relationship routes: at least two
 *   members, and each member points at exactly one thing — a sibling item in
 *   this draft (`localKey`) or an entity that already exists (`refId`). A
 *   member carrying both is ambiguous, and the applier would have to guess
 *   which one the person meant.
 *
 *   An unknown kind fails closed with `{ ok: false }` — no throw, and no
 *   falling through to another kind's schema. The route turns it into a 400.
 *
 * Every rejection also asserts on the error text, so it fails for the stated
 * reason rather than because something else in the fixture was invalid, and so
 * the message the route hands back to the client stays useful.
 *
 * Falsification checks for this suite, all run red against a deliberately
 * broken validator:
 *   - Remove `.strict()` from any one of the three schemas and that kind's
 *     unknown-key test fails.
 *   - Relax `members` from `.min(2)` to `.min(1)` and the fewer-than-two test
 *     fails.
 *   - Weaken the member refine from `!==` (exactly one) to `||` (at least one)
 *     and the both-set test fails.
 *   - Make an unknown kind fall through to the entity schema and every
 *     unknown-kind test fails.
 *   - Drop the `.default('')` on `summary` and the minimal-entity test fails on
 *     the returned value's shape.
 *
 *   An entity's category must be one of its workspace's entity types — the
 *   same names POST /entities accepts there, a user-defined one included —
 *   and a workspace with no types falls back to the built-in list.
 *
 * Not pure: the entity schema reads the workspace's EntityType registry, so
 * this runs against the in-memory mongod (tests/helpers/db.js). The fixed
 * WORKSPACE_ID has no types, so every fixture below is checked against the
 * built-in categories; the registry group makes its own workspace.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';

import * as db from '../helpers/db.js';
import Workspace from '../../src/models/Workspace.js';
import EntityType from '../../src/models/EntityType.js';
import { validateItemPayload } from '../../src/lib/draftItemSchema.js';

// A workspace with no entity types: getCategories() falls back to the built-in
// list for it. A string, as req.workspaceId reaches the route.
const WORKSPACE_ID = '65f0000000000000000000ee';

before(async () => { await db.connect(); });
after(async () => { await db.disconnect(); });

/** An existing entity's id as it arrives in an edit body: a string, not an ObjectId. */
const EXISTING_ID = '65f0000000000000000000aa';

/**
 * The smallest valid payload of each kind. Functions rather than constants so
 * every test gets its own copy and no fixture can carry a mutation into the next.
 */
const minimal = {
  entity: () => ({ title: 'Iron Gate', category: 'Worlds' }),
  relationship: () => ({
    members: [
      { localKey: 'e1', name: 'Iron Gate' },
      { refId: EXISTING_ID, name: 'The Conductor' },
    ],
  }),
  open_question: () => ({ question: 'Who built the Iron Gate?' }),
};

/** Asserts a rejection of the right shape and returns its error text. */
async function rejected(kind, payload) {
  const result = await validateItemPayload(kind, payload, WORKSPACE_ID);
  assert.equal(result.ok, false, `expected the ${kind} payload to be rejected: ${JSON.stringify(payload)}`);
  assert.equal(typeof result.error, 'string');
  assert.ok(!('value' in result), 'a rejection must not carry a value the caller could store');
  return result.error;
}

describe('validateItemPayload accepts a minimal payload', () => {
  test('entity: title and category, with the optional fields defaulted', async () => {
    assert.deepEqual(await validateItemPayload('entity', minimal.entity(), WORKSPACE_ID), {
      ok: true,
      value: { title: 'Iron Gate', category: 'Worlds', summary: '', tags: [], blocks: [] },
    });
  });

  test('relationship: one local and one existing member, each filled out to the full member shape', async () => {
    assert.deepEqual(await validateItemPayload('relationship', minimal.relationship(), WORKSPACE_ID), {
      ok: true,
      value: {
        label: null,
        members: [
          { localKey: 'e1', refId: null, refModel: 'Entity', name: 'Iron Gate', label: null, notes: null },
          { localKey: null, refId: EXISTING_ID, refModel: 'Entity', name: 'The Conductor', label: null, notes: null },
        ],
      },
    });
  });

  test('open_question: the question alone, with no linked entries', async () => {
    assert.deepEqual(await validateItemPayload('open_question', minimal.open_question(), WORKSPACE_ID), {
      ok: true,
      value: { question: 'Who built the Iron Gate?', entry_ids: [] },
    });
  });

  test('entity: every optional key the normalizer writes is allowed', async () => {
    // Generated items carry `normalizedCategory`, and an edit round-trips it.
    // The strictness below must not reject a key the system itself writes, or
    // no generated entity could ever be edited.
    const payload = {
      ...minimal.entity(),
      summary: 'The only way into the eastern districts.',
      tags: ['gate', 'east'],
      blocks: [{ type: 'text', order: 0, data: { text: 'Iron, and older than the line.' } }],
      normalizedCategory: 'Places',
    };
    const result = await validateItemPayload('entity', payload, WORKSPACE_ID);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.value, payload);
  });
});

describe("validateItemPayload checks an entity's category against its workspace", () => {
  test('a workspace with no types accepts only the built-in categories', async () => {
    assert.equal((await validateItemPayload('entity', minimal.entity(), WORKSPACE_ID)).ok, true);
    const error = await rejected('entity', { ...minimal.entity(), category: 'Vehicles' });
    assert.match(error, /^category: /, `the error should point at category: ${error}`);
  });

  test("a workspace's own types are the list: a user-defined one is accepted, a built-in it lacks is not", async () => {
    const { _id } = await Workspace.create({ name: 'Registry', ownerId: new mongoose.Types.ObjectId() });
    const workspaceId = String(_id);
    await EntityType.insertMany([{ name: 'Vehicles', order: 0, workspaceId }, { name: 'Worlds', order: 1, workspaceId }]);

    const vehicle = await validateItemPayload('entity', { ...minimal.entity(), category: 'Vehicles' }, workspaceId);
    assert.equal(vehicle.ok, true, vehicle.error);

    const character = await validateItemPayload('entity', { ...minimal.entity(), category: 'Characters' }, workspaceId);
    assert.equal(character.ok, false);
    assert.match(character.error, /^category: /);
    assert.ok(character.error.includes("'Vehicles'"), `the error should list the workspace's types: ${character.error}`);
  });
});

describe('validateItemPayload rejects unknown keys', () => {
  // Each case is a minimal valid payload plus one key the schema does not
  // declare, carrying a plausible value: the rejection has to come from the
  // key's existence, not its contents.
  const CASES = [
    // The field entities no longer have. A client still sending it is losing
    // content, and should get a 400 rather than have it dropped.
    ['entity', 'body', 'Legacy prose field — content lives in blocks now.'],
    // Tenancy belongs to the draft, not the payload. An edit must not be able
    // to carry a workspace of its own into the stored item.
    ['entity', 'workspaceId', '65f00000000000000000ffff'],
    // Misspellings of real keys — the likeliest way to hit this in practice.
    ['relationship', 'groupLabel', 'guards'],
    ['open_question', 'entryIds', [EXISTING_ID]],
  ];

  for (const [kind, key, value] of CASES) {
    test(`${kind}: rejects \`${key}\` and names it`, async () => {
      const error = await rejected(kind, { ...minimal[kind](), [key]: value });
      assert.match(error, /unrecognized key/i);
      assert.ok(error.includes(`'${key}'`), `the error should name the offending key: ${error}`);
    });
  }
});

describe('validateItemPayload relationship member rules', () => {
  test('rejects a relationship with fewer than two members', async () => {
    const [local] = minimal.relationship().members;
    for (const members of [[], [local]]) {
      const error = await rejected('relationship', { members });
      assert.match(error, /^members: /, `the error should point at members: ${error}`);
      assert.match(error, /at least 2/);
    }
  });

  test('rejects a relationship with no members key at all', async () => {
    assert.match(await rejected('relationship', {}), /^members: /);
  });

  test('rejects a member carrying both localKey and refId, naming the member', async () => {
    // The bad member is second on purpose, so the path has to identify it
    // rather than defaulting to the first.
    const [local, existing] = minimal.relationship().members;
    const error = await rejected('relationship', { members: [local, { ...existing, localKey: 'e2' }] });
    assert.equal(error, 'members.1: each member needs exactly one of localKey or refId');
  });

  test('rejects a member carrying neither', async () => {
    const [local] = minimal.relationship().members;
    const error = await rejected('relationship', { members: [local, { name: 'Someone' }] });
    assert.equal(error, 'members.1: each member needs exactly one of localKey or refId');
  });

  test('accepts members that carry both keys with one of them null', async () => {
    // The shape a stored `proposed` member actually has — both keys present,
    // one explicitly null — and so what a client sends back when it edits an
    // item it was shown. Null has to count as "not set".
    const result = await validateItemPayload('relationship', {
      members: [
        { localKey: 'e1', refId: null, name: 'Iron Gate' },
        { localKey: null, refId: EXISTING_ID, name: 'The Conductor' },
      ],
    }, WORKSPACE_ID);
    assert.equal(result.ok, true, result.error);
  });
});

describe('validateItemPayload with an unknown kind', () => {
  // Paired with a payload that is valid *as an entity*, so a validator that
  // fell through to the entity schema for anything unrecognised would accept
  // it and fail here. `delete` is a reserved op in the Draft model, not a kind;
  // the next two are near-misses of real kinds.
  const KINDS = ['delete', 'openQuestion', 'Entity', '', undefined, null];

  for (const kind of KINDS) {
    test(`fails closed for ${JSON.stringify(kind) ?? 'undefined'}`, async () => {
      const result = await validateItemPayload(kind, minimal.entity(), WORKSPACE_ID);
      assert.deepEqual(result, { ok: false, error: `Unknown item kind: ${kind}` });
    });
  }
});
