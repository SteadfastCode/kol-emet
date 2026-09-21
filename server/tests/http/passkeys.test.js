/**
 * HTTP tests for passkeys: register, sign in, and confirm an account deletion,
 * over the real stack and the real @simplewebauthn/server verification.
 *
 * KOL-024: registration stored every credential id base64url-encoded a second
 * time, and every lookup compared against the id the browser sends, so no
 * passkey was ever recognized. No test caught it because no test could run a
 * ceremony. tests/helpers/softAuthenticator.js is a software authenticator that
 * answers the server's own options with real attestation and assertion
 * objects, signed with a real P-256 key, so nothing here is stubbed. Like a
 * browser, it also refuses to use a credential that a non-empty
 * allowCredentials does not name, so an id offered in the wrong form fails
 * here as it would on a device.
 *
 * What each test defends:
 *   - A passkey registered now is stored under the id the browser sends, and
 *     signs in by it, with an email (allowCredentials) and without one
 *     (discoverable). deviceType and backedUp come from the authenticator.
 *   - A passkey stored in the legacy form is offered in its corrected form,
 *     signs in, and is rewritten to the correct form on that first sign-in.
 *     The legacy value is written straight into the database, as a pre-fix
 *     registration left it.
 *   - An impostor that holds the id but not the key signs in as no one and
 *     triggers no rewrite. An unknown or malformed id is a 401, not a crash.
 *   - A credential id that is already registered is refused with 409, wherever
 *     it is: on another account, on the caller's own, and on an account that
 *     stored it in the legacy form. Nothing is saved, and the account holding
 *     it keeps exactly what it had (KOL-036).
 *   - And refused in the other direction too: an authenticator chooses its own
 *     raw credential-id bytes, so bytes equal to `utf8(victimId)` are reported
 *     as the id `legacyEncoding(victimId)` — a different string that names the
 *     same row at sign-in. The duplicate check asked only about the new id's
 *     own two forms, so that copy used to be stored and the victim's sign-in
 *     could then resolve to the attacker's row (KOL-043).
 *   - Account deletion's passkey confirmation recognizes a legacy id too, and
 *     a real assertion deletes the account. This is the success path
 *     accountDeletion.test.js could not reach.
 *   - Settings (KOL-025). GET /auth/webauthn/passkeys lists the caller's own
 *     passkeys with what labels them, and no response carries a public key.
 *     DELETE removes only the caller's own, in either stored form, and refuses
 *     the last way into an account with no password. Both need a browser
 *     session, not the bearer token. A sign-in records lastUsedAt and fills in
 *     a legacy passkey's sync status.
 *
 * Falsification checks: re-encode `credential.id` in passkeyFromRegistration
 * (lib/passkeyIds.js) and the first test fails on the stored id and then a 401;
 * drop the legacy branch of matchCredentialId and the legacy sign-in and
 * deletion tests fail (401 / 403), and so does the duplicate-id test that goes
 * through a legacy value; drop the rewrite in migrateCredentialId and the
 * legacy sign-in test fails on the stored id; offer stored ids unconverted in
 * credentialDescriptors and the authenticator refuses the legacy challenges;
 * drop the User.exists() check in register/complete and every duplicate-id test
 * gets a 200 and a second account holding the same credential; narrow it back
 * to credentialIdQuery and the KOL-043 test gets a 200 and stores the crafted
 * copy.
 * For Settings: answer with the stored passkeys instead of passkeySummary() and
 * the public-key checks fail; drop the `$nor` condition on the removal and the
 * passwordless test gets a 200; skip the flag update in recordUse and the
 * legacy sync-status test fails; fall through to next() for a bearer token and
 * the session test fails.
 *
 * Isolation: every test registers its own account under a unique email, for
 * the reasons at the top of tests/http/auth.test.js.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_PASSKEY_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per account and per passkey created or altered, naming
 *             what did it and the ids involved
 *   normal  — light, plus every ceremony call and what it answered
 *   verbose — normal, plus the passkeys read back from the database
 * The routes log on PASSKEY_LOG_LEVEL (and ACCOUNT_DELETE_LOG_LEVEL), silenced
 * here unless set, for when a failure needs their trail.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import session from 'express-session';
import request from 'supertest';

import * as db from '../helpers/db.js';
import { createSoftAuthenticator } from '../helpers/softAuthenticator.js';
import User from '../../src/models/User.js';
import { credentialIdQuery, legacyEncoding } from '../../src/lib/passkeyIds.js';

// createApp() reads NODE_ENV when called, and src/routes/auth.js reads the
// relying party at module load, so all of it is set before src/app.js is
// imported below. Not 'production': that arms secure/domain-scoped cookies
// supertest won't return. The relying party is set outright, not defaulted,
// because the software authenticator signs for exactly this origin.
const ORIGIN = 'http://localhost:5173';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
delete process.env.BEARER_TOKEN;
process.env.WEBAUTHN_RP_ID = 'localhost';
process.env.WEBAUTHN_ORIGIN = ORIGIN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.ACCOUNT_DELETE_LOG_LEVEL ??= 'off';
process.env.PASSKEY_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_PASSKEY_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/passkeys:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

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
  const agent = request.agent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
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
  log('light', `user ${t.userId}: passkey ${authenticator.id} added (source: POST /auth/webauthn/register/complete)`);
}

/** `userId`'s passkeys, as stored. */
async function storedPasskeys(userId) {
  const { passkeys } = await User.findById(userId).select('passkeys').lean();
  log('verbose', `user ${userId} passkeys: ${JSON.stringify(passkeys.map(({ publicKey, ...rest }) => rest))}`);
  return passkeys;
}

/** Puts `userId`'s first passkey back in the double-encoded form a pre-KOL-024 registration stored. */
async function makeLegacy(userId, authenticator) {
  await User.updateOne({ _id: userId }, { $set: { 'passkeys.0.credentialID': legacyEncoding(authenticator.id) } });
  log('light', `user ${userId}: passkey ${authenticator.id} stored as ${legacyEncoding(authenticator.id)} (source: this test, standing in for a pre-KOL-024 registration)`);
}

/** A passkey sign-in on a fresh agent: begin, with `email` when given, then complete with `authenticator`'s assertion. */
async function signIn(authenticator, email) {
  const agent = request.agent(app);
  const begin = called(`POST /auth/webauthn/login/begin (${email ? 'with email' : 'discoverable'})`, await agent
    .post('/auth/webauthn/login/begin')
    .send(email ? { email } : {}));
  assert.equal(begin.status, 200);
  const res = called('POST /auth/webauthn/login/complete', await agent
    .post('/auth/webauthn/login/complete')
    .send(authenticator.assert(begin.body)));
  return { agent, options: begin.body, res };
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore() });
});

after(async () => { await db.disconnect(); });

describe('passkey registration and sign-in', () => {
  test('a passkey registered now is stored under the id the browser sends, and signs in by it', async () => {
    const t = await tenant('passkey-new');
    const synced = device({ synced: true });
    await addPasskey(t, synced);

    const [stored] = await storedPasskeys(t.userId);
    assert.equal(stored.credentialID, synced.id, "the stored id must be the browser's id, not an encoding of it");
    assert.equal(stored.deviceType, 'multiDevice');
    assert.equal(stored.backedUp, true);
    assert.ok(stored.createdAt instanceof Date);
    assert.equal(stored.counter, 0);

    // With an email, the challenge names the passkey and the browser offers it.
    const withEmail = await signIn(synced, t.email);
    assert.deepEqual(withEmail.options.allowCredentials.map(c => c.id), [synced.id]);
    assert.equal(withEmail.res.status, 200, `sign-in failed: ${withEmail.res.status} ${JSON.stringify(withEmail.res.body)}`);
    assert.equal((await withEmail.agent.get('/auth/me')).status, 200, 'the sign-in must open a session');

    // Without one: a discoverable credential, found by its id alone.
    const discoverable = await signIn(synced);
    assert.deepEqual(discoverable.options.allowCredentials, []);
    assert.equal(discoverable.res.status, 200, `discoverable sign-in failed: ${discoverable.res.status} ${JSON.stringify(discoverable.res.body)}`);

    const [after] = await storedPasskeys(t.userId);
    assert.equal(after.credentialID, synced.id);
    assert.equal(after.counter, 2, 'each sign-in must advance the stored counter');
  });

  test('a device-bound passkey is recorded as neither synced nor backed up', async () => {
    const t = await tenant('passkey-device-bound');
    await addPasskey(t, device({ synced: false }));

    const [stored] = await storedPasskeys(t.userId);
    assert.equal(stored.deviceType, 'singleDevice');
    assert.equal(stored.backedUp, false);
  });

  test('a passkey stored double-encoded before KOL-024 is offered correctly, signs in, and is rewritten once', async () => {
    const t = await tenant('passkey-legacy');
    const authenticator = device();
    await addPasskey(t, authenticator);
    await makeLegacy(t.userId, authenticator);

    // Registering the same authenticator again must still be refused: the
    // exclusion list names it in the form the browser knows.
    const reRegister = called('POST /auth/webauthn/register/begin (legacy passkey on file)', await t.agent.post('/auth/webauthn/register/begin'));
    assert.deepEqual(reRegister.body.excludeCredentials.map(c => c.id), [authenticator.id]);

    const first = await signIn(authenticator, t.email);
    assert.deepEqual(first.options.allowCredentials.map(c => c.id), [authenticator.id],
      'the challenge must offer the id the browser knows, not the stored legacy value');
    assert.equal(first.res.status, 200, `legacy sign-in failed: ${first.res.status} ${JSON.stringify(first.res.body)}`);
    assert.equal((await storedPasskeys(t.userId))[0].credentialID, authenticator.id,
      'the first successful sign-in must rewrite a legacy id to the correct form');

    const second = await signIn(authenticator, t.email);
    assert.equal(second.res.status, 200, 'the rewritten passkey must keep signing in');
    const [after] = await storedPasskeys(t.userId);
    assert.equal(after.credentialID, authenticator.id);
    assert.equal(after.counter, 2);
  });

  test('an impostor holding the id but not the key signs in as no one, and rewrites nothing', async () => {
    const t = await tenant('passkey-impostor');
    const owner = device();
    await addPasskey(t, owner);
    await makeLegacy(t.userId, owner);

    const impostor = device({ id: owner.id });
    const { agent, res } = await signIn(impostor, t.email);
    assert.equal(res.status, 401, `expected 401, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'Passkey authentication failed');
    assert.equal((await agent.get('/auth/me')).status, 401, 'a failed assertion must not open a session');

    const [stored] = await storedPasskeys(t.userId);
    assert.equal(stored.credentialID, legacyEncoding(owner.id), 'an unverified assertion must not trigger the rewrite');
    assert.equal(stored.counter, 0);

    // And the owner still gets in afterwards.
    assert.equal((await signIn(owner, t.email)).res.status, 200);
  });

  test('an unknown or malformed credential id is 401 "Passkey not recognized"', async () => {
    const stranger = await signIn(device());
    assert.equal(stranger.res.status, 401);
    assert.equal(stranger.res.body.error, 'Passkey not recognized');

    for (const [what, body] of [['no id', {}], ['an object id', { id: { $ne: '' } }], ['an empty id', { id: '' }], ['no body', undefined]]) {
      const pending = request(app).post('/auth/webauthn/login/complete');
      const res = called(`POST /auth/webauthn/login/complete (${what})`, await (body === undefined ? pending : pending.send(body)));
      assert.equal(res.status, 401, `${what}: expected 401, got ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, 'Passkey not recognized', what);
    }
  });
});

describe('a credential id already registered is refused (KOL-036)', () => {
  const ALREADY = 'This passkey is already registered';

  /**
   * A registration that ignores the exclusion list, the way a crafted
   * authenticator would. addPasskey() is the honest path: the software
   * authenticator refuses to register when `excludeCredentials` names it, as a
   * browser does, so the server's own check is only reachable from a caller
   * that does not play along. An attacker has the ids to try: an email is
   * enough to make POST /auth/webauthn/login/begin list an account's.
   */
  async function registerIgnoringExclusions(t, authenticator) {
    const begin = called('POST /auth/webauthn/register/begin', await t.agent.post('/auth/webauthn/register/begin'));
    assert.equal(begin.status, 200);
    return called('POST /auth/webauthn/register/complete (exclusions ignored)', await t.agent
      .post('/auth/webauthn/register/complete')
      .send(authenticator.register({ ...begin.body, excludeCredentials: [] })));
  }

  test("another account's credential id is refused, and nothing is stored", async () => {
    const alice = await tenant('duplicate-alice');
    const bob = await tenant('duplicate-bob');
    const hers = device();
    await addPasskey(alice, hers);

    // Bob's authenticator holds her credential id and a key of its own — what
    // anyone can build from the ids a sign-in challenge hands out for an email.
    const res = await registerIgnoringExclusions(bob, device({ id: hers.id }));
    assert.equal(res.status, 409, `expected 409, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, ALREADY);
    assert.equal((await storedPasskeys(bob.userId)).length, 0, 'a refused registration must store nothing');

    // Hers is untouched, so the sign-in lookup still has one account to find.
    assert.deepEqual((await storedPasskeys(alice.userId)).map(pk => pk.credentialID), [hers.id]);
    assert.equal((await signIn(hers, alice.email)).res.status, 200, 'the owner must still sign in');
  });

  test("the caller's own credential id gets the same answer, and the passkey it already has is kept", async () => {
    const alice = await tenant('duplicate-own');
    const hers = device();
    await addPasskey(alice, hers);
    const [before] = await storedPasskeys(alice.userId);

    const again = await registerIgnoringExclusions(alice, hers);
    assert.equal(again.status, 409, `expected 409, got ${again.status} ${JSON.stringify(again.body)}`);
    assert.deepEqual(again.body, { error: ALREADY },
      'the same answer as for a stranger: the refusal must not say whose the id is');

    // The same id from a different key must not overwrite the key on file.
    const overwrite = await registerIgnoringExclusions(alice, device({ id: hers.id }));
    assert.equal(overwrite.status, 409, `expected 409, got ${overwrite.status} ${JSON.stringify(overwrite.body)}`);

    const stored = await storedPasskeys(alice.userId);
    assert.equal(stored.length, 1, 'exactly one passkey, and no second copy of it');
    assert.equal(stored[0].credentialID, hers.id);
    assert.deepEqual(stored[0].publicKey, before.publicKey, 'the stored key must still be the one registered first');
    assert.equal((await signIn(hers, alice.email)).res.status, 200, 'and it still signs in');
  });

  test('a credential id stored in the legacy double-encoded form blocks a copy of it too', async () => {
    const alice = await tenant('duplicate-legacy');
    const bob = await tenant('duplicate-legacy-other');
    const hers = device();
    await addPasskey(alice, hers);
    await makeLegacy(alice.userId, hers);

    const res = await registerIgnoringExclusions(bob, device({ id: hers.id }));
    assert.equal(res.status, 409, `expected 409, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, ALREADY);
    assert.equal((await storedPasskeys(bob.userId)).length, 0, 'a refused registration must store nothing');
    assert.deepEqual((await storedPasskeys(alice.userId)).map(pk => pk.credentialID), [legacyEncoding(hers.id)],
      'the refusal must leave the legacy value alone: only a verified assertion rewrites it');
  });

  test('a crafted id whose raw bytes spell a registered one is refused too (KOL-043)', async () => {
    const alice = await tenant('duplicate-reverse');
    const bob = await tenant('duplicate-reverse-other');
    const hers = device();
    await addPasskey(alice, hers);

    // An authenticator picks its own raw credential-id bytes. Bytes equal to
    // utf8(hers.id) are a credential of its own, with a key of its own, that
    // @simplewebauthn reports under the id legacyEncoding(hers.id) — the one
    // string a sign-in for hers.id also matches. Nothing here is stored as
    // legacy: alice holds the current form throughout.
    const crafted = device({ id: legacyEncoding(hers.id) });
    assert.equal(crafted.id, legacyEncoding(hers.id), 'the crafted authenticator must report the double-encoded id');
    assert.notEqual(crafted.id, hers.id);

    const res = await registerIgnoringExclusions(bob, crafted);
    assert.equal(res.status, 409, `expected 409, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, ALREADY);
    assert.equal((await storedPasskeys(bob.userId)).length, 0, 'a refused registration must store nothing');
    assert.deepEqual((await storedPasskeys(alice.userId)).map(pk => pk.credentialID), [hers.id],
      'and must leave the account that holds the credential untouched');

    // The point of the refusal: exactly one account answers that sign-in.
    assert.equal(await User.countDocuments(credentialIdQuery(hers.id)), 1,
      'the sign-in lookup must have one account to find, not two');
    assert.equal((await signIn(hers, alice.email)).res.status, 200, 'so the owner still signs in');
  });
});

describe('DELETE /auth/account confirmed with a passkey', () => {
  test('a passkey stored in the legacy form is offered correctly and confirms the deletion', async () => {
    const t = await tenant('passkey-delete');
    const authenticator = device({ synced: false });
    await addPasskey(t, authenticator);
    await makeLegacy(t.userId, authenticator);

    const challenge = called('POST /auth/account/passkey-challenge', await t.agent.post('/auth/account/passkey-challenge'));
    assert.equal(challenge.status, 200);
    assert.deepEqual(challenge.body.allowCredentials.map(c => c.id), [authenticator.id],
      'the confirmation challenge must offer the id the browser knows');

    const res = called('DELETE /auth/account (passkey)', await t.agent
      .delete('/auth/account')
      .send({ email: t.email, passkey: authenticator.assert(challenge.body) }));
    assert.equal(res.status, 204, `deletion failed: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(await User.countDocuments({ _id: t.userId }), 0, 'the account must be gone');
  });
});

describe('passkey management from Settings', () => {
  const SUMMARY_FIELDS = ['backedUp', 'createdAt', 'credentialID', 'deviceType', 'lastUsedAt'];

  /** No response may carry a public key: not by name, and not as any field a summary does not list. */
  function assertNoPublicKey(res) {
    assert.ok(!/publickey/i.test(res.text), `a response named a public key: ${res.text}`);
    for (const pk of res.body?.passkeys ?? []) assert.deepEqual(Object.keys(pk).sort(), SUMMARY_FIELDS);
  }

  const list = async (t) =>
    called('GET /auth/webauthn/passkeys', await t.agent.get('/auth/webauthn/passkeys'));
  const remove = async (t, id) =>
    called(`DELETE /auth/webauthn/passkeys/${id}`, await t.agent.delete(`/auth/webauthn/passkeys/${encodeURIComponent(id)}`));
  const summary = (res) => res.body.passkeys.map(pk => [pk.credentialID, pk.deviceType, pk.backedUp, pk.lastUsedAt]);

  test("GET lists the caller's own passkeys with what labels them, and no public key", async () => {
    const a = await tenant('manage-list-a');
    const b = await tenant('manage-list-b');
    const synced = device({ synced: true });
    const bound = device({ synced: false });
    await addPasskey(a, synced);
    await addPasskey(a, bound);
    await addPasskey(b, device());

    const res = await list(a);
    assert.equal(res.status, 200);
    assertNoPublicKey(res);
    assert.equal(res.body.hasPassword, true);
    assert.deepEqual(summary(res), [[synced.id, 'multiDevice', true, null], [bound.id, 'singleDevice', false, null]],
      "only this account's passkeys, in the order they were added");
    assert.ok(!Number.isNaN(Date.parse(res.body.passkeys[0].createdAt)), 'createdAt must be a date');

    const none = await list(await tenant('manage-list-none'));
    assert.deepEqual(none.body, { passkeys: [], hasPassword: true });
  });

  test('both routes need a browser session: 401 without one, 403 for the bearer token', async () => {
    const routes = [
      ['GET', () => request(app).get('/auth/webauthn/passkeys')],
      ['DELETE', () => request(app).delete('/auth/webauthn/passkeys/anything')],
    ];
    for (const [method, pending] of routes) {
      assert.equal(called(`${method} (anonymous)`, await pending()).status, 401, method);
    }
    process.env.BEARER_TOKEN = 'test-bearer-token';
    try {
      for (const [method, pending] of routes) {
        const res = called(`${method} (bearer)`, await pending().set('Authorization', 'Bearer test-bearer-token'));
        assert.equal(res.status, 403, `${method}: a connector must not manage how an account signs in`);
      }
    } finally {
      delete process.env.BEARER_TOKEN;
    }
  });

  test('a sign-in records when it happened, and the sync status a legacy passkey never had', async () => {
    const t = await tenant('manage-last-used');
    const authenticator = device({ synced: true });
    await addPasskey(t, authenticator);
    await makeLegacy(t.userId, authenticator);
    await User.updateOne({ _id: t.userId }, { $unset: { 'passkeys.0.deviceType': 1, 'passkeys.0.backedUp': 1 } });
    log('light', `user ${t.userId}: passkey sync status unset (source: this test, standing in for a pre-KOL-024 registration)`);

    const before = await list(t);
    assertNoPublicKey(before);
    assert.deepEqual(summary(before), [[authenticator.id, null, null, null]],
      'a legacy passkey is listed by the id the browser knows, its sync status unknown');

    const startedAt = Date.now();
    assert.equal((await signIn(authenticator)).res.status, 200);

    const [after] = (await list(t)).body.passkeys;
    assert.equal(after.deviceType, 'multiDevice', 'the assertion fills in what registration never recorded');
    assert.equal(after.backedUp, true);
    assert.ok(Date.parse(after.lastUsedAt) >= startedAt, `lastUsedAt must be this sign-in, got ${after.lastUsedAt}`);
  });

  test("DELETE removes only the caller's own passkey, in either stored form", async () => {
    const a = await tenant('manage-remove-a');
    const b = await tenant('manage-remove-b');
    const mine = device();
    const theirs = device();
    await addPasskey(a, mine);
    await addPasskey(b, theirs);
    await makeLegacy(a.userId, mine);

    const refused = await remove(a, theirs.id);
    assert.equal(refused.status, 404, "another account's passkey is not found, not removed");
    assertNoPublicKey(refused);
    assert.equal((await storedPasskeys(b.userId)).length, 1, "another account's passkey must survive");

    const res = await remove(a, mine.id);
    assert.equal(res.status, 200, `removal failed: ${res.status} ${JSON.stringify(res.body)}`);
    assertNoPublicKey(res);
    assert.deepEqual(res.body, { passkeys: [], hasPassword: true },
      'an account with a password may remove its only passkey');
    assert.equal((await storedPasskeys(a.userId)).length, 0);
    assert.equal((await signIn(mine, a.email)).res.status, 401, 'a removed passkey must not sign in');
    assert.equal((await remove(a, mine.id)).status, 404, 'removing it again is a 404');
  });

  test('DELETE refuses to remove the last way into an account with no password', async () => {
    const t = await tenant('manage-passwordless');
    const first = device();
    const second = device();
    await addPasskey(t, first);
    await addPasskey(t, second);
    // Every account has a password today. This rule is for the passwordless
    // ones, so the hash is unset directly, past the schema.
    await User.updateOne({ _id: t.userId }, { $unset: { passwordHash: 1 } });
    log('light', `user ${t.userId}: password unset (source: this test, standing in for a passwordless account)`);
    assert.equal((await list(t)).body.hasPassword, false);

    const res = await remove(t, first.id);
    assert.equal(res.status, 200, `with two passkeys, one may go: ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body.passkeys.map(pk => pk.credentialID), [second.id]);

    const refused = await remove(t, second.id);
    assert.equal(refused.status, 409, `the last one must stay: ${refused.status} ${JSON.stringify(refused.body)}`);
    assert.deepEqual((await storedPasskeys(t.userId)).map(pk => pk.credentialID), [second.id]);
  });
});
