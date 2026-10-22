/**
 * HTTP tests for POST /auth/sessions/revoke-all and the session stamp it is
 * measured against.
 *
 * KOL-076: a session is a row in the session store keyed by its own id, and the
 * store cannot be searched *by user* — the Decision Log records that as the
 * reason a deleted account's other sessions outlive it. The consequence for a
 * public product was worse than that: `POST /auth/logout` destroys only the
 * session it is called from, so a session left on a borrowed laptop, or one on
 * a stolen phone, could not be ended by its owner at all. This file defends the
 * mechanism that ends them — an `issuedAt` stamped into every session at
 * sign-in, a `credentialsChangedAt` on the account, and one comparison in
 * `requireAuth` and `requireActor`.
 *
 * What each test defends:
 *   - Two agents signed in as one user: a revocation from the first ends the
 *     second. Its next `GET /entities` is 401, its session is **gone from the
 *     store** and not merely refused, and the first goes on reading `/entities`
 *     and writing through `requireActor`.
 *   - A second user's session is untouched: the bump is per-account.
 *   - A wrong password is 403 — not 401, the session is still good — and bumps
 *     nothing: the other agent stays signed in.
 *   - A passkey assertion confirms one too, against a challenge under this
 *     route's own session key, and cannot be replayed.
 *   - Unauthenticated is 401; the MCP bearer token is 403 at the route (a
 *     connector does not sign an account's devices out) and, carrying no
 *     session of its own, **goes on working** through `requireAuth` and
 *     `requireActor` after a revocation.
 *   - A session issued *after* the bump is accepted — the check is a
 *     comparison, not a flag that locks an account out.
 *   - An account with no `credentialsChangedAt` at all (registered before
 *     KOL-076) keeps its sessions: absence means nothing was ever revoked.
 *   - A session with no `issuedAt` (issued before KOL-076) is ended by a
 *     revocation, because it cannot be shown to postdate one.
 *   - Repeated wrong passwords are throttled on the account's own counter —
 *     the one the deletion and password-change confirmations share.
 *   - The other devices' live `/events` streams are closed at once, with the
 *     `session-ended` frame, and the calling browser's are **left open and
 *     still receiving broadcasts** (KOL-112): that frame is final to the
 *     client, so sending it to the one session this route keeps signed in left
 *     that tab blind for the rest of its life.
 *
 * Not here, but part of the same mechanism: the two OAuth approval forms, which
 * read `req.session.userId` themselves until KOL-098 put them behind
 * `requireLoginSession` — a revoked session could mint a connector grant and
 * get its workspace back through `/mcp`. Those refusals are driven where the
 * routes live, in `tests/http/oauth.test.js` and `tests/http/bridge.test.js`.
 *
 * Falsification checks: drop the comparison in `requireAuth` and the revoked
 * agent reads `/entities`; drop it in `requireActor` and it still writes; stamp
 * only `/login` and the registration-session case survives a revocation it
 * should not; make the comparison `<=` and the calling agent signs itself out;
 * treat a missing `credentialsChangedAt` as zero and the legacy-account case
 * fails; treat a missing `issuedAt` as valid and the legacy-session case fails;
 * bump before re-stamping and the caller is signed out when the store write
 * fails; use `requireAuth` instead of the bearer guard and the connector signs
 * every device out; drop the `exceptSessionId` the route passes
 * `closeStreamsForUser` and the calling browser loses its live stream.
 *
 * Real stack throughout — createApp() over supertest, real registration
 * (bcrypt, Workspace, seedWorkspace), real mongod, a real `@simplewebauthn`
 * assertion — for the reasons at the top of tests/http/auth.test.js. The
 * session store is a MemoryStore this file holds, so a test can ask it what it
 * still has: the difference between a session destroyed and a cookie cleared.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_SESSION_REVOKE_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per account created or revoked, naming what did it
 *   normal  — light, plus every call made here and what it answered
 *   verbose — normal, plus the stamps either side of a revocation, which is how
 *             "this one stayed signed in" is read
 * The routes log on SESSION_REVOKE_LOG_LEVEL, silenced here unless set.
 */

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import session from 'express-session';
import request from 'supertest';

// Every session write is checked against CLIENT_ORIGIN (src/middleware/originGuard.js),
// so this suite names one below and its agents send a matching Origin.
import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';

import * as db from '../helpers/db.js';
// Registration is throttled per client address, and this suite registers its
// fixtures through the real endpoint from one address. See the helper.
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import { createSoftAuthenticator } from '../helpers/softAuthenticator.js';
import User from '../../src/models/User.js';
import { setMcpUser } from '../../src/lib/mcpUserStore.js';
// Live /events streams are registered straight on the broadcaster rather than
// over a socket: an SSE response is never finished, so supertest would hang
// waiting for one. See liveStream() below.
import { addClient, removeClient, broadcast } from '../../src/lib/broadcaster.js';

// createApp() reads NODE_ENV when called, and src/routes/auth.js reads the
// relying party at module load, so all of it is set before src/app.js is
// imported below. Not 'production': that arms secure/domain-scoped cookies
// supertest won't return. The relying party is set outright, not defaulted,
// because the software authenticator signs for exactly this origin.
const ORIGIN = 'http://localhost:5173';
const RP_ID = 'localhost';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
// Unset so every request here is a session request; the tests about the bearer
// token set it for themselves and remove it again.
delete process.env.BEARER_TOKEN;
process.env.WEBAUTHN_RP_ID = RP_ID;
process.env.WEBAUTHN_ORIGIN = ORIGIN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.SESSION_REVOKE_LOG_LEVEL ??= 'off';
process.env.PASSKEY_LOG_LEVEL ??= 'off';
process.env.AUTH_LIMIT_LOG_LEVEL ??= 'off';
process.env.SESSION_COOKIE_LOG_LEVEL ??= 'off';
process.env.EVENTS_LOG_LEVEL ??= 'off';
process.env.SSE_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_SESSION_REVOKE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/sessionRevocation:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

/**
 * Failed re-authentications allowed per account per window. Small on purpose,
 * so the throttle test does not have to spend ten bcrypt compares; every other
 * test here registers its own account, and the counter is keyed by the account,
 * so no test can reach another's budget.
 */
const PER_USER = 3;

let app;
let sessionStore;

let emailCounter = 0;
function uniqueEmail(label) {
  emailCounter += 1;
  return `${label}-${emailCounter}@example.test`;
}

/** Logs a call and its answer at the 'normal' tier. */
function called(what, res) {
  log('normal', `${what} → ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

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

/** Writes `patch` straight into the store for `sid` — how a pre-KOL-076 session is staged. */
function writeStoredSession(sid, patch) {
  return new Promise((resolve, reject) => {
    sessionStore.get(sid, (err, stored) => {
      if (err || !stored) return reject(err ?? new Error(`no session ${sid} in the store`));
      sessionStore.set(sid, { ...stored, ...patch }, (setErr) => (setErr ? reject(setErr) : resolve()));
    });
  });
}

const device = (opts) => createSoftAuthenticator({ origin: ORIGIN, ...opts });

/** An account registered through the real endpoint, signed in on its own agent. */
async function tenant(label) {
  const email = uniqueEmail(label);
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  const user = await User.findOne({ email }).select('_id').lean();
  const cookie = sessionCookie(res);
  log('light', `registered ${email} (source: POST /auth/register) → user ${user._id}, session ${sessionId(cookie)}`);
  return { email, agent, userId: String(user._id), cookie, sid: sessionId(cookie) };
}

/** A second (third, …) session on an existing account, through the real sign-in. */
async function signIn(t, label) {
  const agent = originAgent(app);
  const res = called(`POST /auth/login (${t.email}, ${label})`, await agent.post('/auth/login').send({ email: t.email, password: PASSWORD }));
  assert.equal(res.status, 200, `POST /auth/login (${t.email}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = sessionCookie(res);
  const sid = sessionId(cookie);
  log('light', `signed ${t.email} in a second time (source: POST /auth/login) → session ${sid}`);
  return { agent, cookie, sid, email: t.email, userId: t.userId };
}

/** The account's revocation timestamp, as the collection holds it. */
async function revokedAt(userId) {
  const user = await User.findById(userId).select('credentialsChangedAt').lean();
  log('verbose', `user ${userId}: credentialsChangedAt ${user?.credentialsChangedAt?.toISOString() ?? '(unset)'}`);
  return user?.credentialsChangedAt ?? null;
}

/** The `issuedAt` the store holds for a session, as a number, or null. */
async function issuedAt(sid) {
  const stored = await storedSession(sid);
  log('verbose', `session ${sid}: issuedAt ${stored?.issuedAt ?? '(unstamped)'}`);
  return stored ? Number(stored.issuedAt) : null;
}

/** Adds `authenticator`'s passkey to `t` through the real ceremony. */
async function addPasskey(t, authenticator) {
  const begin = called('POST /auth/webauthn/register/begin', await t.agent.post('/auth/webauthn/register/begin'));
  assert.equal(begin.status, 200);
  const complete = called('POST /auth/webauthn/register/complete', await t.agent
    .post('/auth/webauthn/register/complete')
    .send(authenticator.register(begin.body)));
  assert.equal(complete.status, 200, `passkey registration failed: ${complete.status} ${JSON.stringify(complete.body)}`);
}

/** Client ids registered straight on the broadcaster, cleared after each test. */
const liveStreams = [];

/**
 * A live `GET /events` stream for `session`, registered the way the route
 * registers one.
 *
 * Not opened over HTTP: an SSE response is deliberately never finished, so a
 * supertest request for one does not resolve. What this suite needs to see is
 * which streams a revocation closes, and that is decided by the `{userId,
 * sessionId}` pair the route stored — which is exactly what is handed over
 * here, with a fake `res` standing in for the held socket.
 */
function liveStream(clientId, session, workspaceId) {
  const res = { chunks: [], ended: false };
  res.write = (chunk) => { res.chunks.push(chunk); return true; };
  res.end = () => { res.ended = true; };
  const added = addClient(clientId, res, workspaceId, { userId: session.userId, sessionId: session.sid });
  assert.equal(added.accepted, true, `the broadcaster refused the ${clientId} fixture`);
  liveStreams.push(clientId);
  log('normal', `opened a live /events stream (${clientId}) for session ${session.sid}`);
  return res;
}

/** The `event: <name>` frames a fake stream received, parsed. */
const streamFrames = (res) => res.chunks.map((chunk) => ({
  event: chunk.match(/^event: (.*)$/m)?.[1] ?? 'ping',
  data: chunk.startsWith('event:') ? JSON.parse(chunk.match(/^data: (.*)$/m)[1]) : null,
}));

before(async () => {
  await db.connect();
  // Held, not just passed: the tests below ask the store what it still has,
  // which is the difference between a session destroyed and one merely refused.
  sessionStore = new session.MemoryStore();
  app = createApp({ sessionStore, authLimits: { ...SUITE_AUTH_LIMITS, perUser: PER_USER } });
});

afterEach(() => {
  // The broadcaster's client map is module-level state; a fixture left in it
  // would count against the next test's per-user stream cap.
  for (const clientId of liveStreams.splice(0)) removeClient(clientId, 'the test that opened it ended');
});

after(async () => { await db.disconnect(); });

describe('POST /auth/sessions/revoke-all', () => {
  test('ends the account’s other sessions, keeps the one that asked, and leaves another account alone', async () => {
    const t = await tenant('revokes');
    const other = await signIn(t, 'the device left behind');
    const bystander = await tenant('bystander');

    // Both sessions work before the revocation, and both are stamped.
    assert.equal((await t.agent.get('/entities')).status, 200);
    assert.equal((await other.agent.get('/entities')).status, 200);
    assert.ok(Number.isFinite(await issuedAt(t.sid)), 'a registration session must be stamped');
    assert.ok(Number.isFinite(await issuedAt(other.sid)), 'a sign-in session must be stamped');

    const res = called('POST /auth/sessions/revoke-all (right password)', await t.agent
      .post('/auth/sessions/revoke-all')
      .send({ password: PASSWORD }));

    assert.equal(res.status, 200, `revocation failed: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.ok, true);
    const bumped = await revokedAt(t.userId);
    assert.equal(res.body.revokedAt, bumped.toISOString(), 'the route reports the moment it wrote');
    log('light', `user ${t.userId}: revoked everything issued before ${bumped.toISOString()} (source: POST /auth/sessions/revoke-all)`);

    // The other device: refused, and its session is *gone from the store* —
    // the thing POST /auth/logout could only do for the caller's own.
    const refused = called('GET /entities (the other device)', await other.agent.get('/entities'));
    assert.equal(refused.status, 401, `expected 401, got ${refused.status} ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error, 'Unauthorized');
    assert.equal(await storedSession(other.sid), null, 'the revoked session must be destroyed, not merely refused');
    // And refused at the write guard too, which looks the account up itself.
    const write = called('POST /entities (the other device)', await other.agent
      .post('/entities').send({ title: 'From the lost phone', category: 'Worlds', summary: 'nope' }));
    assert.equal(write.status, 401, 'requireActor must refuse it as well');

    // The device that asked: still reading, still writing, and its stamp is the
    // very moment the account was bumped.
    assert.equal(called('GET /entities (the caller)', await t.agent.get('/entities')).status, 200,
      'the device that asked must stay signed in');
    const mine = called('POST /entities (the caller)', await t.agent
      .post('/entities').send({ title: 'Still here', category: 'Worlds', summary: 'fixture' }));
    assert.equal(mine.status, 201, `the caller must still write: ${JSON.stringify(mine.body)}`);
    assert.equal(await issuedAt(t.sid), bumped.getTime(), 'the calling session is re-stamped to the bump itself');

    // Another account's session is untouched: the bump is per-account.
    assert.equal((await bystander.agent.get('/entities')).status, 200, 'a second account must be unaffected');
    assert.notEqual(await revokedAt(bystander.userId), null);
    assert.ok((await revokedAt(bystander.userId)).getTime() < bumped.getTime(),
      'and its own timestamp must be the one registration set, not this bump');
  });

  test('a session signed in after the revocation is accepted', async () => {
    const t = await tenant('signs-back-in');
    const old = await signIn(t, 'before the revocation');

    assert.equal((await t.agent.post('/auth/sessions/revoke-all').send({ password: PASSWORD })).status, 200);
    assert.equal((await old.agent.get('/entities')).status, 401, 'the session from before is over');

    // The same device, signing in again: the check is a comparison, not a flag
    // that locks the account out.
    const fresh = await signIn(t, 'after the revocation');
    assert.equal(called('GET /entities (signed in afresh)', await fresh.agent.get('/entities')).status, 200);
    assert.ok((await issuedAt(fresh.sid)) >= (await revokedAt(t.userId)).getTime(),
      'its stamp must postdate the revocation');

    // Including a passkey sign-in, which is the third door that stamps.
    const authenticator = device({ synced: false });
    await addPasskey(t, authenticator);
    const begin = called('POST /auth/webauthn/login/begin', await request(app)
      .post('/auth/webauthn/login/begin').send({ email: t.email }));
    assert.equal(begin.status, 200);
    const passkeyAgent = originAgent(app);
    // The challenge has to be issued to the agent that completes it.
    const own = called('POST /auth/webauthn/login/begin (own agent)', await passkeyAgent
      .post('/auth/webauthn/login/begin').send({ email: t.email }));
    assert.equal(own.status, 200);
    const complete = called('POST /auth/webauthn/login/complete', await passkeyAgent
      .post('/auth/webauthn/login/complete').send(authenticator.assert(own.body)));
    assert.equal(complete.status, 200, `passkey sign-in failed: ${JSON.stringify(complete.body)}`);
    assert.equal(called('GET /entities (passkey session)', await passkeyAgent.get('/entities')).status, 200,
      'a passkey sign-in must be stamped too, or it is refused at once');
  });

  test('a passkey assertion confirms a revocation, and cannot be replayed', async () => {
    const t = await tenant('passkey-revokes');
    const authenticator = device({ synced: false });
    await addPasskey(t, authenticator);
    const other = await signIn(t, 'the device left behind');

    const challenge = called('POST /auth/sessions/passkey-challenge', await t.agent.post('/auth/sessions/passkey-challenge'));
    assert.equal(challenge.status, 200, `challenge failed: ${challenge.status} ${JSON.stringify(challenge.body)}`);
    assert.deepEqual(challenge.body.allowCredentials.map(c => c.id), [authenticator.id],
      'the challenge must offer the id the browser knows');

    const res = called('POST /auth/sessions/revoke-all (passkey)', await t.agent
      .post('/auth/sessions/revoke-all')
      .send({ passkey: authenticator.assert(challenge.body) }));
    assert.equal(res.status, 200, `revocation failed: ${res.status} ${JSON.stringify(res.body)}`);

    assert.equal((await other.agent.get('/entities')).status, 401, 'the other session is over');
    assert.equal((await t.agent.get('/entities')).status, 200, 'the caller stays signed in');
    const first = await revokedAt(t.userId);

    // One challenge buys one try, and the key is this route's own.
    const replay = called('POST /auth/sessions/revoke-all (replayed assertion)', await t.agent
      .post('/auth/sessions/revoke-all')
      .send({ passkey: authenticator.assert({ challenge: challenge.body.challenge, rpId: RP_ID }) }));
    assert.equal(replay.status, 403, 'a spent challenge must not confirm a second revocation');
    assert.equal((await revokedAt(t.userId)).getTime(), first.getTime(), 'and must bump nothing');

    // An assertion-shaped body with no challenge behind it is the same 403.
    const unchallenged = called('POST /auth/sessions/revoke-all (passkey, no challenge)', await t.agent
      .post('/auth/sessions/revoke-all')
      .send({ passkey: { id: 'nope', rawId: 'nope', type: 'public-key', response: {}, clientExtensionResults: {} } }));
    assert.equal(unchallenged.status, 403);
    assert.equal(unchallenged.body.error, 'Passkey confirmation failed');
  });

  test('a wrong password is 403 and revokes nothing', async () => {
    const t = await tenant('wrong-password');
    const other = await signIn(t, 'the device that stays');
    const before = await revokedAt(t.userId);
    const stamp = await issuedAt(other.sid);

    const res = called('POST /auth/sessions/revoke-all (wrong password)', await t.agent
      .post('/auth/sessions/revoke-all')
      .send({ password: 'incorrect-horse-battery-staple' }));

    // 403 and not 401: the session is fine, the re-authentication was not, and
    // a 401 from *this* route would be a particularly confusing answer.
    assert.equal(res.status, 403, `expected 403, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'Incorrect password');
    assert.equal((await revokedAt(t.userId))?.getTime(), before?.getTime(), 'a refusal must bump nothing');
    assert.equal(await issuedAt(other.sid), stamp, 'and must re-stamp nothing');
    assert.equal(called('GET /entities (the other device, after a refusal)', await other.agent.get('/entities')).status, 200,
      'the other session must still work');
    assert.equal((await t.agent.get('/auth/me')).status, 200, 'and the caller must stay signed in');

    // Neither credential offered is a 400, and bumps nothing either.
    for (const [what, body] of [
      ['neither credential', {}],
      ['an empty password', { password: '' }],
      ['a non-string password', { password: { $ne: '' } }],
      ['a null passkey', { password: null, passkey: null }],
    ]) {
      const bad = called(`POST /auth/sessions/revoke-all (${what})`, await t.agent
        .post('/auth/sessions/revoke-all').send(body));
      assert.equal(bad.status, 400, `${what}: expected 400, got ${bad.status} ${JSON.stringify(bad.body)}`);
      assert.equal((await revokedAt(t.userId))?.getTime(), before?.getTime(), `${what}: nothing may be revoked`);
    }
  });

  test('repeated wrong passwords are throttled on the account, before the compare', async () => {
    const t = await tenant('throttled');
    const before = await revokedAt(t.userId);

    for (let attempt = 1; attempt <= PER_USER; attempt++) {
      const res = called(`POST /auth/sessions/revoke-all (wrong, attempt ${attempt})`, await t.agent
        .post('/auth/sessions/revoke-all').send({ password: `guess-number-${attempt}` }));
      assert.equal(res.status, 403, `attempt ${attempt} must be answered normally`);
    }

    const blocked = called('POST /auth/sessions/revoke-all (over the limit)', await t.agent
      .post('/auth/sessions/revoke-all').send({ password: 'one-guess-too-many' }));
    assert.equal(blocked.status, 429, `expected 429, got ${blocked.status} ${JSON.stringify(blocked.body)}`);
    assert.ok(Number(blocked.headers['retry-after']) > 0, 'a 429 must say how long to wait');

    // The throttle is on the credential check, not the route: the *right*
    // password is refused too while the window stands, and nothing is revoked.
    const rightButBlocked = called('POST /auth/sessions/revoke-all (right password, blocked)', await t.agent
      .post('/auth/sessions/revoke-all').send({ password: PASSWORD }));
    assert.equal(rightButBlocked.status, 429);
    assert.equal((await revokedAt(t.userId))?.getTime(), before?.getTime(), 'a throttled attempt must revoke nothing');
  });

  test('without a session it is 401, and the MCP bearer token is 403', async () => {
    const t = await tenant('mcp-token');
    const before = await revokedAt(t.userId);

    const anonymous = called('POST /auth/sessions/revoke-all (anonymous)', await request(app)
      .post('/auth/sessions/revoke-all').send({ password: PASSWORD }));
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error, 'Unauthorized');
    const anonymousChallenge = called('POST /auth/sessions/passkey-challenge (anonymous)', await request(app)
      .post('/auth/sessions/passkey-challenge'));
    assert.equal(anonymousChallenge.status, 401);

    process.env.BEARER_TOKEN = 'test-bearer-token';
    // Authorized as this very account, which is the case worth refusing: the
    // connector holds the user's own identity (requireActor's bearer path) and
    // the right password, and is still 403. An unauthorized connector never
    // reaches the route's own guard — it is 401 at requireActor.
    await setMcpUser(t.userId);
    try {
      const res = called('POST /auth/sessions/revoke-all (bearer token)', await request(app)
        .post('/auth/sessions/revoke-all')
        .set('Authorization', 'Bearer test-bearer-token')
        .send({ password: PASSWORD }));
      assert.equal(res.status, 403, 'signing an account’s devices out is a session-only action');
      assert.equal(res.body.error, 'Signing out everywhere needs a signed-in browser session');
      const challenge = called('POST /auth/sessions/passkey-challenge (bearer token)', await request(app)
        .post('/auth/sessions/passkey-challenge')
        .set('Authorization', 'Bearer test-bearer-token'));
      assert.equal(challenge.status, 403, 'nor may it start a confirmation');
    } finally {
      delete process.env.BEARER_TOKEN;
      await setMcpUser(null);
    }
    assert.equal((await revokedAt(t.userId))?.getTime(), before?.getTime(), 'a refusal must bump nothing');
  });

  test('the MCP bearer token keeps working after a revocation — it carries no session', async () => {
    const t = await tenant('mcp-survives');
    // The connector acts as this user: that is what makes the token's requests
    // reach requireActor's bearer path, and resolveWorkspace's, with a real
    // account behind them.
    await setMcpUser(t.userId);

    process.env.BEARER_TOKEN = 'test-bearer-token';
    try {
      assert.equal((await t.agent.post('/auth/sessions/revoke-all').send({ password: PASSWORD })).status, 200);

      const read = called('GET /entities (bearer token, after a revocation)', await request(app)
        .get('/entities').set('Authorization', 'Bearer test-bearer-token'));
      assert.equal(read.status, 200, 'the connector has no session to revoke, so it reads on');

      const write = called('POST /entities (bearer token, after a revocation)', await request(app)
        .post('/entities')
        .set('Authorization', 'Bearer test-bearer-token')
        .send({ title: 'Written by the connector', category: 'Worlds', summary: 'fixture' }));
      assert.equal(write.status, 201, `and writes on: ${JSON.stringify(write.body)}`);
    } finally {
      delete process.env.BEARER_TOKEN;
      await setMcpUser(null);
    }
  });

  test('closes the other devices’ live /events streams and leaves the caller’s open', async () => {
    // KOL-112. The close frame is `{ error: 'session-ended' }`, which the
    // browser treats as final — it stops reconnecting for the life of the tab
    // and says the account was signed out elsewhere. This route tells the
    // browser it is called from the opposite, and that browser's session is
    // still good, so its stream has to survive the revocation it asked for.
    const t = await tenant('keeps-its-stream');
    const other = await signIn(t, 'the device left behind');
    const workspaceId = 'ws-revoke-streams';
    const caller = liveStream('revoke-caller-tab', t, workspaceId);
    const callerSecondTab = liveStream('revoke-caller-tab-2', t, workspaceId);
    const theirs = liveStream('revoke-other-device-tab', other, workspaceId);

    const res = called('POST /auth/sessions/revoke-all (with streams open)', await t.agent
      .post('/auth/sessions/revoke-all')
      .send({ password: PASSWORD }));
    assert.equal(res.status, 200, `revocation failed: ${res.status} ${JSON.stringify(res.body)}`);

    assert.equal(theirs.ended, true, 'the revoked device kept its live stream');
    assert.deepEqual(streamFrames(theirs).filter(f => f.event === 'error').map(f => f.data),
      [{ error: 'session-ended' }], 'the revoked device was not told why its stream ended');

    assert.equal(caller.ended, false, 'the browser that asked was cut off from live updates');
    assert.equal(callerSecondTab.ended, false, 'a second tab of the calling browser was cut off');
    assert.equal(streamFrames(caller).filter(f => f.event === 'error').length, 0,
      'the calling browser was told its session had ended');

    // Open is not the same as live: the kept streams still receive this
    // workspace's updates, which is what "this browser stays signed in" means
    // for the sidebar.
    broadcast('entity:created', { entity: { _id: 'e1', title: 'After the revocation' } }, { workspaceId });
    for (const [label, stream] of [['the caller', caller], ['its second tab', callerSecondTab]]) {
      assert.equal(streamFrames(stream).filter(f => f.event === 'entity:created').length, 1,
        `${label} stopped receiving live updates`);
    }
    assert.equal(streamFrames(theirs).filter(f => f.event === 'entity:created').length, 0,
      'a closed stream received a broadcast');
    log('light', `user ${t.userId}: the revoked device's stream was closed and the caller's ${caller.chunks.length} frame(s) kept flowing (source: POST /auth/sessions/revoke-all)`);
  });
});

describe('the sessions this check was not written for', () => {
  test('an account with no credentialsChangedAt keeps its sessions — absence is not a revocation', async () => {
    const t = await tenant('legacy-account');
    // What a registration from before KOL-076 left: no timestamp at all. Written
    // straight into the collection, because the model sets one on creation.
    await User.updateOne({ _id: t.userId }, { $unset: { credentialsChangedAt: '' } });
    assert.equal(await revokedAt(t.userId), null);
    log('light', `user ${t.userId}: credentialsChangedAt removed (source: this test, standing in for a pre-KOL-076 registration)`);

    assert.equal(called('GET /entities (legacy account)', await t.agent.get('/entities')).status, 200,
      'an existing user must not be signed out by the deploy that adds this');
    const write = await t.agent.post('/entities').send({ title: 'Legacy write', category: 'Worlds', summary: 'fixture' });
    assert.equal(write.status, 201, 'nor refused at the write guard');

    // And a revocation from such an account works, bumping from nothing to now.
    assert.equal((await t.agent.post('/auth/sessions/revoke-all').send({ password: PASSWORD })).status, 200);
    assert.notEqual(await revokedAt(t.userId), null);
    assert.equal((await t.agent.get('/entities')).status, 200, 'the caller still stays signed in');
  });

  test('a session with no issuedAt is ended by a revocation — it cannot be shown to postdate one', async () => {
    const t = await tenant('legacy-session');
    const other = await signIn(t, 'a session from before the stamp');
    // The whole pre-KOL-076 world, staged: an account with no timestamp and
    // sessions with no stamp, which is what the deploy that adds this will find.
    // Written straight into the collection and the store, because the model sets
    // one on creation now and every sign-in stamps.
    await User.updateOne({ _id: t.userId }, { $unset: { credentialsChangedAt: '' } });
    await writeStoredSession(other.sid, { issuedAt: undefined });
    await writeStoredSession(t.sid, { issuedAt: undefined });
    assert.ok(!Number.isFinite(await issuedAt(other.sid)), 'the fixture must hold an unstamped session');
    log('light', `user ${t.userId} and its two sessions stripped of the stamp and the timestamp (source: this test, standing in for the state a deploy finds)`);

    // Nothing has been revoked, so both unstamped sessions stand. This is the
    // migration: a deploy must not sign the product's existing users out.
    assert.equal(called('GET /entities (unstamped, no revocation yet)', await other.agent.get('/entities')).status, 200,
      'an unstamped session must go on working until something revokes it');
    assert.equal((await t.agent.get('/entities')).status, 200);

    assert.equal((await t.agent.post('/auth/sessions/revoke-all').send({ password: PASSWORD })).status, 200,
      'and such an account can still revoke');

    const refused = called('GET /entities (unstamped, after a revocation)', await other.agent.get('/entities'));
    assert.equal(refused.status, 401, 'a session that cannot be shown to postdate the revocation is over');
    assert.equal(await storedSession(other.sid), null, 'and is destroyed in the store');
    // The caller's own unstamped session was re-stamped by the route, so the
    // device that asked survives its own revocation even from this state.
    assert.equal(called('GET /entities (the caller, re-stamped)', await t.agent.get('/entities')).status, 200,
      'the device that asked stays signed in');
    assert.equal(await issuedAt(t.sid), (await revokedAt(t.userId)).getTime());
  });
});
