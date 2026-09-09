/**
 * End-to-end tenancy isolation: two real accounts, one Express app, one database.
 *
 * Every scoped route filters its queries on `req.workspaceId`, which
 * `resolveWorkspace` sets from the caller's session. That is one middleware and
 * a `workspaceId:` clause per query — a mount that forgets the middleware, or a
 * query that forgets the clause, silently serves one tenant's content to
 * another. Unit tests cannot see either mistake, so these drive the real stack:
 * `createApp()` over supertest, real `POST /auth/register` (bcrypt, real
 * `Workspace` creation, real `seedWorkspace`), real mongod.
 *
 * The two users are registered through the HTTP API rather than inserted
 * directly, so the fixture exercises the same path a signup does and cannot
 * drift from it. Both workspaces are seeded from the default template, which
 * also keeps the "B never sees A's X" assertions honest: B's own lists are
 * non-empty, so an accidentally-empty response fails rather than passes.
 *
 * A foreign id is answered with 404, never 403 — see the comment in
 * `src/routes/entities.js`. 403 would confirm that the id exists somewhere.
 *
 * Falsification check for this suite: remove `resolveWorkspace` from any mount
 * in `src/app.js` and this file must fail. What it catches is worth being
 * precise about. Without the middleware `req.workspaceId` is undefined, and
 * Mongoose 8 casts an undefined filter value to null rather than dropping the
 * clause — so *reads* fail closed (everything 404s) instead of going
 * cross-tenant. The leak-shaped assertions below would therefore still pass.
 * What actually catches it is the write side: creates stamp `workspaceId: null`
 * and the content is orphaned outside every workspace. Hence the fixture
 * asserts that each document it creates carries its owner's workspace id, for
 * every mount this file touches.
 *
 * One trap when re-running that check by hand: `app.use('/', requireAuth,
 * resolveWorkspace, changelogRouter)` matches every path, so it already sets
 * `req.workspaceId` for every mount declared after it. Stripping the middleware
 * from `/relationship-groups` or `/open-questions` alone therefore changes
 * nothing — the catch-all has to come off too before those sections go red.
 * `/entities` is mounted before the catch-all, so it falsifies on its own.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_TENANCY_LOG_LEVEL = off | light | normal | verbose (default light)
 * When an isolation assertion fails, the missing information is always *which*
 * workspace a document ended up in and where that id came from.
 *   off     — nothing
 *   light   — one line per fixture document, naming the request that created it
 *             and the workspace it landed in
 *   normal  — light, plus each cross-tenant probe and the status it got back
 *   verbose — normal, plus the ids returned by every list read
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import session from 'express-session';
import request from 'supertest';

import * as db from '../helpers/db.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';

// createApp() reads NODE_ENV when called, and the OAuth router reads its token
// at module load, so the environment has to be in place before src/app.js is
// imported — hence the dynamic import below rather than a static one.
// NODE_ENV must not be 'production' here: that arms secure/none/domain-scoped
// session cookies, which supertest's agent would refuse to send back.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
// Unset on purpose. Every request in this file authenticates with a session
// cookie; with no bearer token configured, a stray Authorization header cannot
// resolve to the MCP user and quietly satisfy requireAuth.
delete process.env.BEARER_TOKEN;
// Registration seeds two workspaces per run and seedWorkspace logs at 'light'
// by default. Overridable when a seeding problem is what is being chased.
process.env.SEED_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_TENANCY_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/tenancy:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

let app;

/** The two tenants: an authenticated supertest agent plus the ids behind it. */
let alice;
let bob;

/** Documents owned by alice, created over HTTP in before(). */
const aliceOwns = { entityId: null, otherEntityId: null, groupId: null, questionId: null };

const ALICE_ENTITY_TITLE = 'Alice Only';
const ALICE_QUESTION = 'Does the tenancy boundary hold?';

/**
 * Registers a user through the real endpoint and reads back the ids
 * registration created, so the fixture asserts on what the API actually did
 * rather than on what it was asked to do.
 */
async function registerUser(email) {
  const agent = request.agent(app);
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
  log('light', `created entity ${res.body._id} "${res.body.title}" (source: POST /entities as ${who.email}) in workspace ${res.body.workspaceId}`);
  return res.body;
}

/** Logs a cross-tenant probe and its answer at the 'normal' tier. */
function probed(who, what, res) {
  log('normal', `${who.email} probed ${what} → ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

/** Collects `_id`s from a list response, logging them at the 'verbose' tier. */
function idsOf(what, res) {
  assert.equal(res.status, 200, `${what} failed: ${res.status} ${JSON.stringify(res.body)}`);
  assert.ok(Array.isArray(res.body), `${what} should return an array`);
  const ids = res.body.map(doc => String(doc._id));
  log('verbose', `${what} returned ${ids.length} id(s): ${ids.join(', ') || '(none)'}`);
  return ids;
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore() });

  alice = await registerUser('alice@example.test');
  bob   = await registerUser('bob@example.test');
  assert.notEqual(alice.workspaceId, bob.workspaceId, 'two registrations must yield two distinct workspaces');

  const entity = await createEntity(alice, {
    title: ALICE_ENTITY_TITLE,
    category: 'Characters',
    summary: 'Content that must never reach another tenant.',
    tags: ['private'],
    blocks: [{ type: 'text', order: 0, data: { markdown: 'A secret only alice should read.' } }],
  });
  aliceOwns.entityId = String(entity._id);
  assert.equal(String(entity.workspaceId), alice.workspaceId, "alice's entity must land in alice's workspace");

  const other = await createEntity(alice, {
    title: 'Alice Second',
    category: 'Worlds',
    summary: 'A second entity, so alice can own a relationship group.',
  });
  aliceOwns.otherEntityId = String(other._id);

  const group = await alice.agent.post('/relationship-groups').send({
    label: 'Alice Private Link',
    members: [{ entityId: aliceOwns.entityId }, { entityId: aliceOwns.otherEntityId }],
  });
  assert.equal(group.status, 201, `POST /relationship-groups as alice failed: ${group.status} ${JSON.stringify(group.body)}`);
  aliceOwns.groupId = String(group.body._id);
  assert.equal(String(group.body.workspaceId), alice.workspaceId, "alice's group must land in alice's workspace");
  log('light', `created relationship group ${aliceOwns.groupId} (source: POST /relationship-groups as alice) in workspace ${group.body.workspaceId}`);

  const question = await alice.agent.post('/open-questions').send({
    question: ALICE_QUESTION,
    entry_ids: [aliceOwns.entityId],
  });
  assert.equal(question.status, 201, `POST /open-questions as alice failed: ${question.status} ${JSON.stringify(question.body)}`);
  aliceOwns.questionId = String(question.body._id);
  assert.equal(String(question.body.workspaceId), alice.workspaceId, "alice's question must land in alice's workspace");
  log('light', `created open question ${aliceOwns.questionId} (source: POST /open-questions as alice) in workspace ${question.body.workspaceId}`);
});

after(async () => { await db.disconnect(); });

describe('GET /entities/:id', () => {
  test('the owner reads their own entity', async () => {
    const res = await alice.agent.get(`/entities/${aliceOwns.entityId}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.title, ALICE_ENTITY_TITLE);
  });

  test("another tenant gets 404 — not 403 — and no content", async () => {
    const res = probed(bob, `GET /entities/${aliceOwns.entityId}`, await bob.agent.get(`/entities/${aliceOwns.entityId}`));

    assert.equal(res.status, 404, 'a foreign id must be indistinguishable from a non-existent one');
    assert.equal(res.body.error, 'Not found');
    assert.equal(res.body.title, undefined, 'no field of the foreign entity may appear in the response');
    assert.equal(res.body.summary, undefined);
    assert.equal(res.body.blocks, undefined);
  });
});

describe('GET /entities', () => {
  test("another tenant's entity never appears in the list", async () => {
    const bobIds = idsOf('GET /entities as bob', await bob.agent.get('/entities'));

    // bob's workspace is seeded at registration, so an empty list here would be
    // a bug in the fixture rather than proof of isolation.
    assert.ok(bobIds.length > 0, "bob should see his own seeded entities");
    assert.ok(!bobIds.includes(aliceOwns.entityId), "alice's entity must not be listed for bob");
    assert.ok(!bobIds.includes(aliceOwns.otherEntityId));

    const aliceIds = idsOf('GET /entities as alice', await alice.agent.get('/entities'));
    assert.ok(aliceIds.includes(aliceOwns.entityId), 'alice must still see her own entity');
  });

  test('a search that matches the foreign entity still returns nothing', async () => {
    const res = await bob.agent.get('/entities').query({ q: ALICE_ENTITY_TITLE });
    const ids = idsOf('GET /entities?q= as bob', res);

    assert.ok(!ids.includes(aliceOwns.entityId), 'the query filter must not widen past the workspace filter');
  });
});

describe('PUT and DELETE /entities/:id', () => {
  test('a foreign update is 404 and changes nothing', async () => {
    const res = probed(bob, `PUT /entities/${aliceOwns.entityId}`, await bob.agent
      .put(`/entities/${aliceOwns.entityId}`)
      .send({ title: 'Hijacked', summary: 'Rewritten by bob.' }));

    assert.equal(res.status, 404);

    const after = await alice.agent.get(`/entities/${aliceOwns.entityId}`);
    assert.equal(after.status, 200, "alice's entity must survive the attempt");
    assert.equal(after.body.title, ALICE_ENTITY_TITLE, 'the title must be untouched');
  });

  test('a foreign delete is 404 and the entity survives', async () => {
    const res = probed(bob, `DELETE /entities/${aliceOwns.entityId}`, await bob.agent
      .delete(`/entities/${aliceOwns.entityId}`));

    assert.equal(res.status, 404);

    const after = await alice.agent.get(`/entities/${aliceOwns.entityId}`);
    assert.equal(after.status, 200, "alice's entity must still exist");
  });
});

describe('client-supplied workspaceId', () => {
  test("POST /entities ignores it and writes into the caller's workspace", async () => {
    const res = await bob.agent.post('/entities').send({
      title: 'Planted By Bob',
      category: 'Characters',
      summary: "Carries alice's workspaceId in the body.",
      workspaceId: alice.workspaceId,
    });

    assert.equal(res.status, 201);
    assert.equal(String(res.body.workspaceId), bob.workspaceId, 'stripTenancy must drop the forged key');
    assert.notEqual(String(res.body.workspaceId), alice.workspaceId);

    const planted = String(res.body._id);
    log('normal', `bob planted entity ${planted} with a forged workspaceId → landed in ${res.body.workspaceId}`);

    const asAlice = await alice.agent.get(`/entities/${planted}`);
    assert.equal(asAlice.status, 404, "the planted entity must not be readable in alice's workspace");
    assert.ok(!idsOf('GET /entities as alice', await alice.agent.get('/entities')).includes(planted));
  });

  test('PUT /entities/:id ignores it and cannot move an entity between workspaces', async () => {
    const moving = await createEntity(alice, {
      title: 'Alice Movable',
      category: 'Worlds',
      summary: 'Target of a workspace-moving update.',
    });

    const res = await alice.agent.put(`/entities/${moving._id}`).send({
      title: 'Alice Movable (edited)',
      workspaceId: bob.workspaceId,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'Alice Movable (edited)', 'the rest of the update must still apply');
    assert.equal(String(res.body.workspaceId), alice.workspaceId, 'the entity must not move workspaces');

    const asBob = await bob.agent.get(`/entities/${moving._id}`);
    assert.equal(asBob.status, 404, 'bob must not have gained the entity');
  });
});

describe('/relationship-groups', () => {
  test("another tenant's group is 404 and never listed", async () => {
    const res = probed(bob, `GET /relationship-groups/${aliceOwns.groupId}`, await bob.agent
      .get(`/relationship-groups/${aliceOwns.groupId}`));

    assert.equal(res.status, 404);
    assert.equal(res.body.members, undefined, 'no member of the foreign group may leak');

    const ids = idsOf('GET /relationship-groups as bob', await bob.agent.get('/relationship-groups'));
    assert.ok(ids.length > 0, 'bob should see the group seeded into his own workspace');
    assert.ok(!ids.includes(aliceOwns.groupId), "alice's group must not be listed for bob");
  });

  test('a foreign group cannot be relabelled or deleted', async () => {
    const patch = probed(bob, `PATCH /relationship-groups/${aliceOwns.groupId}`, await bob.agent
      .patch(`/relationship-groups/${aliceOwns.groupId}`)
      .send({ label: 'Bob Was Here' }));
    assert.equal(patch.status, 404);

    const del = probed(bob, `DELETE /relationship-groups/${aliceOwns.groupId}`, await bob.agent
      .delete(`/relationship-groups/${aliceOwns.groupId}`));
    assert.equal(del.status, 404);

    const asAlice = await alice.agent.get(`/relationship-groups/${aliceOwns.groupId}`);
    assert.equal(asAlice.status, 200, "alice's group must survive both attempts");
    assert.equal(asAlice.body.label, 'Alice Private Link');
  });

  test("a group cannot be built out of another tenant's entities", async () => {
    const res = probed(bob, 'POST /relationship-groups with foreign members', await bob.agent
      .post('/relationship-groups')
      .send({
        label: 'Bob Reaching Across',
        members: [{ entityId: aliceOwns.entityId }, { entityId: aliceOwns.otherEntityId }],
      }));

    assert.equal(res.status, 400, "a foreign entity id must not be linkable into bob's graph");
    assert.match(res.body.error, /Unknown entity/);
  });
});

describe('/open-questions', () => {
  test("another tenant's question is 404 and never listed", async () => {
    const res = probed(bob, `GET /open-questions/${aliceOwns.questionId}`, await bob.agent
      .get(`/open-questions/${aliceOwns.questionId}`));

    assert.equal(res.status, 404);
    assert.equal(res.body.question, undefined, 'the question text must not leak');

    const ids = idsOf('GET /open-questions as bob', await bob.agent.get('/open-questions'));
    assert.ok(ids.length > 0, 'bob should see the question seeded into his own workspace');
    assert.ok(!ids.includes(aliceOwns.questionId), "alice's question must not be listed for bob");
  });

  test('a foreign question cannot be updated or deleted', async () => {
    const put = probed(bob, `PUT /open-questions/${aliceOwns.questionId}`, await bob.agent
      .put(`/open-questions/${aliceOwns.questionId}`)
      .send({ question: 'Rewritten by bob', status: 'resolved' }));
    assert.equal(put.status, 404);

    const del = probed(bob, `DELETE /open-questions/${aliceOwns.questionId}`, await bob.agent
      .delete(`/open-questions/${aliceOwns.questionId}`));
    assert.equal(del.status, 404);

    const asAlice = await alice.agent.get(`/open-questions/${aliceOwns.questionId}`);
    assert.equal(asAlice.status, 200, "alice's question must survive both attempts");
    assert.equal(asAlice.body.question, ALICE_QUESTION);
    assert.equal(asAlice.body.status, 'open');
  });

  test("entry_ids naming another tenant's entity do not back-link into it", async () => {
    const res = await bob.agent.post('/open-questions').send({
      question: "Can bob attach a question to alice's entity?",
      entry_ids: [aliceOwns.entityId],
    });

    assert.equal(res.status, 201);
    assert.equal(String(res.body.workspaceId), bob.workspaceId);
    const planted = String(res.body._id);
    log('normal', `bob created question ${planted} naming alice's entity ${aliceOwns.entityId} as an entry`);

    const asAlice = await alice.agent.get(`/entities/${aliceOwns.entityId}`);
    assert.equal(asAlice.status, 200);
    const linked = (asAlice.body.open_questions ?? []).map(q => String(q._id));
    assert.ok(!linked.includes(planted), "bob's question must not be back-linked onto alice's entity");
  });
});

/**
 * Known gap, found while writing this suite and deliberately left unfixed here:
 * fixing it means changing routes, which is outside this item.
 *
 * Both routes call `populate()` without a workspace filter, and both arrays
 * they populate can be pointed at another workspace's ids by the caller —
 * `entry_ids` is taken from the POST body, and `stripTenancy` in
 * `src/routes/entities.js` strips only `workspaceId`, so `open_questions` is
 * writable too. Planting a foreign id in your own document and reading it back
 * therefore discloses the other tenant's entity title/category, or its question
 * text. Self-inflicted — the attacker supplies the id — but it crosses the
 * boundary, which is the thing this file exists to defend.
 *
 * `todo` rather than a route change: these assert the guarantee the product
 * should make, fail today, and go green the moment the populate calls are
 * scoped (`match: { workspaceId }`) or the ids are rejected on write. They do
 * not fail `yarn test`.
 */
describe('known gap: unscoped populate() reaches across workspaces', () => {
  test("open-questions: entry_ids resolve another tenant's entity", { todo: 'scope the populate in src/routes/openQuestions.js' }, async () => {
    const created = await bob.agent.post('/open-questions').send({
      question: "Bob's question, pointed at alice's entity.",
      entry_ids: [aliceOwns.entityId],
    });
    assert.equal(created.status, 201);

    const res = await bob.agent.get(`/open-questions/${created.body._id}`);
    assert.equal(res.status, 200);
    const titles = (res.body.entry_ids ?? []).map(e => e.title);
    assert.ok(!titles.includes(ALICE_ENTITY_TITLE), `alice's entity title leaked through entry_ids: ${JSON.stringify(titles)}`);
  });

  test("entities: open_questions resolve another tenant's question", { todo: 'scope the populate in src/routes/entities.js, or strip open_questions on write' }, async () => {
    const created = await bob.agent.post('/entities').send({
      title: "Bob's Carrier",
      category: 'Characters',
      summary: "Carries alice's open question id in the body.",
      open_questions: [aliceOwns.questionId],
    });
    assert.equal(created.status, 201);

    const res = await bob.agent.get(`/entities/${created.body._id}`);
    assert.equal(res.status, 200);
    const questions = (res.body.open_questions ?? []).map(q => q.question);
    assert.ok(!questions.includes(ALICE_QUESTION), `alice's question text leaked through open_questions: ${JSON.stringify(questions)}`);
  });
});
