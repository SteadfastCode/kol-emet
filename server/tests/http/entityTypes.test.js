/**
 * The entity-type registry (Phase 6 step 1) across real accounts.
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
 * uses cannot be renamed or deleted, and while the Entity enum stands a type's
 * name is one of the built-in categories. That last rule is why the fixtures
 * below make room — delete an unused type — before creating one.
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

async function registerUser(email) {
  const agent = request.agent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  log('light', `registered ${email} (source: POST /auth/register) → workspace ${workspace._id} (source: Workspace.members.userId lookup)`);
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

      assert.deepEqual(seeded.map(t => t.name), CATEGORIES, `${who.email}'s registry must match the Entity enum, in its order`);
      assert.deepEqual(seeded.map(t => t.order), [0, 1, 2, 3, 4, 5]);
      for (const t of seeded) assert.equal(String(t.workspaceId), who.workspaceId, `seeded "${t.name}" must be in ${who.email}'s workspace`);
    }

    const characters = await typeNamed(alice, 'Characters');
    assert.deepEqual(characters.color, { bg: '#B5D4F4', text: '#0C447C' }, "the client's pill colours must carry over");
    assert.equal(characters.icon, null);

    const aliceIds = new Set((await listTypes(alice)).map(t => String(t._id)));
    assert.ok((await listTypes(bob)).every(t => !aliceIds.has(String(t._id))), 'each workspace gets its own rows, not shared ones');
  });

  test('seedEntityTypes adds only what is missing, so a re-run never duplicates', async () => {
    const workspaceId = new mongoose.Types.ObjectId();
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
    // A fresh workspace has all six, so a create needs room: nothing uses Open Questions.
    const gone = await deleteType(alice, 'Open Questions');
    assert.ok(!(await listTypes(alice)).some(t => t._id === gone._id), 'a deleted type is no longer listed');
    assert.equal((await alice.agent.delete(`/entity-types/${gone._id}`)).status, 404, 'a second delete finds nothing');

    const created = await createType(alice, { name: '  open questions  ', icon: '❓', color: { bg: '#111111', text: '#EEEEEE' } });
    assert.equal(created.name, 'Open Questions', "the name is trimmed and takes the category's spelling");
    const before = await listTypes(alice);
    assert.equal(created.order, Math.max(...before.filter(t => t._id !== created._id).map(t => t.order)) + 1,
      'with no order given, a new type goes after the last one');
    assert.equal(before.at(-1).name, 'Open Questions', 'the list is sorted by order');

    const put = await alice.agent.put(`/entity-types/${created._id}`).send({ name: 'OPEN QUESTIONS', order: 99, color: { text: '#FFFFFF' } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.name, 'Open Questions', 'a differently cased current name is not a rename');
    assert.equal(put.body.order, 99);
    assert.deepEqual(put.body.color, { bg: '#111111', text: '#FFFFFF' }, 'a partial colour update keeps the other half');
    assert.equal(put.body.icon, '❓', 'fields not in the body are untouched');
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

  test('a name that is not a built-in category is 400, since no entity could use it', async () => {
    const create = probed(alice, 'POST /entity-types "Vehicles"', await alice.agent.post('/entity-types').send({ name: 'Vehicles' }));
    assert.equal(create.status, 400);
    assert.deepEqual(create.body.categories, CATEGORIES, 'the refusal lists the names that are allowed');

    const openQuestions = await typeNamed(alice, 'Open Questions');
    const rename = probed(alice, 'PUT rename to "Vehicles"', await alice.agent.put(`/entity-types/${openQuestions._id}`).send({ name: 'Vehicles' }));
    assert.equal(rename.status, 400);
    assert.ok(!(await listTypes(alice)).some(t => t.name === 'Vehicles'), 'neither write registered it');
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
    await deleteType(bob, 'Open Questions');
    const planted = await createType(bob, { name: 'Open Questions', workspaceId: alice.workspaceId });
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
    const rename = await bob.agent.put(`/entity-types/${openQuestions._id}`).send({ name: 'lore & mechanics' });
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
  test('cannot be renamed or deleted while the Entity enum stands, but can be restyled', async () => {
    // The starter "Example Character" seeded at registration uses Characters.
    // bob has no Open Questions type since the rename above, so it is a free name.
    const characters = await typeNamed(bob, 'Characters');

    const rename = probed(bob, 'PUT rename in-use "Characters"', await bob.agent
      .put(`/entity-types/${characters._id}`)
      .send({ name: 'Open Questions' }));
    assert.equal(rename.status, 409);
    assert.ok(rename.body.entities >= 1, `the refusal should say how many entities use the type: ${JSON.stringify(rename.body)}`);

    const del = probed(bob, 'DELETE in-use "Characters"', await bob.agent.delete(`/entity-types/${characters._id}`));
    assert.equal(del.status, 409);

    const restyle = await bob.agent.put(`/entity-types/${characters._id}`).send({ name: 'Characters', icon: '👤' });
    assert.equal(restyle.status, 200, 'resending the current name is not a rename');
    assert.equal(restyle.body.icon, '👤');
    assert.equal(restyle.body.name, 'Characters');
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
