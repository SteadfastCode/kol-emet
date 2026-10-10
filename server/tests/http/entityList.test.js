/**
 * HTTP tests for the shape of `GET /entities` — the list request.
 *
 * The list route used to answer with every entity in the workspace as a full
 * hydrated document, `blocks` and all, and the client asks for it unfiltered on
 * load. Nothing on that path reads block content (sidebar card, virtual list
 * and `useFilters` read title, summary, category and tags; the detail panel and
 * the editor re-read through `GET /entities/:id`), so the one request that
 * decides how long a workspace takes to open carried the entire text of the
 * wiki. The route now projects `LIST_FIELDS` and reads `.lean()`.
 *
 * Three things about that can only be asserted over a real request:
 *
 *   A projection is only safe if it keeps what the caller reads. Each field the
 *   client touches is asserted present by name, including the populated
 *   `open_questions` — a projection that omitted the path would have made
 *   `populate` a no-op and the badge would have gone quiet, not loud.
 *
 *   The win is measured, not asserted in prose: the serialized length of the
 *   projected response is compared against the `?include=blocks` one for a
 *   fixture carrying a large markdown block. That is the number the item is
 *   about, so it is the number the test checks.
 *
 *   `?q=` matches `blocks.data.markdown` in the *query* while the projection
 *   governs the *response*, and conflating the two is the easy mistake here.
 *   A word that exists only inside a block still has to find its entity — and
 *   the hit still comes back without blocks.
 *
 * Tenancy is pinned by `tests/http/tenancy.test.js`; the case here is narrower
 * and guards this route's own rewrite — a `select()` added to a `find()` whose
 * filter lost `workspaceId` would still look plausible.
 *
 * Falsification: delete the `query.select(LIST_FIELDS)` line and the default
 * shape and size cases fail; drop `open_questions` from `LIST_FIELDS` and the
 * field case fails; make `?include=blocks` unconditional and the opt-in case
 * passes for the wrong reason while the default one fails.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_ENTITY_LIST_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture document, naming the request that created it
 *             and the workspace it landed in
 *   normal  — light, plus every list request with its status, result count and
 *             serialized size
 *   verbose — normal, plus the keys each listed entity came back with
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
import Entity from '../../src/models/Entity.js';
import Workspace from '../../src/models/Workspace.js';

// The environment has to be in place before src/app.js is imported — same
// reasoning as tests/http/entitySearch.test.js, hence the dynamic import below.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
// Unset on purpose: every request here authenticates with a session cookie, so
// a stray Authorization header must not be able to satisfy requireAuth.
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');
// The route's own cap, so the cap cases cannot drift from it. Imported after
// the environment above and from the cache app.js has already filled: a static
// import would evaluate the auth middleware's module-level token gate before
// the `delete process.env.BEARER_TOKEN` above had run.
const { LIST_LIMIT_MAX } = await import('../../src/routes/entities.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_ENTITY_LIST_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/entityList:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

/** Every field the client reads off a listed entity, plus the id. */
const LIST_FIELDS = ['_id', 'title', 'category', 'summary', 'tags', 'open_questions', 'relationships', 'createdAt', 'updatedAt'];

/**
 * A word that appears nowhere but inside a block, so `?q=` finding it proves
 * the keyword clause still reaches block markdown under the projection.
 */
const BLOCK_ONLY_WORD = 'phlogiston';

/**
 * The heavy fixture. ~48 KB of markdown in one block is a modest real entity —
 * a few pages of prose — and it is the whole of what the old list response
 * carried per row.
 */
const BIG_MARKDOWN = `The boiler runs on ${BLOCK_ONLY_WORD}. `.repeat(1200);

const BIG = {
  title: 'Boiler Room',
  category: 'Worlds',
  summary: 'Where the pressure comes from.',
  tags: ['engine', 'steam'],
  blocks: [{ type: 'text', order: 0, data: { markdown: BIG_MARKDOWN } }],
};

/** A row with no blocks at all, so the projected shape is not read off one document. */
const SMALL = {
  title: 'Alder Street',
  category: 'Worlds',
  summary: 'A stop on the northern line.',
  tags: ['stations'],
};

/** Bob's row. Its title is distinctive so a leak into alice's list is unmistakable. */
const BOB_ENTITY = {
  title: "Bob's Private Siding",
  category: 'Worlds',
  summary: 'Another tenant entirely.',
  tags: ['engine'],
  blocks: [{ type: 'text', order: 0, data: { markdown: `Also built on ${BLOCK_ONLY_WORD}.` } }],
};

const OPEN_QUESTION = 'Who stokes it on the night run?';

let app;
let alice;
let bob;
let bigId;

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
  log('light', `created entity ${res.body._id} "${res.body.title}" (source: POST /entities as ${who.email}) in workspace ${res.body.workspaceId}, ${res.body.blocks?.length ?? 0} block(s)`);
  return res.body;
}

/** GETs `/entities<query>` as `who`, asserts a 200 array, and returns the body. */
async function list(who, query = '') {
  const res = await who.agent.get(`/entities${query}`);
  assert.equal(res.status, 200, `GET /entities${query} answered ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(Array.isArray(res.body), `GET /entities${query} should answer an array, got ${JSON.stringify(res.body)}`);
  log('normal', `GET /entities${query} as ${who.email} → ${res.status}, ${res.body.length} result(s), ${JSON.stringify(res.body).length} serialized bytes`);
  log('verbose', `keys: ${res.body.map(e => `${e.title}{${Object.keys(e).join(',')}}`).join(' | ')}`);
  return res.body;
}

/** The one listed row with `title`, which must be there for the case to mean anything. */
function row(body, title) {
  const found = body.find(e => e.title === title);
  assert.ok(found, `"${title}" should be listed: got ${body.map(e => e.title).join(', ') || '(nothing)'}`);
  return found;
}

function titles(body) {
  return body.map(e => e.title).sort();
}

/**
 * Every title in `who`'s workspace, straight from the database — registration
 * seeds a couple of example entities, so the fixtures above are not the whole
 * list and an exact expectation has to be read rather than written out.
 */
async function allTitles(who) {
  const docs = await Entity.find({ workspaceId: who.workspaceId }).select('title').lean();
  return docs.map(d => d.title).sort();
}

before(async () => {
  await db.connect();

  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });

  alice = await registerUser('list-alice@example.test');
  bob = await registerUser('list-bob@example.test');
  assert.notEqual(alice.workspaceId, bob.workspaceId, 'two registrations must yield two distinct workspaces');

  const big = await createEntity(alice, BIG);
  bigId = String(big._id);
  await createEntity(alice, SMALL);
  await createEntity(bob, BOB_ENTITY);

  // A real open question on the heavy row: the list populates the path, and a
  // projection that dropped it would leave the badge silently empty.
  const oq = await alice.agent.post('/open-questions').send({ question: OPEN_QUESTION, entry_ids: [bigId] });
  assert.equal(oq.status, 201, `POST /open-questions failed: ${oq.status} ${JSON.stringify(oq.body)}`);
  log('light', `created open question ${oq.body._id} (source: POST /open-questions as ${alice.email}) on entity ${bigId}`);
});

after(async () => {
  await db.disconnect();
});

describe('GET /entities list shape', () => {
  test('no listed entity carries a blocks key', async () => {
    const body = await list(alice);

    for (const entity of body) {
      assert.ok(!('blocks' in entity), `"${entity.title}" still ships blocks: keys ${Object.keys(entity).join(', ')}`);
    }
  });

  test('every field the client reads is still there', async () => {
    const heavy = row(await list(alice), BIG.title);

    for (const field of LIST_FIELDS) {
      assert.ok(field in heavy, `the list dropped ${field}: keys ${Object.keys(heavy).join(', ')}`);
    }
    assert.equal(heavy.summary, BIG.summary, 'the summary the sidebar card renders');
    assert.equal(heavy.category, BIG.category, 'the category the pill renders');
    assert.deepEqual(heavy.tags, BIG.tags, 'the tags useFilters reads');
  });

  test('open_questions is still populated, not left as raw ids', async () => {
    const heavy = row(await list(alice), BIG.title);

    assert.ok(Array.isArray(heavy.open_questions), `open_questions should be an array: ${JSON.stringify(heavy.open_questions)}`);
    assert.deepEqual(heavy.open_questions.map(q => q?.question), [OPEN_QUESTION], `expected the populated question: ${JSON.stringify(heavy.open_questions)}`);
    assert.equal(heavy.open_questions[0].status, 'open', 'the status the badge reads');
  });

  test('a row with no blocks of its own is unchanged by the projection', async () => {
    const light = row(await list(alice), SMALL.title);

    assert.ok(!('blocks' in light), `keys ${Object.keys(light).join(', ')}`);
    assert.equal(light.summary, SMALL.summary);
    assert.deepEqual(light.tags, SMALL.tags);
  });
});

describe('GET /entities?include=blocks', () => {
  test('the opt-in brings the blocks back', async () => {
    const heavy = row(await list(alice, '?include=blocks'), BIG.title);

    assert.ok(Array.isArray(heavy.blocks), `blocks should be an array: ${JSON.stringify(heavy.blocks)?.slice(0, 120)}`);
    assert.equal(heavy.blocks.length, 1, 'the fixture has one block');
    assert.equal(heavy.blocks[0].data.markdown, BIG_MARKDOWN, 'the block markdown should come back whole');
  });

  test('the projected response is a fraction of the one carrying blocks', async () => {
    const projected = JSON.stringify(await list(alice));
    const withBlocks = JSON.stringify(await list(alice, '?include=blocks'));

    log('light', `serialized list: ${projected.length} bytes projected vs ${withBlocks.length} bytes with blocks (source: JSON.stringify of each response body)`);

    // The fixture's one block is ~48 KB against a few hundred bytes of
    // metadata, so a tenth is a conservative bar that still fails loudly if
    // the projection stops applying.
    assert.ok(
      projected.length * 10 < withBlocks.length,
      `the projection saved little or nothing: ${projected.length} vs ${withBlocks.length} bytes`,
    );
  });

  test('a value that is not an opt-in is not one', async () => {
    // Same typing rule as the filters: an operator object must not be read as
    // a projection the caller never asked for.
    for (const query of ['?include=summary', '?include%5B%24ne%5D=blocks', '?include=blocks&include=blocks']) {
      const heavy = row(await list(alice, query), BIG.title);
      assert.ok(!('blocks' in heavy), `${query} opted in: keys ${Object.keys(heavy).join(', ')}`);
    }
  });
});

describe('GET /entities?q= under the projection', () => {
  test('a word that appears only inside a block still finds its entity', async () => {
    const body = await list(alice, `?q=${BLOCK_ONLY_WORD}`);

    // The word is in no title, summary or tag — only in BIG's block markdown.
    assert.deepEqual(titles(body), [BIG.title], `the block-markdown match is wrong: ${titles(body).join(', ')}`);
  });

  test('and the hit still comes back without its blocks', async () => {
    const heavy = row(await list(alice, `?q=${BLOCK_ONLY_WORD}`), BIG.title);

    assert.ok(!('blocks' in heavy), `a search hit shipped blocks: keys ${Object.keys(heavy).join(', ')}`);
  });

  test('the same search with the opt-in carries them', async () => {
    const heavy = row(await list(alice, `?q=${BLOCK_ONLY_WORD}&include=blocks`), BIG.title);

    assert.equal(heavy.blocks?.[0]?.data?.markdown, BIG_MARKDOWN);
  });
});

describe('GET /entities tenancy under the projection', () => {
  test("another workspace's entities stay absent, projected or not", async () => {
    const aliceOwn = await allTitles(alice);
    assert.ok(aliceOwn.includes(BIG.title) && aliceOwn.includes(SMALL.title), `premise: ${aliceOwn.join(', ')}`);

    assert.deepEqual(titles(await list(alice)), aliceOwn, "alice's list");
    assert.deepEqual(titles(await list(alice, '?include=blocks')), aliceOwn, "alice's list with blocks");
    assert.deepEqual(titles(await list(bob)), await allTitles(bob), "bob's list");

    assert.ok(!titles(await list(alice)).includes(BOB_ENTITY.title), "bob's row leaked into alice's list");
  });

  test("a keyword both tenants match returns only the caller's rows", async () => {
    // Bob's block markdown holds the same word, so a lost workspace clause
    // would show up here and nowhere else.
    assert.deepEqual(titles(await list(bob, `?q=${BLOCK_ONLY_WORD}`)), [BOB_ENTITY.title]);
  });

  test('an unauthenticated caller gets nothing either way', async () => {
    for (const query of ['', '?include=blocks']) {
      const res = await request(app).get(`/entities${query}`);
      assert.equal(res.status, 401, `GET /entities${query} with no session answered ${res.status}`);
    }
  });
});

/**
 * ─── Pagination (KOL-067) ────────────────────────────────────────────────────
 *
 * The list route answered with every row in the workspace, and it is the first
 * request every tenant makes. KOL-061 took the block content out of it; the row
 * count was still the whole workspace, so a large one still serialized in one
 * go on the single event loop this multi-tenant API shares.
 *
 * What can only be asserted over real requests, and is asserted below:
 *
 *   The old shape survives. No `?limit=` is the bare array it has always been,
 *   because the MCP tools, the chat tool, the graph view and any script outside
 *   this repo read it — the envelope is the breaking part, and it only arrives
 *   when it is asked for. Every "not a page size" value lands here too.
 *
 *   A page boundary neither drops nor repeats a row. The fixture holds two
 *   entities with the *same title*, which is what breaks a cursor that keys on
 *   the sort field alone: walked one row at a time, every title has to come
 *   back exactly once. (`skip` fails a different way — it cannot be caught by a
 *   static fixture at all, which is half of why the cursor is a keyset.)
 *
 *   `?q=` puts an `$or` in the filter and the cursor needs one of its own, so a
 *   paged search is walked too: one object cannot hold two `$or` keys, and the
 *   one that loses is either the search or the page boundary.
 *
 *   `total` counts the filtered set, not the page and not the remainder.
 *
 *   The cap is real, which needs more rows than a readable fixture has — hence
 *   a third workspace bulk-loaded past the cap, which doubles as the proof that
 *   those rows never surface in anyone else's pages.
 *
 * Falsification: drop `_id` from the sort or from the cursor and the same-title
 * walk loses a row; count `pageFilter` instead of `filter` and `total` shrinks
 * page by page; put the cursor clause beside `$or` instead of under `$and` and
 * the paged search walks the whole workspace; let `boundedInteger` pass `0`
 * through and the `?limit=0` case gets an empty envelope instead of the list.
 */

/** Two entities sharing a title — the case a title-only cursor loses. */
const SAME_TITLE = 'Signal Box';
/** A word only those two carry, so a paged `?q=` has two rows and a boundary. */
const PAIR_WORD = 'interlocking';
const PAIR = [
  { title: SAME_TITLE, category: 'Worlds', summary: `The ${PAIR_WORD} frame at Alder Street.`, tags: ['stations'] },
  { title: SAME_TITLE, category: 'Worlds', summary: `The ${PAIR_WORD} frame at the yard.`, tags: ['stations'] },
];

/** Carol's workspace: one row more than the cap, so the cap is visible. */
const BULK_PREFIX = 'Bulk Row ';

let carol;
let bulkCount;

/** GETs `/entities<query>` as `who` and asserts the paged envelope's shape. */
async function pageOf(who, query) {
  const res = await who.agent.get(`/entities${query}`);
  assert.equal(res.status, 200, `GET /entities${query} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);

  const body = res.body;
  assert.ok(
    body && !Array.isArray(body) && Array.isArray(body.items),
    `GET /entities${query} should answer { items, nextAfter, total }, got ${JSON.stringify(body).slice(0, 300)}`,
  );
  assert.equal(typeof body.total, 'number', `total should be a number: ${JSON.stringify(body.total)}`);
  assert.ok('nextAfter' in body, `the envelope must carry nextAfter, even as null: ${Object.keys(body).join(', ')}`);

  log('normal', `GET /entities${query} as ${who.email} → ${body.items.length} row(s), total ${body.total}, nextAfter ${JSON.stringify(body.nextAfter)}`);
  return body;
}

/** The query string for one page: `prefix` (if any) plus limit and cursor. */
function pageQuery(prefix, limit, cursor) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) {
    params.set('after[title]', cursor.title);
    params.set('after[_id]', cursor._id);
  }
  return `${prefix ? `${prefix}&` : '?'}${params}`;
}

/**
 * Walks every page of `prefix` at `pageSize` and returns the rows in the order
 * they were served, plus how many requests it took. Asserts the walk ends on a
 * null cursor rather than being cut off by the guard below.
 */
async function walk(who, pageSize, prefix = '') {
  const rows = [];
  let cursor = null;
  let requests = 0;

  do {
    // A cursor that does not advance is an infinite loop, and a test that hangs
    // says less than one that fails: the bound is the workspace plus slack.
    assert.ok(requests < 400, `the walk did not terminate after ${requests} requests`);
    const body = await pageOf(who, pageQuery(prefix, pageSize, cursor));
    requests += 1;

    assert.ok(body.items.length <= pageSize, `a page served ${body.items.length} rows for limit ${pageSize}`);
    rows.push(...body.items);
    cursor = body.nextAfter;
  } while (cursor);

  log('light', `walked ${rows.length} row(s) of ${who.email} in ${requests} request(s) at limit ${pageSize} (source: GET /entities${prefix || ''} paged)`);
  return { rows, requests };
}

describe('GET /entities pagination', () => {
  before(async () => {
    // The pair goes in alice's workspace, where the other groups above have
    // already run, so nothing they assert is disturbed by it.
    for (const body of PAIR) await createEntity(alice, body);

    carol = await registerUser('list-carol@example.test');
    bulkCount = LIST_LIMIT_MAX + 1;
    // Straight through the model rather than 201 POSTs: what is being asserted
    // is the cap, and the route's own write path is pinned elsewhere. Zero-
    // padded so the title order is the insertion order.
    await Entity.insertMany(
      Array.from({ length: bulkCount }, (_, i) => ({
        title: `${BULK_PREFIX}${String(i).padStart(4, '0')}`,
        category: 'Worlds',
        summary: `Row ${i} of carol's bulk load.`,
        tags: ['bulk'],
        workspaceId: carol.workspaceId,
      })),
    );
    log('light', `bulk-loaded ${bulkCount} entities into carol's workspace ${carol.workspaceId} (source: Entity.insertMany, cap is ${LIST_LIMIT_MAX})`);
  });

  test('no limit is no envelope — the response is the bare array it always was', async () => {
    const body = await list(alice);

    assert.deepEqual(titles(body), await allTitles(alice), 'the unpaged list should still be the whole workspace');
    // And the pair is in it twice, which is the premise of the walk below.
    assert.equal(body.filter(e => e.title === SAME_TITLE).length, 2, `the fixture should hold two "${SAME_TITLE}" rows`);
  });

  test('?limit=2 answers the first two rows by title, with a total for the whole filter', async () => {
    const all = await allTitles(alice);
    const body = await pageOf(alice, '?limit=2');

    assert.equal(body.items.length, 2, 'a page of two');
    assert.deepEqual(body.items.map(e => e.title), all.slice(0, 2), 'the first two rows in title order');
    assert.equal(body.total, all.length, 'total is the whole filtered set, not the page');
    assert.deepEqual(
      body.nextAfter,
      { title: body.items[1].title, _id: String(body.items[1]._id) },
      'the cursor is the last row served',
    );
  });

  test('a page carries the same projected fields as the unpaged list', async () => {
    const heavy = (await pageOf(alice, `?limit=50&q=${BLOCK_ONLY_WORD}`)).items.find(e => e.title === BIG.title);
    assert.ok(heavy, 'the heavy row should be the one hit');

    for (const field of LIST_FIELDS) {
      assert.ok(field in heavy, `a paged row dropped ${field}: keys ${Object.keys(heavy).join(', ')}`);
    }
    assert.ok(!('blocks' in heavy), `a paged row shipped blocks: keys ${Object.keys(heavy).join(', ')}`);
    assert.deepEqual(heavy.open_questions.map(q => q?.question), [OPEN_QUESTION], 'still populated on a page');
  });

  test('paging one row at a time serves every row exactly once, same titles and all', async () => {
    const { rows, requests } = await walk(alice, 1);

    assert.deepEqual(rows.map(e => e.title).sort(), await allTitles(alice), 'the walk is the workspace, no row dropped or repeated');
    // Ids, because two rows share a title and sorted titles alone would be
    // satisfied by the same row served twice.
    const ids = rows.map(e => String(e._id));
    assert.equal(new Set(ids).size, ids.length, `a row was served twice: ${ids.join(', ')}`);
    assert.equal(rows.filter(e => e.title === SAME_TITLE).length, 2, 'both same-title rows made it through a boundary');
    // One request per row and no more: the route reads one row past the page,
    // so the last page that has rows is also the one that ends the walk. A
    // cursor handed out at every full page would cost an extra empty request.
    assert.equal(requests, rows.length, `${rows.length} rows at limit 1 took ${requests} requests`);
  });

  test('a paged search keeps its own filter: the two same-title rows and nothing else', async () => {
    // `?q=` holds the filter's `$or`; the cursor needs one too. If the cursor's
    // clause overwrote it the walk would return the whole workspace.
    const { rows } = await walk(alice, 1, `?q=${PAIR_WORD}`);

    assert.deepEqual(rows.map(e => e.title), [SAME_TITLE, SAME_TITLE], `the paged search returned ${rows.map(e => e.title).join(', ')}`);
    assert.equal(new Set(rows.map(e => String(e._id))).size, 2, 'two distinct rows');
  });

  test('total counts the filtered set, on every page of it', async () => {
    const inWorlds = await Entity.countDocuments({ workspaceId: alice.workspaceId, category: 'Worlds' });
    assert.ok(inWorlds > 2, `premise: alice should have several Worlds rows, has ${inWorlds}`);

    let cursor = null;
    let seen = 0;
    do {
      const body = await pageOf(alice, pageQuery('?category=Worlds', 2, cursor));
      assert.equal(body.total, inWorlds, 'total must not shrink as the cursor advances');
      for (const row of body.items) assert.equal(row.category, 'Worlds', `${row.title} is not a Worlds row`);
      seen += body.items.length;
      cursor = body.nextAfter;
    } while (cursor);

    assert.equal(seen, inWorlds, 'the pages add up to the filtered set');
  });

  test('a search that matches one row pages to a single page with no cursor', async () => {
    const body = await pageOf(alice, `?limit=2&q=${BLOCK_ONLY_WORD}`);

    assert.deepEqual(body.items.map(e => e.title), [BIG.title]);
    assert.equal(body.total, 1, 'total is the match count, not the workspace');
    assert.equal(body.nextAfter, null, 'a short page hands out no cursor');
  });

  test('a value that is not a page size is no page size', async () => {
    const all = await allTitles(alice);

    // `?limit[$gt]=1` percent-encoded, as the extended query parser receives it.
    for (const query of ['?limit=0', '?limit=abc', '?limit=-1', '?limit%5B%24gt%5D=1', '?limit=1&limit=2', '?limit=1.5', '?limit=']) {
      const body = await list(alice, query);
      assert.deepEqual(titles(body), all, `${query} was read as a page size`);
    }
  });

  test('a limit above the cap is capped, not refused', async () => {
    const body = await pageOf(carol, '?limit=9999');

    assert.equal(body.items.length, LIST_LIMIT_MAX, `a page of ${body.items.length} for ?limit=9999`);
    assert.ok(body.total > LIST_LIMIT_MAX, `premise: carol's workspace should be bigger than the cap, total ${body.total}`);
    assert.ok(body.nextAfter, 'a capped page is not the last one');
  });

  test('the cap holds across a walk of a workspace larger than it', async () => {
    const { rows } = await walk(carol, LIST_LIMIT_MAX, '?tag=bulk');

    assert.equal(rows.length, bulkCount, `expected the ${bulkCount} bulk rows, walked ${rows.length}`);
    assert.equal(new Set(rows.map(e => String(e._id))).size, bulkCount, 'no row served twice across the boundary');
  });

  test("another workspace's rows never appear on any page", async () => {
    const { rows } = await walk(alice, 1);
    const seen = rows.map(e => e.title);

    assert.ok(!seen.includes(BOB_ENTITY.title), `bob's row leaked into alice's pages: ${seen.join(', ')}`);
    assert.ok(!seen.some(t => t.startsWith(BULK_PREFIX)), `carol's rows leaked into alice's pages: ${seen.join(', ')}`);

    // And the other way: carol's own pages are hers alone.
    const mine = (await walk(carol, LIST_LIMIT_MAX)).rows.map(e => e.title);
    assert.ok(!mine.includes(BIG.title) && !mine.includes(BOB_ENTITY.title), `alice's or bob's rows reached carol: ${mine.length} row(s)`);
  });

  test('a cursor the server did not issue is refused rather than answered with page one', async () => {
    // Silently dropping it would answer page 1 to a request for page 2 — and a
    // client that pages until nextAfter is null would never stop.
    const queries = [
      '?limit=2&after=nonsense',
      '?limit=2&after%5Btitle%5D=Alder%20Street',
      '?limit=2&after%5B_id%5D=000000000000000000000000',
      '?limit=2&after%5Btitle%5D=Alder%20Street&after%5B_id%5D=not-an-id',
      '?limit=2&after%5Btitle%5D%5B%24gt%5D=A&after%5B_id%5D=000000000000000000000000',
    ];

    for (const query of queries) {
      const res = await alice.agent.get(`/entities${query}`);
      assert.equal(res.status, 400, `GET /entities${query} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
      assert.match(res.body.error ?? '', /after/, `the refusal should name the parameter: ${JSON.stringify(res.body)}`);
    }
  });

  test('a cursor for a row that no longer exists still pages from that position', async () => {
    // A deleted cursor row is ordinary: the keyset is a position in the sort,
    // not a row reference, so paging continues from where the row was.
    const first = await pageOf(alice, '?limit=1');
    const gone = { title: first.nextAfter.title, _id: String(new mongoose.Types.ObjectId()) };
    const body = await pageOf(alice, pageQuery('', 50, gone));

    assert.ok(!body.items.some(e => String(e._id) === String(first.items[0]._id)), 'the row before the cursor should not come back');
    assert.equal(body.total, (await allTitles(alice)).length, 'total is unaffected by the cursor');
  });

  test('an unauthenticated caller gets nothing from a page either', async () => {
    const res = await request(app).get('/entities?limit=2');
    assert.equal(res.status, 401, `GET /entities?limit=2 with no session answered ${res.status}`);
  });
});
