/**
 * HTTP tests for `/open-questions` — the write half of the route (KOL-104).
 *
 * The collection has had full CRUD, a `?status=` filter, back-links maintained
 * on both sides and two MCP tools since the start, and no test of any of it:
 * `tests/http/openQuestionList.test.js` pins the *list* request (its cap, its
 * cursor and its order) and the rest of the route was unpinned. It is now also
 * the contract a browser is built against — `client/src/api/openQuestions.js`
 * and the open-question section of `client/src/components/EntityHeader.vue` —
 * so what those depend on has to be a fact about the server and not about the
 * day they were written.
 *
 * What can only be asserted over real requests, and is asserted below:
 *
 *   The two halves of the model meet: a question created against an entity
 *   shows up on `GET /entities/:id`, populated, and a deleted one is gone from
 *   there — the back-link is a second write on another collection, so it is
 *   exactly the kind of thing that silently stops happening.
 *
 *   `PUT` writes the fields the body names **and no others**, from both sides:
 *   a status write leaves the text alone and a text write leaves the status
 *   alone. The client splits a resolve from a rename for this reason, and the
 *   split is only worth anything if the route honours it.
 *
 *   `?status=` filters the list the panel's badge counts from.
 *
 *   **Each write reaches the workspace's other tabs** (KOL-116). This route
 *   imported no broadcaster at all, so every open-question write was invisible
 *   in every other open client: the entity routes get their frames from
 *   `logCreate`/`logUpdate`/`logDelete` and this collection has no ChangeLog to
 *   hang one on. The three cases below are the only place the fan-out and the
 *   write path meet — that a frame is emitted per write, that it carries the
 *   row and its `entry_ids`, that it is scoped to one workspace, and that the
 *   tab which asked for the write (the `X-SSE-Client-Id` the browser echoes)
 *   does not receive its own echo.
 *
 *   Tenancy, which is the whole reason these routes cannot be taken on trust:
 *   another workspace's entity id is **dropped from `entry_ids` rather than
 *   stored** (and its entity is never back-linked), and another workspace's
 *   question is a 404 on read, write and delete rather than a 403 — the API
 *   never confirms another tenant's row exists.
 *
 * Falsification: drop the `Entity.updateMany` in POST and the entity never
 * shows the question; drop it in DELETE and a deleted question stays on the
 * entity as a dangling id; replace `ownEntryIds` with the raw body and the
 * foreign-entity case stores it; drop `workspaceId` from a scope and the 404
 * cases answer 200.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_QUESTION_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture document, naming the request that created it
 *             and the workspace it landed in
 *   normal  — light, plus every question write with its status and what it sent
 *   verbose — normal, plus the body each request came back with
 */

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

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
import OpenQuestion from '../../src/models/OpenQuestion.js';
import Entity from '../../src/models/Entity.js';

// The environment has to be in place before src/app.js is imported — same
// reasoning as tests/http/openQuestionList.test.js, hence the dynamic import.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
// Unset on purpose: every request here authenticates with a session cookie, so
// a stray Authorization header must not be able to satisfy requireAuth.
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.OPEN_QUESTION_LIST_LOG_LEVEL ??= 'off';
process.env.CHANGELOG_LOG_LEVEL ??= 'off';
// The live-sync group below drives real broadcasts; both of these narrate every
// one of them, which is readable when a frame is being chased and noise here.
process.env.SSE_LOG_LEVEL ??= 'off';
process.env.OPEN_QUESTION_SSE_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');
// The same module instance the app broadcasts through — one process, one client
// map — so a connection registered here really is a listener on the route's
// fan-out. See the live-sync group at the bottom.
const { addClient, removeClient } = await import('../../src/lib/broadcaster.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_QUESTION_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/questions:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

/** `Worlds` is in the default template's entity-type registry. */
const entityBody = (title) => ({
  title,
  category: 'Worlds',
  summary: `${title}, for a question to hang off.`,
  tags: ['stations'],
});

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

  log('light', `registered ${email} (source: POST /auth/register) → user ${user._id}, workspace ${workspace._id}`);
  return { agent, email, userId: String(user._id), workspaceId: String(workspace._id) };
}

/** POSTs an entity as `who` and returns its id. */
async function createEntity(who, title) {
  const res = await who.agent.post('/entities').send(entityBody(title));
  assert.equal(res.status, 201, `POST /entities as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('light', `created entity ${res.body._id} "${title}" (source: POST /entities as ${who.email})`);
  return String(res.body._id);
}

/** POSTs a question as `who`, asserts 201, and returns the created document. */
async function createQuestion(who, question, entry_ids = []) {
  const res = await who.agent.post('/open-questions').send({ question, entry_ids });
  assert.equal(res.status, 201, `POST /open-questions as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('normal', `POST /open-questions as ${who.email} → 201 ${res.body._id}, entry_ids ${JSON.stringify(res.body.entry_ids)} (sent ${JSON.stringify(entry_ids)})`);
  log('verbose', `body: ${JSON.stringify(res.body)}`);
  return res.body;
}

/** PUTs `patch` as `who`, asserts 200, and returns the updated document. */
async function putQuestion(who, id, patch) {
  const res = await who.agent.put(`/open-questions/${id}`).send(patch);
  assert.equal(res.status, 200, `PUT /open-questions/${id} as ${who.email} answered ${res.status}: ${JSON.stringify(res.body)}`);
  log('normal', `PUT /open-questions/${id} as ${who.email} → 200, sent ${JSON.stringify(patch)}`);
  log('verbose', `body: ${JSON.stringify(res.body)}`);
  return res.body;
}

/** The questions `GET /entities/:id` reports on an entity, as the panel sees them. */
async function questionsOnEntity(who, entityId) {
  const res = await who.agent.get(`/entities/${entityId}`);
  assert.equal(res.status, 200, `GET /entities/${entityId} as ${who.email} answered ${res.status}`);
  log('normal', `GET /entities/${entityId} as ${who.email} → ${res.body.open_questions.length} open question(s)`);
  return res.body.open_questions;
}

/** `GET /open-questions<query>` as `who`, asserted to be a 200 bare array. */
async function list(who, query = '') {
  const res = await who.agent.get(`/open-questions${query}`);
  assert.equal(res.status, 200, `GET /open-questions${query} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  assert.ok(Array.isArray(res.body), `expected a bare array, got ${JSON.stringify(res.body).slice(0, 200)}`);
  return res.body;
}

const ids = (rows) => rows.map(r => String(r._id));

before(async () => {
  await db.connect();

  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });

  alice = await registerUser('oq-alice@example.test');
  bob = await registerUser('oq-bob@example.test');
  assert.notEqual(alice.workspaceId, bob.workspaceId, 'two registrations must yield two distinct workspaces');
});

after(async () => {
  await db.disconnect();
});

describe('POST /open-questions', () => {
  test('a question created against an entity appears on GET /entities/:id', async () => {
    const entityId = await createEntity(alice, 'Boiler Room');
    const created = await createQuestion(alice, 'Who stokes it on the night run?', [entityId]);

    assert.equal(created.status, 'open', 'a new question is open until somebody resolves it');
    assert.deepEqual(created.entry_ids.map(String), [entityId], 'the entity it was created against');

    const onEntity = await questionsOnEntity(alice, entityId);
    assert.deepEqual(ids(onEntity), [String(created._id)], `the entity should carry the question: ${JSON.stringify(onEntity)}`);
    // Populated, not a raw id: the panel renders this without a second request.
    assert.equal(onEntity[0].question, 'Who stokes it on the night run?');
    assert.equal(onEntity[0].status, 'open');
  });

  test('a question with no entities is created and linked to nothing', async () => {
    const created = await createQuestion(alice, 'Where does the coal come from?');

    assert.deepEqual(created.entry_ids, []);
    assert.equal(created.status, 'open');
  });

  test("another workspace's entity id is dropped from entry_ids rather than stored", async () => {
    const mine = await createEntity(alice, 'Signal Box');
    const theirs = await createEntity(bob, "Bob's Shed");

    const created = await createQuestion(alice, 'Whose shed is that?', [theirs, mine]);

    // Hers kept, his dropped — not refused, not stored.
    assert.deepEqual(created.entry_ids.map(String), [mine], `entry_ids should hold her entity alone: ${JSON.stringify(created.entry_ids)}`);

    // And the drop is not only in the response: nothing was written either.
    const stored = await OpenQuestion.findById(created._id).select('entry_ids').lean();
    assert.deepEqual(stored.entry_ids.map(String), [mine], 'the stored document kept a foreign id');

    // Nor was his entity back-linked, which is the write a reader of his
    // workspace would have seen.
    assert.deepEqual(await questionsOnEntity(bob, theirs), [], "her question reached bob's entity");
  });

  test('an unauthenticated caller cannot create one', async () => {
    const before = (await list(alice)).length;
    const res = await request(app).post('/open-questions').send({ question: 'Who is asking?' });

    assert.equal(res.status, 401, `POST /open-questions with no session answered ${res.status}`);
    assert.equal((await list(alice)).length, before, 'a refused create still wrote something');
  });
});

describe('PUT /open-questions/:id', () => {
  test('a status write resolves the question and leaves its text alone', async () => {
    const created = await createQuestion(alice, 'How long is the northern line?');

    const saved = await putQuestion(alice, created._id, { status: 'resolved' });

    assert.equal(saved.status, 'resolved');
    assert.equal(saved.question, 'How long is the northern line?', 'a status write rewrote the question');
  });

  test('a text write leaves the status alone', async () => {
    // The client sends these as two separate writes for exactly this reason:
    // a rename that carried a stale status would reopen an answered question.
    const created = await createQuestion(alice, 'Who drives the night run?');
    await putQuestion(alice, created._id, { status: 'resolved' });

    const saved = await putQuestion(alice, created._id, { question: 'Who drives it?' });

    assert.equal(saved.question, 'Who drives it?');
    assert.equal(saved.status, 'resolved', 'a text write reopened a resolved question');
  });

  test('a write that names neither keeps both, and still answers the question', async () => {
    const created = await createQuestion(alice, 'Does the line end?');

    const saved = await putQuestion(alice, created._id, {});

    assert.equal(saved.question, 'Does the line end?');
    assert.equal(saved.status, 'open');
  });

  test('entry_ids moves the back-link from the old entity to the new one', async () => {
    const from = await createEntity(alice, 'Water Tower');
    const to = await createEntity(alice, 'Coaling Stage');
    const created = await createQuestion(alice, 'Which fills first?', [from]);
    assert.deepEqual(ids(await questionsOnEntity(alice, from)), [String(created._id)], 'premise: linked to the first entity');

    const saved = await putQuestion(alice, created._id, { entry_ids: [to] });

    assert.deepEqual(saved.entry_ids.map(e => e.title), ['Coaling Stage'], `entry_ids should be populated: ${JSON.stringify(saved.entry_ids)}`);
    assert.deepEqual(await questionsOnEntity(alice, from), [], 'the old entity kept a back-link to a question it no longer holds');
    assert.deepEqual(ids(await questionsOnEntity(alice, to)), [String(created._id)], 'the new entity never got the back-link');
  });

  test("entry_ids naming another workspace's entity is dropped here too", async () => {
    const theirs = await createEntity(bob, "Bob's Platform");
    const created = await createQuestion(alice, 'Whose platform?');

    const saved = await putQuestion(alice, created._id, { entry_ids: [theirs] });

    assert.deepEqual(saved.entry_ids, [], `a foreign entity id was stored: ${JSON.stringify(saved.entry_ids)}`);
    assert.deepEqual(await questionsOnEntity(bob, theirs), [], "her question reached bob's entity");
  });

  test("another workspace's question is 404 on read and on write, not 403", async () => {
    const hers = await createQuestion(alice, 'Can bob see this?');

    for (const res of [
      await bob.agent.get(`/open-questions/${hers._id}`),
      await bob.agent.put(`/open-questions/${hers._id}`).send({ status: 'resolved' }),
      await bob.agent.put(`/open-questions/${hers._id}`).send({ entry_ids: [] }),
      await bob.agent.delete(`/open-questions/${hers._id}`),
    ]) {
      assert.equal(res.status, 404, `a foreign question answered ${res.status}: ${JSON.stringify(res.body)}`);
    }

    // And nothing of hers moved.
    const after = await OpenQuestion.findById(hers._id).lean();
    assert.ok(after, "bob's delete removed her question");
    assert.equal(after.status, 'open', "bob's write resolved her question");
  });

  test('a status outside the enum is refused rather than stored', async () => {
    // `findOneAndUpdate` runs no validators by default, so this route answered
    // 200 and stored whatever arrived — leaving a question that is neither open
    // nor answered, which the client's badge counts as open forever.
    const created = await createQuestion(alice, 'What counts as resolved?');

    const res = await alice.agent.put(`/open-questions/${created._id}`).send({ status: 'banana' });

    assert.equal(res.status, 400, `answered ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'VALIDATION_FAILED');
    assert.deepEqual(res.body.fields, ['status'], `the refusal should name the field: ${JSON.stringify(res.body)}`);

    const stored = await OpenQuestion.findById(created._id).select('status').lean();
    assert.equal(stored.status, 'open', 'the refused status was written anyway');
  });

  test('a blank question is refused rather than stored', async () => {
    const created = await createQuestion(alice, 'Can I be emptied?');

    const res = await alice.agent.put(`/open-questions/${created._id}`).send({ question: '' });

    assert.equal(res.status, 400, `answered ${res.status}: ${JSON.stringify(res.body)}`);
    const stored = await OpenQuestion.findById(created._id).select('question').lean();
    assert.equal(stored.question, 'Can I be emptied?', 'the blank text was written anyway');
  });

  test('a malformed id is 400 INVALID_ID rather than a 500', async () => {
    const res = await alice.agent.put('/open-questions/not-an-id').send({ status: 'resolved' });

    assert.equal(res.status, 400, `answered ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'INVALID_ID');
  });
});

describe('GET /open-questions?status=', () => {
  test('?status=open excludes a resolved question, and ?status=resolved is its complement', async () => {
    const open = await createQuestion(alice, 'Still unanswered?');
    const resolved = await createQuestion(alice, 'Answered already?');
    await putQuestion(alice, resolved._id, { status: 'resolved' });

    const openIds = ids(await list(alice, '?status=open'));
    const resolvedIds = ids(await list(alice, '?status=resolved'));

    assert.ok(openIds.includes(String(open._id)), 'the open question should be listed as open');
    assert.ok(!openIds.includes(String(resolved._id)), 'a resolved question was listed as open');
    assert.ok(resolvedIds.includes(String(resolved._id)), 'the resolved question should be listed as resolved');
    assert.ok(!resolvedIds.includes(String(open._id)), 'an open question was listed as resolved');

    // The two filters partition the workspace, so nothing falls between them.
    const all = ids(await list(alice));
    assert.deepEqual([...openIds, ...resolvedIds].sort(), [...all].sort(), 'the filters do not add up to the whole set');
  });

  test("the list never carries another workspace's questions", async () => {
    const hers = await createQuestion(alice, 'Only in her workspace');

    assert.ok(!ids(await list(bob)).includes(String(hers._id)), "her question appeared in bob's list");
    assert.ok(ids(await list(alice)).includes(String(hers._id)), 'her own list should hold it');
  });
});

describe('DELETE /open-questions/:id', () => {
  test('a delete removes the back-link from the entity', async () => {
    const entityId = await createEntity(alice, 'Turntable');
    const created = await createQuestion(alice, 'Which way does it turn?', [entityId]);
    const kept = await createQuestion(alice, 'And how fast?', [entityId]);
    assert.equal((await questionsOnEntity(alice, entityId)).length, 2, 'premise: two questions on the entity');

    const res = await alice.agent.delete(`/open-questions/${created._id}`);
    assert.equal(res.status, 204, `DELETE answered ${res.status}: ${JSON.stringify(res.body)}`);
    log('normal', `DELETE /open-questions/${created._id} as ${alice.email} → 204`);

    // Exactly one gone, from both the collection and the entity: a stale id
    // left behind would be dropped by the populate and invisible, and the
    // entity's own array is where it would sit.
    assert.equal(await OpenQuestion.findById(created._id), null, 'the question is still stored');
    assert.deepEqual(ids(await questionsOnEntity(alice, entityId)), [String(kept._id)], 'the wrong set survived on the entity');

    const raw = await Entity.findById(entityId).select('open_questions').lean();
    assert.deepEqual(raw.open_questions.map(String), [String(kept._id)], `the entity kept a dangling id: ${JSON.stringify(raw.open_questions)}`);
  });

  test('deleting the same question twice is 404 the second time', async () => {
    const created = await createQuestion(alice, 'Delete me twice?');

    assert.equal((await alice.agent.delete(`/open-questions/${created._id}`)).status, 204);
    assert.equal((await alice.agent.delete(`/open-questions/${created._id}`)).status, 404);
  });
});

/**
 * Live sync (KOL-116): the frames a write puts on `/events`.
 *
 * Listeners are registered straight into the broadcaster with a fake `res`,
 * rather than opened as real `GET /events` sockets. The subject here is the
 * *route* — whether it broadcasts at all, with what payload, scoped to whom —
 * and `addClient` is the whole of what a connection is to a broadcast
 * (`tests/http/events.test.js` owns the socket's own behaviour over real
 * sockets, and `tests/unit/broadcaster.test.js` the fan-out's). The write
 * itself is a real request through supertest, which is the half that was
 * missing: the frame has to come out of the handler.
 *
 * Falsification: drop any one `broadcastQuestion*` call from
 * `src/routes/openQuestions.js` and that write's case fails with no frame;
 * drop `workspaceId` from the options and every case fails (the broadcaster
 * delivers to nobody); drop `excludeClientId` and the writer's-own-tab
 * assertion fails; return the populated `entry_ids` straight from PUT instead
 * of normalising to ids and the PUT case fails on the payload shape.
 */
describe('the frames a write broadcasts', () => {
  /** Every client registered by the current test, dropped in afterEach. */
  let connected = [];
  let clientCounter = 0;

  afterEach(() => {
    for (const clientId of connected) removeClient(clientId);
    connected = [];
  });

  /** One SSE frame as the broadcaster wrote it. */
  function parseFrame(chunk) {
    const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? null;
    const raw = /^data: (.*)$/m.exec(chunk)?.[1] ?? null;
    let data = null;
    try { data = raw === null ? null : JSON.parse(raw); } catch { data = raw; }
    return { event, data };
  }

  /**
   * A listener in `who`'s workspace, collecting what it receives. The returned
   * `clientId` is what a browser would echo back as `X-SSE-Client-Id`.
   */
  function listen(label, who) {
    const received = [];
    const clientId = `${label}-${(clientCounter += 1)}`;
    const added = addClient(clientId, { write: (chunk) => received.push(parseFrame(chunk)) },
      who.workspaceId, { userId: who.userId });
    assert.ok(added.accepted, `the broadcaster refused a listener for ${label}: ${JSON.stringify(added)}`);
    connected.push(clientId);
    log('light', `listening as ${clientId} in workspace ${who.workspaceId} (source: addClient)`);
    return {
      clientId,
      received,
      named: (event) => received.filter((f) => f.event === event),
      // The `question:*` traffic alone. The fixtures these tests build are
      // entities, and an entity create broadcasts its own frame from a
      // fire-and-forget `logCreate` that can land at any point after — so
      // "received nothing" has to mean "received no question frame", not
      // "received no frame".
      questions: () => received.filter((f) => (f.event ?? '').startsWith('question:')),
    };
  }

  test('POST sends one question:created to the other tab, and not to the writer or another workspace', async () => {
    const entityId = await createEntity(alice, 'Brake Van');
    const writer = listen('alice/writing-tab', alice);
    const other = listen('alice/other-tab', alice);
    const stranger = listen('bob/tab', bob);

    const res = await alice.agent
      .post('/open-questions')
      .set('X-SSE-Client-Id', writer.clientId)
      .send({ question: 'Who rides in the brake van?', entry_ids: [entityId] });
    assert.equal(res.status, 201, `POST answered ${res.status}: ${JSON.stringify(res.body)}`);

    const frames = other.named('question:created');
    assert.equal(frames.length, 1, `the other tab received ${JSON.stringify(other.questions())}`);
    assert.equal(frames[0].data.question._id, String(res.body._id));
    assert.equal(frames[0].data.question.question, 'Who rides in the brake van?');
    assert.equal(frames[0].data.question.status, 'open');
    // The entities the frame is about, so a tab can tell whether the panel it
    // is showing is affected without asking the server.
    assert.deepEqual(frames[0].data.entry_ids, [entityId]);

    assert.deepEqual(writer.questions(), [], 'the tab that did the write received its own echo');
    assert.deepEqual(stranger.questions(), [], "another workspace's tab received this workspace's write");
  });

  test('PUT sends one question:updated, with entry_ids as plain ids rather than populated rows', async () => {
    const from = await createEntity(alice, 'Guard Compartment');
    const to = await createEntity(alice, 'Luggage Rack');
    const created = await createQuestion(alice, 'Where does the guard sit?', [from]);
    const writer = listen('alice/writing-tab', alice);
    const other = listen('alice/other-tab', alice);
    const stranger = listen('bob/tab', bob);

    const res = await alice.agent
      .put(`/open-questions/${created._id}`)
      .set('X-SSE-Client-Id', writer.clientId)
      .send({ status: 'resolved', entry_ids: [to] });
    assert.equal(res.status, 200, `PUT answered ${res.status}: ${JSON.stringify(res.body)}`);

    const frames = other.named('question:updated');
    assert.equal(frames.length, 1, `the other tab received ${JSON.stringify(other.questions())}`);
    assert.equal(frames[0].data.question._id, String(created._id));
    assert.equal(frames[0].data.question.status, 'resolved');
    // The response populates `entry_ids` to `{ title, category }`; the frame
    // must not, or a listener would have to know which write it came from.
    assert.deepEqual(frames[0].data.entry_ids, [to],
      `entry_ids should be bare ids: ${JSON.stringify(frames[0].data.entry_ids)}`);

    assert.deepEqual(writer.questions(), [], 'the tab that did the write received its own echo');
    assert.deepEqual(stranger.questions(), [], "another workspace's tab received this workspace's write");
  });

  test('DELETE sends one question:deleted, carrying the row that is now gone', async () => {
    const entityId = await createEntity(alice, 'Observation Car');
    const created = await createQuestion(alice, 'Who cleans the glass?', [entityId]);
    const writer = listen('alice/writing-tab', alice);
    const other = listen('alice/other-tab', alice);
    const stranger = listen('bob/tab', bob);

    const res = await alice.agent
      .delete(`/open-questions/${created._id}`)
      .set('X-SSE-Client-Id', writer.clientId);
    assert.equal(res.status, 204, `DELETE answered ${res.status}: ${JSON.stringify(res.body)}`);

    const frames = other.named('question:deleted');
    assert.equal(frames.length, 1, `the other tab received ${JSON.stringify(other.questions())}`);
    assert.equal(frames[0].data.questionId, String(created._id));
    // A 204 carries nothing and this collection keeps no snapshot, so the frame
    // is the only account of what was deleted.
    assert.equal(frames[0].data.question.question, 'Who cleans the glass?');
    assert.deepEqual(frames[0].data.entry_ids, [entityId],
      'the entities whose panels just changed were not named');

    assert.deepEqual(writer.questions(), [], 'the tab that did the write received its own echo');
    assert.deepEqual(stranger.questions(), [], "another workspace's tab received this workspace's write");
  });

  test('a refused write broadcasts nothing', async () => {
    // The frame follows the write, not the request: a 400 left nothing to tell
    // another tab about, and a frame for it would have every listener refetch
    // an entity that did not change.
    const created = await createQuestion(alice, 'Does a refusal travel?');
    const other = listen('alice/other-tab', alice);

    const res = await alice.agent.put(`/open-questions/${created._id}`).send({ status: 'banana' });
    assert.equal(res.status, 400, `PUT answered ${res.status}: ${JSON.stringify(res.body)}`);

    assert.deepEqual(other.questions(), [], `a refused write still broadcast: ${JSON.stringify(other.questions())}`);
  });

  test('a write with no X-SSE-Client-Id reaches every tab in the workspace', async () => {
    // The MCP tool and curl have no stream to exclude; so does a browser whose
    // stream has not come back yet.
    const first = listen('alice/tab-1', alice);
    const second = listen('alice/tab-2', alice);

    const res = await alice.agent.post('/open-questions').send({ question: 'Who asked, though?' });
    assert.equal(res.status, 201, `POST answered ${res.status}: ${JSON.stringify(res.body)}`);

    assert.equal(first.named('question:created').length, 1, `tab 1 received ${JSON.stringify(first.questions())}`);
    assert.equal(second.named('question:created').length, 1, `tab 2 received ${JSON.stringify(second.questions())}`);
  });
});
