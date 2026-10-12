/**
 * HTTP tests for POST /auth/password and the policy both write routes share.
 *
 * KOL-074: there was no route that replaced `passwordHash`, so an account whose
 * password its owner no longer trusted could only be deleted and rebuilt; and
 * `usablePassword()` accepted any non-empty string, so `a` was a valid password
 * on a product with open registration. This file defends both halves — the door
 * (who may change a password, and with what proof) and the rule (what may be
 * stored, at registration and at a change alike).
 *
 * What each test defends:
 *   - A change re-authenticated with the current password sticks: the new
 *     password signs in, the old one does not, and the stored hash is a new one.
 *   - And re-authenticated with a *passkey* assertion against a challenge from
 *     POST /auth/password/passkey-challenge, which is the path an account with
 *     no password of its own would use. Real @simplewebauthn verification; see
 *     tests/helpers/softAuthenticator.js.
 *   - A wrong current password is **403** and the hash is byte-identical
 *     afterwards. 403, not 401: the session is still good, and a 401 reads to a
 *     client as "signed out" (the Decision Log's reasoning for
 *     DELETE /auth/account, which this route follows).
 *   - Repeated wrong attempts are throttled, on the account's own counter,
 *     before the bcrypt compare — the same counter the deletion route's
 *     confirmation spends, because it is the same guess at the same secret.
 *   - An 11-character new password is 400, with the policy's sentence, and
 *     changes nothing. Registering with one is the same 400, and creates no
 *     user and no workspace.
 *   - The policy gates writes and **never `/login`**: an account whose stored
 *     password is shorter than the minimum goes on signing in, because locking
 *     out everyone who registered before the rule is the worse failure.
 *   - The MCP bearer token is refused with 403 even holding the right password:
 *     a connector does not get to change someone's password. Unauthenticated is
 *     401, from `requireAuth`, before any of this.
 *
 * Falsification checks: drop the `passwordProblem` call in the route and the
 * 11-character case gets a 200; drop it in `/register` and the short-signup
 * case creates an account; add it to `/login` and the legacy-password case
 * fails; swap the 403 for a 401 and two tests fail on the status; move the
 * limiter check after the compare and the throttle test's first 429 arrives one
 * attempt late; use `requireActor` instead of the session check and the bearer
 * test changes the password; forget `delete req.session[challengeKey]` in
 * passkeyRefusal and the replayed-challenge case gets a second 200.
 *
 * Real stack throughout — createApp() over supertest, real registration
 * (bcrypt, Workspace, seedWorkspace), real mongod — for the reasons at the top
 * of tests/http/auth.test.js. Every test registers its own account under a
 * unique email, so no test depends on another's leftovers.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_PASSWORD_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per account created or altered, naming what did it
 *   normal  — light, plus every call made here and what it answered
 *   verbose — normal, plus the stored hash prefix (never a password) around a
 *             change, which is how "unchanged" is read
 * The routes log on PASSWORD_LOG_LEVEL and AUTH_LIMIT_LOG_LEVEL, silenced here
 * unless set, for when a failure needs their trail.
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
import { createSoftAuthenticator } from '../helpers/softAuthenticator.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import { PASSWORD_MIN_LENGTH } from '../../src/lib/passwordPolicy.js';

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
// Unset so every request here is a session request; the one test about the
// bearer token sets it for itself and removes it again.
delete process.env.BEARER_TOKEN;
process.env.WEBAUTHN_RP_ID = RP_ID;
process.env.WEBAUTHN_ORIGIN = ORIGIN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.PASSWORD_LOG_LEVEL ??= 'off';
process.env.PASSKEY_LOG_LEVEL ??= 'off';
process.env.AUTH_LIMIT_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_PASSWORD_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/password:${level}] ${msg}`);
}

const PASSWORD     = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'a-different-horse-entirely';
const SHORT        = 'a'.repeat(PASSWORD_MIN_LENGTH - 1);

/**
 * Failed re-authentications allowed per account per window. Small on purpose,
 * so the throttle test does not have to spend ten bcrypt compares; every other
 * test here registers its own account, and the counter is keyed by the account,
 * so no test can reach another's budget.
 */
const PER_USER = 3;

let app;

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

const device = (opts) => createSoftAuthenticator({ origin: ORIGIN, ...opts });

/** An account registered through the real endpoint, signed in on its own agent. */
async function tenant(label) {
  const email = uniqueEmail(label);
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  const user = await User.findOne({ email }).select('_id').lean();
  log('light', `registered ${email} (source: POST /auth/register) → user ${user._id}`);
  return { email, agent, userId: String(user._id) };
}

/** The account's stored hash, logged by its prefix only — never a password. */
async function storedHash(userId) {
  const user = await User.findById(userId).select('passwordHash').lean();
  log('verbose', `user ${userId}: stored hash ${user?.passwordHash?.slice(0, 14) ?? '(none)'}…`);
  return user?.passwordHash ?? null;
}

/** Adds `authenticator`'s passkey to `t` through the real ceremony. */
async function addPasskey(t, authenticator) {
  const begin = called('POST /auth/webauthn/register/begin', await t.agent.post('/auth/webauthn/register/begin'));
  assert.equal(begin.status, 200);
  const complete = called('POST /auth/webauthn/register/complete', await t.agent
    .post('/auth/webauthn/register/complete')
    .send(authenticator.register(begin.body)));
  assert.equal(complete.status, 200, `passkey registration failed: ${complete.status} ${JSON.stringify(complete.body)}`);
  log('light', `user ${t.userId}: passkey ${authenticator.id} added (source: POST /auth/webauthn/register/complete)`);
}

/** Whether `password` signs the account in, on a fresh agent of its own. */
async function signsIn(email, password) {
  const res = called(`POST /auth/login (${email})`, await request(app).post('/auth/login').send({ email, password }));
  assert.ok([200, 401].includes(res.status), `unexpected sign-in status ${res.status} ${JSON.stringify(res.body)}`);
  return res.status === 200;
}

before(async () => {
  await db.connect();
  app = createApp({
    sessionStore: new session.MemoryStore(),
    authLimits: { ...SUITE_AUTH_LIMITS, perUser: PER_USER },
  });
});

after(async () => { await db.disconnect(); });

describe('POST /auth/password', () => {
  test('the current password confirms a change: the new password signs in, the old one does not', async () => {
    const t = await tenant('rotates');
    const before = await storedHash(t.userId);

    const res = called('POST /auth/password (right current password)', await t.agent
      .post('/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }));

    assert.equal(res.status, 200, `change failed: ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { ok: true });

    const after = await storedHash(t.userId);
    assert.notEqual(after, before, 'the stored hash must be a new one');
    assert.ok(await bcrypt.compare(NEW_PASSWORD, after), 'and must be the hash of the new password');
    assert.match(after, /^\$2[aby]\$12\$/, 'hashed with bcrypt at 12 rounds, as /register hashes');

    assert.ok(await signsIn(t.email, NEW_PASSWORD), 'the new password must sign in');
    assert.ok(!(await signsIn(t.email, PASSWORD)), 'the old password must not');

    // The session that made the change keeps it — the point of answering 200
    // rather than clearing the cookie. Ending the account's *other* sessions is
    // KOL-076's, and deliberately not done here.
    assert.equal((await t.agent.get('/auth/me')).status, 200, 'the caller must stay signed in');
  });

  test('a wrong current password is 403, and the stored hash is untouched', async () => {
    const t = await tenant('wrong-current');
    const before = await storedHash(t.userId);

    const res = called('POST /auth/password (wrong current password)', await t.agent
      .post('/auth/password')
      .send({ currentPassword: 'incorrect-horse-battery-staple', newPassword: NEW_PASSWORD }));

    // 403 and not 401: the session is fine, the re-authentication was not, and
    // a 401 would tell the client it had been signed out.
    assert.equal(res.status, 403, `expected 403, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'Incorrect password');
    assert.equal(await storedHash(t.userId), before, 'a refusal must change nothing');
    assert.ok(await signsIn(t.email, PASSWORD), 'the old password must still sign in');
    assert.ok(!(await signsIn(t.email, NEW_PASSWORD)), 'and the one that was refused must not');
    assert.equal((await t.agent.get('/auth/me')).status, 200, 'a refusal must leave the caller signed in');
  });

  test('a passkey assertion confirms a change', async () => {
    const t = await tenant('passkey-confirms');
    const authenticator = device({ synced: false });
    await addPasskey(t, authenticator);
    const before = await storedHash(t.userId);

    const challenge = called('POST /auth/password/passkey-challenge', await t.agent.post('/auth/password/passkey-challenge'));
    assert.equal(challenge.status, 200, `challenge failed: ${challenge.status} ${JSON.stringify(challenge.body)}`);
    assert.deepEqual(challenge.body.allowCredentials.map(c => c.id), [authenticator.id],
      'the challenge must offer the id the browser knows');

    const res = called('POST /auth/password (passkey)', await t.agent
      .post('/auth/password')
      .send({ newPassword: NEW_PASSWORD, passkey: authenticator.assert(challenge.body) }));

    assert.equal(res.status, 200, `change failed: ${res.status} ${JSON.stringify(res.body)}`);
    const after = await storedHash(t.userId);
    assert.notEqual(after, before);
    assert.ok(await bcrypt.compare(NEW_PASSWORD, after));
    assert.ok(await signsIn(t.email, NEW_PASSWORD), 'the new password must sign in');

    // One challenge buys one try: the assertion cannot be replayed, and the
    // challenge key is this route's own, so the deletion route's is not spent
    // either way.
    const replay = called('POST /auth/password (replayed assertion)', await t.agent
      .post('/auth/password')
      .send({ newPassword: 'a-third-horse-altogether', passkey: authenticator.assert({ challenge: challenge.body.challenge, rpId: RP_ID }) }));
    assert.equal(replay.status, 403, 'a spent challenge must not confirm a second change');
    assert.equal(await storedHash(t.userId), after, 'and must change nothing');
  });

  test('a passkey challenge is refused when the account holds none', async () => {
    const t = await tenant('no-passkey');
    const res = called('POST /auth/password/passkey-challenge (no passkey)', await t.agent.post('/auth/password/passkey-challenge'));
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'This account has no passkey');

    // And an assertion-shaped body with no challenge behind it is a 403, not a
    // change: passkeyRefusal spends the session key before anything else.
    const attempt = called('POST /auth/password (passkey, no challenge)', await t.agent
      .post('/auth/password')
      .send({ newPassword: NEW_PASSWORD, passkey: { id: 'nope', rawId: 'nope', type: 'public-key', response: {}, clientExtensionResults: {} } }));
    assert.equal(attempt.status, 403);
    assert.equal(attempt.body.error, 'Passkey confirmation failed');
    assert.ok(await signsIn(t.email, PASSWORD), 'the password on the account must be the one it had');
  });

  test('a new password short of the minimum is 400 and changes nothing, however it is confirmed', async () => {
    const t = await tenant('short-new');
    const before = await storedHash(t.userId);

    for (const [what, body] of [
      [`${PASSWORD_MIN_LENGTH - 1} characters`, { currentPassword: PASSWORD, newPassword: SHORT }],
      ['one character', { currentPassword: PASSWORD, newPassword: 'a' }],
      ['an empty string', { currentPassword: PASSWORD, newPassword: '' }],
      ['no new password at all', { currentPassword: PASSWORD }],
      ['a non-string new password', { currentPassword: PASSWORD, newPassword: { $ne: '' } }],
    ]) {
      const res = called(`POST /auth/password (${what})`, await t.agent.post('/auth/password').send(body));
      assert.equal(res.status, 400, `${what}: expected 400, got ${res.status} ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, /^A password /, `${what}: the policy's own sentence`);
      assert.equal(await storedHash(t.userId), before, `${what}: nothing may be stored`);
    }
    // Specifically the boundary, with the minimum itself allowed right after it.
    assert.equal([...SHORT].length, PASSWORD_MIN_LENGTH - 1);
    const minimum = 'b'.repeat(PASSWORD_MIN_LENGTH);
    const accepted = called('POST /auth/password (exactly the minimum)', await t.agent
      .post('/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: minimum }));
    assert.equal(accepted.status, 200, `the minimum itself must be allowed: ${JSON.stringify(accepted.body)}`);
    assert.ok(await signsIn(t.email, minimum));
  });

  test('without the current password or a passkey it is 400, and nothing is changed', async () => {
    const t = await tenant('unconfirmed');
    const before = await storedHash(t.userId);

    for (const [what, body] of [
      ['neither credential', { newPassword: NEW_PASSWORD }],
      ['an empty current password', { currentPassword: '', newPassword: NEW_PASSWORD }],
      ['a non-string current password', { currentPassword: { $ne: '' }, newPassword: NEW_PASSWORD }],
      ['a null passkey', { currentPassword: null, passkey: null, newPassword: NEW_PASSWORD }],
      ['no body', undefined],
    ]) {
      const pending = t.agent.post('/auth/password');
      const res = called(`POST /auth/password (${what})`, await (body === undefined ? pending : pending.send(body)));
      assert.equal(res.status, 400, `${what}: expected 400, got ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(await storedHash(t.userId), before, `${what}: nothing may be stored`);
    }
    assert.ok(await signsIn(t.email, PASSWORD));
  });

  test('repeated wrong current passwords are throttled on the account, before the compare', async () => {
    const t = await tenant('throttled');
    const before = await storedHash(t.userId);

    for (let attempt = 1; attempt <= PER_USER; attempt++) {
      const res = called(`POST /auth/password (wrong, attempt ${attempt})`, await t.agent
        .post('/auth/password')
        .send({ currentPassword: `guess-number-${attempt}`, newPassword: NEW_PASSWORD }));
      assert.equal(res.status, 403, `attempt ${attempt} must be answered normally`);
    }

    const blocked = called('POST /auth/password (over the limit)', await t.agent
      .post('/auth/password')
      .send({ currentPassword: 'one-guess-too-many', newPassword: NEW_PASSWORD }));
    assert.equal(blocked.status, 429, `expected 429, got ${blocked.status} ${JSON.stringify(blocked.body)}`);
    assert.equal(blocked.body.error, 'Too many attempts. Try again later.');
    assert.ok(Number(blocked.headers['retry-after']) > 0, 'a 429 must say how long to wait');

    // The throttle is on the credential check, not the route: the *right*
    // password is refused too while the window stands, and nothing is stored.
    const rightButBlocked = called('POST /auth/password (right password, blocked)', await t.agent
      .post('/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }));
    assert.equal(rightButBlocked.status, 429);
    assert.equal(await storedHash(t.userId), before, 'a throttled attempt must change nothing');
    assert.ok(await signsIn(t.email, PASSWORD), 'and must not touch the account itself');
  });

  test('the MCP bearer token cannot change a password, even holding the right one', async () => {
    const t = await tenant('mcp-token');
    const before = await storedHash(t.userId);
    process.env.BEARER_TOKEN = 'test-bearer-token';
    try {
      const res = called('POST /auth/password (bearer token)', await request(app)
        .post('/auth/password')
        .set('Authorization', 'Bearer test-bearer-token')
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }));

      assert.equal(res.status, 403, 'changing a password is a session-only action');
      assert.equal(await storedHash(t.userId), before, 'a refusal must change nothing');

      const challenge = called('POST /auth/password/passkey-challenge (bearer token)', await request(app)
        .post('/auth/password/passkey-challenge')
        .set('Authorization', 'Bearer test-bearer-token'));
      assert.equal(challenge.status, 403, 'nor may it start a confirmation');
    } finally {
      delete process.env.BEARER_TOKEN;
    }
    assert.ok(await signsIn(t.email, PASSWORD));
  });

  test('without a session it is 401', async () => {
    const res = called('POST /auth/password (anonymous)', await request(app)
      .post('/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }));
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Unauthorized');

    const challenge = called('POST /auth/password/passkey-challenge (anonymous)', await request(app)
      .post('/auth/password/passkey-challenge'));
    assert.equal(challenge.status, 401);
  });
});

describe('the password policy at the other two doors', () => {
  test('registering with a password short of the minimum is 400, and creates nothing', async () => {
    const email = uniqueEmail('short-signup');

    const res = called('POST /auth/register (short password)', await request(app)
      .post('/auth/register')
      .send({ email, password: SHORT }));

    assert.equal(res.status, 400, `expected 400, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, `A password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
    assert.equal(await User.countDocuments({ email }), 0, 'no account may be created');
    // The whole point of refusing before the writes: no workspace, no seed.
    assert.equal(await Workspace.countDocuments({ name: 'My Workspace', ownerId: null }), 0);
    assert.ok(!(await signsIn(email, SHORT)), 'and the address must not sign in');

    // The missing-field refusal keeps its own wording, so a client can still
    // tell "you left it blank" from "it is too short".
    const missing = called('POST /auth/register (no password)', await request(app)
      .post('/auth/register')
      .send({ email: uniqueEmail('no-password') }));
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'Email and password are required');

    // And the minimum itself registers.
    const ok = called('POST /auth/register (exactly the minimum)', await request(app)
      .post('/auth/register')
      .send({ email: uniqueEmail('minimum-signup'), password: 'c'.repeat(PASSWORD_MIN_LENGTH) }));
    assert.equal(ok.status, 201, `the minimum must be allowed: ${JSON.stringify(ok.body)}`);
  });

  test('an account whose stored password is short still signs in — the policy never gates /login', async () => {
    // Written straight into the collection, as a registration from before the
    // policy existed left it. Locking this account out would be a worse failure
    // than its short password.
    const email = uniqueEmail('legacy-short');
    const user = await User.create({ email, passwordHash: await bcrypt.hash(SHORT, 12) });
    log('light', `created ${email} with a ${[...SHORT].length}-character password (source: this test, standing in for a pre-KOL-074 registration) → user ${user._id}`);

    assert.ok(await signsIn(email, SHORT), 'a short stored password must go on signing in');
    assert.ok(!(await signsIn(email, 'wrong-but-long-enough')), 'and a wrong one must still be refused');

    // It is a write that the policy gates — including this account's own change,
    // which has to leave it with a password the rule allows.
    const agent = originAgent(app);
    assert.equal((await agent.post('/auth/login').send({ email, password: SHORT })).status, 200);
    const refused = called('POST /auth/password (legacy account, short new password)', await agent
      .post('/auth/password')
      .send({ currentPassword: SHORT, newPassword: SHORT }));
    assert.equal(refused.status, 400);

    const changed = called('POST /auth/password (legacy account)', await agent
      .post('/auth/password')
      .send({ currentPassword: SHORT, newPassword: NEW_PASSWORD }));
    assert.equal(changed.status, 200, `the way off a short password: ${JSON.stringify(changed.body)}`);
    assert.ok(await signsIn(email, NEW_PASSWORD));
  });
});
