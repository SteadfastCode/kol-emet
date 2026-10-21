/**
 * HTTP tests for `GET /relationship-groups` — the group list request (KOL-092).
 *
 * The route answered with every group in the workspace, each carrying its whole
 * `members` array, in one unbounded response — and the graph view asks for it
 * the moment it opens. KOL-061 and KOL-067 took that read off `GET /entities`;
 * this was the same read, one route over. It now serves the keyset contract
 * `/entities` serves, with a bare-id cursor because this sort is `_id` alone.
 *
 * What can only be asserted over real requests, and is asserted below:
 *
 *   The old shape survives. No `?limit=` is the bare array it has always been,
 *   because `tests/http/import.test.js`, `tests/http/tenancy.test.js` and any
 *   script outside this repo read it — the envelope is the breaking part, and it
 *   only arrives when it is asked for. Every "not a page size" value lands here
 *   too, including the `0` that would mean *no limit* to MongoDB.
 *
 *   A page is never longer than its limit, and the pages concatenate to the
 *   whole set with nothing served twice and nothing skipped — including across
 *   a write that lands mid-walk. The mutation is a **delete** of a row that was
 *   already served plus a create: under `skip` the delete shifts every later row
 *   forward one place and the walk loses one, which is the defect a keyset
 *   cursor does not have. (`_id` is insertion order, so an append alone cannot
 *   tell the two apart — hence the delete.)
 *
 *   A cursor is a position in the sort and not a key into another workspace: an
 *   `after` naming a group that belongs to someone else pages from where that
 *   id sits and answers the caller's own rows, never the foreign one.
 *
 *   The cap is real, which needs more rows than a readable fixture has — hence
 *   a third workspace bulk-loaded past it, which doubles as the proof that those
 *   rows never surface in anyone else's pages.
 *
 * Falsification: drop `query.limit(limit + 1)` and the cap case serves the whole
 * workspace; sort by something other than `_id` and the cursor stops naming a
 * position (the walk repeats or loses a row); ignore an unusable `after` instead
 * of refusing it and the 400 case answers page one; let `boundedInteger` pass
 * `0` through and the `?limit=0` case gets an empty envelope instead of the list.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_GROUP_LIST_LOG_LEVEL = off | light | normal | verbose (default light)
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
import RelationshipGroup from '../../src/models/RelationshipGroup.js';

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
process.env.GROUP_LIST_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');
// The route's own cap, so the cap cases cannot drift from it. Imported after
// the environment above and from the cache app.js has already filled: a static
// import would evaluate the auth middleware's module-level token gate before
// the `delete process.env.BEARER_TOKEN` above had run.
const { GROUP_LIMIT_MAX } = await import('../../src/routes/relationshipGroups.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_GROUP_LIST_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/groupList:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

/** `Worlds` is in the default template's entity-type registry. */
const entityBody = (title) => ({
  title,
  category: 'Worlds',
  summary: `${title}, for a group to point at.`,
  tags: ['stations'],
});

let app;
let alice;
let bob;
let carol;
let aliceEntityIds;
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

/** POSTs a group over two of `who`'s entities and returns its id. */
async function createGroup(who, label, entityIds) {
  const res = await who.agent.post('/relationship-groups').send({
    label,
    members: entityIds.map(entityId => ({ entityId })),
  });
  assert.equal(res.status, 201, `POST /relationship-groups as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('light', `created group ${res.body._id} "${label}" (source: POST /relationship-groups as ${who.email}) in workspace ${res.body.workspaceId}`);
  return String(res.body._id);
}

/** GETs `/relationship-groups<query>` as `who`, asserts a 200 array, returns it. */
async function list(who, query = '') {
  const res = await who.agent.get(`/relationship-groups${query}`);
  assert.equal(res.status, 200, `GET /relationship-groups${query} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  assert.ok(Array.isArray(res.body), `GET /relationship-groups${query} should answer an array, got ${JSON.stringify(res.body).slice(0, 200)}`);
  log('normal', `GET /relationship-groups${query} as ${who.email} → ${res.status}, ${res.body.length} group(s)`);
  return res.body;
}

/** GETs one page and asserts the envelope's shape. */
async function pageOf(who, query) {
  const res = await who.agent.get(`/relationship-groups${query}`);
  assert.equal(res.status, 200, `GET /relationship-groups${query} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);

  const body = res.body;
  assert.ok(
    body && !Array.isArray(body) && Array.isArray(body.items),
    `GET /relationship-groups${query} should answer { items, nextAfter }, got ${JSON.stringify(body).slice(0, 300)}`,
  );
  assert.ok('nextAfter' in body, `the envelope must carry nextAfter, even as null: ${Object.keys(body).join(', ')}`);

  log('normal', `GET /relationship-groups${query} as ${who.email} → ${body.items.length} group(s), nextAfter ${body.nextAfter ?? '(none)'}`);
  log('verbose', `page ids: ${body.items.map(g => g._id).join(', ') || '(empty)'}`);
  return body;
}

const pageQuery = (limit, cursor) =>
  `?${new URLSearchParams(cursor ? { limit: String(limit), after: cursor } : { limit: String(limit) })}`;

/**
 * Walks every page at `pageSize` and returns the rows in the order they were
 * served, plus how many requests it took. `between` runs after each page, so a
 * test can land a write in the middle of a walk.
 */
async function walk(who, pageSize, between = null) {
  const rows = [];
  let cursor = null;
  let requests = 0;

  do {
    // A cursor that does not advance is an infinite loop, and a test that hangs
    // says less than one that fails: the bound is the workspace plus slack.
    assert.ok(requests < 400, `the walk did not terminate after ${requests} requests`);
    const body = await pageOf(who, pageQuery(pageSize, cursor));
    requests += 1;

    assert.ok(body.items.length <= pageSize, `a page served ${body.items.length} rows for limit ${pageSize}`);
    rows.push(...body.items);
    cursor = body.nextAfter;
    if (between) await between(body, requests);
  } while (cursor);

  log('light', `walked ${rows.length} group(s) of ${who.email} in ${requests} request(s) at limit ${pageSize}`);
  return { rows, requests };
}

/**
 * Every group id in `who`'s workspace, straight from the database — in the
 * route's own order, since registration seeds a starter group and the fixtures
 * below are not the whole set.
 */
async function allGroupIds(who) {
  const docs = await RelationshipGroup.find({ workspaceId: who.workspaceId }).select('_id').sort({ _id: 1 }).lean();
  return docs.map(d => String(d._id));
}

const ids = (rows) => rows.map(g => String(g._id));

before(async () => {
  await db.connect();

  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });

  alice = await registerUser('groups-alice@example.test');
  bob = await registerUser('groups-bob@example.test');
  assert.notEqual(alice.workspaceId, bob.workspaceId, 'two registrations must yield two distinct workspaces');

  aliceEntityIds = [];
  for (const title of ['Alder Street', 'Boiler Room', 'Coupling Yard']) {
    aliceEntityIds.push(await createEntity(alice, title));
  }
  await createGroup(alice, 'Runs through', [aliceEntityIds[0], aliceEntityIds[1]]);
  await createGroup(alice, 'Feeds', [aliceEntityIds[1], aliceEntityIds[2]]);
  await createGroup(alice, 'Shares a signaller with', [aliceEntityIds[0], aliceEntityIds[2]]);

  const bobEntities = [await createEntity(bob, "Bob's Siding"), await createEntity(bob, "Bob's Depot")];
  await createGroup(bob, "Bob's own", bobEntities);
});

after(async () => {
  await db.disconnect();
});

describe('GET /relationship-groups without a limit', () => {
  test('the response is the bare array it has always been', async () => {
    const body = await list(alice);

    assert.deepEqual(ids(body).sort(), (await allGroupIds(alice)).sort(), 'the unpaged list should be the whole workspace');
    // The fixture's three groups plus registration's starter one.
    assert.ok(body.length >= 4, `premise: alice should have at least four groups, has ${body.length}`);
  });

  test('a group carries its members as ids, unpopulated', async () => {
    const group = (await list(alice)).find(g => g.label === 'Runs through');
    assert.ok(group, 'the fixture group should be listed');

    assert.equal(group.members.length, 2);
    for (const member of group.members) {
      assert.equal(member.refModel, 'Entity');
      assert.ok(member.refId, `a member should carry refId: ${JSON.stringify(member)}`);
      assert.ok(!('ref' in member), `the list must not populate members: ${JSON.stringify(member)}`);
    }
  });

  test('a value that is not a page size is no page size', async () => {
    const all = (await allGroupIds(alice)).sort();

    // `?limit[$gt]=1` percent-encoded, as the extended query parser receives it.
    for (const query of ['?limit=0', '?limit=abc', '?limit=-1', '?limit%5B%24gt%5D=1', '?limit=1&limit=2', '?limit=1.5', '?limit=']) {
      assert.deepEqual(ids(await list(alice, query)).sort(), all, `${query} was read as a page size`);
    }
  });

  test('an unauthenticated caller gets nothing', async () => {
    for (const query of ['', '?limit=2']) {
      const res = await request(app).get(`/relationship-groups${query}`);
      assert.equal(res.status, 401, `GET /relationship-groups${query} with no session answered ${res.status}`);
    }
  });
});

describe('GET /relationship-groups pagination', () => {
  before(async () => {
    carol = await registerUser('groups-carol@example.test');
    bulkCount = GROUP_LIMIT_MAX + 1;
    // Straight through the model rather than 201 POSTs: what is being asserted
    // is the cap, and the route's own write path is pinned elsewhere.
    await RelationshipGroup.insertMany(
      Array.from({ length: bulkCount }, (_, i) => ({
        label: `Bulk group ${String(i).padStart(4, '0')}`,
        workspaceId: carol.workspaceId,
        members: [
          { refId: new mongoose.Types.ObjectId(), refModel: 'Entity' },
          { refId: new mongoose.Types.ObjectId(), refModel: 'Entity' },
        ],
      })),
    );
    log('light', `bulk-loaded ${bulkCount} groups into carol's workspace ${carol.workspaceId} (cap is ${GROUP_LIMIT_MAX})`);
  });

  test('?limit=2 answers the first two rows in _id order, with the last of them as the cursor', async () => {
    const all = await allGroupIds(alice);
    const body = await pageOf(alice, '?limit=2');

    assert.equal(body.items.length, 2, 'a page of two');
    assert.deepEqual(ids(body.items), all.slice(0, 2), 'the first two rows in _id order');
    assert.equal(body.nextAfter, String(body.items[1]._id), 'the cursor is the last row served');
  });

  test('paging one row at a time serves every group exactly once', async () => {
    const expected = await allGroupIds(alice);
    const { rows, requests } = await walk(alice, 1);

    assert.deepEqual(ids(rows), expected, 'the walk is the workspace, in order, no row dropped or repeated');
    assert.equal(new Set(ids(rows)).size, rows.length, `a row was served twice: ${ids(rows).join(', ')}`);
    // One request per row and no more: the route reads one row past the page,
    // so the last page that has rows is also the one that ends the walk.
    assert.equal(requests, rows.length, `${rows.length} rows at limit 1 took ${requests} requests`);
  });

  test('a page is never longer than its limit, and a short page hands out no cursor', async () => {
    const whole = await pageOf(alice, `?limit=${GROUP_LIMIT_MAX}`);

    assert.equal(whole.items.length, (await allGroupIds(alice)).length, 'alice fits in one page');
    assert.equal(whole.nextAfter, null, 'a short page hands out no cursor');
  });

  test('a delete and a create landing mid-walk skip no row and repeat none', async () => {
    // The case `skip` answers wrongly: removing a row the walk has passed
    // shifts every later row forward one place, so an offset page serves one
    // row twice over — a keyset cursor names a position instead, so it does not
    // move. A create is in here too, as the ordinary mid-walk write.
    const before = await allGroupIds(alice);
    let mutated = false;
    let created = null;

    const { rows } = await walk(alice, 1, async (page, requests) => {
      if (mutated || requests !== 1) return;
      mutated = true;
      const servedId = String(page.items[0]._id);
      const del = await alice.agent.delete(`/relationship-groups/${servedId}`);
      assert.equal(del.status, 204, `DELETE /relationship-groups/${servedId} answered ${del.status}`);
      created = await createGroup(alice, 'Landed mid-walk', [aliceEntityIds[0], aliceEntityIds[1]]);
      log('light', `mid-walk: deleted the group page 1 served (${servedId}) and created ${created}`);
    });

    const served = ids(rows);
    assert.equal(new Set(served).size, served.length, `a row was served twice: ${served.join(', ')}`);
    // Every row that existed when the walk started was served — the deleted one
    // included, since page 1 served it before it was deleted — plus the new one.
    assert.deepEqual(served.slice().sort(), [...before, created].sort(), 'the walk lost or gained a row');
  });

  test('a limit above the cap is capped, not refused', async () => {
    const body = await pageOf(carol, '?limit=9999');

    assert.equal(body.items.length, GROUP_LIMIT_MAX, `a page of ${body.items.length} for ?limit=9999`);
    assert.ok(body.nextAfter, 'a capped page is not the last one');
  });

  test('the cap holds across a walk of a workspace larger than it', async () => {
    const expected = await allGroupIds(carol);
    assert.ok(expected.length > GROUP_LIMIT_MAX, `premise: carol's workspace should be bigger than the cap, is ${expected.length}`);

    const { rows } = await walk(carol, GROUP_LIMIT_MAX);

    assert.deepEqual(ids(rows), expected, 'the walk is the workspace, in order');
    assert.equal(new Set(ids(rows)).size, expected.length, 'no row served twice across the boundary');
  });
});

describe('GET /relationship-groups cursors', () => {
  test("an after naming another workspace's group answers nothing of theirs", async () => {
    // Created last, so its id sorts after every one of alice's: paging from
    // that position is the empty page, and the foreign row is not in it.
    const foreign = await createGroup(bob, "Bob's newest", [
      await createEntity(bob, "Bob's Turntable"),
      await createEntity(bob, "Bob's Coal Drop"),
    ]);

    const body = await pageOf(alice, pageQuery(GROUP_LIMIT_MAX, foreign));

    assert.deepEqual(body.items, [], `a foreign cursor returned ${JSON.stringify(ids(body.items))}`);
    assert.equal(body.nextAfter, null);

    // And the other direction: no page of alice's ever carries bob's rows.
    const { rows } = await walk(alice, 1);
    const bobIds = new Set(await allGroupIds(bob));
    assert.ok(!ids(rows).some(id => bobIds.has(id)), `bob's group leaked into alice's pages: ${ids(rows).join(', ')}`);
  });

  test('a cursor the server did not issue is refused rather than answered with page one', async () => {
    // Silently dropping it would answer page 1 to a request for page 2 — and a
    // client that pages until nextAfter is null would never stop.
    const queries = [
      '?limit=2&after=nonsense',
      '?limit=2&after=not-an-id',
      '?limit=2&after%5B_id%5D=000000000000000000000000',
      '?limit=2&after%5B%24gt%5D=000000000000000000000000',
      '?limit=2&after=000000000000000000000000&after=000000000000000000000001',
    ];

    for (const query of queries) {
      const res = await alice.agent.get(`/relationship-groups${query}`);
      assert.equal(res.status, 400, `GET /relationship-groups${query} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
      assert.match(res.body.error ?? '', /after/, `the refusal should name the parameter: ${JSON.stringify(res.body)}`);
    }
  });

  test('an empty after is no cursor rather than a refusal', async () => {
    // A client that built a query string around a value it does not have.
    const body = await pageOf(alice, '?limit=2&after=');

    assert.deepEqual(ids(body.items), (await allGroupIds(alice)).slice(0, 2), 'it should be page one');
  });

  test('a cursor for a group that no longer exists still pages from that position', async () => {
    // A keyset is a position in the sort, not a row reference.
    const all = await allGroupIds(alice);
    const first = await pageOf(alice, '?limit=1');
    const del = await alice.agent.delete(`/relationship-groups/${first.nextAfter}`);
    assert.equal(del.status, 204, `DELETE answered ${del.status}`);

    const body = await pageOf(alice, pageQuery(GROUP_LIMIT_MAX, first.nextAfter));

    assert.deepEqual(ids(body.items), all.slice(1), 'paging continues from where the deleted row was');
  });
});
