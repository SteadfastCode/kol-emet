/**
 * Which workspace a request acts in, over the real stack (KOL-090).
 *
 * Until this item `resolveWorkspace` was `Workspace.findOne({
 * 'members.userId': userId })` with no sort: for a user in two workspaces the
 * acting one was whichever document the server happened to return first, so a
 * session could read workspace A and then write workspace B, and
 * `GET /workspace` could report a name the content did not come from. Nothing
 * listed a user's workspaces either, so a client could not show the choice.
 *
 * What this file pins — every case is a user who is a member of *two*
 * workspaces, because the one-workspace case is what every other suite in
 * tests/http already covers:
 *
 *   - **determinism**: twenty consecutive requests resolve the same workspace,
 *     and it is the default — the oldest the caller owns;
 *   - **`GET /workspaces`** lists both, in the `workspaceBody` shape, oldest
 *     first, with the caller's own role in each;
 *   - **a selection moves everything together**: after
 *     `POST /workspaces/:id/select`, `GET /entities`, `GET /workspace` and a
 *     write all land in the selected workspace — the "read A, write B" split is
 *     what the item exists to make impossible;
 *   - **selecting a workspace the caller is not a member of is 404** and
 *     changes nothing: not 403, which would confirm the row exists, and not a
 *     write;
 *   - **a stale selection falls back rather than refusing**: when the
 *     membership behind the selected id is revoked, requests resolve the
 *     default again instead of answering 403 on every route, so losing access
 *     to someone else's workspace cannot lock a user out of their own;
 *   - **one session's selection does not affect another's**, neither another
 *     user's nor the same user's second session.
 *
 * The second workspace is seeded directly (`Workspace.create` plus a
 * membership) rather than through a route: creating one from the UI is out of
 * scope for this item, and this is its prerequisite rather than the feature.
 * Everything *else* goes through the real stack — `createApp()` over supertest,
 * real `POST /auth/register`, real mongod — because the subject is a middleware
 * and a mount, which a unit test cannot see.
 *
 * Falsification checks: drop the `req.session.workspaceId` preference in
 * `resolveWorkspace` and the "a selection moves" group fails; drop the
 * membership re-check and the stale-selection group fails (it would answer from
 * a workspace the caller is no longer in); drop the `createdAt`/`_id` sort from
 * `workspacesForUser` and the determinism group becomes a coin toss. Isolation
 * itself is `tests/http/tenancy.test.js`, which must keep passing unchanged —
 * this feature must not weaken the boundary, only make the choice of side explicit.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_WORKSPACE_SELECT_LOG_LEVEL = off | light | normal | verbose (default light)
 * When one of these fails, the missing information is always *which* workspace
 * answered and where that choice came from.
 *   off     — nothing
 *   light   — one line per fixture, naming what created it, and every selection
 *   normal  — light, plus each request and the workspace id it resolved
 *   verbose — normal, plus whole response bodies
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import bcrypt from 'bcrypt';
import session from 'express-session';
import request from 'supertest';

// Every session write is checked against CLIENT_ORIGIN (src/middleware/originGuard.js),
// so this suite names one below and its agents send a matching Origin.
import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';

import * as db from '../helpers/db.js';
// Registration is throttled per client address, and this suite registers its
// fixtures through the real endpoint from one address. See the helper.
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import Entity from '../../src/models/Entity.js';

// Environment before src/app.js is imported, for the reasons in tenancy.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
// Unset on purpose: with no bearer token configured a stray Authorization
// header cannot resolve to the MCP user and quietly satisfy requireAuth.
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.WORKSPACE_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  const active = LEVELS[process.env.TEST_WORKSPACE_SELECT_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/workspaceSelect:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';
const HOME = "Alice's Bible";          // created by registration; alice owns it
const SHARED = 'The Shared Compendium'; // created below; alice is an editor in it
const BOB_WORKSPACE = "Bob's Compendium";

let app;
/** alice: owner of HOME, editor in SHARED. Two memberships, one session. */
let alice;
/** bob: one workspace of his own, used for the foreign-id and crosstalk cases. */
let bob;
/** The second workspace alice is a member of, created directly. */
let shared;
/** A user who owns nothing and is a member of two workspaces of other people's. */
let guest;

/** Registers through the real endpoint and reads back the ids it created. */
async function registerUser(email, workspaceName) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD, workspaceName });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id name').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  log('light', `registered ${email} (source: POST /auth/register) → user ${user._id}, workspace ${workspace._id} "${workspace.name}"`);
  return { agent, email, userId: String(user._id), workspaceId: String(workspace._id), workspaceName: workspace.name };
}

/**
 * A second workspace for `member`, created directly — see the file comment.
 *
 * Backdated to be **older than every registered workspace**, which is what
 * makes the default assertions mean anything: the rule is "the oldest you own,
 * else the oldest you are in", so a shared workspace that was *newer* would be
 * rejected by age alone and the fixture could not tell ownership-first from
 * age-only. Older, and only the ownership half of the rule keeps alice's own
 * workspace as her default.
 *
 * Written through the raw collection because Mongoose marks `createdAt`
 * immutable and strips it from an update.
 */
async function createSharedWorkspace(owner, members) {
  const doc = await Workspace.create({
    name: SHARED,
    ownerId: owner.userId,
    members: [{ userId: owner.userId, role: 'owner' }, ...members],
  });
  const backdated = new Date(Date.now() - 86_400_000);
  await Workspace.collection.updateOne({ _id: doc._id }, { $set: { createdAt: backdated } });
  log('light', `created workspace ${doc._id} "${doc.name}" owned by ${owner.email}, with ${members.map(m => `${m.userId} as ${m.role}`).join(', ')}, backdated to ${backdated.toISOString()} (source: direct Workspace.create + raw createdAt write)`);
  return { workspaceId: String(doc._id), name: doc.name, createdAt: backdated };
}

/**
 * A signed-in user whose memberships are only ever in other people's
 * workspaces — the second half of the default rule, which no registered
 * account can exercise (registration always makes you an owner of one).
 * Created directly, then signed in through the real `POST /auth/login`, as
 * tests/http/workspace.test.js does it.
 */
async function addMember(email, memberships) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = await User.create({ email, passwordHash });
  for (const { workspaceId, role } of memberships) {
    await Workspace.updateOne({ _id: workspaceId }, { $push: { members: { userId: user._id, role } } });
  }

  const agent = originAgent(app);
  const res = await agent.post('/auth/login').send({ email, password: PASSWORD });
  assert.equal(res.status, 200, `POST /auth/login (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  log('light', `added ${email} to ${memberships.length} workspace(s) they do not own (source: direct User.create + $push, signed in via POST /auth/login)`);
  return { agent, email, userId: String(user._id) };
}

/** GETs a path as `who`, logging the status and the workspace it resolved. */
async function get(who, path, label) {
  const res = await who.agent.get(path);
  log('normal', `${label ?? `GET ${path}`} as ${who.email} → ${res.status}`);
  log('verbose', JSON.stringify(res.body));
  return res;
}

/** POSTs the selection and asserts nothing about it; the tests do that. */
async function select(who, workspaceId) {
  const res = await who.agent.post(`/workspaces/${workspaceId}/select`).send({});
  log('light', `${who.email} selected workspace ${workspaceId} → ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

/** The workspace id `GET /workspace` reports for `who`. */
async function actingWorkspace(who, label) {
  const res = await get(who, '/workspace', label);
  assert.equal(res.status, 200, `GET /workspace as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return String(res.body._id);
}

/**
 * Asserts that `GET /entities` returned exactly the entities stored in
 * `workspaceId` — compared by id against the collection, because the list
 * shape carries no `workspaceId` of its own (KOL-061 trimmed it). Equality,
 * not absence: a response that is missing one of the caller's own entities is
 * as wrong as one carrying another workspace's.
 */
async function assertEntityListIsWorkspace(res, workspaceId, label) {
  assert.equal(res.status, 200, `${label} failed: ${res.status} ${JSON.stringify(res.body)}`);
  const listed = res.body.map(e => String(e._id)).sort();
  const stored = (await Entity.find({ workspaceId, deleted: { $ne: true } }).select('_id').lean())
    .map(e => String(e._id)).sort();
  log('verbose', `${label} listed ${listed.length} id(s); workspace ${workspaceId} stores ${stored.length}`);
  assert.ok(stored.length > 0, `${label}: the fixture's workspace should hold entities, or this proves nothing`);
  assert.deepEqual(listed, stored, `${label}: the list must be exactly workspace ${workspaceId}`);
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });

  alice = await registerUser('alice@example.test', HOME);
  bob = await registerUser('bob@example.test', BOB_WORKSPACE);
  assert.notEqual(alice.workspaceId, bob.workspaceId, 'two registrations must yield two distinct workspaces');

  // bob owns it, alice is an editor: two memberships for alice, and the one she
  // does not own is the *older* of the two — see createSharedWorkspace.
  shared = await createSharedWorkspace(bob, [{ userId: alice.userId, role: 'editor' }]);

  const memberships = await Workspace.find({ 'members.userId': alice.userId }).select('_id').lean();
  assert.equal(memberships.length, 2, 'the fixture must leave alice in exactly two workspaces');

  // Owns neither: shared (the oldest) and bob's own.
  guest = await addMember('guest@example.test', [
    { workspaceId: shared.workspaceId, role: 'editor' },
    { workspaceId: bob.workspaceId, role: 'viewer' },
  ]);
});

after(async () => { await db.disconnect(); });

describe('with no selection, the acting workspace is the deterministic default', () => {
  test('twenty consecutive requests resolve the same workspace', async () => {
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      seen.add(await actingWorkspace(alice, `GET /workspace #${i + 1}`));
    }

    log('light', `twenty requests resolved ${seen.size} distinct workspace(s): ${[...seen].join(', ')}`);
    assert.equal(seen.size, 1, `a request must not resolve a workspace at random: saw ${[...seen].join(', ')}`);
    assert.equal([...seen][0], alice.workspaceId, 'the default is the oldest workspace the caller owns');
  });

  test('the default is the one she owns, even though the other is older', async () => {
    const res = await get(alice, '/workspace');

    assert.equal(res.status, 200);
    assert.equal(res.body.name, HOME);
    assert.equal(res.body.role, 'owner');
    // An invitation to someone else's workspace — which, once invites land, can
    // arrive without being asked for — must not become where her writes go.
    assert.notEqual(String(res.body._id), shared.workspaceId);
  });

  test('a user who owns none of theirs falls to the oldest they are in', async () => {
    const res = await get(guest, '/workspace');

    assert.equal(res.status, 200);
    assert.equal(String(res.body._id), shared.workspaceId, 'the oldest membership');
    assert.equal(res.body.role, 'editor');
  });

  test('a GET /entities list comes from that same workspace', async () => {
    const res = await get(alice, '/entities');

    await assertEntityListIsWorkspace(res, alice.workspaceId, 'GET /entities with no selection');
  });
});

describe('GET /workspaces', () => {
  test('lists every membership, oldest first, in the GET /workspace shape', async () => {
    const res = await get(alice, '/workspaces');

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), 'the body should be an array');
    assert.equal(res.body.length, 2, 'alice is a member of two workspaces');
    for (const entry of res.body) {
      assert.deepEqual(Object.keys(entry).sort(), ['_id', 'createdAt', 'name', 'role'], 'the same body shape as GET /workspace');
    }
    assert.deepEqual(res.body.map(w => String(w._id)), [shared.workspaceId, alice.workspaceId], 'oldest first — the shared one is backdated');
    assert.deepEqual(res.body.map(w => w.name), [SHARED, HOME]);
    assert.deepEqual(res.body.map(w => w.role), ['editor', 'owner'], "each entry carries the caller's own role in it");
  });

  test("another user sees only their own, with their own role", async () => {
    const res = await get(bob, '/workspaces');

    assert.equal(res.status, 200);
    const ids = res.body.map(w => String(w._id));
    assert.ok(ids.includes(bob.workspaceId), 'bob sees his own workspace');
    assert.ok(ids.includes(shared.workspaceId), 'and the one he owns and shared with alice');
    assert.ok(!ids.includes('000000000000000000000000'));
    assert.deepEqual(res.body.map(w => w.role), ['owner', 'owner']);
    assert.deepEqual(ids, [shared.workspaceId, bob.workspaceId], 'oldest first for him too');
  });

  test('an unauthenticated call is 401 and lists nothing', async () => {
    const res = await request(app).get('/workspaces');
    log('normal', `GET /workspaces unauthenticated → ${res.status} ${JSON.stringify(res.body)}`);

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Unauthorized');
    assert.equal(res.body.length, undefined);
  });
});

describe('POST /workspaces/:id/select', () => {
  test('a selection moves the whole session together: list, workspace and write', async () => {
    const chosen = await select(alice, shared.workspaceId);
    assert.equal(chosen.status, 200);
    assert.equal(String(chosen.body._id), shared.workspaceId);
    assert.equal(chosen.body.name, SHARED);
    assert.equal(chosen.body.role, 'editor', "the role answered is alice's own in the selected workspace");

    // GET /workspace follows it.
    assert.equal(await actingWorkspace(alice, 'GET /workspace after selecting the shared workspace'), shared.workspaceId);

    // A write lands there, not in the workspace the session started in.
    const created = await alice.agent.post('/entities').send({
      title: 'Written After Switching',
      category: 'Characters',
      summary: 'Must land in the selected workspace.',
    });
    assert.equal(created.status, 201, `POST /entities failed: ${created.status} ${JSON.stringify(created.body)}`);
    assert.equal(String(created.body.workspaceId), shared.workspaceId, 'the write must land in the selected workspace');
    log('light', `created entity ${created.body._id} (source: POST /entities after selecting ${shared.workspaceId}) in workspace ${created.body.workspaceId}`);

    // And the read side agrees with the write side — the split this item removes.
    const list = await get(alice, '/entities', 'GET /entities after selecting the shared workspace');
    await assertEntityListIsWorkspace(list, shared.workspaceId, 'GET /entities after selecting the shared workspace');
    assert.ok(list.body.map(e => String(e._id)).includes(String(created.body._id)), 'the entity just written must be in the list the same session reads');

    // It is not in the workspace she started in, which is the other half of it.
    const stored = await Entity.findById(created.body._id).select('workspaceId').lean();
    assert.notEqual(String(stored.workspaceId), alice.workspaceId);

    // Back again, so the rest of the file starts from the default.
    const back = await select(alice, alice.workspaceId);
    assert.equal(back.status, 200);
    assert.equal(await actingWorkspace(alice, 'GET /workspace after selecting back'), alice.workspaceId);
  });

  test('selecting a workspace the caller is not a member of is 404 and changes nothing', async () => {
    const before = await actingWorkspace(alice, 'GET /workspace before the refused selection');

    // bob's own workspace, which alice is not in. A real row, so this is the
    // case 403 would confirm the existence of.
    const res = await select(alice, bob.workspaceId);

    assert.equal(res.status, 404, 'a foreign workspace id must be indistinguishable from a non-existent one');
    assert.equal(res.body.error, 'Not found');
    assert.equal(res.body.name, undefined, "no field of bob's workspace may appear");

    assert.equal(await actingWorkspace(alice, 'GET /workspace after the refused selection'), before, 'the acting workspace must be untouched');
  });

  test('a non-existent but well-formed id is 404, and a malformed one is 400', async () => {
    const missing = await select(alice, '000000000000000000000000');
    assert.equal(missing.status, 404);

    const malformed = await alice.agent.post('/workspaces/not-an-id/select').send({});
    log('normal', `POST /workspaces/not-an-id/select → ${malformed.status} ${JSON.stringify(malformed.body)}`);
    assert.equal(malformed.status, 400, 'the shared objectId param check must run here too');
    assert.equal(malformed.body.error, 'INVALID_ID');
    assert.equal(malformed.body.param, 'id');
  });

  test('an unauthenticated selection is 401', async () => {
    const res = await request(app)
      .post(`/workspaces/${shared.workspaceId}/select`)
      .set('Origin', CLIENT_ORIGIN)
      .send({});
    log('normal', `POST /workspaces/:id/select unauthenticated → ${res.status} ${JSON.stringify(res.body)}`);

    assert.equal(res.status, 401);
  });
});

describe("one session's selection does not reach another", () => {
  test("another user's requests are unaffected", async () => {
    // Two sessions, two explicit and different choices, in the one workspace
    // they share: bob picks his own, alice picks the shared one. bob owns both
    // of his, so his *default* is the shared one too — which is exactly why he
    // chooses here rather than relying on it.
    const bobChose = await select(bob, bob.workspaceId);
    assert.equal(bobChose.status, 200);
    const aliceChose = await select(alice, shared.workspaceId);
    assert.equal(aliceChose.status, 200);

    assert.equal(await actingWorkspace(bob, 'GET /workspace as bob'), bob.workspaceId, "bob keeps his own choice while alice is in the shared one");
    assert.equal(await actingWorkspace(alice, 'GET /workspace as alice'), shared.workspaceId);

    const back = await select(alice, alice.workspaceId);
    assert.equal(back.status, 200);
  });

  test("the same user's second session keeps the default", async () => {
    // A second browser for alice: its own cookie jar, its own session.
    const second = originAgent(app);
    const signedIn = await second.post('/auth/login').send({ email: alice.email, password: PASSWORD });
    assert.equal(signedIn.status, 200, `POST /auth/login failed: ${signedIn.status} ${JSON.stringify(signedIn.body)}`);
    const other = { agent: second, email: `${alice.email} (second session)` };

    const chosen = await select(alice, shared.workspaceId);
    assert.equal(chosen.status, 200);

    assert.equal(await actingWorkspace(alice, 'GET /workspace in the first session'), shared.workspaceId);
    assert.equal(await actingWorkspace(other, 'GET /workspace in the second session'), alice.workspaceId, 'a selection is this session\'s, not the account\'s');

    const back = await select(alice, alice.workspaceId);
    assert.equal(back.status, 200);
  });
});

/**
 * The case that decides whether a selection is a liability: the membership
 * behind the selected id is revoked while the session holds it. Refusing every
 * request with 403 would lock a user out of their *own* workspace over access
 * they lost to someone else's, so the rule is to fall back to the default.
 */
describe('a selection whose membership is then removed', () => {
  test('falls back to the default instead of refusing every request', async () => {
    const chosen = await select(alice, shared.workspaceId);
    assert.equal(chosen.status, 200);
    assert.equal(await actingWorkspace(alice, 'GET /workspace while the membership stands'), shared.workspaceId);

    // Revoked past the routes: removing a member is out of scope for this item
    // (it is the roadmap's own next step), and what is being tested is what a
    // *stale* selection does, not how it became stale.
    await Workspace.updateOne({ _id: shared.workspaceId }, { $pull: { members: { userId: alice.userId } } });
    log('light', `removed alice's membership from workspace ${shared.workspaceId} (source: direct $pull), leaving her session selection stale`);

    assert.equal(await actingWorkspace(alice, 'GET /workspace with a stale selection'), alice.workspaceId, 'the stale selection must fall back to the default');

    const list = await get(alice, '/entities', 'GET /entities with a stale selection');
    assert.equal(list.status, 200, 'a stale selection must not make every route 403');
    await assertEntityListIsWorkspace(list, alice.workspaceId, 'GET /entities with a stale selection');

    const created = await alice.agent.post('/entities').send({
      title: 'Written With A Stale Selection',
      category: 'Characters',
      summary: 'Must land in the fallback workspace.',
    });
    assert.equal(created.status, 201);
    assert.equal(String(created.body.workspaceId), alice.workspaceId, 'and so does a write');

    // The list no longer offers it either, so a client cannot re-select it.
    const list2 = await get(alice, '/workspaces', 'GET /workspaces after the revocation');
    assert.deepEqual(list2.body.map(w => String(w._id)), [alice.workspaceId]);

    // And re-selecting the revoked id is now the foreign-id case: 404.
    const again = await select(alice, shared.workspaceId);
    assert.equal(again.status, 404);
  });
});
