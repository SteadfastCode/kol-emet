/**
 * The entity-type registry (Phase 6 step 1) across two real accounts.
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
 * Types are referenced by *name* from `Entity.category`, which is why a type
 * in use cannot be renamed or deleted yet — see src/routes/entityTypes.js.
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

/** A type alice creates in before(), for bob to probe. */
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

  aliceSecret = await createType(alice, { name: 'Alice Secret Type', icon: '🔒' });
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
    const created = await createType(alice, { name: '  Vehicles  ', icon: '🚂', color: { bg: '#111111', text: '#EEEEEE' } });
    assert.equal(created.name, 'Vehicles', 'the name is trimmed');
    const before = await listTypes(alice);
    assert.equal(created.order, Math.max(...before.filter(t => t._id !== created._id).map(t => t.order)) + 1,
      'with no order given, a new type goes after the last one');
    assert.equal(before.at(-1).name, 'Vehicles', 'the list is sorted by order');

    const put = await alice.agent.put(`/entity-types/${created._id}`).send({ name: 'Trains', order: 99, color: { text: '#FFFFFF' } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.name, 'Trains');
    assert.equal(put.body.order, 99);
    assert.deepEqual(put.body.color, { bg: '#111111', text: '#FFFFFF' }, 'a partial colour update keeps the other half');
    assert.equal(put.body.icon, '🚂', 'fields not in the body are untouched');

    const del = await alice.agent.delete(`/entity-types/${created._id}`);
    assert.equal(del.status, 204);
    assert.ok(!(await listTypes(alice)).some(t => t._id === created._id), 'a deleted type is no longer listed');
    assert.equal((await alice.agent.delete(`/entity-types/${created._id}`)).status, 404, 'a second delete finds nothing');
  });

  test('names are unique per workspace, case-insensitively — and only per workspace', async () => {
    const dup = probed(alice, 'POST /entity-types "characters"', await alice.agent.post('/entity-types').send({ name: 'characters' }));
    assert.equal(dup.status, 409);
    assert.equal(dup.body.existing.name, 'Characters');

    await createType(alice, { name: 'Starships' });
    await createType(bob, { name: 'Starships' }); // the same name in another workspace is fine

    const artifacts = await createType(alice, { name: 'Artifacts' });
    const rename = probed(alice, 'PUT rename onto "worlds"', await alice.agent.put(`/entity-types/${artifacts._id}`).send({ name: 'worlds' }));
    assert.equal(rename.status, 409);
    assert.equal((await typeNamed(alice, 'Artifacts'))._id, artifacts._id, 'the refused rename changed nothing');
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
    const names = (await listTypes(bob)).map(t => t.name);
    assert.ok(names.length > 0, "bob should see his own seeded types — an empty list would prove nothing");
    assert.ok(!names.includes(aliceSecret.name), "alice's type must not be listed for bob");
    assert.ok(!(await listTypes(bob, { q: 'Alice Secret' })).some(t => t._id === aliceSecret._id), 'nor found by search');
  });

  test("a foreign type cannot be updated or deleted: 404, and nothing changes", async () => {
    const put = probed(bob, `PUT /entity-types/${aliceSecret._id}`, await bob.agent
      .put(`/entity-types/${aliceSecret._id}`)
      .send({ name: 'Hijacked', icon: '💀' }));
    assert.equal(put.status, 404);
    assert.equal(put.body.name, undefined, 'no field of the foreign type may appear in the response');

    const del = probed(bob, `DELETE /entity-types/${aliceSecret._id}`, await bob.agent.delete(`/entity-types/${aliceSecret._id}`));
    assert.equal(del.status, 404);

    const survivor = await typeNamed(alice, 'Alice Secret Type');
    assert.equal(survivor.icon, '🔒', "alice's type must survive both attempts untouched");
  });

  test('a malformed id is 404, not 400 or 500', async () => {
    assert.equal(probed(bob, 'PUT /entity-types/not-an-id', await bob.agent.put('/entity-types/not-an-id').send({ icon: 'x' })).status, 404);
    assert.equal(probed(bob, 'DELETE /entity-types/not-an-id', await bob.agent.delete('/entity-types/not-an-id')).status, 404);
  });

  test("a client-supplied workspaceId is ignored on create and update", async () => {
    const planted = await createType(bob, { name: 'Planted By Bob', workspaceId: alice.workspaceId });
    assert.ok(!(await listTypes(alice)).some(t => t._id === planted._id), "the planted type must not appear in alice's registry");

    const moved = await alice.agent.put(`/entity-types/${aliceSecret._id}`).send({ workspaceId: bob.workspaceId, order: 50 });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.order, 50, 'the rest of the update still applies');
    assert.equal(String(moved.body.workspaceId), alice.workspaceId, 'the type must not move workspaces');
  });
});

describe('types in use by entities', () => {
  test('cannot be renamed or deleted while the Entity enum stands, but can be restyled', async () => {
    // The starter "Example Character" seeded at registration uses Characters.
    const characters = await typeNamed(alice, 'Characters');

    const rename = probed(alice, 'PUT rename in-use "Characters"', await alice.agent
      .put(`/entity-types/${characters._id}`)
      .send({ name: 'People' }));
    assert.equal(rename.status, 409);
    assert.ok(rename.body.inUse >= 1, `the refusal should say how many entities use the type: ${JSON.stringify(rename.body)}`);

    const del = probed(alice, 'DELETE in-use "Characters"', await alice.agent.delete(`/entity-types/${characters._id}`));
    assert.equal(del.status, 409);

    const restyle = await alice.agent.put(`/entity-types/${characters._id}`).send({ name: 'Characters', icon: '👤' });
    assert.equal(restyle.status, 200, 'resending the current name is not a rename');
    assert.equal(restyle.body.icon, '👤');
    assert.equal(restyle.body.name, 'Characters');
  });

  test("use is counted in the caller's workspace only", async () => {
    const entity = await bob.agent.post('/entities').send({ title: "Bob's Epoch", category: 'Timeline', summary: 'Makes Timeline in use for bob.' });
    assert.equal(entity.status, 201, JSON.stringify(entity.body));

    const bobTimeline = await typeNamed(bob, 'Timeline');
    assert.equal(probed(bob, 'DELETE in-use "Timeline"', await bob.agent.delete(`/entity-types/${bobTimeline._id}`)).status, 409);

    // alice has no Timeline entity; bob's must not block her.
    const aliceTimeline = await typeNamed(alice, 'Timeline');
    assert.equal((await alice.agent.delete(`/entity-types/${aliceTimeline._id}`)).status, 204);
  });
});
