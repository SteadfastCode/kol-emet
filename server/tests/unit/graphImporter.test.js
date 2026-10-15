/**
 * Reading a canonical export back, src/lib/graphImporter.js (KOL-077).
 *
 * The exporter's own suite proves a workspace can be *written* to a file. This
 * one proves the file is complete — which only a round trip can show, because
 * an export that silently omitted a collection, a field or a member's position
 * looks perfectly fine on its own and only fails when something tries to
 * rebuild the graph from it.
 *
 * What this file pins:
 *
 *   - **The round trip.** A fixture graph exported, imported into a fresh
 *     workspace and exported again is byte-identical **except for the ids** —
 *     compared by normalizing every ObjectId to the order it first appears in,
 *     so a renamed field, a dropped collection, a lost tag, a re-dated row or
 *     a reshuffled member array all fail here.
 *   - **A nested subgroup, and member order.** A group whose members are an
 *     entity *and another group* survives with its `refModel` discriminators
 *     and its array positions, because position is what encodes order
 *     (PATCH /relationship-groups/:id/members/reorder writes it).
 *   - **An unknown `version` is refused**, and writes nothing.
 *   - **A planted foreign `workspaceId`** — a hand-edited document naming
 *     another tenant — lands in the caller's workspace and nowhere else.
 *   - **A document over the caps is refused with nothing written.**
 *   - The emptiness rule: a workspace holding content is `WORKSPACE_NOT_EMPTY`
 *     and unchanged, and a reference that resolves to nothing is dropped rather
 *     than written as an id this import never minted.
 *
 * Fixture: a real mongod (tests/helpers/db.js) and the real models, because
 * what is under test is which *documents* get written — the id rewrite, the
 * timestamps, the registry validation on `Entity.category` — and none of that
 * is meaningful against stubs.
 *
 * Falsification checks, run red by hand:
 *   - copy the file's ids instead of minting new ones -> the round trip still
 *     passes, but 'every id is new' fails
 *   - copy `relationships` from the file instead of rebuilding them -> the
 *     rebuild test fails
 *   - sort a group's `members` -> the subgroup/order test fails
 *   - read `doc.workspaceId` anywhere -> the planted-tenant test fails
 *   - drop `{ timestamps: false }` from the inserts -> the round trip fails
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_GRAPH_IMPORT_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture workspace and per import, with its counts
 *   normal  — light, plus each refusal's code
 *   verbose — normal, plus both normalized documents
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';
import * as db from '../helpers/db.js';
import Workspace from '../../src/models/Workspace.js';
import Entity from '../../src/models/Entity.js';
import EntityType from '../../src/models/EntityType.js';
import RelationshipType from '../../src/models/RelationshipType.js';
import RelationshipGroup from '../../src/models/RelationshipGroup.js';
import OpenQuestion from '../../src/models/OpenQuestion.js';
import User from '../../src/models/User.js';

process.env.EXPORT_LOG_LEVEL ??= 'off';
process.env.IMPORT_LOG_LEVEL ??= 'off';
process.env.ENTITY_TYPE_LOG_LEVEL ??= 'off';
process.env.ACCOUNT_DELETE_LOG_LEVEL ??= 'off';

const { exportWorkspace } = await import('../../src/lib/graphExporter.js');
const {
  importWorkspace, readImportDocument, importCaps, workspaceContentCounts,
  IMPORT_CAPS, IMPORT_VERSIONS,
} = await import('../../src/lib/graphImporter.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  const active = LEVELS[process.env.TEST_GRAPH_IMPORT_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/graphImporter:${level}] ${msg}`);
}

/** Fixed, so neither export reads the clock and a diff is about the data. */
const EXPORTED_AT = '2026-10-15T09:15:00.000Z';

/** The workspace name both ends share — an import never renames a workspace. */
const WORKSPACE_NAME = 'My Workspace';

const TITLES = ['Aleph Station', 'Mica the Conductor', 'Zephyr Line'];

let source;       // the fixture graph, exported below
let exported;     // its export document
let seq = 0;      // keeps fixture emails unique across tests

/** A user and a workspace, with nothing in it. `seeded` types are never added. */
async function emptyWorkspace(label) {
  const email = `importer-${label}-${seq++}@example.test`;
  const user = await User.create({ email, passwordHash: 'x'.repeat(20) });
  const workspace = await Workspace.create({
    name: WORKSPACE_NAME,
    ownerId: user._id,
    members: [{ userId: user._id, role: 'owner' }],
  });
  log('light', `created empty workspace ${workspace._id} for ${email} (source: emptyWorkspace("${label}"))`);
  return workspace._id;
}

/**
 * The fixture graph: two entity types, two relationship-type scopes, three
 * entities, a group nested inside another group, and an open question — i.e.
 * one of everything the export carries, including the two shapes nothing else
 * exercises (a `RelationshipGroup` member of a group, and the back-reference
 * caches on `Entity`).
 *
 * The caches (`relationships`, `open_questions`) are written here by hand
 * because the fixture does not go through the routes that maintain them — and
 * they are written *correctly*, since the importer rebuilds them from the
 * groups and the questions, so a fixture whose cache disagreed with its own
 * groups could never round-trip.
 */
async function seedGraph(workspaceId) {
  await EntityType.create({ name: 'Worlds', order: 1, icon: '🌍', color: { bg: '#123456', text: '#abcdef' }, workspaceId });
  await EntityType.create({ name: 'Characters', order: 0, workspaceId });

  await RelationshipType.create({ name: 'Wife', scope: 'member', workspaceId });
  await RelationshipType.create({ name: 'Affiliation', scope: 'group', sourceCategory: 'Characters', targetCategory: 'Worlds', workspaceId });

  const byTitle = new Map();
  for (const title of TITLES) {
    byTitle.set(title, await Entity.create({
      title,
      category: title.includes('Conductor') ? 'Characters' : 'Worlds',
      summary: `${title} — fixture content.`,
      tags: ['train', 'fixture'],
      blocks: [
        { type: 'text', order: 2, data: { markdown: `Second block of ${title}.` } },
        { type: 'text', order: 0, data: { markdown: `First block of ${title}.` } },
      ],
      workspaceId,
    }));
  }

  // Created first, so its id sorts first: the export orders groups by `_id`.
  const inner = await RelationshipGroup.create({
    label: 'The line itself',
    // Zephyr before Aleph on purpose — the order is the data, not a sort key.
    members: [
      { refId: byTitle.get('Zephyr Line')._id, refModel: 'Entity', label: 'Home World' },
      { refId: byTitle.get('Aleph Station')._id, refModel: 'Entity', label: 'Stop' },
    ],
    workspaceId,
  });
  const outer = await RelationshipGroup.create({
    label: 'Crew of the line',
    members: [
      { refId: byTitle.get('Mica the Conductor')._id, refModel: 'Entity', label: 'Conductor' },
      { refId: inner._id, refModel: 'RelationshipGroup', label: 'Her route', notes: 'A subgroup, nested one deep.' },
    ],
    workspaceId,
  });

  const question = await OpenQuestion.create({
    question: 'Where does the Zephyr Line end?',
    status: 'open',
    entry_ids: [byTitle.get('Zephyr Line')._id, byTitle.get('Mica the Conductor')._id],
    workspaceId,
  });

  await Entity.updateOne({ _id: byTitle.get('Zephyr Line')._id }, { $set: { relationships: [inner._id], open_questions: [question._id] } }, { timestamps: false });
  await Entity.updateOne({ _id: byTitle.get('Aleph Station')._id }, { $set: { relationships: [inner._id] } }, { timestamps: false });
  await Entity.updateOne({ _id: byTitle.get('Mica the Conductor')._id }, { $set: { relationships: [outer._id], open_questions: [question._id] } }, { timestamps: false });

  log('light', `seeded workspace ${workspaceId}: 2 entity types, 2 relationship types, ${TITLES.length} entities, 2 groups (one nested), 1 open question`);
  return { byTitle, inner, outer, question };
}

/**
 * Every 24-hex id replaced by `<id:n>`, numbered by first appearance.
 *
 * This is what "byte-identical except for the ids" means: two documents with
 * the same shape and the same *pattern* of references normalize to the same
 * string, however the ids themselves were minted. Block ids are covered too —
 * Mongoose mints those, and nothing references them.
 */
function normalizeIds(doc) {
  const seen = new Map();
  return JSON.stringify(doc, null, 2).replace(/\b[0-9a-f]{24}\b/g, (id) => {
    if (!seen.has(id)) seen.set(id, `<id:${seen.size}>`);
    return seen.get(id);
  });
}

/** Every 24-hex id in a document, as a Set. */
const idsIn = (doc) => new Set(JSON.stringify(doc).match(/\b[0-9a-f]{24}\b/g) ?? []);

const exportOf = (workspaceId) => exportWorkspace(workspaceId, { exportedAt: EXPORTED_AT, source: 'tests/graphImporter' });

/** Runs an import expected to fail, and returns the error. */
async function refusal(doc, workspaceId, options) {
  try {
    const result = await importWorkspace(doc, workspaceId, { source: 'tests/graphImporter', ...options });
    assert.fail(`import should have been refused, got ${JSON.stringify(result)}`);
  } catch (err) {
    log('normal', `refused with ${err.code}: ${err.message}`);
    return err;
  }
}

before(async () => {
  await db.connect();
  source = await emptyWorkspace('source');
  await seedGraph(source);
  exported = await exportOf(source);
});

after(async () => { await db.disconnect(); });

describe('the round trip', () => {
  test('an export imported into a fresh workspace exports identically but for the ids', async () => {
    const destination = await emptyWorkspace('round-trip');
    const result = await importWorkspace(exported, destination, { source: 'tests/graphImporter' });

    assert.equal(result.version, IMPORT_VERSIONS[0]);
    assert.deepEqual(result.imported, {
      entityTypes: 2, relationshipTypes: 2, entities: 3, relationshipGroups: 2, openQuestions: 1,
    });
    // Nothing was skipped as already present, and no reference was dropped: the
    // destination was empty and the document is internally complete.
    assert.deepEqual(result.skipped, { entityTypes: 0, relationshipTypes: 0 });
    assert.deepEqual(result.dropped, { members: 0, questionEntries: 0 });

    const again = await exportOf(destination);
    log('verbose', normalizeIds(again));
    assert.equal(normalizeIds(again), normalizeIds(exported));
  });

  test('every id in the imported graph is new', async () => {
    const destination = await emptyWorkspace('fresh-ids');
    await importWorkspace(exported, destination, { source: 'tests/graphImporter' });
    const again = await exportOf(destination);

    const before = idsIn(exported);
    const after = idsIn(again);
    assert.ok(after.size > 0);
    for (const id of after) {
      assert.ok(!before.has(id), `id ${id} came from the file; every id must be minted on import`);
    }
  });

  test('the nested subgroup and its member order survive', async () => {
    const destination = await emptyWorkspace('subgroup');
    await importWorkspace(exported, destination, { source: 'tests/graphImporter' });

    const groups = await RelationshipGroup.find({ workspaceId: destination }).lean();
    assert.equal(groups.length, 2);

    const outer = groups.find(g => g.label === 'Crew of the line');
    const inner = groups.find(g => g.label === 'The line itself');
    assert.ok(outer && inner);

    // The discriminator, and the id rewritten to the *imported* subgroup.
    assert.deepEqual(outer.members.map(m => m.refModel), ['Entity', 'RelationshipGroup']);
    assert.equal(String(outer.members[1].refId), String(inner._id));
    assert.equal(outer.members[1].notes, 'A subgroup, nested one deep.');

    // Array position is the order, so the member labels come back in the order
    // the fixture wrote them — Zephyr before Aleph, which no sort would give.
    assert.deepEqual(inner.members.map(m => m.label), ['Home World', 'Stop']);
    const titles = await Promise.all(inner.members.map(async m => (await Entity.findById(m.refId).select('title').lean()).title));
    assert.deepEqual(titles, ['Zephyr Line', 'Aleph Station']);
  });

  test("an entity's relationships and open questions are rebuilt from the groups and questions", async () => {
    const destination = await emptyWorkspace('back-references');
    await importWorkspace(exported, destination, { source: 'tests/graphImporter' });

    const groups = await RelationshipGroup.find({ workspaceId: destination }).lean();
    const inner = groups.find(g => g.label === 'The line itself');
    const outer = groups.find(g => g.label === 'Crew of the line');
    const question = await OpenQuestion.findOne({ workspaceId: destination }).lean();

    const zephyr = await Entity.findOne({ workspaceId: destination, title: 'Zephyr Line' }).lean();
    const mica = await Entity.findOne({ workspaceId: destination, title: 'Mica the Conductor' }).lean();

    assert.deepEqual(zephyr.relationships.map(String), [String(inner._id)]);
    assert.deepEqual(mica.relationships.map(String), [String(outer._id)]);
    // The question names both, so both cache it — and with the new id.
    assert.deepEqual(zephyr.open_questions.map(String), [String(question._id)]);
    assert.deepEqual(mica.open_questions.map(String), [String(question._id)]);
    assert.deepEqual(question.entry_ids.map(String).sort(), [String(zephyr._id), String(mica._id)].sort());
  });

  test('the source workspace is untouched by an import elsewhere', async () => {
    const destination = await emptyWorkspace('isolation');
    await importWorkspace(exported, destination, { source: 'tests/graphImporter' });

    const still = await exportOf(source);
    assert.equal(JSON.stringify(still), JSON.stringify(exported), 'importing a graph must not write to the workspace it came from');
  });
});

describe('a document that cannot be trusted', () => {
  test('an unknown version is refused, and writes nothing', async () => {
    const destination = await emptyWorkspace('version');
    const err = await refusal({ ...exported, version: 'kol-emet/workspace-export@2' }, destination);

    assert.equal(err.code, 'UNSUPPORTED_VERSION');
    assert.deepEqual(await workspaceContentCounts(destination), { entities: 0, relationshipGroups: 0, openQuestions: 0 });
    assert.equal(await EntityType.countDocuments({ workspaceId: destination }), 0, 'not even the type registries');
  });

  test('a document with no version at all is refused as one', async () => {
    const destination = await emptyWorkspace('no-version');
    const { version, ...headless } = exported;
    assert.equal(version, IMPORT_VERSIONS[0]);
    assert.equal((await refusal(headless, destination)).code, 'UNSUPPORTED_VERSION');
  });

  test('a planted foreign workspaceId lands in the caller\'s workspace and nowhere else', async () => {
    const victim = await emptyWorkspace('victim');
    const destination = await emptyWorkspace('planted');

    // What a hand-edited file looks like: a tenant id at the top, on every row
    // the exporter's allowlist leaves it off, and on a nested member.
    const planted = JSON.parse(JSON.stringify(exported));
    planted.workspaceId = String(victim);
    planted.workspace.workspaceId = String(victim);
    for (const key of ['entityTypes', 'relationshipTypes', 'entities', 'relationshipGroups', 'openQuestions']) {
      for (const row of planted[key]) row.workspaceId = String(victim);
    }
    planted.relationshipGroups[0].members[0].workspaceId = String(victim);

    const result = await importWorkspace(planted, destination, { source: 'tests/graphImporter' });
    assert.equal(result.imported.entities, 3);

    // Everything is in the caller's workspace…
    assert.deepEqual(await workspaceContentCounts(destination), { entities: 3, relationshipGroups: 2, openQuestions: 1 });
    // …and the named one has nothing, in any collection.
    assert.deepEqual(await workspaceContentCounts(victim), { entities: 0, relationshipGroups: 0, openQuestions: 0 });
    assert.equal(await EntityType.countDocuments({ workspaceId: victim }), 0);
    assert.equal(await RelationshipType.countDocuments({ workspaceId: victim }), 0);

    // And no row carries the planted id anywhere, as a workspace or otherwise.
    const written = await Entity.find({ workspaceId: destination }).lean();
    for (const entity of written) {
      assert.equal(String(entity.workspaceId), String(destination));
      assert.ok(!JSON.stringify(entity).includes(String(victim)));
    }
  });

  test('a reference to a row the document does not carry is dropped, not written', async () => {
    const destination = await emptyWorkspace('dangling');
    const stranger = new mongoose.Types.ObjectId();

    const edited = JSON.parse(JSON.stringify(exported));
    edited.relationshipGroups[0].members.push({ refId: String(stranger), refModel: 'Entity', label: 'Somebody else\'s', notes: null });
    edited.openQuestions[0].entry_ids.push(String(stranger));

    const result = await importWorkspace(edited, destination, { source: 'tests/graphImporter' });
    assert.deepEqual(result.dropped, { members: 1, questionEntries: 1 });

    const bytes = JSON.stringify(await exportOf(destination));
    assert.ok(!bytes.includes(String(stranger)), 'an id this import did not mint must not reach the database');
  });

  test('a malformed row is refused by its path, with nothing written', async () => {
    const destination = await emptyWorkspace('malformed');

    const broken = JSON.parse(JSON.stringify(exported));
    delete broken.entities[1].summary;
    const err = await refusal(broken, destination);
    assert.equal(err.code, 'MALFORMED_DOCUMENT');
    assert.deepEqual(err.fields, ['entities[1].summary']);
    assert.deepEqual(await workspaceContentCounts(destination), { entities: 0, relationshipGroups: 0, openQuestions: 0 });
    assert.equal(await EntityType.countDocuments({ workspaceId: destination }), 0);

    // A category no type in the document or the workspace names is the same
    // refusal, rather than a Mongoose validation error halfway through.
    const unknownType = JSON.parse(JSON.stringify(exported));
    unknownType.entities[0].category = 'Spacecraft';
    assert.equal((await refusal(unknownType, destination)).code, 'MALFORMED_DOCUMENT');

    // So is a block type outside the schema's five.
    const badBlock = JSON.parse(JSON.stringify(exported));
    badBlock.entities[0].blocks[0].type = 'iframe';
    assert.equal((await refusal(badBlock, destination)).code, 'MALFORMED_DOCUMENT');
  });

  test('two rows sharing an _id are refused, because a reference to it is ambiguous', async () => {
    const destination = await emptyWorkspace('duplicate-id');
    const doubled = JSON.parse(JSON.stringify(exported));
    doubled.entities[1]._id = doubled.entities[0]._id;

    assert.equal((await refusal(doubled, destination)).code, 'MALFORMED_DOCUMENT');
  });
});

describe('the caps', () => {
  test('a document over a cap is refused with nothing written', async () => {
    const destination = await emptyWorkspace('caps');
    const caps = { ...importCaps(), entities: 2 };

    const err = await refusal(exported, destination, { caps });
    assert.equal(err.code, 'IMPORT_TOO_LARGE');
    assert.deepEqual(err.fields, ['entities']);
    assert.deepEqual(await workspaceContentCounts(destination), { entities: 0, relationshipGroups: 0, openQuestions: 0 });
    assert.equal(await EntityType.countDocuments({ workspaceId: destination }), 0, 'a cap refusal happens before the first insert');

    // At the cap, not over it, the same document imports.
    const ok = await importWorkspace(exported, destination, { source: 'tests/graphImporter', caps: { ...caps, entities: 3 } });
    assert.equal(ok.imported.entities, 3);
  });

  test('the defaults are overridable per deployment, and only by a positive integer', () => {
    assert.deepEqual(importCaps({}), { ...IMPORT_CAPS });
    assert.equal(importCaps({ IMPORT_MAX_ENTITIES: '12' }).entities, 12);
    assert.equal(importCaps({ IMPORT_MAX_ENTITIES: '0' }).entities, IMPORT_CAPS.entities);
    assert.equal(importCaps({ IMPORT_MAX_ENTITIES: 'lots' }).entities, IMPORT_CAPS.entities);
    assert.equal(importCaps({ IMPORT_MAX_OPEN_QUESTIONS: '7' }).openQuestions, 7);
  });

  test('readImportDocument refuses what is not an export document at all', () => {
    assert.equal(readImportDocumentCode(null), 'MALFORMED_DOCUMENT');
    assert.equal(readImportDocumentCode([]), 'MALFORMED_DOCUMENT');
    assert.equal(readImportDocumentCode('{}'), 'MALFORMED_DOCUMENT');
    assert.equal(readImportDocumentCode({ version: IMPORT_VERSIONS[0], entities: {} }), 'MALFORMED_DOCUMENT');

    // A document carrying only a version is a legal, empty graph.
    const empty = readImportDocument({ version: IMPORT_VERSIONS[0] });
    assert.deepEqual(empty.collections.entities, []);
    assert.deepEqual(empty.collections.openQuestions, []);
  });
});

/** The code `readImportDocument` refuses `doc` with, or null if it accepted it. */
function readImportDocumentCode(doc) {
  try {
    readImportDocument(doc);
    return null;
  } catch (err) {
    return err.code;
  }
}

describe('the empty-workspace rule', () => {
  test('a workspace holding one entity is refused and left exactly as it was', async () => {
    const destination = await emptyWorkspace('occupied');
    await EntityType.create({ name: 'Characters', order: 0, workspaceId: destination });
    const resident = await Entity.create({
      title: 'Already here',
      category: 'Characters',
      summary: 'Written before the import was attempted.',
      workspaceId: destination,
    });

    const err = await refusal(exported, destination);
    assert.equal(err.code, 'WORKSPACE_NOT_EMPTY');
    assert.deepEqual(err.fields, ['entities']);

    const after = await Entity.find({ workspaceId: destination }).lean();
    assert.equal(after.length, 1);
    assert.equal(String(after[0]._id), String(resident._id));
    assert.equal(after[0].title, 'Already here');
  });

  test('a relationship group or an open question alone is enough to refuse', async () => {
    const withGroup = await emptyWorkspace('occupied-group');
    await RelationshipGroup.create({ label: 'Already here', members: [], workspaceId: withGroup });
    assert.deepEqual((await refusal(exported, withGroup)).fields, ['relationshipGroups']);

    const withQuestion = await emptyWorkspace('occupied-question');
    await OpenQuestion.create({ question: 'Already asked?', workspaceId: withQuestion });
    assert.deepEqual((await refusal(exported, withQuestion)).fields, ['openQuestions']);
  });

  test('a seeded type registry does not make a workspace non-empty', async () => {
    // Registration seeds both registries, so a brand-new workspace always has
    // types; a rule that counted them could never import anything. The
    // registry's own rows are kept and the document's duplicates skipped.
    const destination = await emptyWorkspace('seeded-types');
    await EntityType.create({ name: 'Characters', order: 0, workspaceId: destination });
    await EntityType.create({ name: 'worlds', order: 1, workspaceId: destination }); // same name, other case
    await RelationshipType.create({ name: 'Wife', scope: 'member', workspaceId: destination });

    const result = await importWorkspace(exported, destination, { source: 'tests/graphImporter' });
    assert.equal(result.imported.entities, 3);
    assert.deepEqual(result.skipped, { entityTypes: 2, relationshipTypes: 1 });
    assert.equal(result.imported.entityTypes, 0, 'both type names were already present, one in another case');
    assert.equal(result.imported.relationshipTypes, 1, 'only the group-scoped "Affiliation" was new');

    // The unique index is case-insensitive, so a second "Worlds" would have
    // been a write error rather than a duplicate row.
    assert.equal(await EntityType.countDocuments({ workspaceId: destination }), 2);
    // And the categories come out as the registry *holds* them — "worlds", the
    // name already here, not the file's "Worlds". `Entity.category` is checked
    // against the registry exactly, so an entity keeping the file's casing
    // would be a row naming a type this workspace does not have.
    assert.equal(await Entity.countDocuments({ workspaceId: destination, category: 'worlds' }), 2);
    assert.equal(await Entity.countDocuments({ workspaceId: destination, category: 'Worlds' }), 0);
    // The same rewrite reaches a relationship type's category references.
    const affiliation = await RelationshipType.findOne({ workspaceId: destination, scope: 'group' }).lean();
    assert.equal(affiliation.targetCategory, 'worlds');
  });
});
