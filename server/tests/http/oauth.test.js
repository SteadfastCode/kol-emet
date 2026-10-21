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
 *   - The router's log holds no credential, and the pending-code map is bounded
 *     (KOL-088 — see the group at the bottom of this file).
 *
 * Falsification checks: drop `requireLoginSession` from `POST /authorize` and
 * the anonymous, bearer and revoked cases all fail; read `req.session.userId`
 * instead of `req.loginUserId` and the revoked case fails; set the MCP user
 * before the missing-parameter check and the malformed-approval case fails;
 * render the Allow form unconditionally and the page case fails; print
 * `req.body` or `[...authCodes.keys()]` anywhere in the router and the
 * redaction group fails; drop the issue-time sweep and the expiry case fails.
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
import { createHash, randomBytes, randomUUID } from 'node:crypto';

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
// Quiet by default; the KOL-088 group raises it per capture and puts it back.
process.env.OAUTH_LOG_LEVEL ??= 'off';

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

/**
 * Runs `fn` with `OAUTH_LOG_LEVEL` at `level` and both console streams
 * collected rather than printed.
 *
 * Both streams, not just `console.log`: a value the router never meant to print
 * could also reach the log through the error handler, which writes the error
 * itself to `console.error` — so a suite that captured one stream could watch
 * the secret leave by the other.
 */
async function capturingLog(level, fn) {
  const lines = [];
  const realLog = console.log;
  const realError = console.error;
  const realLevel = process.env.OAUTH_LOG_LEVEL;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  process.env.OAUTH_LOG_LEVEL = level;
  try {
    const result = await fn();
    return { result, lines, text: lines.join('\n') };
  } finally {
    console.log = realLog;
    console.error = realError;
    if (realLevel === undefined) delete process.env.OAUTH_LOG_LEVEL;
    else process.env.OAUTH_LOG_LEVEL = realLevel;
  }
}

/** The fingerprint the router logs in place of a code: first 8 hex of SHA-256. */
const sha8 = (value) => createHash('sha256').update(value).digest('hex').slice(0, 8);

/**
 * Runs `fn` with `Date.now` moved `ms` into the future.
 *
 * The code lifetime is five minutes and nothing exports it, so a test about
 * expiry has to move the clock; `node --test` runs a file's tests one at a
 * time, so nothing else is reading the clock while this is in force.
 */
async function atClockOffset(ms, fn) {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/** Comfortably past the router's five-minute code lifetime. */
const PAST_CODE_TTL_MS = 6 * 60 * 1000;

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

/**
 * ─── KOL-088: the log is not a credential store, and the map is bounded ─────
 *
 * Every line this router used to print came from dumping a whole request:
 * `POST /oauth/token` logged its form body (the one-time `code` and the
 * `code_verifier`, which is the PKCE secret), a miss logged the submitted code
 * plus `[...authCodes.keys()]` — every code outstanding, for every user — and
 * the PKCE check logged the computed and the stored challenge. Each of those
 * codes redeems for `MCP_BEARER_TOKEN`, the workspace-wide write token, so the
 * log was a list of credentials and on a hosted box the log is the deploy
 * console.
 *
 * So these tests read what was *printed*, at the loudest tier, and assert what
 * is absent. The fingerprint is what has to be present instead: two lines that
 * can be tied to one exchange without either being redeemable.
 *
 * Second defect, same file: `expiresAt` was read only at redemption, so a code
 * nobody redeemed stayed for the life of the process. The expiry case asserts
 * the sweep through the *refusal it changes* — a swept code is "code not
 * found", a merely-expired one is "code expired" — rather than through an
 * exported internal, which would pass just as well with no sweep at all.
 */
describe('OAuth logging and the pending-code map (KOL-088)', () => {
  test('a full exchange at the loudest tier prints no code, no verifier and no challenge', async () => {
    // Registered outside the capture, so only the exchange's own lines are read.
    const t = await tenant('redaction');
    const { verifier, challenge } = pkcePair();

    const { result, text } = await capturingLog('verbose', async () => {
      const code = await issueCode(challenge, t.agent);
      const res = await request(app)
        .post('/oauth/token')
        .type('form')
        .send({ grant_type: 'authorization_code', code, code_verifier: verifier });
      return { code, res };
    });

    // The protocol first: a redaction that broke the exchange would "pass".
    assert.equal(result.res.status, 200, `the happy path must still issue a token: ${result.res.text}`);
    assert.equal(result.res.body.access_token, 'test-mcp-bearer-token');
    assert.equal(result.res.body.token_type, 'Bearer');

    assert.ok(!text.includes(result.code), `the one-time code must not be logged: ${text}`);
    assert.ok(!text.includes(verifier), `the PKCE verifier must not be logged: ${text}`);
    assert.ok(!text.includes(challenge), `the challenge it hashes to must not be logged: ${text}`);
    assert.ok(!text.includes('opaque-state'), `nor the client's state: ${text}`);

    // What ties the two lines together instead.
    const print = sha8(result.code);
    const tied = text.split('\n').filter(line => line.includes(print));
    assert.ok(tied.length >= 2, `the issue and the redemption must share one fingerprint: ${text}`);
    assert.match(text, /issued code [0-9a-f]{8}, \d+ outstanding/);
    assert.match(text, /redeemed code [0-9a-f]{8} → token issued/);
    assert.match(text, /audience: mcp/, 'and the line must name the rule that chose the token');
    log('verbose', `exchange logged under fingerprint ${print} across ${tied.length} lines`);
  });

  test('OAUTH_LOG_LEVEL=off prints nothing at all', async () => {
    const t = await tenant('silent');
    const { verifier, challenge } = pkcePair();

    const { result, text } = await capturingLog('off', async () => {
      const code = await issueCode(challenge, t.agent);
      return await request(app)
        .post('/oauth/token')
        .type('form')
        .send({ grant_type: 'authorization_code', code, code_verifier: verifier });
    });

    assert.equal(result.status, 200);
    assert.ok(!text.includes('[oauth:'), `off must print no router line: ${text}`);
  });

  test('a miss does not print the codes that are still outstanding', async () => {
    const t = await tenant('pending-bystander');
    // Issued and deliberately left unredeemed: what the old key dump published.
    const pending = await issueCode(pkcePair().challenge, t.agent);

    const { result, text } = await capturingLog('verbose', () => request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code: randomUUID(), code_verifier: pkcePair().verifier }));

    assert.equal(result.status, 400);
    assert.equal(result.body.detail, 'code not found');
    assert.ok(!text.includes(pending), `a miss must not print a live code: ${text}`);
    assert.ok(!text.includes(sha8(pending)), `nor the fingerprint of one: ${text}`);
    assert.match(
      text,
      /refused code [0-9a-f]{8}: no such code \(source: the pending map, \d+ outstanding\)/,
      `the count is what replaces the key dump, and the rule has to be named: ${text}`,
    );
  });

  test('a wrong verifier names the rule it broke and prints neither challenge', async () => {
    const t = await tenant('mismatch-log');
    const { challenge } = pkcePair();
    const wrong = pkcePair();
    const code = await issueCode(challenge, t.agent);

    const { result, text } = await capturingLog('verbose', () => request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, code_verifier: wrong.verifier }));

    assert.equal(result.status, 400);
    assert.equal(result.body.detail, 'pkce mismatch');
    assert.ok(!text.includes(code), `the code must not be logged: ${text}`);
    assert.ok(!text.includes(wrong.verifier), `nor the verifier that was sent: ${text}`);
    assert.ok(!text.includes(challenge), `nor the stored challenge: ${text}`);
    assert.ok(!text.includes(wrong.challenge), `nor the one just computed from the verifier: ${text}`);
    assert.match(
      text,
      /does not hash to the stored challenge \(source: the S256 PKCE check\)/,
      `the refusal has to name its rule: ${text}`,
    );
  });

  test('an unsupported grant type is refused by name, with the code only as a fingerprint', async () => {
    const { result, text } = await capturingLog('verbose', () => request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'client_credentials', code: 'not-a-real-code' }));

    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'unsupported_grant_type');
    assert.ok(!text.includes('not-a-real-code'), `even a bogus code is logged as a fingerprint: ${text}`);
    assert.match(text, /grant_type must be authorization_code \(source: the form body, which sent client_credentials\)/);
  });

  test('an expired code nothing has swept is refused as expired', async () => {
    const t = await tenant('expired');
    const { verifier, challenge } = pkcePair();
    const code = await issueCode(challenge, t.agent);

    // POST /oauth/token touches no database, so this is the clock moving and
    // nothing else. The control for the sweep case below.
    const res = await atClockOffset(PAST_CODE_TTL_MS, () => request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, code_verifier: verifier }));

    assert.equal(res.status, 400);
    assert.equal(res.body.detail, 'code expired', 'still in the map, just too old');
  });

  test('issuing a code sweeps the ones whose five minutes are up', async () => {
    const t = await tenant('sweep');
    const { verifier, challenge } = pkcePair();
    const stale = await issueCode(challenge, t.agent);

    // The next approval, five minutes later, is what runs the sweep.
    const { text } = await capturingLog('normal', () => atClockOffset(
      PAST_CODE_TTL_MS,
      () => issueCode(pkcePair().challenge, t.agent),
    ));
    assert.match(text, /dropped \d+ expired code\(s\).*source: the issue-time sweep/, `the sweep has to say it ran: ${text}`);

    const res = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code: stale, code_verifier: verifier });

    assert.equal(res.status, 400);
    assert.equal(
      res.body.detail,
      'code not found',
      'the sweep must have removed it — "code expired" would mean it was still in the map',
    );
  });

  test('an approval past the pending-code ceiling is a 503 that binds nothing', async () => {
    const t = await tenant('ceiling');
    const bystander = await tenant('ceiling-bystander');

    // How many are outstanding right now, read off the issue line rather than
    // an exported internal: the tests above left codes in the map on purpose.
    const { text } = await capturingLog('normal', () => issueCode(pkcePair().challenge, t.agent));
    const outstanding = text.match(/issued code [0-9a-f]{8}, (\d+) outstanding/);
    assert.ok(outstanding, `the issue line has to report the count: ${text}`);

    // After that approval, not before — it binds the identity itself.
    await setMcpUser(bystander.userId);

    // The ceiling set to exactly what is already there: the next one is over it.
    process.env.OAUTH_MAX_PENDING_CODES = outstanding[1];
    try {
      const res = called('POST /authorize (at the ceiling)', await t.agent
        .post('/authorize')
        .type('form')
        .send({ redirect_uri: REDIRECT_URI, code_challenge: pkcePair().challenge, state: 'opaque-state' }));

      assert.equal(res.status, 503, 'a full map is a server condition, not a bad request');
      assert.equal(res.headers.location, undefined, 'and no code may be issued');
      assert.equal(
        await getMcpUser(),
        bystander.userId,
        'the refusal is ahead of the identity write, so an approval that cannot complete binds nothing',
      );
    } finally {
      delete process.env.OAUTH_MAX_PENDING_CODES;
    }

    // And the ceiling lifted, approvals work again.
    assert.ok(await issueCode(pkcePair().challenge, t.agent));
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
