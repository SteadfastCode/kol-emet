/**
 * `GET /export` over the real stack: two accounts, one Express app, one database.
 *
 * The export is the one response that carries a whole workspace, so the mount
 * is the thing under test as much as the document is. What this file pins:
 *
 *   - an authenticated caller gets **their own** graph — the entity they
 *     created is in it — and **nothing** of the second workspace's, which is
 *     seeded and non-empty, so a missing `workspaceId` clause shows up as
 *     extra rows rather than as an absence nobody notices;
 *   - an **unauthenticated** call is 401 and carries no document at all;
 *   - the **filename header** is set, as `attachment` with
 *     `<workspace>-<YYYY-MM-DD>.json`, so a browser saves the file instead of
 *     painting a megabyte of JSON into a tab;
 *   - the body is `application/json`, parses, and is the canonical shape
 *     `lib/graphExporter.js` documents — indented, because this file is meant
 *     to be diffed.
 *
 * The fixture registers through the real `POST /auth/register`, so both
 * workspaces are seeded from the default template exactly as a signup's would
 * be — which is what makes "bob's rows are not in alice's export" a real
 * assertion rather than two empty lists agreeing.
 *
 * Falsification check: drop `resolveWorkspace` from the `/export` mount in
 * src/app.js and the isolation test must fail. (Note the trap recorded in
 * tests/http/tenancy.test.js: `app.use('/', requireAuth, resolveWorkspace,
 * changelogRouter)` matches every path, so it sets `req.workspaceId` for every
 * mount declared after it — that catch-all has to come off too.)
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_EXPORT_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture document, naming the request that created it
 *   normal  — light, plus each export request, its status, headers and size
 *   verbose — normal, plus the exported document
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

// Environment before src/app.js is imported, for the reasons in tenancy.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
// Unset on purpose: with no bearer token configured a stray Authorization
// header cannot resolve to the MCP user and quietly satisfy requireAuth.
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.EXPORT_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');
const { EXPORT_VERSION, EXPORT_COLLECTIONS } = await import('../../src/lib/graphExporter.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  const active = LEVELS[process.env.TEST_EXPORT_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/export:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';
const ALICE_TITLE = 'Alice Only';
const BOB_TITLE = 'Bob Only';

let app;
let alice;
let bob;

/** Registers through the real endpoint and reads back the ids it created. */
async function registerUser(email) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id name').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  log('light', `registered ${email} (source: POST /auth/register) → workspace ${workspace._id} "${workspace.name}"`);
  return { agent, email, workspaceId: String(workspace._id), workspaceName: workspace.name };
}

/** POSTs an entity as `who` and returns it. */
async function createEntity(who, title) {
  const res = await who.agent.post('/entities').send({
    title,
    category: 'Characters',
    summary: `${title} — created for the export suite.`,
    tags: ['export-fixture'],
    blocks: [{ type: 'text', order: 0, data: { markdown: `Only ${who.email} should ever read this.` } }],
  });
  assert.equal(res.status, 201, `POST /entities as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('light', `created entity ${res.body._id} "${title}" (source: POST /entities as ${who.email}) in workspace ${res.body.workspaceId}`);
  return res.body;
}

/** GETs /export as `who`, logging the answer. Returns the supertest response. */
async function exportAs(who, label) {
  const res = await who.agent.get('/export');
  log('normal', `${label} → ${res.status}, type ${res.headers['content-type']}, disposition ${res.headers['content-disposition']}, ${res.text?.length ?? 0} bytes`);
  log('verbose', res.text ?? JSON.stringify(res.body));
  return res;
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });

  alice = await registerUser('alice@example.test');
  bob = await registerUser('bob@example.test');
  assert.notEqual(alice.workspaceId, bob.workspaceId, 'two registrations must yield two distinct workspaces');

  alice.entity = await createEntity(alice, ALICE_TITLE);
  bob.entity = await createEntity(bob, BOB_TITLE);
});

after(async () => { await db.disconnect(); });

describe('GET /export', () => {
  test('an authenticated caller gets their own graph, in the canonical shape', async () => {
    const res = await exportAs(alice, 'GET /export as alice');

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);

    const doc = JSON.parse(res.text);
    assert.equal(doc.version, EXPORT_VERSION);
    assert.deepEqual(Object.keys(doc), [
      'version', 'exportedAt', 'workspace',
      'entityTypes', 'relationshipTypes', 'entities', 'relationshipGroups', 'openQuestions',
    ]);
    assert.equal(doc.workspace.name, alice.workspaceName);

    // Registration seeds the workspace, so every collection the template fills
    // is non-empty; an empty one here would be a dropped collection.
    for (const collection of EXPORT_COLLECTIONS) {
      assert.ok(Array.isArray(doc[collection]), `${collection} should be an array`);
    }
    assert.ok(doc.entityTypes.length > 0, 'the seeded entity-type registry must be in the export');
    assert.ok(doc.relationshipTypes.length > 0, 'the seeded relationship-type vocabulary must be in the export');

    const mine = doc.entities.find(e => e.title === ALICE_TITLE);
    assert.ok(mine, "alice's own entity must be in alice's export");
    assert.equal(mine.blocks[0].data.markdown, `Only ${alice.email} should ever read this.`);
  });

  test('the body is indented JSON, because it is meant to be diffed', async () => {
    const res = await exportAs(alice, 'GET /export as alice (formatting)');

    assert.ok(res.text.startsWith('{\n  "version"'), `expected two-space indentation, got: ${res.text.slice(0, 40)}`);
  });

  test("nothing of the other workspace's content is in it", async () => {
    const res = await exportAs(alice, 'GET /export as alice (isolation)');
    const doc = JSON.parse(res.text);

    assert.ok(!doc.entities.some(e => e.title === BOB_TITLE), "bob's entity must not be in alice's export");
    assert.ok(!res.text.includes(String(bob.entity._id)), "no id of bob's must appear anywhere in the bytes");
    assert.ok(!res.text.includes(bob.email), "no trace of the other tenant's account either");
    assert.ok(!res.text.includes(String(bob.workspaceId)));

    // And the other direction, so the test cannot pass by alice's export being empty.
    const theirs = JSON.parse((await exportAs(bob, 'GET /export as bob (isolation)')).text);
    assert.ok(theirs.entities.some(e => e.title === BOB_TITLE), 'bob must see his own entity');
    assert.ok(!theirs.entities.some(e => e.title === ALICE_TITLE), "alice's entity must not be in bob's export");
  });

  test('no account, tenancy or billing field is in the bytes', async () => {
    const res = await exportAs(alice, 'GET /export as alice (sweep)');

    for (const forbidden of ['aiBudget', 'passwordHash', 'userId', 'email', 'workspaceId', 'ownerId']) {
      assert.ok(!res.text.includes(`"${forbidden}"`), `"${forbidden}" must not appear as a key in an export`);
    }
    assert.ok(!res.text.includes(String(alice.workspaceId)), 'an export is one workspace, so its id is left out');
  });

  test('the filename header names the workspace and the day', async () => {
    const res = await exportAs(alice, 'GET /export as alice (header)');
    const disposition = res.headers['content-disposition'];

    assert.ok(disposition, 'Content-Disposition must be set, or the browser renders the file instead of saving it');
    assert.match(disposition, /^attachment; filename="[a-z0-9][a-z0-9-]*-\d{4}-\d{2}-\d{2}\.json"$/);

    // The day in the name is the export's own, in UTC.
    const doc = JSON.parse(res.text);
    assert.ok(
      disposition.includes(doc.exportedAt.slice(0, 10)),
      `the filename's date must be the document's: ${disposition} vs ${doc.exportedAt}`,
    );
  });
});

describe('an unauthenticated call', () => {
  test('is 401 and carries no document', async () => {
    const res = await request(app).get('/export');
    log('normal', `GET /export unauthenticated → ${res.status} ${JSON.stringify(res.body)}`);

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Unauthorized');
    assert.equal(res.body.entities, undefined);
    assert.equal(res.headers['content-disposition'], undefined, 'a refusal must not offer a download');
  });

  test('a bearer token that is not configured cannot stand in for a session', async () => {
    const res = await request(app).get('/export').set('Authorization', 'Bearer not-a-token');
    log('normal', `GET /export with a bogus bearer → ${res.status} ${JSON.stringify(res.body)}`);

    assert.equal(res.status, 401);
    assert.equal(res.body.entities, undefined);
  });
});
