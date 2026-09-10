/**
 * HTTP tests for the account lifecycle: register → login → session → logout.
 *
 * This is the boundary the whole product sits behind, so these drive the real
 * stack rather than stubbing it — `createApp()` over supertest, real bcrypt,
 * real `Workspace` creation, real `seedWorkspace`, real mongod. A stubbed
 * `User` would not catch the two things most likely to break here: the schema
 * setters that normalise an email, and the unique index that makes "one account
 * per address" true even when the route's own check loses a race.
 *
 * What each group defends, and why it is worth a test:
 *
 *   Registration is the only place a tenant is born. `resolveWorkspace` fails
 *   closed, so a user created without a workspace can neither read nor write
 *   anything — an account that exists and cannot be used. Registration must
 *   therefore leave behind exactly one workspace, owned by the new user, with
 *   at least one relationship type seeded into it (an empty type list makes the
 *   relationship picker look broken on first use, which is the product's core
 *   feature).
 *
 *   Email normalisation decides whether `Alice@x.test` and `alice@x.test` are
 *   one account or two. Two would mean a user who cannot log in because they
 *   capitalised the way their phone keyboard does, and a duplicate that the
 *   409 check silently waves through.
 *
 *   The 401 bodies are an account-enumeration boundary. If a wrong password and
 *   an unknown address answer differently — by status, by message, by length,
 *   by setting a cookie — then registration doubles as an address oracle for
 *   anyone with a list. So the assertion is on raw bytes, not on a parsed body.
 *
 *   Logout has to end the session on the server. Clearing the cookie only
 *   removes the browser's copy; a session left live in the store is still
 *   usable by anyone holding the value, which is the case logout exists for.
 *
 * Isolation: every test mints its own email via `uniqueEmail()` and asserts on
 * documents scoped to its own user or workspace, so tests neither clear the
 * database between runs (registration costs a bcrypt hash at cost 12 — paying
 * for extra ones buys nothing) nor depend on each other's leftovers. A count
 * that accidentally spanned tests would be scoped-out by construction.
 *
 * Falsification checks for this suite: drop `lowercase: true` from
 * `src/models/User.js` and the normalisation and duplicate-casing tests fail;
 * remove the `Workspace.create` block from `POST /auth/register` and the
 * registration test fails; change either 401 in `POST /auth/login` to name
 * which half was wrong and the enumeration test fails; swap
 * `req.session.destroy()` for a bare `res.clearCookie()` and the logout test
 * fails on the replayed cookie.
 *
 * Deliberately not covered: the WebAuthn ceremonies. Registering or asserting a
 * passkey needs a browser authenticator (or a software one signing real
 * attestation objects); faking it would test the mock. `/auth/webauthn/*` is
 * therefore untested here and should be marked so in any coverage discussion.
 *
 * ─── Two gaps this file documents rather than asserts ────────────────────────
 * Both are real, both are in `src/routes/auth.js`, and fixing either is an auth
 * change — out of scope for the item that added this file. Neither is written
 * as a failing test, for the reasons given:
 *
 *   1. Concurrent duplicate registration. The route does `findOne` and then
 *      `create`, which is not atomic; two simultaneous signups for one address
 *      both pass the check, and the loser's `User.create` rejects with E11000
 *      inside an async handler that Express 4 does not catch. The request never
 *      answers and the unhandled rejection takes the process down under Node's
 *      default. A test for it would hang or kill the test runner, so this file
 *      asserts the model-level backstop (the unique index still refuses the
 *      second write) and leaves the route's handling of it to a follow-up.
 *
 *   2. Timing-based enumeration. The bodies are byte-identical, but an unknown
 *      address returns before `bcrypt.compare` runs while a known one pays for
 *      it — a difference of roughly the hash cost, measurable over a few
 *      samples. Asserting on wall-clock time is flaky on shared CI, so it is
 *      recorded here instead. The fix is to compare against a dummy hash on the
 *      unknown-user path.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_AUTH_LOG_LEVEL = off | light | normal | verbose (default light)
 * When one of these fails on an unattended run, the missing information is
 * always which credential was sent, which document came back, and where the id
 * or session came from — never the assertion itself.
 *   off     — nothing
 *   light   — one line per account created, naming the request that created it
 *             and the user/workspace ids it produced
 *   normal  — light, plus every login/logout/me call and the status it got
 *   verbose — normal, plus session cookie ids and raw 401 bodies
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import session from 'express-session';
import request from 'supertest';

import * as db from '../helpers/db.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import RelationshipType from '../../src/models/RelationshipType.js';

// createApp() reads NODE_ENV when called, and the OAuth router reads its token
// at module load, so the environment has to be in place before src/app.js is
// imported — hence the dynamic import below rather than a static one.
// NODE_ENV must not be 'production' here: that arms secure/none/domain-scoped
// session cookies, which supertest's agent would refuse to send back.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
// Unset on purpose, and load-bearing for this file specifically: requireAuth
// accepts `Authorization: Bearer <BEARER_TOKEN>` as an alternative to a
// session. With a token configured, the "logout with no session is 401" case
// could pass for the wrong reason.
delete process.env.BEARER_TOKEN;
// Every registration below seeds a workspace, and seedWorkspace logs at 'light'
// by default. Overridable when a seeding problem is what is being chased.
process.env.SEED_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_AUTH_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/auth:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';
const WRONG_PASSWORD = 'incorrect-horse-battery-staple';

let app;

/** Distinct address per test, so no test can be polluted by another's account. */
let emailCounter = 0;
function uniqueEmail(label) {
  emailCounter += 1;
  return `${label}-${emailCounter}@example.test`;
}

/**
 * The `connect.sid=<value>` pair from a response's Set-Cookie, or null when the
 * response issued no session. Returned in Cookie-header form so it can be
 * replayed directly with `.set('Cookie', ...)`.
 */
function sessionCookie(res) {
  const setCookie = res.headers['set-cookie'] ?? [];
  const cookie = setCookie.find(c => c.startsWith('connect.sid='));
  return cookie ? cookie.split(';')[0] : null;
}

/** True when the response's Set-Cookie expires connect.sid rather than issuing one. */
function clearsSessionCookie(res) {
  const setCookie = res.headers['set-cookie'] ?? [];
  return setCookie.some(c => /^connect\.sid=;/.test(c) && /Expires=Thu, 01 Jan 1970/.test(c));
}

/**
 * Registers through the real endpoint and reads back what it created, so
 * callers assert on what the API did rather than on what it was asked to do.
 * `email` is passed through verbatim — casing and whitespace included — because
 * two tests here are about exactly that.
 */
async function register(agent, email, password = PASSWORD) {
  const res = await agent.post('/auth/register').send({ email, password });
  if (res.status !== 201) {
    log('normal', `POST /auth/register (${JSON.stringify(email)}) → ${res.status} ${JSON.stringify(res.body)}`);
    return { res, user: null, workspace: null };
  }

  const user = await User.findOne({ email: email.trim().toLowerCase() }).select('_id email').lean();
  const workspace = user
    ? await Workspace.findOne({ 'members.userId': user._id }).lean()
    : null;

  log('light', `registered ${JSON.stringify(email)} (source: POST /auth/register) → user ${user?._id} stored as ${JSON.stringify(user?.email)}, workspace ${workspace?._id}`);
  return { res, user, workspace };
}

/** Logs a call and its status at the 'normal' tier. */
function called(what, res) {
  log('normal', `${what} → ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

before(async () => {
  await db.connect();
  // Index builds are asynchronous, and the duplicate-email backstop below is an
  // assertion about the unique index specifically — so wait for it to exist
  // rather than racing the first insert.
  await User.init();
  app = createApp({ sessionStore: new session.MemoryStore() });
});

after(async () => { await db.disconnect(); });

describe('POST /auth/register', () => {
  test('creates the account, signs it in, and gives it one owner workspace with seeded content', async () => {
    const email = uniqueEmail('new-account');
    const agent = request.agent(app);
    const { res, user, workspace } = await register(agent, email);

    assert.equal(res.status, 201, `registration failed: ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { ok: true }, 'the response must not echo the account back');
    assert.ok(user, 'registration must persist a User');

    // Registration signs you in — a signup that dropped you on the login form
    // would be a UX regression, and it is what the session cookie here proves.
    assert.ok(sessionCookie(res), 'registration must issue a session cookie');
    assert.equal(called('GET /auth/me after register', await agent.get('/auth/me')).status, 200);

    // Exactly one workspace: a second one would be an orphan the user can never
    // switch to, and resolveWorkspace would pick between them arbitrarily.
    const workspaceCount = await Workspace.countDocuments({ 'members.userId': user._id });
    assert.equal(workspaceCount, 1, 'registration must create exactly one workspace for the new user');

    assert.ok(workspace, 'the new user must be a member of a workspace');
    assert.equal(String(workspace.ownerId), String(user._id), 'the new user must own their workspace');
    assert.equal(workspace.members.length, 1, 'a fresh workspace has exactly one member');
    assert.equal(workspace.members[0].role, 'owner', 'the first member must be an owner, not an editor or viewer');
    assert.equal(String(workspace.members[0].userId), String(user._id));

    // Seeding is best-effort by design (see lib/workspaceSeeder.js) but the
    // relationship types are the part that must not be missing: without them
    // the relationship picker is empty on first use.
    const typeCount = await RelationshipType.countDocuments({ workspaceId: workspace._id });
    assert.ok(typeCount > 0, `registration must seed at least one RelationshipType, got ${typeCount}`);
    log('normal', `workspace ${workspace._id} seeded ${typeCount} relationship type(s) (source: seedWorkspace at registration)`);
  });

  test('stores the email lowercased and trimmed', async () => {
    const email = uniqueEmail('Mixed-Case');
    const { res, user } = await register(request.agent(app), `  ${email.toUpperCase()}  `);

    assert.equal(res.status, 201);
    assert.ok(user, 'the account must be findable by its normalised address');
    assert.equal(user.email, email.toLowerCase(), 'the stored email must be lowercased and trimmed');
  });

  test('a duplicate email is 409 and creates no second account or workspace', async () => {
    const email = uniqueEmail('duplicate');
    const first = await register(request.agent(app), email);
    assert.equal(first.res.status, 201);

    const second = await request(app).post('/auth/register').send({ email, password: PASSWORD });
    called('POST /auth/register (duplicate)', second);

    assert.equal(second.status, 409, 'a taken address must be refused');
    assert.equal(second.body.error, 'Email already registered');
    assert.equal(await User.countDocuments({ email }), 1, 'the duplicate must not create a second user');
    assert.equal(
      await Workspace.countDocuments({ 'members.userId': first.user._id }), 1,
      'the refused registration must not have created a second workspace',
    );
  });

  test('a duplicate that differs only in casing is 409 too', async () => {
    const email = uniqueEmail('case-duplicate');
    assert.equal((await register(request.agent(app), email)).res.status, 201);

    const second = await request(app)
      .post('/auth/register')
      .send({ email: email.toUpperCase(), password: PASSWORD });
    called('POST /auth/register (upper-cased duplicate)', second);

    // The route's check is `User.findOne({ email })`, which only catches this
    // because Mongoose runs the schema's lowercase setter on query filters as
    // well as on writes. Drop `lowercase: true` and this becomes a second
    // account for the same person.
    assert.equal(second.status, 409, 'casing must not buy a second account for the same address');
    assert.equal(await User.countDocuments({ email }), 1);
  });

  test('the unique index refuses a duplicate the route never sees', async () => {
    const email = uniqueEmail('index-backstop');
    assert.equal((await register(request.agent(app), email)).res.status, 201);

    // Straight at the model, bypassing the route's findOne — this is the
    // guarantee that survives two concurrent signups (see the note at the top
    // of this file about how the route currently handles that).
    await assert.rejects(
      () => User.create({ email: email.toUpperCase(), passwordHash: 'not-a-real-hash' }),
      (err) => {
        assert.equal(err.code, 11000, `expected a duplicate-key error, got ${err.code ?? err.name}: ${err.message}`);
        return true;
      },
      'User.email must be uniquely indexed, case-insensitively',
    );
    assert.equal(await User.countDocuments({ email }), 1);
  });

  test('a missing email or password is 400 and creates nothing', async () => {
    const email = uniqueEmail('incomplete');

    const noPassword = called('POST /auth/register (no password)', await request(app).post('/auth/register').send({ email }));
    assert.equal(noPassword.status, 400);
    assert.equal(noPassword.body.error, 'Email and password are required');

    const noEmail = called('POST /auth/register (no email)', await request(app).post('/auth/register').send({ password: PASSWORD }));
    assert.equal(noEmail.status, 400);

    const noBody = called('POST /auth/register (no body)', await request(app).post('/auth/register'));
    assert.equal(noBody.status, 400, 'a bodyless request must be refused, not crash on destructuring');

    assert.equal(await User.countDocuments({ email }), 0, 'a rejected registration must persist nothing');
  });
});

describe('POST /auth/login', () => {
  test('signs in with the right password whatever the casing of the email', async () => {
    const email = uniqueEmail('login-casing');
    assert.equal((await register(request.agent(app), email)).res.status, 201);

    const agent = request.agent(app);
    const res = called('POST /auth/login (upper-cased email)', await agent
      .post('/auth/login')
      .send({ email: email.toUpperCase(), password: PASSWORD }));

    assert.equal(res.status, 200, 'the same person must be able to sign in from a capitalising keyboard');
    assert.deepEqual(res.body, { ok: true });
    assert.ok(sessionCookie(res), 'a successful login must issue a session cookie');
    assert.equal((await agent.get('/auth/me')).status, 200);
  });

  test('a wrong password and an unknown email are byte-identical 401s', async () => {
    const known = uniqueEmail('enumeration');
    assert.equal((await register(request.agent(app), known)).res.status, 201);

    const wrongPassword = await request(app).post('/auth/login').send({ email: known, password: WRONG_PASSWORD });
    const unknownEmail  = await request(app).post('/auth/login').send({ email: uniqueEmail('never-registered'), password: PASSWORD });

    log('verbose', `wrong-password body: ${JSON.stringify(wrongPassword.text)}`);
    log('verbose', `unknown-email body:  ${JSON.stringify(unknownEmail.text)}`);

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);

    // Raw bytes, not the parsed body: a difference in wording, whitespace or
    // key order is exactly the signal an enumeration attack reads.
    assert.equal(
      Buffer.compare(Buffer.from(wrongPassword.text), Buffer.from(unknownEmail.text)), 0,
      `401 bodies differ: ${JSON.stringify(wrongPassword.text)} vs ${JSON.stringify(unknownEmail.text)}`,
    );
    assert.equal(wrongPassword.headers['content-length'], unknownEmail.headers['content-length'], 'a length difference is a signal too');
    assert.equal(wrongPassword.headers['content-type'], unknownEmail.headers['content-type']);

    // The message must not name which half was wrong, even in the case where
    // both bodies happen to say the same wrong thing.
    assert.equal(wrongPassword.body.error, 'Invalid email or password');
    assert.doesNotMatch(wrongPassword.body.error, /not found|no such|unknown|unregistered/i);

    // A cookie on one path and not the other would distinguish them as surely
    // as the body would.
    assert.equal(sessionCookie(wrongPassword), null, 'a failed login must not open a session');
    assert.equal(sessionCookie(unknownEmail), null);
  });

  test('a missing email or password is 400 before any lookup', async () => {
    const noPassword = called('POST /auth/login (no password)', await request(app).post('/auth/login').send({ email: uniqueEmail('partial') }));
    assert.equal(noPassword.status, 400);
    assert.equal(noPassword.body.error, 'Email and password are required');

    const noBody = called('POST /auth/login (no body)', await request(app).post('/auth/login'));
    assert.equal(noBody.status, 400, 'a bodyless request must be refused, not crash on destructuring');
  });

  test('a successful login rotates the session id', async () => {
    const email = uniqueEmail('fixation');
    const agent = request.agent(app);

    const registered = await register(agent, email);
    assert.equal(registered.res.status, 201);
    const beforeLogin = sessionCookie(registered.res);

    const res = await agent.post('/auth/login').send({ email, password: PASSWORD });
    assert.equal(res.status, 200);
    const afterLogin = sessionCookie(res);

    log('verbose', `session before login: ${beforeLogin}`);
    log('verbose', `session after login:  ${afterLogin}`);

    // `req.session.regenerate()` in the login handler is what makes this true.
    // Without it a session id known before authentication stays valid after it,
    // which is the whole of session fixation.
    assert.ok(beforeLogin && afterLogin, 'both responses must carry a session cookie');
    assert.notEqual(afterLogin, beforeLogin, 'login must issue a new session id, not adopt the existing one');
  });
});

describe('GET /auth/me', () => {
  test('is 401 anonymous, 200 after login, and 401 again after logout', async () => {
    const email = uniqueEmail('me-lifecycle');
    assert.equal((await register(request.agent(app), email)).res.status, 201);

    // A fresh agent, so the 401 below is a genuine anonymous request rather
    // than the registration session being reused.
    const agent = request.agent(app);

    const anonymous = called('GET /auth/me (anonymous)', await agent.get('/auth/me'));
    assert.equal(anonymous.status, 401);
    assert.deepEqual(anonymous.body, { authenticated: false });

    assert.equal(called('POST /auth/login', await agent.post('/auth/login').send({ email, password: PASSWORD })).status, 200);

    const authenticated = called('GET /auth/me (logged in)', await agent.get('/auth/me'));
    assert.equal(authenticated.status, 200);
    assert.deepEqual(authenticated.body, { authenticated: true });

    assert.equal(called('POST /auth/logout', await agent.post('/auth/logout')).status, 200);

    const afterLogout = called('GET /auth/me (logged out)', await agent.get('/auth/me'));
    assert.equal(afterLogout.status, 401);
    assert.deepEqual(afterLogout.body, { authenticated: false });
  });
});

describe('POST /auth/logout', () => {
  test('destroys the session server-side, not just the browser cookie', async () => {
    const email = uniqueEmail('logout-destroy');
    assert.equal((await register(request.agent(app), email)).res.status, 201);

    const agent = request.agent(app);
    const login = await agent.post('/auth/login').send({ email, password: PASSWORD });
    assert.equal(login.status, 200);
    const cookie = sessionCookie(login);
    assert.ok(cookie, 'login must issue a session cookie to invalidate');
    log('verbose', `captured live session cookie: ${cookie}`);

    const res = called('POST /auth/logout', await agent.post('/auth/logout'));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.ok(clearsSessionCookie(res), 'logout must expire connect.sid in the browser');

    // The real assertion: replay the cookie the browser was told to forget. If
    // logout only cleared the cookie, this still returns 200 — and anyone who
    // captured the value (a shared machine, a proxy log) is still signed in.
    const replayed = called('GET /auth/me with the pre-logout cookie', await request(app).get('/auth/me').set('Cookie', cookie));
    assert.equal(replayed.status, 401, 'the destroyed session must not be usable by a client that kept the cookie');
    assert.deepEqual(replayed.body, { authenticated: false });
  });

  test('without a session it is 401', async () => {
    const res = called('POST /auth/logout (anonymous)', await request(app).post('/auth/logout'));

    assert.equal(res.status, 401, 'logout sits behind requireAuth');
    assert.equal(res.body.error, 'Unauthorized');
  });
});
