/**
 * HTTP tests for `GET /open-questions` — the question list request (KOL-092).
 *
 * The route answered with every question in the workspace *and* resolved each
 * one's `entry_ids`, in one unbounded response: one query, no limit, and a
 * populate over the whole set. It now serves the keyset contract `/entities`
 * serves (KOL-067), with a bare-id cursor — this sort is `_id` alone — and the
 * sort moved from `createdAt: -1` to `_id: -1`, which is the same newest-first
 * order over a field that is unique and already indexed.
 *
 * This route has **no client caller**: nothing under `client/src` fetches it
 * (open questions reach the browser already populated on entities by
 * `GET /entities`), and the MCP `list_open_questions` tool queries the model
 * directly rather than through the route. So it is capped for the public API's
 * sake, and these are its callers.
 *
 * What can only be asserted over real requests, and is asserted below:
 *
 *   The old shape survives — no `?limit=` is the bare array `tests/http/
 *   import.test.js` and `tests/http/tenancy.test.js` read, and every "not a
 *   page size" value lands there too — and so does the old *order*: newest
 *   first, which the sort change had to preserve.
 *
 *   A page is never longer than its limit, and the pages concatenate to the
 *   whole set with nothing served twice and nothing skipped — including across
 *   a write that lands mid-walk. The mutation is a **create**: the sort is
 *   descending, so a new question belongs at the *head* of the list, above the
 *   cursor. Under `skip` that shifts every later row down one place and the row
 *   at the boundary is served twice; a keyset cursor names a position, so the
 *   walk in progress is untouched and sees exactly the set it started with.
 *
 *   `entry_ids` is still populated on a page, workspace-scoped (the populate is
 *   the expensive half of this route, and a page that dropped it would look
 *   fine and quietly change the response).
 *
 *   A cursor is a position in the sort, not a key into another workspace: an
 *   `after` naming someone else's question answers the caller's own rows and
 *   never the foreign one — and one positioned below everything the caller has
 *   answers an empty page.
 *
 * Falsification: drop `query.limit(limit + 1)` and the cap case serves the whole
 * workspace; sort ascending and the newest-first case fails; use `$gt` instead
 * of `$lt` for the cursor and the walk never advances; ignore an unusable
 * `after` instead of refusing it and the 400 case answers page one.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_QUESTION_LIST_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture document, naming the request that created it
 *             and the workspace it landed in
 *   normal  — light, plus every list request with its status and result count
 *   verbose — normal, plus the ids each page came back with, in order
 */

import { describe, test, before, after } from 'node:test';
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
import OpenQuestion from '../../src/models/OpenQuestion.js';

// The environment has to be in place before src/app.js is imported — same
// reasoning as tests/http/entityList.test.js, hence the dynamic import below.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
// Unset on purpose: every request here authenticates with a session cookie, so
// a stray Authorization header must not be able to satisfy requireAuth.
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.OPEN_QUESTION_LIST_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');
// The route's own cap, so the cap cases cannot drift from it. Imported after
// the environment above and from the cache app.js has already filled: a static
// import would evaluate the auth middleware's module-level token gate before
// the `delete process.env.BEARER_TOKEN` above had run.
const { QUESTION_LIMIT_MAX } = await import('../../src/routes/openQuestions.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_QUESTION_LIST_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/questionList:${level}] ${msg}`);
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
let carol;
let aliceEntityId;
let bulkCount;

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

/** POSTs an open question as `who` and returns its id. */
async function createQuestion(who, question, entryIds = []) {
  const res = await who.agent.post('/open-questions').send({ question, entry_ids: entryIds });
  assert.equal(res.status, 201, `POST /open-questions as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('light', `created question ${res.body._id} ${JSON.stringify(question)} (source: POST /open-questions as ${who.email}) in workspace ${res.body.workspaceId}`);
  return String(res.body._id);
}

/** GETs `/open-questions<query>` as `who`, asserts a 200 array, returns it. */
async function list(who, query = '') {
  const res = await who.agent.get(`/open-questions${query}`);
  assert.equal(res.status, 200, `GET /open-questions${query} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  assert.ok(Array.isArray(res.body), `GET /open-questions${query} should answer an array, got ${JSON.stringify(res.body).slice(0, 200)}`);
  log('normal', `GET /open-questions${query} as ${who.email} → ${res.status}, ${res.body.length} question(s)`);
  return res.body;
}

/** GETs one page and asserts the envelope's shape. */
async function pageOf(who, query) {
  const res = await who.agent.get(`/open-questions${query}`);
  assert.equal(res.status, 200, `GET /open-questions${query} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);

  const body = res.body;
  assert.ok(
    body && !Array.isArray(body) && Array.isArray(body.items),
    `GET /open-questions${query} should answer { items, nextAfter }, got ${JSON.stringify(body).slice(0, 300)}`,
  );
  assert.ok('nextAfter' in body, `the envelope must carry nextAfter, even as null: ${Object.keys(body).join(', ')}`);

  log('normal', `GET /open-questions${query} as ${who.email} → ${body.items.length} question(s), nextAfter ${body.nextAfter ?? '(none)'}`);
  log('verbose', `page ids: ${body.items.map(q => q._id).join(', ') || '(empty)'}`);
  return body;
}

function pageQuery(limit, cursor, prefix = '') {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('after', cursor);
  return `${prefix ? `${prefix}&` : '?'}${params}`;
}

/**
 * Walks every page at `pageSize` and returns the rows in the order they were
 * served, plus how many requests it took. `between` runs after each page, so a
 * test can land a write in the middle of a walk.
 */
async function walk(who, pageSize, { prefix = '', between = null } = {}) {
  const rows = [];
  let cursor = null;
  let requests = 0;

  do {
    // A cursor that does not advance is an infinite loop, and a test that hangs
    // says less than one that fails: the bound is the workspace plus slack.
    assert.ok(requests < 400, `the walk did not terminate after ${requests} requests`);
    const body = await pageOf(who, pageQuery(pageSize, cursor, prefix));
    requests += 1;

    assert.ok(body.items.length <= pageSize, `a page served ${body.items.length} rows for limit ${pageSize}`);
    rows.push(...body.items);
    cursor = body.nextAfter;
    if (between) await between(body, requests);
  } while (cursor);

  log('light', `walked ${rows.length} question(s) of ${who.email} in ${requests} request(s) at limit ${pageSize}`);
  return { rows, requests };
}

/**
 * Every question id in `who`'s workspace in the route's own order (newest
 * first), straight from the database — registration seeds a starter question,
 * so the fixtures below are not the whole set.
 */
async function allQuestionIds(who, filter = {}) {
  const docs = await OpenQuestion.find({ workspaceId: who.workspaceId, ...filter })
    .select('_id').sort({ _id: -1 }).lean();
  return docs.map(d => String(d._id));
}

const ids = (rows) => rows.map(q => String(q._id));

before(async () => {
  await db.connect();

  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });

  alice = await registerUser('questions-alice@example.test');
  bob = await registerUser('questions-bob@example.test');
  assert.notEqual(alice.workspaceId, bob.workspaceId, 'two registrations must yield two distinct workspaces');

  aliceEntityId = await createEntity(alice, 'Boiler Room');
  await createQuestion(alice, 'Who stokes it on the night run?', [aliceEntityId]);
  await createQuestion(alice, 'Where does the coal come from?');
  const resolvable = await createQuestion(alice, 'How long is the northern line?');
  const resolve = await alice.agent.put(`/open-questions/${resolvable}`).send({ status: 'resolved' });
  assert.equal(resolve.status, 200, `PUT /open-questions/:id answered ${resolve.status}`);

  await createQuestion(bob, "Bob's own question");
});

after(async () => {
  await db.disconnect();
});

describe('GET /open-questions without a limit', () => {
  test('the response is the bare array it has always been, newest first', async () => {
    const body = await list(alice);

    assert.deepEqual(ids(body), await allQuestionIds(alice), 'the unpaged list should be the whole workspace, newest first');
    // The fixture's three questions plus registration's starter one.
    assert.ok(body.length >= 4, `premise: alice should have at least four questions, has ${body.length}`);

    const created = body.map(q => new Date(q.createdAt).getTime());
    for (let i = 1; i < created.length; i++) {
      assert.ok(created[i] <= created[i - 1], `the order is not newest-first: ${JSON.stringify(body.map(q => q.createdAt))}`);
    }
  });

  test('entry_ids is populated, not left as raw ids', async () => {
    const linked = (await list(alice)).find(q => q.question === 'Who stokes it on the night run?');
    assert.ok(linked, 'the fixture question should be listed');

    assert.deepEqual(linked.entry_ids.map(e => e.title), ['Boiler Room'], `expected the populated entity: ${JSON.stringify(linked.entry_ids)}`);
  });

  test('?status= still filters', async () => {
    assert.deepEqual(ids(await list(alice, '?status=resolved')), await allQuestionIds(alice, { status: 'resolved' }));
    assert.deepEqual(ids(await list(alice, '?status=open')), await allQuestionIds(alice, { status: 'open' }));
  });

  test('a value that is not a page size is no page size', async () => {
    const all = await allQuestionIds(alice);

    // `?limit[$gt]=1` percent-encoded, as the extended query parser receives it.
    for (const query of ['?limit=0', '?limit=abc', '?limit=-1', '?limit%5B%24gt%5D=1', '?limit=1&limit=2', '?limit=1.5', '?limit=']) {
      assert.deepEqual(ids(await list(alice, query)), all, `${query} was read as a page size`);
    }
  });

  test('an unauthenticated caller gets nothing', async () => {
    for (const query of ['', '?limit=2']) {
      const res = await request(app).get(`/open-questions${query}`);
      assert.equal(res.status, 401, `GET /open-questions${query} with no session answered ${res.status}`);
    }
  });
});

describe('GET /open-questions pagination', () => {
  before(async () => {
    carol = await registerUser('questions-carol@example.test');
    bulkCount = QUESTION_LIMIT_MAX + 1;
    // Straight through the model rather than 201 POSTs: what is being asserted
    // is the cap, and the route's own write path is pinned elsewhere.
    await OpenQuestion.insertMany(
      Array.from({ length: bulkCount }, (_, i) => ({
        question: `Bulk question ${String(i).padStart(4, '0')}?`,
        workspaceId: carol.workspaceId,
        entry_ids: [],
      })),
    );
    log('light', `bulk-loaded ${bulkCount} questions into carol's workspace ${carol.workspaceId} (cap is ${QUESTION_LIMIT_MAX})`);
  });

  test('?limit=2 answers the two newest rows, with the last of them as the cursor', async () => {
    const all = await allQuestionIds(alice);
    const body = await pageOf(alice, '?limit=2');

    assert.equal(body.items.length, 2, 'a page of two');
    assert.deepEqual(ids(body.items), all.slice(0, 2), 'the two newest rows');
    assert.equal(body.nextAfter, String(body.items[1]._id), 'the cursor is the last row served');
  });

  test('a page carries the same populated entry_ids as the unpaged list', async () => {
    const { rows } = await walk(alice, 1);
    const linked = rows.find(q => q.question === 'Who stokes it on the night run?');
    assert.ok(linked, 'the linked question should be walked');

    assert.deepEqual(linked.entry_ids.map(e => e.title), ['Boiler Room'], `a paged row dropped the populate: ${JSON.stringify(linked.entry_ids)}`);
  });

  test('paging one row at a time serves every question exactly once', async () => {
    const expected = await allQuestionIds(alice);
    const { rows, requests } = await walk(alice, 1);

    assert.deepEqual(ids(rows), expected, 'the walk is the workspace, newest first, no row dropped or repeated');
    assert.equal(new Set(ids(rows)).size, rows.length, `a row was served twice: ${ids(rows).join(', ')}`);
    // One request per row and no more: the route reads one row past the page,
    // so the last page that has rows is also the one that ends the walk.
    assert.equal(requests, rows.length, `${rows.length} rows at limit 1 took ${requests} requests`);
  });

  test('a paged ?status= keeps its own filter', async () => {
    const expected = await allQuestionIds(alice, { status: 'open' });
    const { rows } = await walk(alice, 1, { prefix: '?status=open' });

    assert.deepEqual(ids(rows), expected, `the paged filter returned ${ids(rows).join(', ')}`);
    for (const row of rows) assert.equal(row.status, 'open');
  });

  test('a question created mid-walk neither repeats nor displaces a row', async () => {
    // The sort is descending, so a new question belongs at the *head* of the
    // list — above the cursor. Under `skip` that shifts every later row down one
    // place and the row at the boundary comes back twice; a keyset cursor names
    // a position, so the walk sees exactly the set it started with.
    const before = await allQuestionIds(alice);
    let created = null;

    const { rows } = await walk(alice, 1, {
      between: async (page, requests) => {
        if (created || requests !== 1) return;
        created = await createQuestion(alice, 'Landed mid-walk?');
        log('light', `mid-walk: created ${created} after the page ending at ${page.nextAfter}`);
      },
    });

    const served = ids(rows);
    assert.equal(new Set(served).size, served.length, `a row was served twice: ${served.join(', ')}`);
    assert.deepEqual(served, before, 'the walk lost or gained a row');
    assert.ok(!served.includes(created), 'a row inserted above the cursor belongs to the next walk, not this one');
  });

  test('a limit above the cap is capped, not refused', async () => {
    const body = await pageOf(carol, '?limit=9999');

    assert.equal(body.items.length, QUESTION_LIMIT_MAX, `a page of ${body.items.length} for ?limit=9999`);
    assert.ok(body.nextAfter, 'a capped page is not the last one');
  });

  test('the cap holds across a walk of a workspace larger than it', async () => {
    const expected = await allQuestionIds(carol);
    assert.ok(expected.length > QUESTION_LIMIT_MAX, `premise: carol's workspace should be bigger than the cap, is ${expected.length}`);

    const { rows } = await walk(carol, QUESTION_LIMIT_MAX);

    assert.deepEqual(ids(rows), expected, 'the walk is the workspace, in order');
    assert.equal(new Set(ids(rows)).size, expected.length, 'no row served twice across the boundary');
  });
});

describe('GET /open-questions cursors', () => {
  test("an after naming another workspace's question answers the caller's own rows and none of theirs", async () => {
    // Bob's newest question sorts above every one of alice's, so paging from it
    // covers her whole set — and would cover bob's older rows too if the
    // workspace clause were ever lost.
    const [bobNewest] = await allQuestionIds(bob);
    assert.ok(bobNewest, "premise: bob should have a question of his own");

    const body = await pageOf(alice, pageQuery(QUESTION_LIMIT_MAX, bobNewest));
    const bobIds = new Set(await allQuestionIds(bob));
    // Below the cursor and nothing else, which for a hex id is a string
    // comparison: alice has a row created *after* bob's newest (the mid-walk
    // fixture above), and it belongs above this cursor, not on this page.
    const aliceBelow = (await allQuestionIds(alice)).filter(id => id < bobNewest);
    assert.ok(aliceBelow.length >= 4, `premise: most of alice's rows should sit below bob's newest, ${aliceBelow.length} do`);

    assert.deepEqual(ids(body.items), aliceBelow, "a foreign cursor should page alice's own rows");
    assert.ok(!ids(body.items).some(id => bobIds.has(id)), `bob's question leaked into alice's page: ${ids(body.items).join(', ')}`);
  });

  test("an after below everything the caller has yields nothing", async () => {
    // A foreign question planted at the bottom of the id order: paging below it
    // is the empty page, and the foreign row is not in it either.
    const planted = await OpenQuestion.create({
      _id: new mongoose.Types.ObjectId('000000000000000000000001'),
      question: "Bob's oldest question",
      workspaceId: bob.workspaceId,
      entry_ids: [],
    });

    const body = await pageOf(alice, pageQuery(QUESTION_LIMIT_MAX, String(planted._id)));

    assert.deepEqual(body.items, [], `paging below the whole set returned ${JSON.stringify(ids(body.items))}`);
    assert.equal(body.nextAfter, null);
  });

  test('a cursor the server did not issue is refused rather than answered with page one', async () => {
    // Silently dropping it would answer page 1 to a request for page 2 — and a
    // client that pages until nextAfter is null would never stop.
    const queries = [
      '?limit=2&after=nonsense',
      '?limit=2&after=not-an-id',
      '?limit=2&after%5B_id%5D=000000000000000000000000',
      '?limit=2&after%5B%24lt%5D=000000000000000000000000',
      '?limit=2&after=000000000000000000000000&after=000000000000000000000001',
    ];

    for (const query of queries) {
      const res = await alice.agent.get(`/open-questions${query}`);
      assert.equal(res.status, 400, `GET /open-questions${query} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
      assert.match(res.body.error ?? '', /after/, `the refusal should name the parameter: ${JSON.stringify(res.body)}`);
    }
  });

  test('an empty after is no cursor rather than a refusal', async () => {
    // A client that built a query string around a value it does not have.
    const body = await pageOf(alice, '?limit=2&after=');

    assert.deepEqual(ids(body.items), (await allQuestionIds(alice)).slice(0, 2), 'it should be page one');
  });

  test('a cursor for a question that no longer exists still pages from that position', async () => {
    // A keyset is a position in the sort, not a row reference.
    const all = await allQuestionIds(alice);
    const first = await pageOf(alice, '?limit=1');
    const del = await alice.agent.delete(`/open-questions/${first.nextAfter}`);
    assert.equal(del.status, 204, `DELETE answered ${del.status}`);

    const body = await pageOf(alice, pageQuery(QUESTION_LIMIT_MAX, first.nextAfter));

    assert.deepEqual(ids(body.items), all.slice(1), 'paging continues from where the deleted row was');
  });
});
