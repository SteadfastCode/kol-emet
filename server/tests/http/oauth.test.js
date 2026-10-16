/**
 * HTTP tests for the OAuth authorization-code + PKCE flow used by the
 * Claude.ai MCP connector, plus the unauthenticated-request guard.
 *
 * ─── What `POST /authorize` actually is ──────────────────────────────────────
 * Not a formality in front of the token endpoint: approving the connector
 * writes `Settings.mcpUserId` (lib/mcpUserStore.js), which is the account every
 * `/mcp` call afterwards reads and writes as, and then hands the caller a code
 * that redeems for `MCP_BEARER_TOKEN`. So the approval form *is* the grant, and
 * KOL-098 is the hole that followed from treating it as paperwork: it read
 * `req.session.userId` straight off the request behind no guard, so
 *
 *   - a session already signed out by `POST /auth/sessions/revoke-all` — the
 *     lost laptop, which keeps its cookie until some guarded route notices —
 *     could re-point `mcpUserId` at its account and read and write the whole
 *     workspace through `/mcp`; and
 *   - a caller with no session at all completed the flow too, which with
 *     `mcpUserId` already set by an earlier legitimate approval is the same
 *     hole with the cookie dropped: a token that acts as that account.
 *
 * Hence the group below, and hence this suite now drives the real stack —
 * a real mongod, a real `POST /auth/register`, real sessions. The guard reads
 * the account's `credentialsChangedAt`, so there is no version of this test
 * that does not touch a database. The session store is a MemoryStore this file
 * holds, so a test can ask it what it still has: the difference between a
 * session refused and a session destroyed.
 *
 * What each group defends:
 *   - Discovery advertises S256 and the endpoints the connector then uses.
 *   - `POST /authorize` takes a live login session, binds the MCP identity to
 *     it, and refuses — with no code issued — an anonymous caller, a bearer
 *     caller (a connector must not be able to re-point the identity it acts
 *     as) and a revoked session, whose session it also destroys.
 *   - The approval page offers the Allow button only when there is somebody to
 *     approve as, so the one user who may do this is not sent into a bare 401.
 *   - `POST /oauth/token` enforces PKCE and single use of a code.
 *   - `requireAuth` refuses `/entities` with no session and no bearer token.
 *
 * Falsification checks: drop `requireLoginSession` from `POST /authorize` and
 * the anonymous, bearer and revoked cases all fail; read `req.session.userId`
 * instead of `req.loginUserId` and the revoked case fails; set the MCP user
 * before the missing-parameter check and the malformed-approval case fails;
 * render the Allow form unconditionally and the page case fails.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_OAUTH_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per account registered or revoked, naming what did it
 *   normal  — light, plus every call made here and what it answered
 *   verbose — normal, plus the MCP identity either side of each approval
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import session from 'express-session';
import request from 'supertest';

// Every session write is checked against CLIENT_ORIGIN (src/middleware/originGuard.js),
// so this suite names one below and its agents send a matching Origin — the
// approval form posts from a page this API serves, which the guard allows as
// its own origin, but supertest sends no Origin of its own at all.
import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';
import * as db from '../helpers/db.js';
// Registration is throttled per client address, and this suite registers its
// fixtures through the real endpoint from one address. See the helper.
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import User from '../../src/models/User.js';
import { getMcpUser, setMcpUser } from '../../src/lib/mcpUserStore.js';

// The OAuth router reads MCP_BEARER_TOKEN once, at module load, so the
// environment has to be in place before src/app.js is imported — hence the
// dynamic import below rather than a static one at the top of the file.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
// The origin the guard compares a session write's Origin header against.
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
process.env.MCP_BEARER_TOKEN = 'test-mcp-bearer-token';
// Unset so no request here can take the REST API's bearer path by accident;
// the bearer group below sets it for itself and removes it again.
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.SESSION_REVOKE_LOG_LEVEL ??= 'off';
process.env.SESSION_COOKIE_LOG_LEVEL ??= 'off';
process.env.AUTH_LIMIT_LOG_LEVEL ??= 'off';
process.env.EVENTS_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const PASSWORD = 'correct-horse-battery-staple';

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_OAUTH_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/oauth:${level}] ${msg}`);
}

/** Logs a call and what it answered, then returns the response. */
function called(what, res) {
  log('normal', `${what} → ${res.status}`);
  return res;
}

let app, sessionStore;

before(async () => {
  await db.connect();
  // Held, not just passed: the revoked case asks the store what it still has.
  sessionStore = new session.MemoryStore();
  app = createApp({ sessionStore, authLimits: SUITE_AUTH_LIMITS });
});

after(async () => { await db.disconnect(); });

let accounts = 0;
const uniqueEmail = (label) => `oauth-${label}-${++accounts}@example.com`;

/** The `connect.sid=<value>` pair from a response's Set-Cookie, in Cookie-header form. */
function sessionCookie(res) {
  const cookie = (res.headers['set-cookie'] ?? []).find(c => c.startsWith('connect.sid='));
  return cookie ? cookie.split(';')[0] : null;
}

/** The session id inside a signed `connect.sid=s%3A<sid>.<sig>` cookie pair. */
function sessionId(cookie) {
  return decodeURIComponent(cookie.slice('connect.sid='.length)).replace(/^s:/, '').split('.')[0];
}

/** What the session store holds for `sid`, or null. */
function storedSession(sid) {
  return new Promise((resolve, reject) => {
    sessionStore.get(sid, (err, stored) => (err ? reject(err) : resolve(stored ?? null)));
  });
}

/** An account registered through the real endpoint, signed in on its own agent. */
async function tenant(label) {
  const email = uniqueEmail(label);
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  const user = await User.findOne({ email }).select('_id').lean();
  const sid = sessionId(sessionCookie(res));
  log('light', `registered ${email} (source: POST /auth/register) → user ${user._id}, session ${sid}`);
  return { email, agent, userId: String(user._id), sid };
}

/** A second session on an existing account, through the real sign-in. */
async function signIn(t, label) {
  const agent = originAgent(app);
  const res = called(`POST /auth/login (${t.email}, ${label})`, await agent.post('/auth/login').send({ email: t.email, password: PASSWORD }));
  assert.equal(res.status, 200, `POST /auth/login (${t.email}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  const sid = sessionId(sessionCookie(res));
  log('light', `signed ${t.email} in a second time (source: POST /auth/login) → session ${sid}`);
  return { agent, sid, email: t.email, userId: t.userId };
}

/** PKCE pair: a verifier and its S256 challenge. */
function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Approves the connector as `agent` and returns the issued authorization code. */
async function issueCode(challenge, agent, body = {}) {
  const res = called('POST /authorize', await agent
    .post('/authorize')
    .type('form')
    .send({ redirect_uri: REDIRECT_URI, code_challenge: challenge, state: 'opaque-state', ...body }));

  assert.equal(res.status, 302, `POST /authorize should redirect back to the client: ${res.status} ${res.text}`);
  const location = new URL(res.headers.location);
  assert.equal(location.searchParams.get('state'), 'opaque-state', 'state must round-trip');

  const code = location.searchParams.get('code');
  assert.ok(code, 'redirect must carry an authorization code');
  return code;
}

/** The approval page's query, with a fresh challenge. */
const pageQuery = (challenge) => ({
  response_type: 'code',
  client_id: 'claude.ai',
  redirect_uri: REDIRECT_URI,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state: 'opaque-state',
});

describe('GET /.well-known/oauth-authorization-server', () => {
  test('advertises the S256 PKCE method', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(res.body.response_types_supported, ['code']);
    assert.deepEqual(res.body.grant_types_supported, ['authorization_code']);
    assert.match(res.body.token_endpoint, /\/oauth\/token$/);
  });
});

describe('POST /authorize', () => {
  test('a live login session binds the MCP identity and gets a code', async () => {
    const t = await tenant('approves');
    await setMcpUser(null);

    const code = await issueCode(pkcePair().challenge, t.agent);

    assert.ok(code, 'an approval by a signed-in user must issue a code');
    assert.equal(await getMcpUser(), t.userId, 'the approval binds the MCP identity to the approving account');
    log('verbose', `MCP identity after the approval: ${await getMcpUser()} (expected ${t.userId})`);
  });

  test('a session revoked by POST /auth/sessions/revoke-all cannot approve, and is ended', async () => {
    const owner = await tenant('revokes');
    const lost = await signIn(owner, 'the device left behind');
    // The identity an earlier, legitimate approval left behind: the thing a
    // revoked session must not be able to re-point *or* ride.
    const bystander = await tenant('bystander');
    await setMcpUser(bystander.userId);

    // The lost device can approve right up to the revocation.
    assert.equal(called('GET /entities (the lost device, before)', await lost.agent.get('/entities')).status, 200);

    const revoke = called('POST /auth/sessions/revoke-all', await owner.agent
      .post('/auth/sessions/revoke-all')
      .send({ password: PASSWORD }));
    assert.equal(revoke.status, 200, `revocation failed: ${revoke.status} ${JSON.stringify(revoke.body)}`);
    log('light', `user ${owner.userId}: every session issued before ${revoke.body.revokedAt} is revoked (source: POST /auth/sessions/revoke-all)`);

    const res = called('POST /authorize (the revoked device)', await lost.agent
      .post('/authorize')
      .type('form')
      .send({ redirect_uri: REDIRECT_URI, code_challenge: pkcePair().challenge, state: 'opaque-state' }));

    assert.equal(res.status, 401, 'a revoked session must not be able to approve the connector');
    assert.equal(res.headers.location, undefined, 'and must be given no authorization code');
    assert.equal(await getMcpUser(), bystander.userId, 'the MCP identity must be exactly as it was');
    assert.equal(await storedSession(lost.sid), null, 'the revoked session must be gone from the store, not merely refused');

    // The device that asked for the revocation still approves.
    assert.ok(await issueCode(pkcePair().challenge, owner.agent), 'the session that revoked must still be able to approve');
    assert.equal(await getMcpUser(), owner.userId);
  });

  test('an anonymous caller is refused and issued no code', async () => {
    const t = await tenant('anonymous-bystander');
    await setMcpUser(t.userId);

    const res = called('POST /authorize (no session)', await request(app)
      .post('/authorize')
      .type('form')
      .send({ redirect_uri: REDIRECT_URI, code_challenge: pkcePair().challenge, state: 'opaque-state' }));

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Unauthorized');
    assert.equal(res.headers.location, undefined, 'no code may be issued to a caller with no session');
    assert.equal(await getMcpUser(), t.userId, 'and nothing may be re-pointed');
  });

  test('a bearer token is not enough: a connector cannot re-point the identity it acts as', async () => {
    const t = await tenant('bearer-bystander');
    await setMcpUser(t.userId);
    process.env.BEARER_TOKEN = 'test-rest-bearer-token';

    try {
      for (const [what, token] of [['the REST token', 'test-rest-bearer-token'], ['the MCP token', 'test-mcp-bearer-token']]) {
        const res = called(`POST /authorize (${what})`, await request(app)
          .post('/authorize')
          .type('form')
          .set('Authorization', `Bearer ${token}`)
          .send({ redirect_uri: REDIRECT_URI, code_challenge: pkcePair().challenge }));

        assert.equal(res.status, 401, `${what} must not approve a connector`);
        assert.equal(res.headers.location, undefined);
      }
    } finally {
      delete process.env.BEARER_TOKEN;
    }

    assert.equal(await getMcpUser(), t.userId, 'the MCP identity must be exactly as it was');
  });

  test('a malformed approval is a 400 that re-points nothing', async () => {
    const t = await tenant('malformed');
    const bystander = await tenant('malformed-bystander');
    await setMcpUser(bystander.userId);

    const res = called('POST /authorize (no code_challenge)', await t.agent
      .post('/authorize')
      .type('form')
      .send({ redirect_uri: REDIRECT_URI }));

    assert.equal(res.status, 400);
    assert.equal(await getMcpUser(), bystander.userId, 'an approval that could not be completed must bind nothing');
  });
});

describe('GET /authorize', () => {
  test('offers the Allow button to a signed-in user', async () => {
    const t = await tenant('page');

    const res = called('GET /authorize (signed in)', await t.agent.get('/authorize').query(pageQuery(pkcePair().challenge)));

    assert.equal(res.status, 200);
    assert.match(res.text, /<form method="POST" action="\/authorize">/);
    assert.match(res.text, /name="code_challenge"/);
  });

  test('tells an unauthenticated visitor to sign in instead of offering a button that 401s', async () => {
    const res = called('GET /authorize (no session)', await request(app).get('/authorize').query(pageQuery(pkcePair().challenge)));

    assert.equal(res.status, 200, 'the page itself grants nothing, so it is not a refusal');
    assert.doesNotMatch(res.text, /<form/, 'no form: posting it could only be a 401');
    assert.match(res.text, /Sign in to Kol Emet/);
  });

  test('still refuses a request that is not an S256 code flow', async () => {
    const { challenge } = pkcePair();

    const bad = await request(app).get('/authorize').query({ ...pageQuery(challenge), response_type: 'token' });
    assert.equal(bad.status, 400);

    const plain = await request(app).get('/authorize').query({ ...pageQuery(challenge), code_challenge_method: 'plain' });
    assert.equal(plain.status, 400);
  });
});

describe('POST /oauth/token', () => {
  test('rejects a code redeemed with the wrong verifier', async () => {
    const t = await tenant('pkce-mismatch');
    const { challenge } = pkcePair();
    const code = await issueCode(challenge, t.agent);

    const res = called('POST /oauth/token (wrong verifier)', await request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, code_verifier: pkcePair().verifier }));

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_grant');
    assert.equal(res.body.detail, 'pkce mismatch');
    assert.equal(res.body.access_token, undefined, 'no token may leak on a failed exchange');
  });

  test('rejects an unsupported grant type', async () => {
    const res = called('POST /oauth/token (client_credentials)', await request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'client_credentials' }));

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'unsupported_grant_type');
  });

  test('issues a token once and refuses to replay a consumed code', async () => {
    const t = await tenant('replay');
    const { verifier, challenge } = pkcePair();
    const code = await issueCode(challenge, t.agent);

    const exchange = () => request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, code_verifier: verifier });

    const first = called('POST /oauth/token (first)', await exchange());
    assert.equal(first.status, 200);
    assert.equal(first.body.access_token, 'test-mcp-bearer-token');
    assert.equal(first.body.token_type, 'Bearer');

    const replay = called('POST /oauth/token (replay)', await exchange());
    assert.equal(replay.status, 400, 'a consumed code must not be redeemable twice');
    assert.equal(replay.body.error, 'invalid_grant');
    assert.equal(replay.body.access_token, undefined);
  });
});

describe('requireAuth', () => {
  test('rejects GET /entities with no session and no bearer token', async () => {
    const res = await request(app).get('/entities');

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Unauthorized');
  });

  test('rejects GET /entities with a bearer token that is not the configured one', async () => {
    const res = await request(app)
      .get('/entities')
      .set('Authorization', 'Bearer not-the-configured-token');

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Unauthorized');
  });
});
