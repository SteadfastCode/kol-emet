/**
 * HTTP tests for the workspace-wide tag operations (KOL-053):
 * `PUT /tags/:tag { to }` and `DELETE /tags/:tag`.
 *
 * These are the first routes that change many entities in one request, so what
 * is asserted here is everything that only shows up at that scale:
 *
 *   The rename is `$addToSet` then `$pull`, as two writes. An entity that
 *   already carries the new name must end with exactly ONE copy of it — the
 *   single-field update a first attempt reaches for ($set over a mapped array,
 *   or both operators in one update) either duplicates the tag or is refused
 *   by Mongo outright.
 *
 *   One ChangeLog entry per changed entity, written before the response. That
 *   is what makes a bulk rename as reversible as the single edit it replaces,
 *   and the count is asserted exactly: a route that logged once for the whole
 *   operation, or not at all, would still answer 200 with the right tags.
 *
 *   Tenancy. Tags are plain strings on entities, so two workspaces holding the
 *   identical tag name is the normal case, not an edge one; every query has to
 *   carry `workspaceId` or one tenant's cleanup rewrites another's data.
 *
 *   The bound. Past 200 affected entities the route refuses with 413 and
 *   writes nothing at all — not the tags, not the changelog.
 *
 * Falsification: drop `workspaceId` from either `updateMany` filter and the
 * cross-tenant cases fail; swap the two writes in the rename and the merge
 * case loses the tag entirely; make the changelog fire-and-forget and the
 * per-entity counts go flaky-to-zero; remove the `MAX_AFFECTED` check and the
 * 413 case fails.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_TAGS_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture document, naming the request that created it
 *             and the workspace it landed in
 *   normal  — light, plus every tag request with its status and body
 *   verbose — normal, plus every entity's tags after each operation
 */

import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';
import session from 'express-session';
import request from 'supertest';

// Every session write is checked against CLIENT_ORIGIN (src/middleware/originGuard.js),
// so this suite names one below and its agents send a matching Origin.
import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';

import * as db from '../helpers/db.js';
// Registration is throttled per client address, and these suites register
// their fixtures through the real endpoint from one address. See the helper.
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import Entity from '../../src/models/Entity.js';
import ChangeLog from '../../src/models/ChangeLog.js';

// The environment has to be in place before src/app.js is imported — same
// reasoning as tests/http/tenancy.test.js, hence the dynamic import below.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
// The origin the guard compares a session write's Origin header against;
// originAgent() above sends it. See tests/helpers/origin.js.
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
// Unset on purpose: every request here authenticates with a session cookie, so
// a stray Authorization header must not be able to satisfy requireAuth.
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.TAG_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');
const { MAX_AFFECTED } = await import('../../src/routes/tags.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_TAGS_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/tags:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

/**
 * Alice's three entities. `train` is on two of them, so a rename has to move
 * exactly those two; `steam` sits beside `train` on one, which is the merge
 * case; and the third carries neither, so it is what an unscoped write drags in.
 */
const ENGINE    = { title: 'The Engine',    category: 'Worlds',     summary: 'Pulls the rest', tags: ['train', 'steam'] };
const CABOOSE   = { title: 'The Caboose',   category: 'Worlds',     summary: 'Brings up the rear', tags: ['train'] };
const CONDUCTOR = { title: 'The Conductor', category: 'Characters', summary: 'Punches tickets', tags: ['crew'] };

/** Bob's row carries the identical tag name, so a lost workspace clause shows up. */
const BOB_ENTITY = { title: "Bob's Engine", category: 'Worlds', summary: 'Another workspace entirely', tags: ['train'] };

let app;
let alice;
let bob;

/**
 * Registers a user through the real endpoint and reads back the ids
 * registration created, so the fixture asserts on what the API actually did.
 */
async function registerUser(email) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  assert.ok(user, `registration should have created a User for ${email}`);
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  log('light', `registered ${email} (source: POST /auth/register) → user ${user._id}, workspace ${workspace._id} (source: Workspace.members.userId lookup)`);
  return { agent, email, userId: String(user._id), workspaceId: String(workspace._id) };
}

/** POSTs an entity as `who` and returns the created document. */
async function createEntity(who, body) {
  const res = await who.agent.post('/entities').send(body);
  assert.equal(res.status, 201, `POST /entities as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(String(res.body.workspaceId), who.workspaceId, `${who.email}'s entity must land in their own workspace`);
  log('light', `created entity ${res.body._id} "${res.body.title}" tags [${res.body.tags}] (source: POST /entities as ${who.email})`);
  return res.body;
}

/** `{ title: tags }` for every entity in `who`'s workspace, straight from the database. */
async function tagsByTitle(who) {
  const docs = await Entity.find({ workspaceId: who.workspaceId }).select('title tags').lean();
  const map = Object.fromEntries(docs.map(d => [d.title, d.tags]));
  log('verbose', `${who.email}'s tags: ${JSON.stringify(map)}`);
  return map;
}

/** The 'updated' ChangeLog entries in `who`'s workspace, by entity title. */
async function updateLogTitles(who) {
  const docs = await ChangeLog.find({ workspaceId: who.workspaceId, changeType: 'updated' })
    .select('entityTitle changes actorLabel')
    .lean();
  return docs.map(d => d.entityTitle).sort();
}

const renameAs = (who, tag, body) => who.agent.put(`/tags/${encodeURIComponent(tag)}`).send(body);
const removeAs = (who, tag) => who.agent.delete(`/tags/${encodeURIComponent(tag)}`);

function logged(res, what) {
  log('normal', `${what} → ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

before(async () => {
  await db.connect();

  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });

  alice = await registerUser('tags-alice@example.test');
  bob = await registerUser('tags-bob@example.test');
  assert.notEqual(alice.workspaceId, bob.workspaceId, 'two registrations must yield two distinct workspaces');
});

// Every test rewrites the same tags, so the entities and the audit trail are
// rebuilt per test; the two accounts and their workspaces are not. The
// fixtures' own 'created' entries are not waited for or cleared — POST
// /entities logs those fire-and-forget, so they can land at any moment — which
// is why every assertion below counts 'updated' entries only.
beforeEach(async () => {
  await Entity.deleteMany({});
  await ChangeLog.deleteMany({});
  for (const body of [ENGINE, CABOOSE, CONDUCTOR]) await createEntity(alice, body);
  await createEntity(bob, BOB_ENTITY);
});

after(async () => {
  await db.disconnect();
});

describe('PUT /tags/:tag', () => {
  test('renames the tag on every entity carrying it and leaves the rest alone', async () => {
    const res = logged(await renameAs(alice, 'train', { to: 'rail' }), 'PUT /tags/train {to: rail}');

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.renamed, 2, 'two of the three entities carry "train"');

    assert.deepEqual(await tagsByTitle(alice), {
      'The Engine':    ['steam', 'rail'],
      'The Caboose':   ['rail'],
      'The Conductor': ['crew'],
    });
  });

  test('a merge leaves exactly one copy of the surviving tag', async () => {
    // The Engine already carries "train"; renaming "steam" onto it must not
    // give it two, and must not take the one it has.
    const res = logged(await renameAs(alice, 'steam', { to: 'train' }), 'PUT /tags/steam {to: train}');

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.renamed, 1);

    const tags = await tagsByTitle(alice);
    assert.deepEqual(tags['The Engine'], ['train'], 'the merged entity must hold the tag exactly once');
    assert.deepEqual(tags['The Caboose'], ['train'], 'an entity that never carried "steam" is untouched');
  });

  test('a case-only rename merges rather than colliding', async () => {
    await createEntity(alice, { title: 'The Yard', category: 'Worlds', summary: 'Sidings', tags: ['Train', 'train'] });

    const res = logged(await renameAs(alice, 'Train', { to: 'train' }), 'PUT /tags/Train {to: train}');

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.renamed, 1);
    assert.deepEqual((await tagsByTitle(alice))['The Yard'], ['train']);
  });

  test('writes one ChangeLog entry per changed entity, before it answers', async () => {
    await renameAs(alice, 'train', { to: 'rail' });

    // No wait, no retry: the route awaits the trail, so it exists by now.
    assert.deepEqual(await updateLogTitles(alice), ['The Caboose', 'The Engine']);

    const entry = await ChangeLog.findOne({ workspaceId: alice.workspaceId, changeType: 'updated', entityTitle: 'The Caboose' }).lean();
    assert.deepEqual(entry.changes.fieldsChanged, ['tags'], 'the diff should name the field that moved');
    assert.deepEqual(entry.snapshot.tags, ['train'], 'the snapshot is what a rollback restores');
    assert.equal(entry.actorLabel, alice.email, 'the session user is the actor, per requireActor');
    assert.equal(await ChangeLog.countDocuments({ workspaceId: alice.workspaceId, changeType: 'updated' }), 2, 'exactly one entry per changed entity');
  });

  test("another workspace's identically-named tag is untouched", async () => {
    await renameAs(alice, 'train', { to: 'rail' });

    assert.deepEqual(await tagsByTitle(bob), { "Bob's Engine": ['train'] }, "bob's tag is a different tag");
    assert.equal(await ChangeLog.countDocuments({ workspaceId: bob.workspaceId, changeType: 'updated' }), 0, "nothing should be logged in bob's workspace");
  });

  test('a blank or non-string `to` is 400 and changes nothing', async () => {
    for (const body of [{ to: '' }, { to: '   ' }, { to: 7 }, { to: null }, { to: ['rail'] }, {}]) {
      const res = logged(await renameAs(alice, 'train', body), `PUT /tags/train ${JSON.stringify(body)}`);
      assert.equal(res.status, 400, `${JSON.stringify(body)} should be refused: ${JSON.stringify(res.body)}`);
    }
    assert.deepEqual((await tagsByTitle(alice))['The Caboose'], ['train']);
    assert.equal(await ChangeLog.countDocuments({ changeType: 'updated' }), 0);
  });

  test('a rename to itself is a 200 no-op, not a changelog entry per entity', async () => {
    const res = logged(await renameAs(alice, 'train', { to: 'train' }), 'PUT /tags/train {to: train}');

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.renamed, 0);
    assert.deepEqual((await tagsByTitle(alice))['The Caboose'], ['train'], 'the tag must survive its own rename');
    assert.equal(await ChangeLog.countDocuments({ changeType: 'updated' }), 0);
  });

  test('a tag no entity carries is 404', async () => {
    const res = logged(await renameAs(alice, 'nonesuch', { to: 'rail' }), 'PUT /tags/nonesuch');
    assert.equal(res.status, 404, JSON.stringify(res.body));
  });

  test('a tag holding a slash addresses its own route', async () => {
    await createEntity(alice, { title: 'The Yard', category: 'Worlds', summary: 'Sidings', tags: ['rolling/stock'] });

    const res = logged(await renameAs(alice, 'rolling/stock', { to: 'stock' }), 'PUT /tags/rolling%2Fstock');

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual((await tagsByTitle(alice))['The Yard'], ['stock']);
  });

  test('a signed-out caller is 401', async () => {
    const res = await request(app).put('/tags/train').send({ to: 'rail' });
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.deepEqual((await tagsByTitle(alice))['The Caboose'], ['train']);
  });
});

describe('DELETE /tags/:tag', () => {
  test('removes the tag everywhere and reports how many entities changed', async () => {
    const res = logged(await removeAs(alice, 'train'), 'DELETE /tags/train');

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.removed, 2);
    assert.deepEqual(await tagsByTitle(alice), {
      'The Engine':    ['steam'],
      'The Caboose':   [],
      'The Conductor': ['crew'],
    });
  });

  test('writes one ChangeLog entry per changed entity', async () => {
    await removeAs(alice, 'train');

    assert.deepEqual(await updateLogTitles(alice), ['The Caboose', 'The Engine']);
    assert.equal(await ChangeLog.countDocuments({ workspaceId: alice.workspaceId, changeType: 'updated' }), 2);
  });

  test("another workspace's identically-named tag is untouched", async () => {
    await removeAs(alice, 'train');

    assert.deepEqual(await tagsByTitle(bob), { "Bob's Engine": ['train'] });
  });

  test('a tag no entity carries is 404', async () => {
    const res = logged(await removeAs(alice, 'nonesuch'), 'DELETE /tags/nonesuch');
    assert.equal(res.status, 404, JSON.stringify(res.body));
  });

  test('a signed-out caller is 401', async () => {
    const res = await request(app).delete('/tags/train');
    assert.equal(res.status, 401, JSON.stringify(res.body));
    assert.deepEqual((await tagsByTitle(alice))['The Caboose'], ['train']);
  });
});

describe('the bulk bound', () => {
  const BULK_TAG = 'bulk';

  /**
   * Inserts `n` entities carrying BULK_TAG straight through the driver —
   * MAX_AFFECTED + 1 POSTs would make this suite minutes long, and what is
   * under test is the route's count, not the create path.
   */
  async function seedBulk(n) {
    const workspaceId = new mongoose.Types.ObjectId(alice.workspaceId);
    const now = new Date();
    await Entity.collection.insertMany(
      Array.from({ length: n }, (_, i) => ({
        title: `Bulk ${i}`, category: 'Worlds', summary: '', tags: [BULK_TAG],
        blocks: [], relationships: [], open_questions: [],
        workspaceId, createdAt: now, updatedAt: now,
      })),
    );
    log('light', `seeded ${n} entities tagged "${BULK_TAG}" (source: Entity.collection.insertMany, bypassing the route)`);
  }

  test(`${MAX_AFFECTED} affected entities is allowed`, async () => {
    await seedBulk(MAX_AFFECTED);

    const res = logged(await renameAs(alice, BULK_TAG, { to: 'batch' }), `PUT /tags/${BULK_TAG} at the limit`);

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.renamed, MAX_AFFECTED);
    assert.equal(await Entity.countDocuments({ workspaceId: alice.workspaceId, tags: 'batch' }), MAX_AFFECTED);
    assert.equal(await ChangeLog.countDocuments({ workspaceId: alice.workspaceId, changeType: 'updated' }), MAX_AFFECTED, 'one entry per changed entity, still');
  });

  test(`${MAX_AFFECTED + 1} affected entities is 413, naming the count, and writes nothing`, async () => {
    await seedBulk(MAX_AFFECTED + 1);

    const res = logged(await renameAs(alice, BULK_TAG, { to: 'batch' }), `PUT /tags/${BULK_TAG} past the limit`);

    assert.equal(res.status, 413, JSON.stringify(res.body));
    assert.match(res.body.error, new RegExp(String(MAX_AFFECTED + 1)), `the refusal should name the count: ${res.body.error}`);
    assert.equal(res.body.affected, MAX_AFFECTED + 1);
    assert.equal(await Entity.countDocuments({ workspaceId: alice.workspaceId, tags: BULK_TAG }), MAX_AFFECTED + 1, 'nothing may have been renamed');
    assert.equal(await Entity.countDocuments({ workspaceId: alice.workspaceId, tags: 'batch' }), 0);
    assert.equal(await ChangeLog.countDocuments({ changeType: 'updated' }), 0, 'a refused operation writes no history');
  });

  test(`a removal past ${MAX_AFFECTED} is refused the same way`, async () => {
    await seedBulk(MAX_AFFECTED + 1);

    const res = logged(await removeAs(alice, BULK_TAG), `DELETE /tags/${BULK_TAG} past the limit`);

    assert.equal(res.status, 413, JSON.stringify(res.body));
    assert.equal(await Entity.countDocuments({ workspaceId: alice.workspaceId, tags: BULK_TAG }), MAX_AFFECTED + 1);
    assert.equal(await ChangeLog.countDocuments({ changeType: 'updated' }), 0);
  });
});
