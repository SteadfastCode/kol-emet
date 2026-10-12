/**
 * HTTP tests for `POST /auth/password` and the policy both password-writing
 * routes share (KOL-074).
 *
 * What this defends. The route is the only thing in the product that replaces
 * a `passwordHash` after registration, so it is the one place where getting it
 * wrong either locks an owner out of their workspace or hands the account to
 * whoever is holding a borrowed session. Hence: the new password really does
 * sign in and the old one really does not (asserted through `POST /auth/login`,
 * not by reading the hash, because a hash that merely *changed* proves
 * nothing); a wrong current password refuses with the stored hash untouched;
 * an assertion from the account's own passkey is accepted; a short new password
 * is refused *before* any credential work, changing nothing; the MCP bearer
 * token is refused outright; an anonymous caller is 401 while a bad
 * re-authentication is 403; and a run of wrong guesses hits the shared attempt
 * limiter.
 *
 * And the one rule that is deliberately asymmetric: an account whose *stored*
 * password is shorter than the new minimum still signs in. The policy gates
 * writes only. Locking out everyone who registered before it — who could not
 * even reach this route to fix it, since changing a password requires signing
 * in — is a worse failure than the short password, so there is a test for that
 * exact case here, built by writing a short password's hash the way an old
 * registration left it.
 *
 * Real stack throughout: createApp() over supertest, real registration
 * (bcrypt at cost 12, a Workspace, seedWorkspace), real mongod, and a real
 * software authenticator for the passkey path — nothing on the server is
 * stubbed. The limiter group builds its own app with a small limit rather than
 * spending ten real bcrypt compares.
 *
 * Falsification checks: drop the `passwordProblem` call from the route and the
 * 11-character case 400s no longer; drop it from `/register` and the signup
 * case fails; add it to `/login` and the legacy-password case fails; swap the
 * 403 for a 401 and two cases fail on the status the Decision Log argues for;
 * remove `passwordCaller` and the bearer token changes the password; drop the
 * limiter call and the throttle group never sees a 429; share the deletion
 * route's challenge key and the cross-ceremony case passes a challenge it
 * should not.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_PASSWORD_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per account registered, naming the request and the ids
 *   normal  — light, plus every password call and what it answered
 *   verbose — normal, plus the stored hash prefix before and after a change
 *             (a prefix and a length, never a password)
 * The route logs on PASSWORD_LOG_LEVEL, silenced here unless set.
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
import Settings from '../../src/models/Settings.js';
import { PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT } from '../../src/lib/passwordPolicy.js';

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
process.env.ACCOUNT_DELETE_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_PASSWORD_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/password:${level}] ${msg}`);
}

const PASSWORD     = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'a-whole-new-horse-entirely';
const WRONG        = 'incorrect-horse-battery-staple';
/** One character under the minimum, so the boundary is tested through the route too. */
const TOO_SHORT    = 'a'.repeat(PASSWORD_MIN_LENGTH - 1);

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
async function tenant(label, { on = app, password = PASSWORD } = {}) {
  const email = uniqueEmail(label);
  const agent = originAgent(on);
  const res = await agent.post('/auth/register').send({ email, password });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  const user = await User.findOne({ email }).select('_id').lean();
  log('light', `registered ${email} (source: POST /auth/register) → user ${user._id}`);
  return { email, agent, userId: String(user._id) };
}

/** Adds `authenticator`'s passkey to `t` through the real ceremony. */
async function addPasskey(t, authenticator) {
  const begin = called('POST /auth/webauthn/register/begin', await t.agent.post('/auth/webauthn/register/begin'));
  assert.equal(begin.status, 200);
  const complete = called('POST /auth/webauthn/register/complete', await t.agent
    .post('/auth/webauthn/register/complete')
    .send(authenticator.register(begin.body)));
  assert.equal(complete.status, 200, `registration failed: ${complete.status} ${JSON.stringify(complete.body)}`);
}

/** The account's stored password hash. */
async function storedHash(userId) {
  const user = await User.findById(userId).select('passwordHash').lean();
  log('verbose', `user ${userId}: stored hash ${user?.passwordHash?.slice(0, 16)}… (${user?.passwordHash?.length} chars)`);
  return user?.passwordHash ?? null;
}

/** A fresh sign-in attempt on its own agent, so it cannot ride the fixture's session. */
const signIn = async (email, password, { on = app } = {}) =>
  called(`POST /auth/login (${password === PASSWORD ? 'the old password' : password === NEW_PASSWORD ? 'the new password' : 'some password'})`,
    await request(on).post('/auth/login').send({ email, password }));

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });
});

after(async () => { await db.disconnect(); });

describe('POST /auth/password', () => {
  test('the new password signs in, the old one does not, and the caller stays signed in', async () => {
    const t = await tenant('rotates');
    const before = await storedHash(t.userId);

    const res = called('POST /auth/password (current password)', await t.agent
      .post('/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }));

    assert.equal(res.status, 200, `the change failed: ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { ok: true });

    // The real assertion: what the sign-in route now accepts. A hash that
    // merely changed could be a hash of anything.
    assert.equal((await signIn(t.email, NEW_PASSWORD)).status, 200, 'the new password must sign in');
    assert.equal((await signIn(t.email, PASSWORD)).status, 401, 'the old password must not');

    const after = await storedHash(t.userId);
    assert.notEqual(after, before, 'the stored hash must be replaced');
    assert.match(after, /^\$2[aby]\$12\$/, 'hashed with bcrypt at cost 12, as registration hashes');

    // The session that asked is untouched — nothing here signs anyone out.
    assert.equal((await t.agent.get('/auth/me')).status, 200, 'the caller must stay signed in');
  });

  test('a wrong current password is 403, changes nothing, and leaves the caller signed in', async () => {
    const t = await tenant('wrong-current');
    const before = await storedHash(t.userId);

    const res = called('POST /auth/password (wrong current password)', await t.agent
      .post('/auth/password')
      .send({ currentPassword: WRONG, newPassword: NEW_PASSWORD }));

    // 403 and not 401: the session is still good, and a 401 reads to a client
    // as "you have been signed out" (the Decision Log's reasoning for deletion).
    assert.equal(res.status, 403, 'a failed re-authentication is 403, not 401');
    assert.equal(res.body.error, 'Incorrect password');
    assert.equal(await storedHash(t.userId), before, 'the stored hash must be untouched');
    assert.equal((await signIn(t.email, PASSWORD)).status, 200, 'the original password must still sign in');
    assert.equal((await signIn(t.email, NEW_PASSWORD)).status, 401, 'the refused password must not sign in');
    assert.equal((await t.agent.get('/auth/me')).status, 200, 'a refusal must leave the caller signed in');
  });

  test(`a new password of ${PASSWORD_MIN_LENGTH - 1} characters is 400 and changes nothing`, async () => {
    const t = await tenant('too-short');
    const before = await storedHash(t.userId);

    const res = called('POST /auth/password (11-character new password)', await t.agent
      .post('/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: TOO_SHORT }));

    assert.equal(res.status, 400);
    assert.equal(res.body.error, PASSWORD_TOO_SHORT, 'the policy\'s own sentence, so the user is told the rule');
    assert.equal(await storedHash(t.userId), before, 'the stored hash must be untouched');
    assert.equal((await signIn(t.email, TOO_SHORT)).status, 401, 'the refused password must not sign in');
    assert.equal((await signIn(t.email, PASSWORD)).status, 200, 'and the current one still must');
  });

  test('a missing new password, a missing credential and a non-string are each 400, changing nothing', async () => {
    const t = await tenant('malformed');
    const before = await storedHash(t.userId);

    const cases = [
      ['no new password',            { currentPassword: PASSWORD }],
      ['no credential',              { newPassword: NEW_PASSWORD }],
      ['neither',                    {}],
      ['no body',                    undefined],
      ['a non-string new password',  { currentPassword: PASSWORD, newPassword: { $ne: '' } }],
      ['a non-string current one',   { currentPassword: { $ne: '' }, newPassword: NEW_PASSWORD }],
      ['an empty current password',  { currentPassword: '', newPassword: NEW_PASSWORD }],
      ['a null passkey',             { passkey: null, newPassword: NEW_PASSWORD }],
    ];
    for (const [what, body] of cases) {
      const pending = t.agent.post('/auth/password');
      const res = called(`POST /auth/password (${what})`, await (body === undefined ? pending : pending.send(body)));
      assert.equal(res.status, 400, `${what}: expected 400, got ${res.status} ${JSON.stringify(res.body)}`);
    }

    assert.equal(await storedHash(t.userId), before, 'no refusal may touch the stored hash');
    assert.equal((await signIn(t.email, PASSWORD)).status, 200);
  });

  test('without a session it is 401', async () => {
    const res = called('POST /auth/password (anonymous)', await request(app)
      .post('/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }));

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Unauthorized');
  });

  test('the MCP bearer token cannot change the password of the account it acts for', async () => {
    const t = await tenant('mcp-user');
    await Settings.findByIdAndUpdate('global', { mcpUserId: t.userId }, { upsert: true });
    process.env.BEARER_TOKEN = 'test-bearer-token';
    try {
      const before = await storedHash(t.userId);

      const res = called('POST /auth/password (bearer token)', await request(app)
        .post('/auth/password')
        .set('Authorization', 'Bearer test-bearer-token')
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }));

      assert.equal(res.status, 403, 'changing a password is a session-only action');
      assert.equal(await storedHash(t.userId), before, 'the stored hash must be untouched');

      // The challenge route is session-only for the same reason.
      const challenge = called('POST /auth/password/passkey-challenge (bearer token)', await request(app)
        .post('/auth/password/passkey-challenge')
        .set('Authorization', 'Bearer test-bearer-token'));
      assert.equal(challenge.status, 403);
    } finally {
      delete process.env.BEARER_TOKEN;
      await Settings.updateOne({ _id: 'global' }, { $set: { mcpUserId: null } });
    }
  });
});

describe('POST /auth/password confirmed with a passkey', () => {
  test('an assertion by the account\'s own passkey is accepted, and the challenge is single-use', async () => {
    const t = await tenant('passkey-change');
    const authenticator = device();
    await addPasskey(t, authenticator);
    const before = await storedHash(t.userId);

    const challenge = called('POST /auth/password/passkey-challenge', await t.agent.post('/auth/password/passkey-challenge'));
    assert.equal(challenge.status, 200);
    assert.deepEqual(challenge.body.allowCredentials.map(c => c.id), [authenticator.id],
      'the challenge must offer the id the browser knows');

    const assertion = authenticator.assert(challenge.body);
    const res = called('POST /auth/password (passkey)', await t.agent
      .post('/auth/password')
      .send({ passkey: assertion, newPassword: NEW_PASSWORD }));

    assert.equal(res.status, 200, `the change failed: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal((await signIn(t.email, NEW_PASSWORD)).status, 200, 'the new password must sign in');
    assert.equal((await signIn(t.email, PASSWORD)).status, 401, 'the old one must not');
    assert.notEqual(await storedHash(t.userId), before);

    // One challenge buys one try: replaying the same assertion must not work.
    const replay = called('POST /auth/password (replayed assertion)', await t.agent
      .post('/auth/password')
      .send({ passkey: assertion, newPassword: 'third-password-entirely' }));
    assert.equal(replay.status, 403, 'a spent challenge must not confirm a second change');
    assert.equal((await signIn(t.email, 'third-password-entirely')).status, 401);
  });

  test('a deletion challenge cannot confirm a password change: the two keys are separate', async () => {
    const t = await tenant('cross-ceremony');
    const authenticator = device();
    await addPasskey(t, authenticator);
    const before = await storedHash(t.userId);

    // Minted for deletion, spent here. Same account, same passkey, wrong ceremony.
    const challenge = called('POST /auth/account/passkey-challenge', await t.agent.post('/auth/account/passkey-challenge'));
    assert.equal(challenge.status, 200);

    const res = called('POST /auth/password (deletion challenge)', await t.agent
      .post('/auth/password')
      .send({ passkey: authenticator.assert(challenge.body), newPassword: NEW_PASSWORD }));

    assert.equal(res.status, 403, 'no challenge was issued to this session for a password change');
    assert.equal(await storedHash(t.userId), before, 'the stored hash must be untouched');
    assert.equal(await User.countDocuments({ _id: t.userId }), 1, 'and nothing may have deleted the account');
  });

  test('an account with no passkey is told so, rather than being offered an empty challenge', async () => {
    const t = await tenant('no-passkey');

    const res = called('POST /auth/password/passkey-challenge (no passkey)', await t.agent
      .post('/auth/password/passkey-challenge'));

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'This account has no passkey');
  });
});

describe('POST /auth/register and the shared policy', () => {
  test(`registering with ${PASSWORD_MIN_LENGTH - 1} characters is 400 and creates no account`, async () => {
    const email = uniqueEmail('short-signup');

    const res = called('POST /auth/register (11-character password)', await request(app)
      .post('/auth/register')
      .send({ email, password: TOO_SHORT }));

    assert.equal(res.status, 400);
    assert.equal(res.body.error, PASSWORD_TOO_SHORT, 'the same sentence POST /auth/password answers with');
    assert.equal(await User.countDocuments({ email }), 0, 'a refused registration must create nothing');
  });

  test('a password of exactly the minimum registers', async () => {
    const email = uniqueEmail('minimum-signup');
    const password = 'b'.repeat(PASSWORD_MIN_LENGTH);

    const res = called('POST /auth/register (12-character password)', await originAgent(app)
      .post('/auth/register')
      .send({ email, password }));

    assert.equal(res.status, 201, `the minimum must be enough: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal((await signIn(email, password)).status, 200);
  });

  test('an account whose stored password is shorter than the minimum still signs in, and can replace it', async () => {
    // How such an account exists: it registered before the minimum did. The
    // hash is written directly for that reason — the endpoint now refuses the
    // password this account holds, which is exactly the asymmetry under test.
    const t = await tenant('legacy-short');
    await User.updateOne({ _id: t.userId }, { $set: { passwordHash: await bcrypt.hash(TOO_SHORT, 12) } });
    log('light', `user ${t.userId}: stored password replaced with an ${TOO_SHORT.length}-character one (source: this test, standing in for a registration from before KOL-074)`);

    // The point of the whole test: the policy gates writes, never the door.
    const signedIn = await signIn(t.email, TOO_SHORT);
    assert.equal(signedIn.status, 200, 'a password shorter than the minimum must still sign in');

    // And from that session the owner can get out of it — which is what makes
    // not locking them out the right call rather than merely the kind one.
    const agent = originAgent(app);
    assert.equal((await agent.post('/auth/login').send({ email: t.email, password: TOO_SHORT })).status, 200);
    const res = called('POST /auth/password (from a short stored password)', await agent
      .post('/auth/password')
      .send({ currentPassword: TOO_SHORT, newPassword: NEW_PASSWORD }));

    assert.equal(res.status, 200, `the change failed: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal((await signIn(t.email, NEW_PASSWORD)).status, 200);
    assert.equal((await signIn(t.email, TOO_SHORT)).status, 401, 'and the short one is gone');
  });
});

/**
 * The throttle (KOL-035's counters, src/lib/attemptLimiter.js). Keyed by the
 * account under this route's own key, so guessing the current password here is
 * bounded exactly as guessing it at the sign-in form is.
 *
 * Its own app with `perUser: 3`: the real limit is 10, and ten wrong guesses
 * is ten real bcrypt compares at cost 12 for an assertion the small limit
 * makes just as well.
 */
describe('POST /auth/password throttling', () => {
  const PER_USER = 3;
  let limitedApp;

  before(() => {
    limitedApp = createApp({
      sessionStore: new session.MemoryStore(),
      authLimits: { ...SUITE_AUTH_LIMITS, perUser: PER_USER },
    });
  });

  test(`refuses with 429 and a Retry-After after ${PER_USER} wrong current passwords, and the hash is still the original`, async () => {
    const t = await tenant('throttled', { on: limitedApp });
    const before = await storedHash(t.userId);

    for (let i = 1; i <= PER_USER; i++) {
      const res = called(`POST /auth/password (wrong ${i}/${PER_USER})`, await t.agent
        .post('/auth/password')
        .send({ currentPassword: WRONG, newPassword: NEW_PASSWORD }));
      assert.equal(res.status, 403, `attempt ${i} must be answered on its merits, not throttled`);
    }

    const refused = called('POST /auth/password (over the limit)', await t.agent
      .post('/auth/password')
      .send({ currentPassword: WRONG, newPassword: NEW_PASSWORD }));
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error, 'Too many attempts. Try again later.');
    assert.ok(Number(refused.headers['retry-after']) > 0, 'a 429 must say how long to wait');

    // Checked before the credential work, so even the *right* password is now
    // refused — that is what makes it a throttle and not an error counter.
    const correct = called('POST /auth/password (right password, over the limit)', await t.agent
      .post('/auth/password')
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }));
    assert.equal(correct.status, 429);
    assert.equal(await storedHash(t.userId), before, 'nothing in a throttled run may change the password');
    assert.equal((await signIn(t.email, PASSWORD, { on: limitedApp })).status, 200, 'and the account is not locked out of signing in');
  });

  test('a successful change clears the account\'s own counter', async () => {
    const t = await tenant('cleared', { on: limitedApp });

    // One short of the limit, then get it right.
    for (let i = 1; i < PER_USER; i++) {
      assert.equal((await t.agent.post('/auth/password').send({ currentPassword: WRONG, newPassword: NEW_PASSWORD })).status, 403);
    }
    assert.equal((await t.agent.post('/auth/password').send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status, 200);

    // The counter is forgotten, so the budget is whole again — a fat-fingered
    // password must not leave its owner one try from a 429 for the next
    // quarter of an hour.
    for (let i = 1; i <= PER_USER; i++) {
      const res = called(`POST /auth/password (wrong ${i}/${PER_USER} after a success)`, await t.agent
        .post('/auth/password')
        .send({ currentPassword: WRONG, newPassword: 'yet-another-password' }));
      assert.equal(res.status, 403, `attempt ${i} after a success must not be throttled`);
    }
  });
});
