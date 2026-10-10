/**
 * `GET /workspace` and `PATCH /workspace` over the real stack (KOL-071): three
 * accounts, one Express app, one database.
 *
 * The workspace is the tenancy boundary, so the mount and the role check are
 * as much the subject here as the two handlers are. What this file pins:
 *
 *   - a member gets **their own** workspace, with the **role read from their
 *     own membership** — alice as `owner`, the editor as `editor` — and never
 *     the second account's workspace, which exists and is named differently,
 *     so a missing scope clause shows up as the wrong name rather than as an
 *     absence nobody notices;
 *   - an **owner renames** it, trimmed, and the rename is what the next
 *     `GET /workspace` and the database both answer;
 *   - an empty, whitespace-only, non-string and 81-character name are each
 *     **400** and change nothing — the stored name is re-read after each one;
 *   - an **editor** is **403 `NOT_WORKSPACE_OWNER`** and the name is unchanged,
 *     which is the one assertion `requireWorkspaceRole` exists for;
 *   - an **unauthenticated** call is **401** on both verbs;
 *   - registering **with** `workspaceName` uses it, registering **without**
 *     keeps `My Workspace`, and an unusable `workspaceName` is a 400 that
 *     creates no account at all.
 *
 * The editor fixture is built directly (a `User` plus a membership in alice's
 * workspace) rather than by registering a third account, because registration
 * would give them a workspace of their own and `resolveWorkspace` takes the
 * first membership it finds — the test would then be asserting against
 * whichever workspace Mongo returned first. Built this way, the editor has
 * exactly one membership and it is alice's workspace.
 *
 * Falsification checks: drop `requireWorkspaceRole('owner')` from the PATCH in
 * src/routes/workspace.js and the editor case must fail; take `resolveWorkspace`
 * off the `/workspace` mount in src/app.js and the isolation case must fail.
 * (Note the trap recorded in tests/http/tenancy.test.js: `app.use('/',
 * requireAuth, resolveWorkspace, changelogRouter)` matches every path, so it
 * sets `req.workspaceId` for every mount declared after it — that catch-all has
 * to come off too.)
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_WORKSPACE_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture, naming what created it
 *   normal  — light, plus every request, its status and body
 *   verbose — normal, plus the stored workspace after each write
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
const { DEFAULT_WORKSPACE_NAME, WORKSPACE_NAME_MAX } = await import('../../src/middleware/workspace.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  const active = LEVELS[process.env.TEST_WORKSPACE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/workspace:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';
const ALICE_WORKSPACE = "Alice's Bible";
const BOB_WORKSPACE = "Bob's Compendium";

let app;
let alice;
let bob;
let editor;

/** Registers through the real endpoint and reads back the ids it created. */
async function registerUser(email, workspaceName) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({
    email,
    password: PASSWORD,
    ...(workspaceName && { workspaceName }),
  });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id name').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  log('light', `registered ${email} (source: POST /auth/register, workspaceName ${workspaceName ? `"${workspaceName}"` : 'absent'}) → workspace ${workspace._id} "${workspace.name}"`);
  return { agent, email, userId: String(user._id), workspaceId: String(workspace._id), workspaceName: workspace.name };
}

/**
 * A signed-in user whose only membership is `role` in `workspaceId`.
 * Created directly, then signed in through the real `POST /auth/login` — see
 * the file comment for why this is not a registration.
 */
async function addMember(email, workspaceId, role) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = await User.create({ email, passwordHash });
  await Workspace.updateOne({ _id: workspaceId }, { $push: { members: { userId: user._id, role } } });

  const agent = originAgent(app);
  const res = await agent.post('/auth/login').send({ email, password: PASSWORD });
  assert.equal(res.status, 200, `POST /auth/login (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  log('light', `added ${email} to workspace ${workspaceId} as ${role} (source: direct User.create + $push, signed in via POST /auth/login)`);
  return { agent, email, userId: String(user._id), workspaceId: String(workspaceId), role };
}

/** The stored name, straight from the database. */
async function storedName(workspaceId) {
  const doc = await Workspace.findById(workspaceId).select('name').lean();
  log('verbose', `workspace ${workspaceId} is stored as "${doc?.name}"`);
  return doc?.name;
}

/** GETs /workspace as `who`. */
async function getWorkspaceAs(who, label) {
  const res = await who.agent.get('/workspace');
  log('normal', `${label} → ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

/** PATCHes /workspace as `who` with whatever body is given. */
async function patchWorkspaceAs(who, body, label) {
  const res = await who.agent.patch('/workspace').send(body);
  log('normal', `${label} → ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });

  alice = await registerUser('alice@example.test', ALICE_WORKSPACE);
  bob = await registerUser('bob@example.test', BOB_WORKSPACE);
  assert.notEqual(alice.workspaceId, bob.workspaceId, 'two registrations must yield two distinct workspaces');

  editor = await addMember('editor@example.test', alice.workspaceId, 'editor');
});

after(async () => { await db.disconnect(); });

describe('GET /workspace', () => {
  test("answers the caller's own workspace, with the role from their membership", async () => {
    const res = await getWorkspaceAs(alice, 'GET /workspace as alice');

    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ['_id', 'createdAt', 'name', 'role']);
    assert.equal(res.body._id, alice.workspaceId);
    assert.equal(res.body.name, await storedName(alice.workspaceId));
    assert.equal(res.body.role, 'owner');
    assert.ok(!Number.isNaN(Date.parse(res.body.createdAt)), 'createdAt should be a date');
  });

  test("never answers another user's workspace", async () => {
    const forAlice = await getWorkspaceAs(alice, 'GET /workspace as alice');
    const forBob = await getWorkspaceAs(bob, 'GET /workspace as bob');

    assert.equal(forBob.status, 200);
    assert.equal(forBob.body._id, bob.workspaceId);
    assert.equal(forBob.body.name, BOB_WORKSPACE);
    assert.notEqual(forAlice.body._id, forBob.body._id);
    assert.notEqual(forAlice.body.name, forBob.body.name);
  });

  test('a member who is not the owner reads the workspace, and their own role', async () => {
    const res = await getWorkspaceAs(editor, 'GET /workspace as the editor');

    assert.equal(res.status, 200);
    assert.equal(res.body._id, alice.workspaceId);
    assert.equal(res.body.role, 'editor');
  });

  test('an unauthenticated call is 401 and carries no workspace', async () => {
    const res = await request(app).get('/workspace');
    log('normal', `GET /workspace unauthenticated → ${res.status} ${JSON.stringify(res.body)}`);

    assert.equal(res.status, 401);
    assert.equal(res.body.name, undefined);
    assert.equal(res.body._id, undefined);
  });
});

describe('PATCH /workspace', () => {
  test('an owner renames it, trimmed, and the rename is what is stored', async () => {
    const res = await patchWorkspaceAs(alice, { name: "  Alice's World Bible  " }, 'PATCH /workspace as alice');

    assert.equal(res.status, 200);
    assert.equal(res.body.name, "Alice's World Bible");
    assert.equal(res.body._id, alice.workspaceId);
    assert.equal(res.body.role, 'owner');

    assert.equal(await storedName(alice.workspaceId), "Alice's World Bible");
    const reread = await getWorkspaceAs(alice, 'GET /workspace as alice, after the rename');
    assert.equal(reread.body.name, "Alice's World Bible");

    // Put it back, so the cases below start from the fixture's name.
    await patchWorkspaceAs(alice, { name: ALICE_WORKSPACE }, 'PATCH /workspace as alice, restoring the fixture name');
    assert.equal(await storedName(alice.workspaceId), ALICE_WORKSPACE);
  });

  test('renaming leaves another workspace alone', async () => {
    await patchWorkspaceAs(alice, { name: 'Renamed Once' }, 'PATCH /workspace as alice');

    assert.equal(await storedName(bob.workspaceId), BOB_WORKSPACE);

    await patchWorkspaceAs(alice, { name: ALICE_WORKSPACE }, 'PATCH /workspace as alice, restoring the fixture name');
  });

  test('an unusable name is 400 and changes nothing', async () => {
    const cases = [
      ['an empty string', { name: '' }],
      ['whitespace only', { name: '   ' }],
      ['a number', { name: 42 }],
      ['an object', { name: { $ne: null } }],
      ['null', { name: null }],
      ['no name at all', {}],
      [`${WORKSPACE_NAME_MAX + 1} characters`, { name: 'x'.repeat(WORKSPACE_NAME_MAX + 1) }],
    ];

    for (const [label, body] of cases) {
      const res = await patchWorkspaceAs(alice, body, `PATCH /workspace as alice with ${label}`);
      assert.equal(res.status, 400, `${label} should be 400, was ${res.status}`);
      assert.equal(res.body.error, 'INVALID_WORKSPACE_NAME', `${label} should answer the name code`);
      assert.equal(await storedName(alice.workspaceId), ALICE_WORKSPACE, `${label} must not change the name`);
    }
  });

  test(`a name of exactly ${WORKSPACE_NAME_MAX} characters is accepted`, async () => {
    const name = 'x'.repeat(WORKSPACE_NAME_MAX);
    const res = await patchWorkspaceAs(alice, { name }, 'PATCH /workspace as alice with the longest allowed name');

    assert.equal(res.status, 200);
    assert.equal(await storedName(alice.workspaceId), name);

    await patchWorkspaceAs(alice, { name: ALICE_WORKSPACE }, 'PATCH /workspace as alice, restoring the fixture name');
  });

  test('an editor is 403 NOT_WORKSPACE_OWNER and the name is unchanged', async () => {
    const res = await patchWorkspaceAs(editor, { name: 'Editor Was Here' }, 'PATCH /workspace as the editor');

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'NOT_WORKSPACE_OWNER');
    assert.equal(await storedName(alice.workspaceId), ALICE_WORKSPACE);
  });

  test('an unauthenticated call is 401 and changes nothing', async () => {
    const res = await request(app)
      .patch('/workspace')
      .set('Origin', CLIENT_ORIGIN)
      .send({ name: 'Nobody Was Here' });
    log('normal', `PATCH /workspace unauthenticated → ${res.status} ${JSON.stringify(res.body)}`);

    assert.equal(res.status, 401);
    assert.equal(await storedName(alice.workspaceId), ALICE_WORKSPACE);
  });
});

describe('POST /auth/register workspaceName', () => {
  test('names the new workspace when given', async () => {
    const named = await registerUser('named@example.test', 'The Signal Archive');
    assert.equal(named.workspaceName, 'The Signal Archive');
  });

  test('trims it, like a rename does', async () => {
    const named = await registerUser('trimmed@example.test', '   The Trimmed Archive   ');
    assert.equal(named.workspaceName, 'The Trimmed Archive');
  });

  test(`keeps "${DEFAULT_WORKSPACE_NAME}" when absent`, async () => {
    const unnamed = await registerUser('unnamed@example.test');
    assert.equal(unnamed.workspaceName, DEFAULT_WORKSPACE_NAME);
  });

  test('an unusable one is 400 and creates no account', async () => {
    for (const [label, workspaceName] of [
      ['an empty string', ''],
      ['whitespace only', '   '],
      ['a number', 7],
      ['null', null],
      [`${WORKSPACE_NAME_MAX + 1} characters`, 'x'.repeat(WORKSPACE_NAME_MAX + 1)],
    ]) {
      const email = `refused-${label.replace(/\W+/g, '-')}@example.test`;
      const res = await originAgent(app).post('/auth/register').send({ email, password: PASSWORD, workspaceName });
      log('normal', `POST /auth/register with ${label} → ${res.status} ${JSON.stringify(res.body)}`);

      assert.equal(res.status, 400, `${label} should be 400, was ${res.status}`);
      assert.equal(res.body.error, 'INVALID_WORKSPACE_NAME');
      assert.equal(await User.countDocuments({ email }), 0, `${label} must create no user`);
    }
  });
});
