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
