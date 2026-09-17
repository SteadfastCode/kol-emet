/**
 * The entity-type registry (Phase 6) across real accounts.
 *
 * Same harness and reasoning as tenancy.test.js: `createApp()` over supertest,
 * real `POST /auth/register` — so the six default types arrive through the real
 * `seedWorkspace` — and real mongod. The registry is tenant content like any
 * other: a foreign id is 404, never 403, and every type the fixture creates is
 * checked for its owner's workspace id. That write-side check is what goes red
 * if the mount loses `resolveWorkspace` (reads fail closed; creates would stamp
 * null). As in that file, the catch-all changelog mount already sets
 * `req.workspaceId` for every later mount, so falsifying by hand means taking
 * the middleware off both.
 *
 * Types are referenced by *name* from `Entity.category` and from a relationship
 * type's source/target category, and the registry must not drift from either
 * (src/lib/entityTypeRegistry.js, src/routes/entityTypes.js): an entity or
 * relationship type cannot name a type its workspace lacks, a type something
 * uses cannot be deleted, and renaming one carries the new name to everything
 * that used the old. With the Entity enum gone (Phase 6 step 2), the registry
 * is the only gate, so any name a type is given is one an entity can use.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_ENTITY_TYPES_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture document: the request that created it and
 *             the workspace it landed in
 *   normal  — light, plus each cross-tenant probe and refused write, with the
 *             status it got back
 *   verbose — normal, plus the names returned by every list read
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';
import session from 'express-session';
import request from 'supertest';

import * as db from '../helpers/db.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import EntityType from '../../src/models/EntityType.js';
import Entity from '../../src/models/Entity.js';
import RelationshipType from '../../src/models/RelationshipType.js';
import RelationshipGroup from '../../src/models/RelationshipGroup.js';
import OpenQuestion from '../../src/models/OpenQuestion.js';
import { CATEGORIES } from '../../src/config/categories.js';
import { seedEntityTypes } from '../../src/lib/workspaceSeeder.js';

// Environment before src/app.js is imported, for the reasons in tenancy.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_ENTITY_TYPES_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/entityTypes:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

let app;
let alice;
let bob;

/** One of alice's types, marked in before(), for bob to probe. */
let aliceSecret;

/** Registers `email`, naming `template` in the body when one is given. */
async function registerUser(email, template) {
  const agent = request.agent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD, ...(template && { template }) });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  log('light', `registered ${email} (source: POST /auth/register, template ${template ? `"${template}"` : 'not named'}) → workspace ${workspace._id} (source: Workspace.members.userId lookup)`);
  return { agent, email, workspaceId: String(workspace._id) };
}

/** POSTs a type as `who`, asserts it landed in their workspace, returns it. */
async function createType(who, body) {
  const res = await who.agent.post('/entity-types').send(body);
  assert.equal(res.status, 201, `POST /entity-types as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(String(res.body.workspaceId), who.workspaceId, `${who.email}'s type must land in their own workspace`);
  log('light', `created entity type ${res.body._id} "${res.body.name}" (source: POST /entity-types as ${who.email}) in workspace ${res.body.workspaceId}`);
  return res.body;
}

/** Deletes one of `who`'s types by name, asserting it was unused and went. */
async function deleteType(who, name) {
  const type = await typeNamed(who, name);
  const res = await who.agent.delete(`/entity-types/${type._id}`);
  assert.equal(res.status, 204, `DELETE "${name}" as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('light', `deleted entity type ${type._id} "${name}" (source: DELETE /entity-types as ${who.email})`);
  return type;
}

/** GETs `who`'s registry, logging the names at the 'verbose' tier. */
async function listTypes(who, query = {}) {
  const res = await who.agent.get('/entity-types').query(query);
  assert.equal(res.status, 200, `GET /entity-types as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  assert.ok(Array.isArray(res.body), 'GET /entity-types should return an array');
  log('verbose', `GET /entity-types${query.q ? `?q=${query.q}` : ''} as ${who.email} → ${res.body.map(t => t.name).join(', ') || '(none)'}`);
  return res.body;
}

async function typeNamed(who, name) {
  const type = (await listTypes(who)).find(t => t.name === name);
  assert.ok(type, `${who.email} should have a "${name}" type`);
  return type;
}

/** POSTs an entity as `who` and returns the response, whatever its status. */
async function postEntity(who, category, title = `${who.email} ${category}`) {
  const res = await who.agent.post('/entities').send({ title, category, summary: 'fixture' });
  log('normal', `${who.email} POST /entities category "${category}" → ${res.status}${res.status === 201 ? '' : ` ${JSON.stringify(res.body)}`}`);
  return res;
}

/** Logs a probe or refused write and its answer at the 'normal' tier. */
function probed(who, what, res) {
  log('normal', `${who.email} ${what} → ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore() });

  alice = await registerUser('alice@example.test');
  bob   = await registerUser('bob@example.test');
  assert.notEqual(alice.workspaceId, bob.workspaceId, 'two registrations must yield two distinct workspaces');

  const lore = await typeNamed(alice, 'Lore & Mechanics');
  const marked = await alice.agent.put(`/entity-types/${lore._id}`).send({ icon: '🔒' });
  assert.equal(marked.status, 200, JSON.stringify(marked.body));
  aliceSecret = marked.body;
  log('light', `marked alice's entity type ${aliceSecret._id} "${aliceSecret.name}" (source: PUT /entity-types as ${alice.email})`);
});

after(async () => { await db.disconnect(); });

describe('seeding', () => {
  test('registration gives each workspace the six current categories, in order, with their colours', async () => {
    for (const who of [alice, bob]) {
      const seeded = (await listTypes(who)).filter(t => CATEGORIES.includes(t.name));

      assert.deepEqual(seeded.map(t => t.name), CATEGORIES, `${who.email}'s registry must match the built-in categories, in their order`);
      assert.deepEqual(seeded.map(t => t.order), [0, 1, 2, 3, 4, 5]);
      for (const t of seeded) assert.equal(String(t.workspaceId), who.workspaceId, `seeded "${t.name}" must be in ${who.email}'s workspace`);
    }

    const characters = await typeNamed(alice, 'Characters');
    assert.deepEqual(characters.color, { bg: '#B5D4F4', text: '#0C447C' }, "the client's pill colours must carry over");
    assert.equal(characters.icon, null);

    const aliceIds = new Set((await listTypes(alice)).map(t => String(t._id)));
    assert.ok((await listTypes(bob)).every(t => !aliceIds.has(String(t._id))), 'each workspace gets its own rows, not shared ones');
  });

  test('registering with the software-architecture template seeds its five types, in order, with their own colours, and its relationship vocabulary', async () => {
    const architect = await registerUser('architect@example.test', 'software-architecture');

    const types = await listTypes(architect);
    assert.deepEqual(types.map(t => t.name), ['Service', 'Data Store', 'API', 'Team', 'External Dependency'], 'exactly the five types, in order — none of the worldbuilding six');
    assert.deepEqual(types.map(t => t.order), [0, 1, 2, 3, 4]);
    for (const t of types) {
      assert.equal(String(t.workspaceId), architect.workspaceId, `seeded "${t.name}" must be in architect's workspace`);
      assert.match(t.color?.bg ?? '', /^#[0-9A-F]{6}$/i, `"${t.name}" needs a background colour`);
      assert.match(t.color?.text ?? '', /^#[0-9A-F]{6}$/i, `"${t.name}" needs a text colour`);
    }
    const pair = t => `${t.color.bg}/${t.color.text}`.toUpperCase();
    assert.equal(new Set(types.map(pair)).size, types.length, 'no two of the five share a colour pair');
    const worldbuildingPairs = new Set((await listTypes(alice)).map(pair));
    assert.ok(types.every(t => !worldbuildingPairs.has(pair(t))), 'none reuses a worldbuilding colour pair');

    const vocabulary = await architect.agent.get('/relationship-types');
    assert.equal(vocabulary.status, 200, JSON.stringify(vocabulary.body));
    log('verbose', `GET /relationship-types as ${architect.email} → ${vocabulary.body.map(t => `${t.name} (${t.scope})`).join(', ')}`);
    const named = scope => vocabulary.body.filter(t => t.scope === scope).map(t => t.name).sort();
    assert.deepEqual(named('group'), ['Calls', 'Depends on', 'Exposes', 'Owned by']);
    for (const role of ['Dependent', 'Dependency', 'Owner', 'Owned', 'Caller', 'Callee', 'Provider', 'Endpoint']) {
      assert.ok(named('member').includes(role), `member role "${role}" should be seeded`);
    }
    assert.ok(!vocabulary.body.some(t => t.name === 'Marriage'), 'no worldbuilding vocabulary');
    const owner = vocabulary.body.find(t => t.name === 'Owner');
    assert.deepEqual([owner.sourceCategory, owner.targetCategory], ['Team', 'Service'], 'category hints name the template\'s own types');

    // Seeding swallows its errors so registration never fails on it, so a
    // starter entity its own registry refused would leave only this to notice.
    const workspaceId = architect.workspaceId;
    const entities = await Entity.find({ workspaceId }).sort({ title: 1 }).lean();
    assert.deepEqual(entities.map(e => [e.title, e.category]), [['Example Database', 'Data Store'], ['Example Service', 'Service']]);
    const [database, service] = entities;

    const groups = await RelationshipGroup.find({ workspaceId }).lean();
    assert.equal(groups.length, 1, 'one starter relationship group');
    assert.equal(groups[0].label, 'Depends on');
    assert.deepEqual(
      groups[0].members.map(m => [String(m.refId), m.label]),
      [[String(service._id), 'Dependent'], [String(database._id), 'Dependency']],
    );

    const questions = await OpenQuestion.find({ workspaceId }).lean();
    assert.equal(questions.length, 1, 'one starter open question');
    assert.deepEqual(questions[0].entry_ids.map(String), [String(service._id)]);
    log('light', `software-architecture seed checked in workspace ${workspaceId} (source: POST /auth/register as ${architect.email}): ${types.length} types, ${vocabulary.body.length} relationship types, ${entities.length} entities, ${groups.length} group, ${questions.length} question`);
  });

  test('a registration that names no template still gets exactly the six worldbuilding types', async () => {
    const plain = await registerUser('no-template@example.test');

    const types = await listTypes(plain);
    assert.deepEqual(types.map(t => t.name), CATEGORIES, 'the six and nothing else');
    const vocabulary = await plain.agent.get('/relationship-types');
    assert.equal(vocabulary.status, 200, JSON.stringify(vocabulary.body));
    assert.ok(vocabulary.body.some(t => t.name === 'Marriage' && t.scope === 'group'), 'worldbuilding vocabulary');
    assert.ok(!vocabulary.body.some(t => t.name === 'Depends on'), 'no software-architecture vocabulary');
  });

  test('seedEntityTypes adds only what is missing, so a re-run never duplicates', async () => {
    // A real workspace: content written under an id with no workspace behind it
    // is discarded by the owner guard (lib/ownerGuard.js).
    const { _id: workspaceId } = await Workspace.create({ name: 'Seeding', ownerId: new mongoose.Types.ObjectId() });
    await EntityType.create({ name: 'characters', workspaceId }); // a user's own, differently cased

    const wouldAdd = await seedEntityTypes(workspaceId, undefined, { apply: false });
    assert.deepEqual(wouldAdd, CATEGORIES.slice(1), 'an existing name matches case-insensitively');
    assert.equal(await EntityType.countDocuments({ workspaceId }), 1, 'apply: false writes nothing');

    assert.deepEqual(await seedEntityTypes(workspaceId), CATEGORIES.slice(1));
    assert.deepEqual(await seedEntityTypes(workspaceId), [], 'a second run adds nothing');
    assert.equal(await EntityType.countDocuments({ workspaceId }), CATEGORIES.length);
  });
});

describe("CRUD in the caller's workspace", () => {
  test('create, read, update and delete a type', async () => {
    const created = await createType(alice, { name: '  Airships  ', icon: '🎈', color: { bg: '#111111', text: '#EEEEEE' } });
    assert.equal(created.name, 'Airships', 'the name is trimmed');
    const before = await listTypes(alice);
    assert.equal(created.order, Math.max(...before.filter(t => t._id !== created._id).map(t => t.order)) + 1,
      'with no order given, a new type goes after the last one');
    assert.equal(before.at(-1).name, 'Airships', 'the list is sorted by order');

    const put = await alice.agent.put(`/entity-types/${created._id}`).send({ name: ' Airships ', order: 99, color: { text: '#FFFFFF' } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.name, 'Airships');
    assert.equal(put.body.relabelled, undefined, 'resending the current name is not a rename');
    assert.equal(put.body.order, 99);
    assert.deepEqual(put.body.color, { bg: '#111111', text: '#FFFFFF' }, 'a partial colour update keeps the other half');
    assert.equal(put.body.icon, '🎈', 'fields not in the body are untouched');

    const gone = await deleteType(alice, 'Airships');
    assert.ok(!(await listTypes(alice)).some(t => t._id === gone._id), 'a deleted type is no longer listed');
    assert.equal((await alice.agent.delete(`/entity-types/${gone._id}`)).status, 404, 'a second delete finds nothing');
  });

  test('names are unique per workspace, case-insensitively', async () => {
    const dup = probed(alice, 'POST /entity-types "characters"', await alice.agent.post('/entity-types').send({ name: 'characters' }));
    assert.equal(dup.status, 409);
    assert.equal(dup.body.existing.name, 'Characters');

    const openQuestions = await typeNamed(alice, 'Open Questions');
    const rename = probed(alice, 'PUT rename onto "worlds"', await alice.agent.put(`/entity-types/${openQuestions._id}`).send({ name: 'worlds' }));
    assert.equal(rename.status, 409);
    assert.equal((await typeNamed(alice, 'Open Questions'))._id, openQuestions._id, 'the refused rename changed nothing');
  });

  test('a name that is not a built-in category is 201, and an entity can use it at once', async () => {
    const vehicles = await createType(alice, { name: 'Vehicles' });
    assert.equal(vehicles.name, 'Vehicles');

    const entity = await postEntity(alice, 'Vehicles', 'The Night Express');
    assert.equal(entity.status, 201, JSON.stringify(entity.body));
    assert.equal(entity.body.category, 'Vehicles');

    const foreign = await postEntity(bob, 'Vehicles');
    assert.equal(foreign.status, 400, "alice's type opens the name in her workspace only");
    assert.match(foreign.body.error, /not an entity type/);
  });

  test('a missing or blank name is 400', async () => {
    assert.equal((await alice.agent.post('/entity-types').send({})).status, 400);
    assert.equal((await alice.agent.post('/entity-types').send({ name: '   ' })).status, 400);
    assert.equal((await alice.agent.put(`/entity-types/${aliceSecret._id}`).send({ name: '' })).status, 400);
    assert.equal((await alice.agent.post('/entity-types').send({ name: 'Colourful', color: 'red' })).status, 400, 'color must be a { bg, text } pair');
  });

  test('?q= fuzzy-filters by name', async () => {
    const names = (await listTypes(alice, { q: 'charact' })).map(t => t.name);
    assert.ok(names.includes('Characters'));
    assert.ok(!names.includes('Timeline'));
  });
});

describe('tenancy', () => {
  test("another tenant's type is never listed", async () => {
    const ids = (await listTypes(bob)).map(t => t._id);
    assert.ok(ids.length > 0, "bob should see his own seeded types — an empty list would prove nothing");
    assert.ok(!ids.includes(aliceSecret._id), "alice's type must not be listed for bob, though he has one of the same name");
    assert.ok(!(await listTypes(bob, { q: aliceSecret.name })).some(t => t._id === aliceSecret._id), 'nor found by search');
  });

  test("a foreign type cannot be updated or deleted: 404, and nothing changes", async () => {
    const put = probed(bob, `PUT /entity-types/${aliceSecret._id}`, await bob.agent
      .put(`/entity-types/${aliceSecret._id}`)
      .send({ name: 'Timeline', icon: '💀' }));
    assert.equal(put.status, 404);
    assert.equal(put.body.name, undefined, 'no field of the foreign type may appear in the response');

    const del = probed(bob, `DELETE /entity-types/${aliceSecret._id}`, await bob.agent.delete(`/entity-types/${aliceSecret._id}`));
    assert.equal(del.status, 404);

    const survivor = await typeNamed(alice, 'Lore & Mechanics');
    assert.equal(survivor.icon, '🔒', "alice's type must survive both attempts untouched");
  });

  test('a malformed id is 404, not 400 or 500', async () => {
    assert.equal(probed(bob, 'PUT /entity-types/not-an-id', await bob.agent.put('/entity-types/not-an-id').send({ icon: 'x' })).status, 404);
    assert.equal(probed(bob, 'DELETE /entity-types/not-an-id', await bob.agent.delete('/entity-types/not-an-id')).status, 404);
  });

  test("a client-supplied workspaceId is ignored on create and update", async () => {
    const planted = await createType(bob, { name: 'Planted', workspaceId: alice.workspaceId });
    assert.ok(!(await listTypes(alice)).some(t => t._id === planted._id), "the planted type must not appear in alice's registry");

    const moved = await alice.agent.put(`/entity-types/${aliceSecret._id}`).send({ workspaceId: bob.workspaceId, order: 50 });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.order, 50, 'the rest of the update still applies');
    assert.equal(String(moved.body.workspaceId), alice.workspaceId, 'the type must not move workspaces');
  });
});

describe('the registry gates the category names data can hold', () => {
  test("an entity cannot take a category its workspace has no type for, on create or update", async () => {
    await deleteType(bob, 'Lore & Mechanics');

    const refused = await postEntity(bob, 'Lore & Mechanics');
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /not an entity type/);
    assert.equal((await postEntity(alice, 'Lore & Mechanics')).status, 201, "alice still has the type; bob's registry must not decide for her");

    const worlds = await postEntity(bob, 'Worlds');
    assert.equal(worlds.status, 201, JSON.stringify(worlds.body));
    const moved = probed(bob, 'PUT entity onto "Lore & Mechanics"', await bob.agent
      .put(`/entities/${worlds.body._id}`)
      .send({ category: 'Lore & Mechanics' }));
    assert.equal(moved.status, 400);
    assert.equal((await bob.agent.get(`/entities/${worlds.body._id}`)).body.category, 'Worlds', 'the refused update changed nothing');

    // A rename moves the gate with it: the old name closes, the new one opens.
    const openQuestions = await typeNamed(bob, 'Open Questions');
    const rename = await bob.agent.put(`/entity-types/${openQuestions._id}`).send({ name: 'Lore & Mechanics' });
    assert.equal(rename.status, 200, JSON.stringify(rename.body));
    assert.equal(rename.body.name, 'Lore & Mechanics');
    assert.equal((await postEntity(bob, 'Lore & Mechanics')).status, 201);
    assert.equal((await postEntity(bob, 'Open Questions')).status, 400);
  });

  test('relationship types that name a type count as uses, and their categories are checked', async () => {
    // Seeded member roles like "Member" and "Leader" target Organizations; no entity does.
    const organizations = await typeNamed(alice, 'Organizations');
    const del = probed(alice, 'DELETE "Organizations"', await alice.agent.delete(`/entity-types/${organizations._id}`));
    assert.equal(del.status, 409);
    assert.equal(del.body.entities, 0);
    assert.ok(del.body.relationshipTypes > 0, `the refusal should count the relationship types: ${JSON.stringify(del.body)}`);
    assert.equal(del.body.inUse, del.body.entities + del.body.relationshipTypes);

    // bob renamed his Open Questions away above.
    const refused = probed(bob, 'POST /relationship-types targeting "Open Questions"', await bob.agent
      .post('/relationship-types')
      .send({ name: 'Witness', sourceCategory: 'Characters', targetCategory: 'Open Questions' }));
    assert.equal(refused.status, 400);

    const witness = await bob.agent.post('/relationship-types').send({ name: 'Witness', sourceCategory: 'Characters', targetCategory: 'Lore & Mechanics' });
    assert.equal(witness.status, 201, JSON.stringify(witness.body));

    const retarget = probed(bob, 'PUT relationship type onto "Open Questions"', await bob.agent
      .put(`/relationship-types/${witness.body._id}`)
      .send({ sourceCategory: 'Open Questions' }));
    assert.equal(retarget.status, 400);
    const cleared = await bob.agent.put(`/relationship-types/${witness.body._id}`).send({ sourceCategory: null });
    assert.equal(cleared.status, 200, 'null still means any type');
    assert.equal(cleared.body.sourceCategory, null);
  });

  test("a workspace's last type cannot be deleted", async () => {
    const carol = await registerUser('carol@example.test');
    // Set up in the database directly: the route would refuse most of these
    // deletes, since the starter content uses them.
    await EntityType.deleteMany({ workspaceId: carol.workspaceId, name: { $ne: 'Timeline' } });

    const timeline = await typeNamed(carol, 'Timeline');
    const del = probed(carol, 'DELETE last type "Timeline"', await carol.agent.delete(`/entity-types/${timeline._id}`));
    assert.equal(del.status, 409);
    assert.match(del.body.error, /at least one entity type/);
    assert.equal((await postEntity(carol, 'Timeline')).status, 201, 'the kept type is usable');
    assert.equal((await postEntity(carol, 'Characters')).status, 400, 'an emptied-out registry still gates');
  });
});

describe('types in use by entities', () => {
  /** Sorted string ids of `model` documents in `workspaceId` matching `filter`. */
  async function idsWhere(model, workspaceId, filter) {
    return (await model.find({ workspaceId, ...filter }).select('_id').lean()).map(d => String(d._id)).sort();
  }

  test('a rename is 200 and cascades to the entities and relationship types that named it; a delete is still 409', async () => {
    // The starter "Example Character" and most seeded member roles use Characters.
    const characters = await typeNamed(bob, 'Characters');
    const ws = bob.workspaceId;
    const entityIds = await idsWhere(Entity, ws, { category: 'Characters' });
    const sourceIds = await idsWhere(RelationshipType, ws, { sourceCategory: 'Characters' });
    const targetIds = await idsWhere(RelationshipType, ws, { targetCategory: 'Characters' });
    assert.ok(entityIds.length && sourceIds.length && targetIds.length,
      `the type must be in use on every path the cascade covers, or this proves nothing: ${entityIds.length}/${sourceIds.length}/${targetIds.length}`);
    const aliceBefore = {
      entities: await idsWhere(Entity, alice.workspaceId, { category: 'Characters' }),
      sources: await idsWhere(RelationshipType, alice.workspaceId, { sourceCategory: 'Characters' }),
    };
    assert.ok(aliceBefore.entities.length, 'alice uses a "Characters" of her own, so a leak across workspaces would show');

    const rename = probed(bob, 'PUT rename in-use "Characters" → "People"', await bob.agent
      .put(`/entity-types/${characters._id}`)
      .send({ name: 'People' }));
    assert.equal(rename.status, 200, JSON.stringify(rename.body));
    assert.equal(rename.body.name, 'People');
    assert.deepEqual(rename.body.relabelled,
      { entities: entityIds.length, sourceCategories: sourceIds.length, targetCategories: targetIds.length },
      'the response counts what moved');

    assert.deepEqual(await idsWhere(Entity, ws, { category: 'People' }), entityIds, 'exactly the entities that named the type moved');
    assert.deepEqual(await idsWhere(RelationshipType, ws, { sourceCategory: 'People' }), sourceIds);
    assert.deepEqual(await idsWhere(RelationshipType, ws, { targetCategory: 'People' }), targetIds);
    assert.equal(await Entity.countDocuments({ workspaceId: ws, category: 'Characters' }), 0, 'nothing is left on the old name');
    assert.equal(await RelationshipType.countDocuments({ workspaceId: ws, $or: [{ sourceCategory: 'Characters' }, { targetCategory: 'Characters' }] }), 0);

    assert.deepEqual(await idsWhere(Entity, alice.workspaceId, { category: 'Characters' }), aliceBefore.entities, "alice's entities are untouched");
    assert.deepEqual(await idsWhere(RelationshipType, alice.workspaceId, { sourceCategory: 'Characters' }), aliceBefore.sources, "alice's relationship types are untouched");

    // Read back through the API, and still writable under the new name.
    assert.equal((await bob.agent.get(`/entities/${entityIds[0]}`)).body.category, 'People');
    const edit = await bob.agent.put(`/entities/${entityIds[0]}`).send({ category: 'People', summary: 'renamed type' });
    assert.equal(edit.status, 200, `a relabelled entity must pass validation: ${JSON.stringify(edit.body)}`);
    assert.equal((await postEntity(bob, 'Characters')).status, 400, 'the old name is closed');

    // Case alone is a rename too: entities store the name as spelled.
    const recased = await bob.agent.put(`/entity-types/${characters._id}`).send({ name: 'PEOPLE' });
    assert.equal(recased.status, 200, JSON.stringify(recased.body));
    assert.equal(recased.body.relabelled.entities, entityIds.length);
    assert.equal((await bob.agent.get(`/entities/${entityIds[0]}`)).body.category, 'PEOPLE');

    const del = probed(bob, 'DELETE in-use "PEOPLE"', await bob.agent.delete(`/entity-types/${characters._id}`));
    assert.equal(del.status, 409);
    assert.ok(del.body.entities >= 1, `the refusal should say how many entities use the type: ${JSON.stringify(del.body)}`);

    const restyle = await bob.agent.put(`/entity-types/${characters._id}`).send({ name: 'PEOPLE', icon: '👤' });
    assert.equal(restyle.status, 200, 'resending the current name is not a rename');
    assert.equal(restyle.body.icon, '👤');
    assert.equal(restyle.body.relabelled, undefined);
  });

  test("use is counted in the caller's workspace only — and a deleted type stays unusable", async () => {
    assert.equal((await postEntity(bob, 'Timeline', "Bob's Epoch")).status, 201);

    const bobTimeline = await typeNamed(bob, 'Timeline');
    assert.equal(probed(bob, 'DELETE in-use "Timeline"', await bob.agent.delete(`/entity-types/${bobTimeline._id}`)).status, 409);

    // alice has no Timeline entity; bob's must not block her.
    await deleteType(alice, 'Timeline');

    // The drift this guards against: a deleted type must not come back through an entity.
    assert.equal((await postEntity(bob, 'Timeline', "Bob's Second Epoch")).status, 201, 'bob still has it');
    assert.equal((await postEntity(alice, 'Timeline')).status, 400, 'alice deleted Timeline, so her entities cannot use it');
  });
});
