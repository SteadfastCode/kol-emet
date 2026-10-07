/**
 * HTTP tests for the search filters on `GET /entities`.
 *
 * The route compiles a string the caller chose into a regex and matches it
 * against every title, summary and block markdown in the workspace. Two things
 * about that can only be tested here, over a real request:
 *
 *   The query string is parsed by Express, not by this file. `?q=(` is a
 *   perfectly ordinary search — a user typing an opening bracket into the
 *   search box — and before `lib/searchFilter.js` it threw a SyntaxError inside
 *   the route's `try` and answered 500. And Express 4's default *extended*
 *   parser is what turns `?category[$ne]=Characters` into an operator object
 *   and `?q=a&q=b` into an array; a unit test can hand `searchTerm` an object,
 *   but only a request proves the route is handed one too. The parser's own
 *   behaviour is asserted below rather than assumed, so if a later change sets
 *   `app.set('query parser', 'simple')` these tests say so instead of passing
 *   vacuously.
 *
 *   The workspace clause has to survive the keyword clause. `keywordFilter`
 *   returns an `$or` that the route merges into a filter already holding
 *   `workspaceId`; a merge that dropped the tenancy key would still return
 *   plausible results, so a term both tenants match is asserted to return only
 *   the caller's row.
 *
 * `tests/unit/searchFilter.test.js` owns the term's own semantics (what escapes,
 * what is null, the length cap). This file asserts what the route does with it.
 *
 * Falsification: put back `new RegExp(req.query.q, 'i')` in
 * `src/routes/entities.js` and the punctuation cases 500; drop the `searchTerm`
 * call on `category`/`tag` and the operator-object cases fail; drop
 * `workspaceId` from the filter and the cross-tenant case fails.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_ENTITY_SEARCH_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture document, naming the request that created it
 *             and the workspace it landed in
 *   normal  — light, plus every search request with its status and result count
 *   verbose — normal, plus the titles each search returned
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
import Workspace from '../../src/models/Workspace.js';
import Entity from '../../src/models/Entity.js';

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

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_ENTITY_SEARCH_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/entitySearch:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

let app;
let alice;
let bob;

/**
 * Alice's fixtures. The summary of PUNCTUATED holds the `(` the item's own
 * example crashes on, BLOCKS holds its punctuation only in block markdown (the
 * third clause of the `$or`), and PLAIN holds no punctuation at all, so it is
 * what a pattern that matched everything would wrongly drag in.
 */
const PUNCTUATED = {
  title: 'C++ (v2) Runtime',
  category: 'Worlds',
  summary: 'Ships the (parenthetical) runtime.',
  tags: ['punct'],
};
const BLOCKS = {
  title: 'Release Notes',
  category: 'Worlds',
  summary: 'A summary with no brackets in it',
  tags: ['notes'],
  blocks: [{ type: 'text', order: 0, data: { markdown: 'Built against C++ (v2) on the old toolchain.' } }],
};
const PLAIN = {
  title: 'Iron Gate',
  category: 'Characters',
  summary: 'No punctuation in this summary',
  tags: ['plain'],
};

/** Bob's row carries the same summary text, so a lost workspace clause shows up. */
const BOB_ENTITY = {
  title: 'Bob (v2) Runtime',
  category: 'Worlds',
  summary: 'Ships the (parenthetical) runtime.',
  tags: ['punct'],
};

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
  log('light', `created entity ${res.body._id} "${res.body.title}" (source: POST /entities as ${who.email}) in workspace ${res.body.workspaceId}`);
  return res.body;
}

/** GETs `/entities<query>` as `who`, asserts a 200, and returns the body. */
async function search(who, query) {
  const res = await who.agent.get(`/entities${query}`);
  log('normal', `GET /entities${query} as ${who.email} → ${res.status}, ${Array.isArray(res.body) ? res.body.length : '?'} result(s)`);
  assert.equal(res.status, 200, `GET /entities${query} answered ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(Array.isArray(res.body), `GET /entities${query} should answer an array, got ${JSON.stringify(res.body)}`);
  log('verbose', `titles: ${res.body.map(e => e.title).join(' | ')}`);
  return res.body;
}

/** Every title in `who`'s workspace, straight from the database. */
async function allTitles(who) {
  const docs = await Entity.find({ workspaceId: who.workspaceId }).select('title').lean();
  return docs.map(d => d.title).sort();
}

function titles(body) {
  return body.map(e => e.title).sort();
}

before(async () => {
  await db.connect();

  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });

  alice = await registerUser('search-alice@example.test');
  bob = await registerUser('search-bob@example.test');
  assert.notEqual(alice.workspaceId, bob.workspaceId, 'two registrations must yield two distinct workspaces');

  for (const body of [PUNCTUATED, BLOCKS, PLAIN]) await createEntity(alice, body);
  await createEntity(bob, BOB_ENTITY);
});

after(async () => {
  await db.disconnect();
});

describe('GET /entities keyword search', () => {
  test('a bare opening bracket is a search, not a 500', async () => {
    const found = titles(await search(alice, '?q=('));

    assert.ok(found.includes(PUNCTUATED.title), `the entity whose summary holds "(" is missing: ${found.join(', ')}`);
    assert.ok(found.includes(BLOCKS.title), `the entity whose block markdown holds "(" is missing: ${found.join(', ')}`);
    assert.ok(!found.includes(PLAIN.title), `an entity with no bracket matched: ${found.join(', ')}`);
  });

  test('a punctuated term matches the entities that literally hold it', async () => {
    const found = titles(await search(alice, `?q=${encodeURIComponent('C++ (v2)')}`));

    assert.deepEqual(found, [BLOCKS.title, PUNCTUATED.title].sort(), 'expected the title match and the block-markdown match');
  });

  test('a catastrophic pattern is matched literally and finds nothing', async () => {
    // Unescaped, `(a+)+$` is a backtracking match against every document in the
    // workspace, on the event loop every tenant shares.
    const found = titles(await search(alice, `?q=${encodeURIComponent('(a+)+$')}`));

    assert.deepEqual(found, [], `nothing holds that string literally: ${found.join(', ')}`);
  });

  test('a term longer than the cap is answered, not refused', async () => {
    const found = titles(await search(alice, `?q=${'a'.repeat(500)}`));

    assert.deepEqual(found, [], `nothing holds that string: ${found.join(', ')}`);
  });

  test('a term both tenants match returns only the caller\'s row', async () => {
    const found = titles(await search(alice, `?q=${encodeURIComponent('(parenthetical)')}`));

    assert.deepEqual(found, [PUNCTUATED.title], `bob's identically-worded row leaked: ${found.join(', ')}`);
  });

  test('a repeated q is no keyword filter rather than a joined one', async () => {
    // The extended parser hands the route ['a', 'b'], which used to stringify
    // into the regex as `a,b` — a term the caller never asked for.
    const parsed = app.get('query parser fn')('q=a&q=b');
    assert.deepEqual(parsed.q, ['a', 'b'], 'premise: Express parses a repeated parameter as an array');

    assert.deepEqual(titles(await search(alice, '?q=a&q=b')), await allTitles(alice));
  });
});

describe('GET /entities filter typing', () => {
  test('an operator object in category is no filter, not the filter the caller wrote', async () => {
    const parsed = app.get('query parser fn')('category%5B%24ne%5D=Characters');
    assert.deepEqual(parsed.category, { $ne: 'Characters' }, 'premise: Express parses a bracketed key into an object');

    const found = titles(await search(alice, '?category%5B%24ne%5D=Characters'));

    // The operator selected nothing of its own: the Characters row it was
    // written to exclude is still listed, and the answer is the whole workspace.
    assert.ok(found.includes(PLAIN.title), `$ne was honoured — the Characters row is missing: ${found.join(', ')}`);
    assert.deepEqual(found, await allTitles(alice));
  });

  test('an operator object in tag is no filter either', async () => {
    const found = titles(await search(alice, '?tag%5B%24ne%5D=plain'));

    assert.ok(found.includes(PLAIN.title), `$ne was honoured — the tagged row is missing: ${found.join(', ')}`);
    assert.deepEqual(found, await allTitles(alice));
  });

  test('a plain category still filters', async () => {
    const found = titles(await search(alice, '?category=Characters'));

    assert.ok(found.includes(PLAIN.title), `the Characters row is missing: ${found.join(', ')}`);
    assert.ok(!found.includes(PUNCTUATED.title), `a Worlds row matched a Characters filter: ${found.join(', ')}`);
  });

  test('a plain tag still filters', async () => {
    const found = titles(await search(alice, '?tag=punct'));

    assert.deepEqual(found, [PUNCTUATED.title], `expected only the tagged row: ${found.join(', ')}`);
  });

  test('a category with surrounding whitespace is trimmed, not missed', async () => {
    const found = titles(await search(alice, '?category=%20Characters%20'));

    assert.ok(found.includes(PLAIN.title), `a trimmable category found nothing: ${found.join(', ')}`);
  });
});
