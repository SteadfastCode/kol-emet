/**
 * A malformed `:id` is a 400 the caller can read, on every router that takes one.
 *
 * Every `:id` route used to hand `req.params.id` straight to Mongoose, so a
 * slug, a truncated id, a URL-encoded title or a stale link threw a `CastError`
 * inside the route's `try` and came back as **500** `Cast to ObjectId failed
 * for value "…" (type string) at path "_id" for model "Entity"` — a client
 * error reported as a server fault, carrying the model name and the driver's
 * cast path. `middleware/objectId.js` is now registered with `router.param` on
 * each of these routers, so the answer is `400 { error: 'INVALID_ID', param }`
 * before the query is built.
 *
 * What this file defends:
 *   - every `:id` route of /entities, the changelog's history and rollback, all
 *     ten /relationship-groups/:id… routes, /open-questions, /conversations and
 *     /drafts answers **400 INVALID_ID** — never 500 — for a malformed id, in
 *     *each* id position it has (`id`, `logId`, `entityId`, `subGroupId`), so a
 *     param left unregistered fails here rather than in production;
 *   - the body is exactly `{ error, param }`: no model name, no cast path;
 *   - a **well-formed** id belonging to another workspace is still **404**, not
 *     400 — the API must keep answering a foreign id the way it answers a
 *     non-existent one, and a malformed id reveals nothing by being refused
 *     because it cannot name anyone's row;
 *   - a 24-hex id that simply does not exist is still 404, so the guard refuses
 *     malformed ids rather than unfamiliar ones;
 *   - a valid id still succeeds on every router touched;
 *   - and, as a sweep over every response this file collected, that no body
 *     anywhere contains `Cast to ObjectId` and none is a 500.
 *
 * Falsification check: delete any `router.param(…)` line added by KOL-069 and
 * the matching rows of the table below must fail with 500 (or, for
 * `PUT /entities/:id`, a 400 whose body is the cast message — hence the body
 * assertion, not just the status).
 *
 * The draft fixture is inserted with the model rather than produced through
 * `POST /drafts` or `POST /drafts/compose`: what is under test is the id in the
 * URL, and the cheapest draft that has an id is the right one — no AI
 * allowance, no provider, no template-specific categories.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_OBJECT_ID_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture document, naming the request that created it
 *   normal  — light, plus every probe and the status it got back
 *   verbose — normal, plus each probe's response body
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';
import session from 'express-session';

// Every session write is checked against CLIENT_ORIGIN (src/middleware/originGuard.js),
// so this suite names one below and its agents send a matching Origin.
import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';

import * as db from '../helpers/db.js';
// Registration is throttled per client address, and these suites register
// their fixtures through the real endpoint from one address. See the helper.
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import ChangeLog from '../../src/models/ChangeLog.js';
import Draft from '../../src/models/Draft.js';

// Environment before src/app.js is imported, for the reasons in tenancy.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
// Unset on purpose: with no bearer token configured a stray Authorization
// header cannot resolve to the MCP user and quietly satisfy requireAuth.
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.ENTITY_LIST_LOG_LEVEL ??= 'off';
process.env.CHANGELOG_LOG_LEVEL ??= 'off';
// The middleware under test logs every refusal at its 'light' tier, and this
// file makes ~40 of them on purpose. Overridable when one is being chased.
process.env.OBJECT_ID_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_OBJECT_ID_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/objectId:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

/** The value sent in place of an id. The item's own example. */
const MALFORMED = 'not-an-id';

let app;
let alice;  // owns every fixture below
let bob;    // a second workspace, for the foreign-id assertions

/** Fixture ids, all alice's, filled in by before(). */
const owned = {
  entityId: null,
  memberEntityId: null,
  rollbackEntityId: null,
  logId: null,
  groupId: null,
  subGroupId: null,
  questionId: null,
  conversationId: null,
  draftId: null,
};

/**
 * Every response this file has seen, for the closing sweep. A cast message can
 * leak through any status, so the sweep reads bodies rather than statuses.
 */
const seen = [];

/** Runs one request through the recorder. `label` is what a failure prints. */
async function probe(label, pending) {
  const res = await pending;
  const body = JSON.stringify(res.body ?? null);
  seen.push({ label, status: res.status, body });
  log('normal', `${label} → ${res.status}`);
  log('verbose', `${label} body: ${body}`);
  return res;
}

async function registerUser(email) {
  const agent = originAgent(app);
  const res = await probe(`POST /auth/register (${email})`, agent.post('/auth/register').send({ email, password: PASSWORD }));
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${res.body?.error}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  log('light', `registered ${email} (source: POST /auth/register) → user ${user._id}, workspace ${workspace._id}`);
  return { agent, email, userId: String(user._id), workspaceId: String(workspace._id) };
}

async function createEntity(who, body) {
  const res = await probe(`POST /entities "${body.title}"`, who.agent.post('/entities').send(body));
  assert.equal(res.status, 201, `POST /entities failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('light', `created entity ${res.body._id} "${res.body.title}" (source: POST /entities as ${who.email})`);
  return res.body;
}

async function createGroup(who, label, entityIds) {
  const res = await probe(`POST /relationship-groups "${label}"`, who.agent
    .post('/relationship-groups')
    .send({ label, members: entityIds.map(entityId => ({ entityId })) }));
  assert.equal(res.status, 201, `POST /relationship-groups failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('light', `created group ${res.body._id} "${label}" (source: POST /relationship-groups as ${who.email})`);
  return res.body;
}

/**
 * Waits until `entityId` has `count` change log entries. The entity routes log
 * fire-and-forget, so reading the history straight after a PUT would race the
 * write that produced the snapshot the rollback fixture needs. Same helper as
 * tests/http/rollback.test.js.
 */
async function waitForLogs(entityId, count) {
  for (let i = 0; i < 100; i++) {
    if (await ChangeLog.countDocuments({ entityId }) >= count) return;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.fail(`entity ${entityId} never reached ${count} change log entries`);
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });

  alice = await registerUser('alice@example.test');
  bob   = await registerUser('bob@example.test');
  assert.notEqual(alice.workspaceId, bob.workspaceId, 'two registrations must yield two distinct workspaces');

  const entity = await createEntity(alice, {
    title: 'The Train Itself',
    category: 'Characters',
    summary: 'A fixture with an id.',
    blocks: [{ type: 'text', order: 0, data: { markdown: 'Body text.' } }],
  });
  owned.entityId = String(entity._id);

  const member = await createEntity(alice, { title: 'Second Entity', category: 'Worlds', summary: 'Group member.' });
  owned.memberEntityId = String(member._id);

  const third = await createEntity(alice, { title: 'Third Entity', category: 'Worlds', summary: 'Sub-group member.' });
  const fourth = await createEntity(alice, { title: 'Fourth Entity', category: 'Worlds', summary: 'Sub-group member.' });

  // A group whose members are the entities above, and a second one to link
  // into it — the only way to get a real :subGroupId to send.
  const group = await createGroup(alice, 'Parent Group', [owned.memberEntityId, owned.entityId]);
  owned.groupId = String(group._id);
  const subGroup = await createGroup(alice, 'Child Group', [String(third._id), String(fourth._id)]);
  owned.subGroupId = String(subGroup._id);

  const linked = await probe('POST /relationship-groups/:id/subgroups', alice.agent
    .post(`/relationship-groups/${owned.groupId}/subgroups`)
    .send({ groupId: owned.subGroupId }));
  assert.equal(linked.status, 201, `linking the sub-group failed: ${linked.status} ${JSON.stringify(linked.body)}`);
  log('light', `linked group ${owned.subGroupId} into ${owned.groupId} (source: POST /relationship-groups/:id/subgroups)`);

  // An entity updated once, so the changelog holds an 'updated' entry WITH a
  // snapshot — a 'created' entry has none and its rollback is a 400.
  const rollbackEntity = await createEntity(alice, { title: 'Original', category: 'Characters', summary: 'Rollback fixture.' });
  owned.rollbackEntityId = String(rollbackEntity._id);
  const updated = await probe('PUT /entities/:id (rollback fixture)', alice.agent
    .put(`/entities/${owned.rollbackEntityId}`)
    .send({ title: 'Current' }));
  assert.equal(updated.status, 200, `PUT /entities failed: ${updated.status} ${JSON.stringify(updated.body)}`);
  await waitForLogs(owned.rollbackEntityId, 2); // 'created' (no snapshot) + 'updated' (snapshot)
  const history = await probe('GET /entities/:id/history (rollback fixture)', alice.agent.get(`/entities/${owned.rollbackEntityId}/history`));
  const entry = history.body.find(e => e.changeType === 'updated');
  assert.ok(entry, 'the update should be in the history');
  owned.logId = String(entry._id);
  log('light', `change log entry ${owned.logId} holds the snapshot (source: GET /entities/:id/history)`);

  const question = await probe('POST /open-questions', alice.agent
    .post('/open-questions')
    .send({ question: 'Does a malformed id answer 400?', entry_ids: [owned.entityId] }));
  assert.equal(question.status, 201, `POST /open-questions failed: ${question.status} ${JSON.stringify(question.body)}`);
  owned.questionId = String(question.body._id);
  log('light', `created open question ${owned.questionId} (source: POST /open-questions)`);

  const conversation = await probe('POST /conversations', alice.agent
    .post('/conversations')
    .send({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' }));
  assert.equal(conversation.status, 201, `POST /conversations failed: ${conversation.status} ${JSON.stringify(conversation.body)}`);
  owned.conversationId = String(conversation.body._id);
  log('light', `created conversation ${owned.conversationId} (source: POST /conversations)`);

  // Inserted, not generated — see the file header.
  const draft = await Draft.create({
    workspaceId: alice.workspaceId,
    createdBy: alice.userId,
    title: 'Fixture draft',
    status: 'ready',
  });
  owned.draftId = String(draft._id);
  log('light', `created draft ${owned.draftId} (source: Draft.create in the fixture)`);
});

after(async () => { await db.disconnect(); });

/**
 * Every `:id` route of the routers KOL-069 touched, with one row per id
 * position. `params` names the positions the path has; the probe puts the
 * malformed value in `malform` and a well-formed (if unused) id in the rest —
 * the guard answers before any query runs, so the other values need not exist.
 */
const ID_ROUTES = [
  // /entities
  { router: '/entities', method: 'get',    path: '/entities/:id',                                 malform: 'id' },
  { router: '/entities', method: 'put',    path: '/entities/:id',                                 malform: 'id', body: { title: 'Renamed' } },
  { router: '/entities', method: 'delete', path: '/entities/:id',                                 malform: 'id' },

  // changelog, mounted at '/'
  { router: 'changelog', method: 'get',    path: '/entities/:id/history',                         malform: 'id' },
  { router: 'changelog', method: 'post',   path: '/entities/:id/rollback/:logId',                 malform: 'id' },
  { router: 'changelog', method: 'post',   path: '/entities/:id/rollback/:logId',                 malform: 'logId' },

  // /relationship-groups — all ten routes
  { router: '/relationship-groups', method: 'get',    path: '/relationship-groups/:id',                             malform: 'id' },
  { router: '/relationship-groups', method: 'patch',  path: '/relationship-groups/:id',                             malform: 'id', body: { label: 'Renamed' } },
  { router: '/relationship-groups', method: 'post',   path: '/relationship-groups/:id/members',                     malform: 'id', body: { members: [] } },
  { router: '/relationship-groups', method: 'patch',  path: '/relationship-groups/:id/members/reorder',             malform: 'id', body: { orderedMembers: [] } },
  { router: '/relationship-groups', method: 'patch',  path: '/relationship-groups/:id/members/:entityId',           malform: 'id', body: { label: 'x' } },
  { router: '/relationship-groups', method: 'patch',  path: '/relationship-groups/:id/members/:entityId',           malform: 'entityId', body: { label: 'x' } },
  { router: '/relationship-groups', method: 'delete', path: '/relationship-groups/:id/members/:entityId',           malform: 'id' },
  { router: '/relationship-groups', method: 'delete', path: '/relationship-groups/:id/members/:entityId',           malform: 'entityId' },
  { router: '/relationship-groups', method: 'post',   path: '/relationship-groups/:id/subgroups',                   malform: 'id', body: { groupId: null } },
  { router: '/relationship-groups', method: 'delete', path: '/relationship-groups/:id/subgroups/:subGroupId',       malform: 'id' },
  { router: '/relationship-groups', method: 'delete', path: '/relationship-groups/:id/subgroups/:subGroupId',       malform: 'subGroupId' },
  { router: '/relationship-groups', method: 'delete', path: '/relationship-groups/:id',                             malform: 'id' },

  // /open-questions
  { router: '/open-questions', method: 'get',    path: '/open-questions/:id',                     malform: 'id' },
  { router: '/open-questions', method: 'put',    path: '/open-questions/:id',                      malform: 'id', body: { question: 'x' } },
  { router: '/open-questions', method: 'delete', path: '/open-questions/:id',                      malform: 'id' },

  // /conversations
  { router: '/conversations', method: 'get',    path: '/conversations/:id',                        malform: 'id' },
  { router: '/conversations', method: 'patch',  path: '/conversations/:id',                        malform: 'id', body: { title: 'x' } },
  { router: '/conversations', method: 'delete', path: '/conversations/:id',                        malform: 'id' },
  { router: '/conversations', method: 'post',   path: '/conversations/:id/title',                  malform: 'id' },

  // /drafts
  { router: '/drafts', method: 'get',    path: '/drafts/:id',                                      malform: 'id' },
  { router: '/drafts', method: 'delete', path: '/drafts/:id',                                      malform: 'id' },
  { router: '/drafts', method: 'get',    path: '/drafts/:id/export',                               malform: 'id' },
  { router: '/drafts', method: 'post',   path: '/drafts/:id/apply',                                malform: 'id' },
  { router: '/drafts', method: 'post',   path: '/drafts/:id/decide-clean',                         malform: 'id' },
  { router: '/drafts', method: 'patch',  path: '/drafts/:id/items/:itemId',                        malform: 'id', body: { decision: 'accepted' } },
  { router: '/drafts', method: 'post',   path: '/drafts/:id/items/:itemId/retarget',               malform: 'id' },
];

/** Fills a path template, putting MALFORMED in `malform` and a fresh id elsewhere. */
function fill(path, malform) {
  return path.replace(/:(\w+)/g, (_, name) => {
    if (name === malform) return MALFORMED;
    // An itemId is a sub-document key, not a route parameter this guard owns.
    return new mongoose.Types.ObjectId().toString();
  });
}

describe('a malformed id is 400 INVALID_ID, on every :id route', () => {
  for (const route of ID_ROUTES) {
    const label = `${route.method.toUpperCase()} ${route.path} [${route.malform}]`;
    test(label, async () => {
      const url = fill(route.path, route.malform);
      const res = await probe(label, alice.agent[route.method](url).send(route.body ?? {}));

      assert.notEqual(res.status, 500, `${label} answered 500 — the CastError reached the catch: ${res.body?.error}`);
      assert.equal(res.status, 400, `${label} should be 400, got ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, 'INVALID_ID');
      assert.equal(res.body.param, route.malform, 'the body must name the parameter that was wrong');
      assert.deepEqual(
        Object.keys(res.body).sort(), ['error', 'param'],
        'the body is exactly { error, param } — no model name, no cast path',
      );
    });
  }
});

describe('the refusal is about the shape, not about the id being unfamiliar', () => {
  // Each of these is one request against GET /entities/:id, the shortest route
  // that reaches a query, so the boundary is read off one handler.
  const refused = {
    'a slug': 'the-train-itself',
    'a truncated id': '507f1f77bcf86cd',
    'a URL-encoded title': 'The%20Train%20Itself',
    'a 12-character string (the form older bson accepted)': 'abcdefghijkl',
    'a hex string one character short': '507f1f77bcf86cd79943901',
    'a non-hex 24-character string': 'ZZZZZZZZZZZZZZZZZZZZZZZZ',
  };

  for (const [what, value] of Object.entries(refused)) {
    test(`${what} is 400`, async () => {
      const res = await probe(`GET /entities/${value}`, alice.agent.get(`/entities/${value}`));
      assert.equal(res.status, 400, `${what} should be 400, got ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, 'INVALID_ID');
    });
  }

  test('a well-formed id that exists nowhere is still 404', async () => {
    const id = new mongoose.Types.ObjectId().toString();
    const res = await probe(`GET /entities/${id}`, alice.agent.get(`/entities/${id}`));

    assert.equal(res.status, 404, 'the guard must refuse malformed ids, not unfamiliar ones');
    assert.equal(res.body.error, 'Not found');
  });

  test('an all-zero id — well-formed hex — reaches the handler', async () => {
    const res = await probe('GET /entities/000…0', alice.agent.get(`/entities/${'0'.repeat(24)}`));
    assert.equal(res.status, 404);
  });
});

describe('a well-formed id in another workspace is still 404, never 400', () => {
  // The tenancy boundary is tested in full in tests/http/tenancy.test.js. What
  // matters here is that KOL-069 did not move any of it to 400: a foreign id
  // must stay indistinguishable from one that does not exist, because unlike a
  // malformed id it names a real row.
  const FOREIGN = [
    { label: 'GET /entities/:id',            url: () => `/entities/${owned.entityId}` },
    { label: 'GET /relationship-groups/:id', url: () => `/relationship-groups/${owned.groupId}` },
    { label: 'GET /open-questions/:id',      url: () => `/open-questions/${owned.questionId}` },
    { label: 'GET /conversations/:id',       url: () => `/conversations/${owned.conversationId}` },
    { label: 'GET /drafts/:id',              url: () => `/drafts/${owned.draftId}` },
  ];

  for (const { label, url } of FOREIGN) {
    test(`${label} as the other tenant is 404`, async () => {
      const res = await probe(`${label} as bob`, bob.agent.get(url()));

      assert.equal(res.status, 404, `a foreign id must be 404, not ${res.status} ${JSON.stringify(res.body)}`);
      assert.notEqual(res.body.error, 'INVALID_ID', 'a foreign id is well-formed — refusing it as malformed would be wrong');
    });
  }

  test("another tenant's rollback of a well-formed pair is 404", async () => {
    const res = await probe('POST rollback as bob', bob.agent
      .post(`/entities/${owned.rollbackEntityId}/rollback/${owned.logId}`)
      .send({}));

    assert.equal(res.status, 404);
    assert.notEqual(res.body.error, 'INVALID_ID');
  });
});

describe('a valid id still succeeds on every router touched', () => {
  test('GET /entities/:id', async () => {
    const res = await probe('GET /entities/:id (valid)', alice.agent.get(`/entities/${owned.entityId}`));
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'The Train Itself');
  });

  test('GET /entities/:id/history', async () => {
    const res = await probe('GET /entities/:id/history (valid)', alice.agent.get(`/entities/${owned.rollbackEntityId}/history`));
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body) && res.body.length >= 2, 'the fixture wrote a created and an updated entry');
  });

  test('POST /entities/:id/rollback/:logId — both params valid', async () => {
    const res = await probe('POST rollback (valid)', alice.agent
      .post(`/entities/${owned.rollbackEntityId}/rollback/${owned.logId}`)
      .send({}));
    assert.equal(res.status, 200, `rollback failed: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.title, 'Original', 'the snapshot should have been restored');
  });

  test('GET /relationship-groups/:id', async () => {
    const res = await probe('GET /relationship-groups/:id (valid)', alice.agent.get(`/relationship-groups/${owned.groupId}`));
    assert.equal(res.status, 200);
    assert.equal(res.body.label, 'Parent Group');
  });

  test('PATCH /relationship-groups/:id/members/:entityId — both params valid', async () => {
    const res = await probe('PATCH member (valid)', alice.agent
      .patch(`/relationship-groups/${owned.groupId}/members/${owned.memberEntityId}`)
      .send({ label: 'Driver' }));
    assert.equal(res.status, 200, `member patch failed: ${res.status} ${JSON.stringify(res.body)}`);
    const member = res.body.members.find(m => String(m.refId) === owned.memberEntityId);
    assert.equal(member.label, 'Driver');
  });

  test('DELETE /relationship-groups/:id/subgroups/:subGroupId — both params valid', async () => {
    const res = await probe('DELETE subgroup (valid)', alice.agent
      .delete(`/relationship-groups/${owned.groupId}/subgroups/${owned.subGroupId}`));
    assert.equal(res.status, 204, `unlink failed: ${res.status} ${JSON.stringify(res.body)}`);

    // 204 carries no body, so the link's removal is read back from the group.
    const after = await probe('GET /relationship-groups/:id (after unlink)', alice.agent.get(`/relationship-groups/${owned.groupId}`));
    assert.equal(after.status, 200);
    assert.ok(
      !after.body.members.some(m => m.refModel === 'RelationshipGroup' && String(m.refId) === owned.subGroupId),
      'the sub-group link should be gone',
    );
  });

  test('GET /open-questions/:id', async () => {
    const res = await probe('GET /open-questions/:id (valid)', alice.agent.get(`/open-questions/${owned.questionId}`));
    assert.equal(res.status, 200);
    assert.equal(res.body._id, owned.questionId);
  });

  test('GET /conversations/:id', async () => {
    const res = await probe('GET /conversations/:id (valid)', alice.agent.get(`/conversations/${owned.conversationId}`));
    assert.equal(res.status, 200);
    assert.equal(res.body._id, owned.conversationId);
  });

  test('GET /drafts/:id', async () => {
    const res = await probe('GET /drafts/:id (valid)', alice.agent.get(`/drafts/${owned.draftId}`));
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'Fixture draft');
  });
});

// Declared last on purpose: node:test runs a file's tests in declaration order,
// so by here `seen` holds every response this suite produced — fixtures,
// refusals, foreign probes and successes alike.
describe('the sweep', () => {
  test('no response body in this suite contains "Cast to ObjectId"', () => {
    const leaked = seen.filter(r => r.body.includes('Cast to ObjectId'));
    assert.deepEqual(leaked, [], `the driver's cast message reached a response: ${leaked.map(r => r.label).join(', ')}`);
  });

  test('no response in this suite is a 500', () => {
    const faults = seen.filter(r => r.status === 500);
    assert.deepEqual(faults, [], `a client error was reported as a server fault: ${faults.map(r => `${r.label} ${r.body}`).join(', ')}`);
  });

  test('the suite actually made the requests above', () => {
    // A guard against a refactor that silently stops recording: the sweeps
    // above pass trivially over an empty list.
    assert.ok(seen.length >= ID_ROUTES.length, `only ${seen.length} responses recorded`);
    log('light', `swept ${seen.length} responses`);
  });
});
