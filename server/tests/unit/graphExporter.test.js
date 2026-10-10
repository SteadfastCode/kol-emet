/**
 * The canonical workspace export, src/lib/graphExporter.js (KOL-070).
 *
 * This document is what a user who leaves takes with them and what a Git
 * connector will commit, so three things have to hold and none of them is
 * visible by reading one export:
 *
 *   - **It carries every collection, with the keys the API reference
 *     documents.** An export that silently dropped `openQuestions` or renamed
 *     a field looks perfectly fine on its own.
 *   - **It is deterministic.** Two exports of the same graph are byte-identical,
 *     and the ordering comes from the data rather than from the order rows
 *     happened to be inserted in — hence the second fixture workspace below,
 *     which holds the same titles inserted backwards and must sort the same way.
 *     The one field that is not a function of the data, `exportedAt`, is
 *     injected; the pair of tests here pins that it is also the *only* one.
 *   - **It carries nothing but graph content.** No `aiBudget`, no
 *     `passwordHash`, no `userId`, no `email`, no `workspaceId` — swept for by
 *     walking every key of the whole document, so a field added to a schema
 *     later cannot leak in without failing here.
 *
 * Fixture: a real mongod (tests/helpers/db.js) and the real models, because the
 * export reads documents through Mongoose and the question "are the ids
 * strings?" is only meaningful against real ObjectIds. Entity types are created
 * before entities: `Entity.category` is validated against the workspace's
 * registry (lib/entityTypeRegistry.js), so the order is load-bearing.
 *
 * Falsification checks, run red by hand:
 *   - drop any `.sort(…)` in the exporter        -> the insertion-order test fails
 *   - read the clock inside exportWorkspace      -> the byte-identity test fails
 *   - spread the document instead of allowlisting -> the forbidden-key sweep fails
 *   - drop the `workspaceId` clause on any query  -> the isolation test fails
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_GRAPH_EXPORT_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture workspace, naming what it was seeded with
 *   normal  — light, plus each export's collection counts and byte size
 *   verbose — normal, plus the whole exported document
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../helpers/db.js';
import Workspace from '../../src/models/Workspace.js';
import Entity from '../../src/models/Entity.js';
import EntityType from '../../src/models/EntityType.js';
import RelationshipType from '../../src/models/RelationshipType.js';
import RelationshipGroup from '../../src/models/RelationshipGroup.js';
import OpenQuestion from '../../src/models/OpenQuestion.js';
import User from '../../src/models/User.js';

// The exporter logs its counts at 'light' by default, and this file exports a
// dozen times. Overridable when the exporter itself is what is being chased.
process.env.EXPORT_LOG_LEVEL ??= 'off';
process.env.ENTITY_TYPE_LOG_LEVEL ??= 'off';
process.env.ACCOUNT_DELETE_LOG_LEVEL ??= 'off';

const {
  exportWorkspace, exportFilename, workspaceSlug, EXPORT_VERSION, EXPORT_COLLECTIONS,
} = await import('../../src/lib/graphExporter.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  const active = LEVELS[process.env.TEST_GRAPH_EXPORT_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/graphExporter:${level}] ${msg}`);
}

/** A fixed timestamp, so byte-identity is a property of the data and not of the clock. */
const EXPORTED_AT = '2026-10-10T08:30:00.000Z';

/** The keys the API reference documents, per collection. Change one and change docs/api.md. */
const DOCUMENTED_KEYS = {
  top: ['version', 'exportedAt', 'workspace', 'entityTypes', 'relationshipTypes', 'entities', 'relationshipGroups', 'openQuestions'],
  entityTypes: ['_id', 'name', 'icon', 'color', 'order', 'createdAt', 'updatedAt'],
  relationshipTypes: ['_id', 'name', 'scope', 'sourceCategory', 'targetCategory', 'createdAt', 'updatedAt'],
  entities: ['_id', 'title', 'category', 'summary', 'tags', 'blocks', 'relationships', 'open_questions', 'createdAt', 'updatedAt'],
  relationshipGroups: ['_id', 'label', 'members', 'createdAt'],
  openQuestions: ['_id', 'question', 'status', 'entry_ids', 'createdAt', 'updatedAt'],
};

/** Keys that must never appear anywhere in an export, at any depth. */
const FORBIDDEN_KEYS = ['aiBudget', 'passwordHash', 'userId', 'email', 'workspaceId', 'ownerId', 'members.userId', '__v'];

/** The three entity titles every fixture workspace holds, in canonical order. */
const TITLES = ['Aleph Station', 'Mica the Conductor', 'Zephyr Line'];

let alice;   // the workspace under test
let bob;     // a second tenant, whose content must never appear in alice's export

/**
 * Builds one workspace's graph. `titleOrder` decides the order the three
 * entities are *inserted* in, which is exactly what the export must not depend
 * on. Entity types are inserted out of display order for the same reason.
 */
async function seedWorkspace(ownerEmail, titleOrder) {
  const user = await User.create({ email: ownerEmail, passwordHash: 'x'.repeat(20) });
  const workspace = await Workspace.create({ name: 'My Workspace', ownerId: user._id, members: [{ userId: user._id, role: 'owner' }] });
  const workspaceId = workspace._id;

  // Inserted Worlds-first on purpose; `order` says Characters comes first.
  await EntityType.create({ name: 'Worlds', order: 1, icon: '🌍', color: { bg: '#123', text: '#abc' }, workspaceId });
  await EntityType.create({ name: 'Characters', order: 0, workspaceId });

  await RelationshipType.create({ name: 'Wife', scope: 'member', workspaceId });
  await RelationshipType.create({ name: 'Affiliation', scope: 'group', sourceCategory: 'Characters', targetCategory: 'Worlds', workspaceId });

  const byTitle = new Map();
  for (const title of titleOrder) {
    const entity = await Entity.create({
      title,
      category: title.includes('Conductor') ? 'Characters' : 'Worlds',
      summary: `${title} — fixture content.`,
      tags: ['train', 'fixture'],
      // Inserted out of order, with a gap, so the exporter's sort by `order` shows.
      blocks: [
        { type: 'text', order: 2, data: { markdown: `Second block of ${title}.` } },
        { type: 'text', order: 0, data: { markdown: `First block of ${title}.` } },
      ],
      workspaceId,
    });
    byTitle.set(title, entity);
  }

  const group = await RelationshipGroup.create({
    label: 'Fixture link',
    members: [
      { refId: byTitle.get('Zephyr Line')._id, refModel: 'Entity', label: 'Home World' },
      { refId: byTitle.get('Aleph Station')._id, refModel: 'Entity', label: 'Stop' },
    ],
    workspaceId,
  });
  // The back-reference cache the entity route maintains; written here by hand
  // because this fixture does not go through the route.
  await Entity.updateOne({ _id: byTitle.get('Zephyr Line')._id }, { $set: { relationships: [group._id] } });

  const question = await OpenQuestion.create({
    question: 'Where does the Zephyr Line end?',
    entry_ids: [byTitle.get('Zephyr Line')._id, byTitle.get('Aleph Station')._id],
    workspaceId,
  });
  await Entity.updateOne({ _id: byTitle.get('Zephyr Line')._id }, { $set: { open_questions: [question._id] } });

  log('light', `seeded workspace ${workspaceId} for ${ownerEmail}: entities inserted as ${titleOrder.join(', ')} (source: seedWorkspace)`);
  return { workspaceId, userId: user._id, groupId: group._id, questionId: question._id, byTitle };
}

/** Exports and logs, so a failing assertion has the document that produced it. */
async function exportOf(workspaceId, options = {}) {
  const doc = await exportWorkspace(workspaceId, { exportedAt: EXPORTED_AT, source: 'tests/unit/graphExporter', ...options });
  const body = JSON.stringify(doc, null, 2);
  log('normal', `exported ${workspaceId}: ${EXPORT_COLLECTIONS.map(k => `${k} ${doc[k].length}`).join(', ')}, ${Buffer.byteLength(body)} bytes`);
  log('verbose', body);
  return doc;
}

/** Every key in the document, at every depth. */
function allKeys(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, found);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      allKeys(child, found);
    }
  }
  return found;
}

/** Every primitive value in the document, with the path it sits at. */
function allValues(value, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => allValues(item, `${path}[${i}]`, found));
  } else if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const [key, child] of Object.entries(value)) allValues(child, `${path}.${key}`, found);
  } else {
    found.push([path, value]);
  }
  return found;
}

before(async () => {
  await db.connect();
  alice = await seedWorkspace('alice@example.test', ['Zephyr Line', 'Mica the Conductor', 'Aleph Station']);
  // The same titles, inserted backwards: whatever this exports to, alice's
  // export must agree with, or the ordering came from the insertion order.
  bob = await seedWorkspace('bob@example.test', ['Aleph Station', 'Mica the Conductor', 'Zephyr Line']);
});

after(async () => { await db.disconnect(); });

describe('the document carries every collection, with the documented keys', () => {
  test('the top level is exactly the documented shape', async () => {
    const doc = await exportOf(alice.workspaceId);

    assert.deepEqual(Object.keys(doc), DOCUMENTED_KEYS.top, 'the key order is part of the canonical form');
    assert.equal(doc.version, EXPORT_VERSION);
    assert.equal(doc.exportedAt, EXPORTED_AT);
    assert.deepEqual(doc.workspace, { name: 'My Workspace' }, 'the workspace is its name and nothing else');
  });

  test('every collection is non-empty and every row has the documented keys', async () => {
    const doc = await exportOf(alice.workspaceId);

    for (const collection of EXPORT_COLLECTIONS) {
      assert.ok(Array.isArray(doc[collection]), `${collection} should be an array`);
      assert.ok(doc[collection].length > 0, `${collection} is empty — the fixture seeds it, so this is a dropped collection`);
      for (const row of doc[collection]) {
        assert.deepEqual(Object.keys(row), DOCUMENTED_KEYS[collection], `${collection} row keys`);
      }
    }
  });

  test('the content itself survives: blocks in `order`, members in stored order', async () => {
    const doc = await exportOf(alice.workspaceId);

    const zephyr = doc.entities.find(e => e.title === 'Zephyr Line');
    assert.deepEqual(zephyr.blocks.map(b => b.order), [0, 2], 'blocks sort by their own `order`, not insertion order');
    assert.equal(zephyr.blocks[0].data.markdown, 'First block of Zephyr Line.');
    assert.deepEqual(zephyr.tags, ['train', 'fixture'], 'tags are kept as stored');
    assert.equal(zephyr.category, 'Worlds');

    const group = doc.relationshipGroups[0];
    assert.deepEqual(
      group.members.map(m => m.label), ['Home World', 'Stop'],
      'member position is meaningful (the reorder route writes it), so it is never sorted',
    );
    assert.equal(group.members[0].refModel, 'Entity');

    const question = doc.openQuestions[0];
    assert.equal(question.question, 'Where does the Zephyr Line end?');
    assert.equal(question.status, 'open');
    assert.equal(question.entry_ids.length, 2);

    const characters = doc.entityTypes.find(t => t.name === 'Worlds');
    assert.deepEqual(characters.color, { bg: '#123', text: '#abc' });
    assert.equal(characters.icon, '🌍');
  });
});

describe('the same graph exports the same bytes', () => {
  test('two exports with the same timestamp are byte-identical', async () => {
    const first = JSON.stringify(await exportOf(alice.workspaceId), null, 2);
    const second = JSON.stringify(await exportOf(alice.workspaceId), null, 2);

    assert.equal(first, second, 'a Git connector commits these bytes; a reshuffle would diff as a whole-file change');
  });

  test('`exportedAt` is the only field the clock touches', async () => {
    const first = await exportOf(alice.workspaceId, { exportedAt: '2026-01-01T00:00:00.000Z' });
    const second = await exportOf(alice.workspaceId, { exportedAt: '2027-06-30T23:59:59.000Z' });

    assert.notEqual(first.exportedAt, second.exportedAt);
    delete first.exportedAt;
    delete second.exportedAt;
    assert.equal(JSON.stringify(first), JSON.stringify(second), 'nothing but exportedAt may vary between two exports of one graph');
  });

  test('a timestamp is normalized to ISO-8601, whatever the caller passes', async () => {
    const fromDate = await exportOf(alice.workspaceId, { exportedAt: new Date('2026-10-10T08:30:00Z') });
    assert.equal(fromDate.exportedAt, EXPORTED_AT);
  });
});

describe('the ordering comes from the data, not from the insertion order', () => {
  test('entities sort by title, in both workspaces, whichever order they went in', async () => {
    const mine = await exportOf(alice.workspaceId);
    const theirs = await exportOf(bob.workspaceId);

    assert.deepEqual(mine.entities.map(e => e.title), TITLES);
    assert.deepEqual(theirs.entities.map(e => e.title), TITLES, 'the backwards-inserted fixture must sort identically');
  });

  test('entity types sort by `order`, then name — not by insertion', async () => {
    const doc = await exportOf(alice.workspaceId);
    assert.deepEqual(doc.entityTypes.map(t => t.name), ['Characters', 'Worlds']);
  });

  test('relationship types, which have no `order`, sort by name', async () => {
    const doc = await exportOf(alice.workspaceId);
    assert.deepEqual(doc.relationshipTypes.map(t => t.name), ['Affiliation', 'Wife']);
  });

  test('groups and open questions sort by `_id`, ascending', async () => {
    const doc = await exportOf(alice.workspaceId);

    for (const collection of ['relationshipGroups', 'openQuestions']) {
      const ids = doc[collection].map(row => row._id);
      assert.deepEqual(ids, [...ids].sort(), `${collection} must be sorted by _id`);
    }
  });

  test('id sets are sorted, so which edge was added first does not show', async () => {
    const doc = await exportOf(alice.workspaceId);
    const question = doc.openQuestions[0];

    assert.deepEqual(question.entry_ids, [...question.entry_ids].sort(), 'entry_ids is a set, so it is sorted');
  });
});

describe('every id is a string', () => {
  test('no ObjectId survives anywhere in the document', async () => {
    const doc = await exportOf(alice.workspaceId);

    for (const [path, value] of allValues(doc)) {
      assert.ok(
        value === null || ['string', 'number', 'boolean'].includes(typeof value),
        `${path} is a ${typeof value}; an export must be plain JSON`,
      );
    }
  });

  test('every id-shaped field is 24 hex characters', async () => {
    const doc = await exportOf(alice.workspaceId);
    const hex = /^[0-9a-f]{24}$/;

    const ids = [
      ...doc.entities.map(e => e._id),
      ...doc.entities.flatMap(e => e.blocks.map(b => b._id)),
      ...doc.entities.flatMap(e => [...e.relationships, ...e.open_questions]),
      ...doc.entityTypes.map(t => t._id),
      ...doc.relationshipTypes.map(t => t._id),
      ...doc.relationshipGroups.map(g => g._id),
      ...doc.relationshipGroups.flatMap(g => g.members.map(m => m.refId)),
      ...doc.openQuestions.map(q => q._id),
      ...doc.openQuestions.flatMap(q => q.entry_ids),
    ];

    assert.ok(ids.length > 10, 'the fixture should produce plenty of ids to check');
    for (const id of ids) assert.match(String(id), hex, `${id} is not a stringified ObjectId`);
  });

  test('timestamps are ISO-8601 strings', async () => {
    const doc = await exportOf(alice.workspaceId);
    for (const entity of doc.entities) {
      assert.match(entity.createdAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      assert.match(entity.updatedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
  });
});

describe('nothing but graph content is in it', () => {
  test('no account, tenancy or billing key appears at any depth', async () => {
    const doc = await exportOf(alice.workspaceId);
    const keys = allKeys(doc);

    for (const forbidden of FORBIDDEN_KEYS) {
      assert.ok(!keys.has(forbidden), `"${forbidden}" must not appear anywhere in an export`);
    }
  });

  test('neither the email nor the workspace id is in the serialized bytes', async () => {
    const body = JSON.stringify(await exportOf(alice.workspaceId));

    assert.ok(!body.includes('alice@example.test'), 'no address of the account that owns the workspace');
    assert.ok(!body.includes(String(alice.workspaceId)), 'an export is one workspace, so its id says nothing and is left out');
  });

  test('the legacy RelationshipGroup.entityId field is not carried', async () => {
    const doc = await exportOf(alice.workspaceId);
    for (const group of doc.relationshipGroups) {
      assert.equal(group.entityId, undefined, 'a dead legacy field must not be exported as if it meant something');
    }
  });
});

describe('an export is one workspace', () => {
  test("a second tenant's content never appears", async () => {
    const doc = await exportOf(alice.workspaceId);

    const ids = new Set([
      ...doc.entities.map(e => e._id),
      ...doc.relationshipGroups.map(g => g._id),
      ...doc.openQuestions.map(q => q._id),
    ]);

    for (const entity of bob.byTitle.values()) {
      assert.ok(!ids.has(String(entity._id)), "another workspace's entity must not be exported");
    }
    assert.ok(!ids.has(String(bob.groupId)));
    assert.ok(!ids.has(String(bob.questionId)));

    // Both workspaces hold three entities, so a missing workspaceId clause
    // would show as six rather than as a leak that is hard to spot.
    assert.equal(doc.entities.length, 3, 'exactly the three entities of this workspace');
  });

  test('a workspace that does not exist is a WORKSPACE_NOT_FOUND error, not an empty export', async () => {
    const gone = (await Workspace.create({ name: 'Gone', ownerId: alice.userId, members: [{ userId: alice.userId }] }))._id;
    await Workspace.deleteOne({ _id: gone });

    await assert.rejects(
      () => exportWorkspace(gone, { exportedAt: EXPORTED_AT, source: 'tests/unit/graphExporter' }),
      (err) => err.code === 'WORKSPACE_NOT_FOUND',
      'an empty document would look like a workspace whose content had been lost',
    );
  });
});

describe('the download filename', () => {
  test('is the workspace slug and the UTC day of the export', () => {
    assert.equal(exportFilename('My Workspace', EXPORTED_AT), 'my-workspace-2026-10-10.json');
    assert.equal(exportFilename('My Workspace', new Date('2026-12-31T23:59:59Z')), 'my-workspace-2026-12-31.json');
  });

  test('cannot carry anything that would break — or extend — the header', () => {
    // A workspace name is user input and the filename goes into
    // Content-Disposition, so a quote, a newline, a `;` or a path separator
    // must not survive into it.
    assert.equal(workspaceSlug('Quote" ; filename=evil'), 'quote-filename-evil');
    assert.equal(workspaceSlug('../../etc/passwd'), 'etc-passwd');
    assert.equal(workspaceSlug('line\r\nbreak'), 'line-break');
    for (const name of ['Quote" ; x', '../../etc/passwd', 'a\r\nb', 'Trailing   ']) {
      assert.match(workspaceSlug(name), /^[a-z0-9][a-z0-9-]*$/, `${JSON.stringify(name)} produced an unsafe slug`);
    }
  });

  test('falls back to `workspace` when a name has no ASCII left, and never runs long', () => {
    assert.equal(workspaceSlug('קול אמת'), 'workspace');
    assert.equal(workspaceSlug(''), 'workspace');
    assert.equal(workspaceSlug(null), 'workspace');
    assert.equal(workspaceSlug('Café Noir'), 'cafe-noir', 'accents are folded, not dropped with the word');
    assert.ok(workspaceSlug('x'.repeat(200)).length <= 60);
  });
});
