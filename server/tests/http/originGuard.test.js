/**
 * The origin guard over the real stack: a cookie-authenticated write from a
 * page that is not this deployment's client must not happen.
 *
 * Unit tests (tests/unit/originGuard.test.js) cover the branching. What only the
 * whole app can show is the part that matters: that the guard is mounted ahead of
 * every router, that a refusal leaves the database untouched, and that the
 * second layer — no app-wide `express.urlencoded` — means a cross-site *simple*
 * POST cannot form a body a route will act on even if the header check were
 * somehow passed. Same harness as entitySearch.test.js: `createApp()` over
 * supertest, real `POST /auth/register`, real mongod.
 *
 * The attack this reproduces: production issues the session cookie with
 * `sameSite: 'none'` (sibling subdomains), so a browser sends it cross-site; a
 * form-encoded POST is a CORS-simple request, so it is sent with no preflight
 * and CORS withholds only the response. `Origin: https://evil.test` below is
 * exactly what the victim's browser would put on such a request.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_ORIGIN_GUARD_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — the fixture account and each probe's method, origin and status
 *   normal  — light, plus the response body of every probe
 *   verbose — normal, plus the entity titles present after each probe
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import session from 'express-session';
import request from 'supertest';

// Every session write is checked against CLIENT_ORIGIN (src/middleware/originGuard.js),
// so this suite names one below and its agents send a matching Origin.
import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';
import * as db from '../helpers/db.js';
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import Entity from '../../src/models/Entity.js';

// createApp() reads NODE_ENV when called and the OAuth router reads its token at
// module load, so the environment goes in place before src/app.js is imported.
// NODE_ENV must not be 'production': that arms secure/none cookies, which
// supertest's agent would not send back.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
// The origin the guard compares a session write's Origin header against;
// originAgent() above sends it. See tests/helpers/origin.js.
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
// The token POST /oauth/token hands out once its form body parses.
const MCP_TOKEN = 'test-mcp-bearer-token';
process.env.MCP_BEARER_TOKEN = MCP_TOKEN;
// Unset on purpose: with no bearer token configured, a stray Authorization
// header cannot satisfy requireAuth and quietly skip the guard's session path.
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };
const active = (level) => (LEVELS[process.env.TEST_ORIGIN_GUARD_LOG_LEVEL] ?? LEVELS.light) >= LEVELS[level];
function log(level, msg) {
  if (active(level)) console.log(`[tests/originGuard:${level}] ${msg}`);
}

const PASSWORD = 'correct horse battery staple';
const EVIL_ORIGIN = 'https://evil.test';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

let app;
let alice;

/** Registers a user through the real endpoint, returning their agent and ids. */
async function registerUser(email) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  assert.ok(user, `registration should have created a User for ${email}`);
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  log('light', `registered ${email} (source: POST /auth/register) → workspace ${workspace._id}`);
  return { agent, email, userId: String(user._id), workspaceId: String(workspace._id) };
}

/** Logs a probe at the configured tier and hands the response back. */
async function probed(label, res) {
  log('light', `${label} → ${res.status}`);
  log('normal', `${label} body: ${JSON.stringify(res.body)}`);
  // Guarded rather than passed as an argument: the query would otherwise run at
  // every tier, including off.
  if (active('verbose')) {
    const titles = (await Entity.find({}).select('title').lean()).map(e => e.title);
    log('verbose', `titles now: ${titles.join(' | ') || '(none)'}`);
  }
  return res;
}

const titled = (title) => Entity.findOne({ title }).lean();

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });
  alice = await registerUser('origin-alice@example.test');
});

after(async () => {
  await db.disconnect();
});

describe('a cookie-authenticated write from a foreign origin', () => {
  test('POST /entities with Origin: evil.test is 403 and creates nothing', async () => {
    const title = 'Forged by evil.test';
    const res = await probed('POST /entities (Origin: evil.test)', await alice.agent
      .post('/entities')
      .set('Origin', EVIL_ORIGIN)
      .send({ title, category: 'Worlds', summary: 'This must never be written.' }));

    assert.equal(res.status, 403, 'a cross-origin session write must be refused');
    assert.deepEqual(res.body, { error: 'CROSS_ORIGIN_REQUEST' });
    assert.equal(await titled(title), null, 'the refused request must not have written an entity');
  });

  test('the same POST from the configured client origin is 201', async () => {
    const title = 'Written by the real client';
    const res = await probed('POST /entities (Origin: CLIENT_ORIGIN)', await alice.agent
      .post('/entities')
      .send({ title, category: 'Worlds', summary: 'The client itself.' }));

    assert.equal(res.status, 201, `the real client must still be able to write: ${JSON.stringify(res.body)}`);
    const stored = await titled(title);
    assert.ok(stored, 'the allowed request must have written the entity');
    assert.equal(String(stored.workspaceId), alice.workspaceId);
  });

  test('a session write with neither Origin nor Referer is 403', async () => {
    // The agent's default Origin blanked, and supertest sends no Referer: a
    // session cookie and no statement of where the request came from.
    const title = 'Headerless write';
    const res = await probed('POST /entities (no Origin, no Referer)', await alice.agent
      .post('/entities')
      .set('Origin', '')
      .send({ title, category: 'Worlds', summary: 'No headers at all.' }));

    assert.equal(res.status, 403);
    assert.equal(await titled(title), null);
  });

  test('a matching Referer stands in for an absent Origin', async () => {
    const title = 'Refered by the real client';
    const res = await probed('POST /entities (Referer only)', await alice.agent
      .post('/entities')
      .set('Origin', '')
      .set('Referer', `${CLIENT_ORIGIN}/entities/new`)
      .send({ title, category: 'Worlds', summary: 'Referer only.' }));

    assert.equal(res.status, 201, `a client that sends only a Referer must not be locked out: ${JSON.stringify(res.body)}`);
    assert.ok(await titled(title));
  });

  test('every unsafe method is refused, not just POST', async () => {
    const seed = await alice.agent.post('/entities').send({ title: 'Target of a forgery', category: 'Worlds', summary: 'Seed.' });
    assert.equal(seed.status, 201);

    const put = await probed('PUT /entities/:id (Origin: evil.test)', await alice.agent
      .put(`/entities/${seed.body._id}`).set('Origin', EVIL_ORIGIN).send({ summary: 'Tampered.' }));
    assert.equal(put.status, 403);

    const del = await probed('DELETE /entities/:id (Origin: evil.test)', await alice.agent
      .delete(`/entities/${seed.body._id}`).set('Origin', EVIL_ORIGIN));
    assert.equal(del.status, 403);

    const after = await Entity.findById(seed.body._id).lean();
    assert.ok(after, 'the entity must still exist');
    assert.equal(after.summary, 'Seed.', 'and must be unchanged');
  });

  test('POST /auth/logout from a foreign origin is refused, so the session survives', async () => {
    const res = await probed('POST /auth/logout (Origin: evil.test)', await alice.agent
      .post('/auth/logout').set('Origin', EVIL_ORIGIN));
    assert.equal(res.status, 403);

    const me = await alice.agent.get('/auth/me');
    assert.equal(me.status, 200, 'the victim must still be signed in');
  });
});

describe('the second layer: no app-wide form parser', () => {
  test('a form-encoded POST /entities is never parsed into a write', async () => {
    const title = 'Form-encoded forgery';
    // Sent *from the allowed origin* on purpose: this asserts the second layer
    // on its own, with the header check satisfied.
    const res = await probed('POST /entities (form-encoded, allowed origin)', await alice.agent
      .post('/entities')
      .type('form')
      .send({ title, category: 'Worlds', summary: 'Posted as a form.' }));

    assert.notEqual(res.status, 201, 'a form body must not create an entity');
    assert.equal(await titled(title), null, 'nothing may be written from an unparsed form body');
  });

  test('POST /oauth/token still parses its own form body', async () => {
    // The four OAuth endpoints mount express.urlencoded themselves. If one lost
    // it, grant_type would read as undefined and this would be
    // 'unsupported_grant_type' instead of the flow completing.
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    const authorized = await probed('POST /authorize (form-encoded)', await alice.agent
      .post('/authorize')
      .type('form')
      .send({ redirect_uri: REDIRECT_URI, code_challenge: challenge, state: 'opaque' }));
    assert.equal(authorized.status, 302, `POST /authorize must still read its form body: ${authorized.text}`);
    const code = new URL(authorized.headers.location).searchParams.get('code');
    assert.ok(code, 'an authorization code must come back');

    const token = await probed('POST /oauth/token (form-encoded)', await request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, code_verifier: verifier }));
    assert.equal(token.status, 200, `POST /oauth/token must still read its form body: ${JSON.stringify(token.body)}`);
    assert.equal(token.body.access_token, MCP_TOKEN);
  });

  test('a JSON POST is parsed as it always was', async () => {
    const title = 'JSON still works';
    const res = await probed('POST /entities (json)', await alice.agent
      .post('/entities').send({ title, category: 'Worlds', summary: 'Ordinary JSON.' }));
    assert.equal(res.status, 201);
    assert.ok(await titled(title));
  });
});
