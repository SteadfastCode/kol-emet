import { Router } from 'express';
import bcrypt from 'bcrypt';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { requireAuth, requireActor } from '../middleware/auth.js';
import { seedWorkspace } from '../lib/workspaceSeeder.js';
import { hasTemplate } from '../config/templates.js';
import { deleteAccount } from '../lib/accountDeleter.js';
import { createAuthLimiter } from '../lib/attemptLimiter.js';
import { clearSessionCookie } from '../lib/sessionCookie.js';
import {
  credentialConflictQuery,
  credentialDescriptors,
  credentialIdQuery,
  findPasskey,
  logPasskey,
  migrateCredentialId,
  passkeyFromRegistration,
  passkeySummary,
  recordUse,
  shortId,
  webAuthnCredential,
} from '../lib/passkeyIds.js';

const router = Router();

const RP_NAME = process.env.WEBAUTHN_RP_NAME ?? 'Kol Emet';
const RP_ID   = process.env.WEBAUTHN_RP_ID   ?? 'localhost';
const ORIGIN  = process.env.WEBAUTHN_ORIGIN  ?? 'http://localhost:5173';

// Named in every passkey log line (PASSKEY_LOG_LEVEL, see lib/passkeyIds.js).
const REGISTER_SOURCE = 'POST /auth/webauthn/register/complete';
const LOGIN_SOURCE    = 'POST /auth/webauthn/login/complete';

// ─── Failed sign-in throttling ────────────────────────────────────────────────
// Three routes below guess-check a credential: the password login, the passkey
// login, and the re-authentication that account deletion demands. Each asks the
// limiter *before* doing that work — a blocked caller costs no bcrypt hash and
// no signature verification — records a failure after one, and clears its own
// key on success. Limits, keys and logging (AUTH_LIMIT_LOG_LEVEL): see
// lib/attemptLimiter.js.

const PASSWORD_LOGIN_SOURCE = 'POST /auth/login';

/**
 * The counters createApp built for this app (`app.locals.authLimiter`,
 * src/app.js). Defaulted lazily so a router mounted on a bare Express app
 * throttles on the shipped limits rather than silently not at all.
 */
function limiter(req) {
  req.app.locals.authLimiter ??= createAuthLimiter();
  return req.app.locals.authLimiter;
}

/** The form an email is counted under: what the schema stores, so two spellings are one key. */
const emailKey = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

/**
 * Whether a request body's `email` names an address at all.
 *
 * JSON can put an object where an address belongs, and until KOL-044 both
 * things downstream of that took it for nothing: `emailKey()` answers `''` for
 * a non-string, and the limiter's `pairs()` skips a key whose value is `''`
 * (lib/attemptLimiter.js). So `POST /auth/login` with `{"email": {...}}`
 * passed the truthiness guard below, was never counted on the email key —
 * collapsing the 10-failures-per-address budget into the 100-per-source-address
 * one, and with it ~100 bcrypt hashes of this API's CPU — and still reached
 * `User.findOne({ email })`, where mongoose reads an operator object such as
 * `{"$regex": "^victim@example.test$"}` as a query and so lets the caller
 * choose the account those uncounted guesses are spent on.
 *
 * Every route that looks an account up by a body's email asks this first and
 * refuses a non-string with the 400 a missing address gets — before any
 * counter, any lookup and any hash, so it costs no more than the empty body it
 * is answered like. Deliberately not counted: it is the same refusal a missing
 * field has always got for free, and counting a malformed body against the
 * source address would let one broken client throttle a whole office.
 */
const usableEmail = (email) => typeof email === 'string' && email.trim() !== '';

/** Likewise a password: only a non-empty string is something bcrypt can be handed. */
const usablePassword = (password) => typeof password === 'string' && password !== '';

// POST /auth/register
router.post('/register', async (req, res) => {
  const { email, password, template } = req.body ?? {};
  if (!usableEmail(email) || !usablePassword(password)) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  // Naming no template gets the default; naming one that doesn't exist is
  // refused before anything is written, rather than quietly seeding the
  // default (getTemplate's fallback) into a workspace the user didn't pick.
  if (template !== undefined && !hasTemplate(template)) {
    return res.status(400).json({ error: 'Unknown template' });
  }

  // The stored form, not the raw body value: what is checked for a duplicate is
  // exactly what the schema would write, and the filter is a primitive string
  // rather than whatever the request sent (KOL-044).
  const existing = await User.findOne({ email: emailKey(email) });
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await User.create({ email, passwordHash });

  // Every user needs a workspace immediately — resolveWorkspace fails closed
  // without one, so a user created here but left workspace-less could not read
  // or write anything.
  let workspace;
  try {
    workspace = await Workspace.create({
      name:    'My Workspace',
      ownerId: user._id,
      members: [{ userId: user._id, role: 'owner' }],
    });
  } catch (err) {
    // Don't strand a user with an account but no workspace.
    await User.deleteOne({ _id: user._id });
    return res.status(500).json({ error: 'Could not create workspace' });
  }

  // Seed starting content so the new workspace isn't an empty shell. Awaited
  // so the first page load sees it, but never fatal — seedWorkspace reports
  // failure rather than throwing, and an unseeded workspace still works.
  const seed = await seedWorkspace(workspace._id, template);
  if (!seed.ok) console.error(`[auth] workspace ${workspace._id} seeded partially:`, seed.error);

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId = user._id.toString();
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: 'Session save error' });
      res.status(201).json({ ok: true });
    });
  });
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!usableEmail(email) || !usablePassword(password)) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  // Asked before the lookup as well as before the hash: an unknown address is
  // counted and blocked exactly like a known one, so the 429 says nothing
  // about who has an account here. True only because the guard above has
  // already refused everything `emailKey()` would answer `''` for — a key the
  // limiter skips is a guess nobody counts (KOL-044).
  const keys = { email: emailKey(email), ip: req.ip };
  const block = limiter(req).blocked(keys, PASSWORD_LOGIN_SOURCE);
  if (block) return limiter(req).refuse(res, block);

  // The counted key itself, so the account being guessed at is by construction
  // the one whose budget is being spent.
  const user = await User.findOne({ email: keys.email });
  if (!user) {
    limiter(req).recordFailure(keys, PASSWORD_LOGIN_SOURCE);
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    limiter(req).recordFailure(keys, PASSWORD_LOGIN_SOURCE);
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // The email's counter only. Clearing the address's own failures is what
  // keeps a fat-fingered password from locking out the person who then types
  // it right; clearing the ip's would let one valid account launder the spray
  // limit for every other account tried from the same place.
  limiter(req).reset({ email: keys.email }, PASSWORD_LOGIN_SOURCE);

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId = user._id.toString();
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: 'Session save error' });
      res.json({ ok: true });
    });
  });
});

// POST /auth/logout
router.post('/logout', requireAuth, (req, res) => {
  // Before destroy(), which takes req.session — and with it the attributes the
  // cookie was actually set with — off the request. Clearing with different
  // attributes leaves the browser holding the original cookie; see
  // lib/sessionCookie.js. The header goes out with whatever this responds,
  // including the 500 below: a logout the server could not complete should
  // still take the credential out of the browser.
  clearSessionCookie(req, res);
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    res.json({ ok: true });
  });
});

// GET /auth/me
//
// Answered from the session *and* the users collection. A session outlives the
// account it names: DELETE /auth/account destroys the caller's own, but
// connect-mongo stores the rest serialized, with no way to look a user's
// sessions up (see the Decision Log entry on account deletion). Every tenant
// route resolves the id and refuses, so reading the session alone told a
// deleted account's other browsers they were signed in and the client
// (client/src/App.vue) showed them a wiki that answers 401 to everything. So
// the id is checked here too, and a session naming a user who is gone is ended
// rather than reported: destroyed in the store, expired in the browser, and
// answered with the same 401 an anonymous caller gets.
router.get('/me', async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ authenticated: false });

  let live;
  try {
    live = await User.exists({ _id: userId });
  } catch (err) {
    // A lookup that did not answer is never 200: a database blip must not be
    // what keeps a deleted account signed in. Nor 401, which would claim the
    // session was over when nothing here ended it — it survives the blip, so a
    // reload once the database answers again signs the caller straight back in,
    // and a client that tells the two apart can say which happened.
    logDeletion('light', `GET /auth/me could not check user ${userId}: ${err.message} (source: User.exists)`);
    return res.status(500).json({ error: 'Session check failed' });
  }

  if (live) return res.json({ authenticated: true });

  logDeletion('light', `GET /auth/me: the session for user ${userId} names an account that no longer exists; ending it (source: User.exists returned nothing)`);
  // Before destroy(), which takes req.session.cookie — and with it the
  // attributes the cookie was set with — off the request; the pair is the same
  // as in DELETE /auth/account below. See lib/sessionCookie.js.
  clearSessionCookie(req, res);
  req.session.destroy((err) => {
    // Still 401: the caller is not authenticated whether or not the store
    // could drop the record, and its cookie is expired above either way.
    if (err) logDeletion('light', `GET /auth/me: the session for deleted user ${userId} was not destroyed: ${err.message}`);
    res.status(401).json({ authenticated: false });
  });
});

// POST /auth/webauthn/register/begin
router.post('/webauthn/register/begin', requireAuth, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: user.email,
    userDisplayName: user.email,
    attestationType: 'none',
    excludeCredentials: credentialDescriptors(user.passkeys),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  req.session.currentChallenge = options.challenge;
  res.json(options);
});

// POST /auth/webauthn/register/complete
router.post('/webauthn/register/complete', requireAuth, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const expectedChallenge = req.session.currentChallenge;
  delete req.session.currentChallenge;

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: false,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!verification.verified) {
    return res.status(400).json({ error: 'Passkey verification failed' });
  }

  const passkey = passkeyFromRegistration(verification.registrationInfo);

  // WebAuthn §7.1: a credential id already registered must not be stored
  // again, and "already registered" means to any account, not just this one. `login/begin` lists an account's ids to anyone who knows its email, so
  // without this a crafted authenticator could answer a challenge with a copy
  // of someone else's id and register it here; the sign-in lookup below
  // (`User.findOne(credentialIdQuery(...))`) would then have two accounts to
  // choose from and pick whichever mongod returned first. The signature check
  // still decides who gets in, so that is a denial of service rather than a
  // takeover — but a denial of service against an account that did nothing.
  // The query is credentialConflictQuery, not the sign-in lookup: it asks for
  // every stored form that would make some browser id ambiguous, which is the
  // new id, its legacy double-encoding, and — because an authenticator chooses
  // its own raw bytes — the id it is itself the legacy encoding of. Asking only
  // the first two was one-directional, and left this check open to the very
  // attack above, run backwards: raw bytes equal to `utf8(victimId)` are
  // reported as `legacyEncoding(victimId)`, which no longer matched a victim
  // holding `victimId` in the current form (KOL-043).
  //
  // One answer whichever account holds it: telling the caller that the id is
  // theirs and not a stranger's would say who else has registered it. A browser
  // reaches this only by ignoring the `excludeCredentials` it was given, which
  // is why re-registering your own device is an InvalidStateError in the
  // browser and never gets this far.
  //
  // Read then write, with no index behind it: two registrations of the same id
  // racing can still both pass this check. Closing that needs a unique index on
  // `passkeys.credentialID`, which is a change to the deployed database, so the
  // race stays a known gap (Decision Log, KOL-036).
  if (await User.exists(credentialConflictQuery(passkey.credentialID))) {
    logPasskey('light', `user ${user._id}: passkey refused, its credential id is already registered (source: ${REGISTER_SOURCE})`);
    logPasskey('verbose', `user ${user._id}: the refused credential is ${shortId(passkey.credentialID)}`);
    return res.status(409).json({ error: 'This passkey is already registered' });
  }

  user.passkeys.push(passkey);
  await user.save();
  logPasskey('light', `user ${user._id}: passkey added, ${passkey.deviceType}${passkey.backedUp ? ', backed up' : ''} (source: ${REGISTER_SOURCE})`);
  logPasskey('verbose', `user ${user._id}: the added passkey is credential ${shortId(passkey.credentialID)}`);

  res.json({ ok: true });
});

// POST /auth/webauthn/login/begin
router.post('/webauthn/login/begin', async (req, res) => {
  const { email } = req.body ?? {};

  let allowCredentials = [];
  // A string address or nothing: this lookup is unauthenticated, so an operator
  // object here would have answered with some arbitrary account's credential
  // ids rather than none (KOL-044).
  if (usableEmail(email)) {
    const user = await User.findOne({ email: emailKey(email) });
    if (user) {
      allowCredentials = credentialDescriptors(user.passkeys);
      logPasskey('verbose', `sign-in challenge for user ${user._id} offers ${allowCredentials.map(c => shortId(c.id)).join(', ') || 'no passkeys'} (source: POST /auth/webauthn/login/begin)`);
    }
  }

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials,
    userVerification: 'preferred',
  });

  req.session.currentChallenge = options.challenge;
  res.json(options);
});

// POST /auth/webauthn/login/complete
router.post('/webauthn/login/complete', async (req, res) => {
  const expectedChallenge = req.session.currentChallenge;
  delete req.session.currentChallenge;

  // Keyed by address alone: this body carries a credential id, never an email,
  // so there is no account to key on until the lookup below — and the lookup is
  // what the throttle is protecting. A guessed assertion is unforgeable rather
  // than merely expensive, but the route still reads the database and runs a
  // signature check per request.
  const keys = { ip: req.ip };
  const block = limiter(req).blocked(keys, LOGIN_SOURCE);
  if (block) return limiter(req).refuse(res, block);

  // The browser's id, matched against both stored forms. Anything but a
  // non-empty string names no credential and must not reach the query.
  const browserId = typeof req.body?.id === 'string' ? req.body.id : '';
  logPasskey('verbose', `sign-in lookup for credential ${shortId(browserId)} (source: ${LOGIN_SOURCE})`);
  const user = browserId ? await User.findOne(credentialIdQuery(browserId)) : null;
  const found = user && findPasskey(user.passkeys, browserId);
  if (!found) {
    limiter(req).recordFailure(keys, LOGIN_SOURCE);
    logPasskey('normal', `passkey sign-in refused: no account holds the credential (source: ${LOGIN_SOURCE})`);
    return res.status(401).json({ error: 'Passkey not recognized' });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: webAuthnCredential(found.passkey, browserId),
      requireUserVerification: false,
    });
  } catch (err) {
    limiter(req).recordFailure(keys, LOGIN_SOURCE);
    logPasskey('normal', `passkey sign-in refused for user ${user._id}: ${err.message} (source: ${LOGIN_SOURCE})`);
    return res.status(400).json({ error: err.message });
  }

  if (!verification.verified) {
    limiter(req).recordFailure(keys, LOGIN_SOURCE);
    logPasskey('normal', `passkey sign-in refused for user ${user._id}: the assertion did not verify (source: ${LOGIN_SOURCE})`);
    return res.status(401).json({ error: 'Passkey authentication failed' });
  }

  logPasskey('normal', `passkey sign-in for user ${user._id}, stored id in the ${found.legacy ? 'legacy' : 'current'} form (source: ${LOGIN_SOURCE})`);
  recordUse(found.passkey, verification.authenticationInfo, { userId: user._id, source: LOGIN_SOURCE });
  migrateCredentialId(found, browserId, { userId: user._id, source: LOGIN_SOURCE });
  try {
    await user.save();
  } catch (err) {
    // Express 4 does not catch a rejection here, and an uncaught one ends the
    // process. A passkey removed in Settings between the lookup and this save
    // lands here as a VersionError (see DELETE /auth/webauthn/passkeys).
    logPasskey('light', `passkey sign-in for user ${user._id} not recorded: ${err.message} (source: ${LOGIN_SOURCE})`);
    return res.status(500).json({ error: 'Could not complete sign-in' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId = user._id.toString();
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: 'Session save error' });
      res.json({ ok: true });
    });
  });
});

// ─── Passkey management ───────────────────────────────────────────────────────
// Settings lists the signed-in user's passkeys and removes them here, and adds
// one through the register routes above. A passkey lives on the device or
// password manager that made it, so this is how an account made on a desktop
// gets one on a phone.
//
// Session only, like account deletion: requireAuth also admits the MCP bearer
// token, which carries no user of its own, and a connector does not get to
// change how an account signs in. Both routes answer through passkeySummary(),
// a list of fields, so a public key never leaves the server. Logs on
// PASSKEY_LOG_LEVEL (lib/passkeyIds.js).

const LIST_SOURCE   = 'GET /auth/webauthn/passkeys';
const REMOVE_SOURCE = 'DELETE /auth/webauthn/passkeys/:credentialID';

/** The session's user id. For a bearer caller, answers 403 and returns null. */
function sessionUserId(req, res, source) {
  if (req.session?.userId) return req.session.userId;
  logPasskey('normal', `${source} refused: bearer token, not a session`);
  res.status(403).json({ error: 'Managing passkeys needs a signed-in browser session' });
  return null;
}

/** What both routes answer. `hasPassword` tells Settings whether the last passkey may go. */
const passkeyList = (user) => ({
  passkeys: (user.passkeys ?? []).map(passkeySummary),
  hasPassword: Boolean(user.passwordHash),
});

// GET /auth/webauthn/passkeys
router.get('/webauthn/passkeys', requireAuth, async (req, res) => {
  const userId = sessionUserId(req, res, LIST_SOURCE);
  if (!userId) return;
  try {
    const user = await User.findById(userId).select('passwordHash passkeys').lean();
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    logPasskey('verbose', `user ${userId}: ${user.passkeys?.length ?? 0} passkey(s) listed (source: ${LIST_SOURCE})`);
    res.json(passkeyList(user));
  } catch (err) {
    logPasskey('light', `${LIST_SOURCE} failed for user ${userId}: ${err.message}`);
    res.status(500).json({ error: 'Could not load passkeys' });
  }
});

// DELETE /auth/webauthn/passkeys/:credentialID
router.delete('/webauthn/passkeys/:credentialID', requireAuth, async (req, res) => {
  const userId = sessionUserId(req, res, REMOVE_SOURCE);
  if (!userId) return;
  try {
    const user = await User.findById(userId).select('passkeys');
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Only the caller's own passkeys are searched, so another account's id is
    // a 404 like an unknown one and says nothing about whose it is. Either
    // stored form matches, as at sign-in.
    const found = findPasskey(user.passkeys, req.params.credentialID);
    if (!found) {
      logPasskey('normal', `${REMOVE_SOURCE} refused for user ${userId}: not one of this account's passkeys`);
      return res.status(404).json({ error: 'Passkey not found' });
    }

    // The last-way-in rule is a condition of the write, not a read before it,
    // so two removals racing for the last two passkeys of an account with no
    // password cannot both land. Bumping __v makes a sign-in that loaded the
    // array before this pull fail its save, rather than write its counter to
    // whichever passkey has moved into the old position.
    const onlyWayIn = { passwordHash: { $in: [null, ''] }, 'passkeys.1': { $exists: false } };
    const result = await User.updateOne(
      { _id: user._id, $nor: [onlyWayIn] },
      { $pull: { passkeys: { _id: found.passkey._id } }, $inc: { __v: 1 } },
    );
    if (result.matchedCount === 0) {
      logPasskey('normal', `${REMOVE_SOURCE} refused for user ${userId}: it is the account's last way to sign in`);
      return res.status(409).json({ error: 'This passkey is the only way to sign in to this account. Add another before removing it.' });
    }
    if (result.modifiedCount === 0) {
      logPasskey('normal', `${REMOVE_SOURCE} refused for user ${userId}: already removed`);
      return res.status(404).json({ error: 'Passkey not found' });
    }
    logPasskey('light', `user ${userId}: passkey removed, ${found.passkey.deviceType ?? 'sync status unrecorded'}${found.passkey.backedUp ? ', backed up' : ''} (source: ${REMOVE_SOURCE})`);
    logPasskey('verbose', `user ${userId}: the removed passkey was credential ${shortId(found.passkey.credentialID)}`);

    res.json(passkeyList(await User.findById(userId).select('passwordHash passkeys').lean()));
  } catch (err) {
    logPasskey('light', `${REMOVE_SOURCE} failed for user ${userId}: ${err.message}`);
    res.status(500).json({ error: 'Could not remove the passkey' });
  }
});

// ─── Account deletion ─────────────────────────────────────────────────────────
// DELETE /auth/account runs the lib/accountDeleter.js cascade for the signed-in
// user. A session alone is not enough: the body must prove the account again —
// the current password, or a passkey assertion against a challenge from
// POST /auth/account/passkey-challenge — and repeat the account's email, which
// is the confirmation the settings UI has the user type.
//
// Session only. requireActor also admits the MCP bearer token, a single secret
// shared with an AI connector; ending an account is not something it gets to
// do on a user's behalf, with or without their password.
//
// Logs on the deleter's own knob, ACCOUNT_DELETE_LOG_LEVEL (off | light |
// normal | verbose, default light), so one setting traces the whole path. Ids
// only, never the email — see lib/accountDeleter.js.
//   light  — every refusal and failure, with its reason and the user id
//   normal — light, plus each passkey challenge issued

const DELETE_SOURCE = 'DELETE /auth/account';
const CHALLENGE_SOURCE = 'POST /auth/account/passkey-challenge';
const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logDeletion(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.ACCOUNT_DELETE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[auth/account:${level}] ${msg}`);
}

/** Answers 403 and returns true when the caller is the MCP bearer token rather than a session. */
function refusedBearer(req, res, source) {
  if (req.actor.type === 'user') return false;
  logDeletion('light', `${source} refused for user ${req.actor.userId}: bearer token, not a session`);
  res.status(403).json({ error: 'Account deletion needs a signed-in browser session' });
  return true;
}

/** Null when `response` is a valid assertion by one of `user`'s own passkeys; otherwise why not. */
async function passkeyRefusal(req, user, response) {
  // Spent on every attempt, pass or fail, so one challenge buys one try.
  const expectedChallenge = req.session.accountDeleteChallenge;
  delete req.session.accountDeleteChallenge;
  if (!expectedChallenge) return 'no passkey challenge was issued to this session';

  const found = findPasskey(user.passkeys, response.id);
  if (!found) return 'the passkey is not registered to this account';

  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: webAuthnCredential(found.passkey, response.id),
      requireUserVerification: false,
    });
    if (!verification.verified) return 'the passkey assertion did not verify';
    // The use recorded, and a legacy id repaired, even though a success
    // usually deletes the user: a 409 refusal leaves the account, and its
    // passkey, in place.
    recordUse(found.passkey, verification.authenticationInfo, { userId: user._id, source: DELETE_SOURCE });
    migrateCredentialId(found, response.id, { userId: user._id, source: DELETE_SOURCE });
    await user.save();
    return null;
  } catch (err) {
    return `the passkey assertion was rejected: ${err.message}`;
  }
}

// POST /auth/account/passkey-challenge
router.post('/account/passkey-challenge', requireActor, async (req, res) => {
  if (refusedBearer(req, res, CHALLENGE_SOURCE)) return;
  try {
    const user = await User.findById(req.actor.userId).select('passkeys').lean();
    if (!user?.passkeys?.length) return res.status(400).json({ error: 'This account has no passkey' });

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: credentialDescriptors(user.passkeys),
      userVerification: 'preferred',
    });
    // Its own key, not currentChallenge: a challenge minted to sign in must not
    // be spendable on deleting an account, nor the other way round.
    req.session.accountDeleteChallenge = options.challenge;
    logDeletion('normal', `passkey challenge issued to user ${req.actor.userId} (source: ${CHALLENGE_SOURCE})`);
    res.json(options);
  } catch (err) {
    logDeletion('light', `${CHALLENGE_SOURCE} failed for user ${req.actor.userId}: ${err.message}`);
    res.status(500).json({ error: 'Could not start passkey confirmation' });
  }
});

// DELETE /auth/account
router.delete('/account', requireActor, async (req, res) => {
  if (refusedBearer(req, res, DELETE_SOURCE)) return;
  const { userId } = req.actor;

  try {
    const { email, password, passkey } = req.body ?? {};
    const hasPassword = typeof password === 'string' && password.length > 0;
    const hasPasskey  = !hasPassword && passkey !== null && typeof passkey === 'object';
    if (typeof email !== 'string' || !email.trim() || (!hasPassword && !hasPasskey)) {
      logDeletion('light', `${DELETE_SOURCE} refused for user ${userId}: no email confirmation or no credential`);
      return res.status(400).json({ error: 'Confirm with your account email and your password or a passkey' });
    }

    // Before the bcrypt compare (and before the passkey verification), keyed
    // by the account rather than the address: the caller is already signed in,
    // so who is guessing is known, and a session is not a licence to try every
    // password its owner might have.
    const keys = { user: String(userId) };
    const block = limiter(req).blocked(keys, DELETE_SOURCE);
    if (block) {
      logDeletion('light', `${DELETE_SOURCE} refused for user ${userId}: too many failed confirmations, retry after ${block.retryAfter}s`);
      return limiter(req).refuse(res, block);
    }

    const user = await User.findById(userId).select('email passwordHash passkeys');
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // The normalisation the schema applies on write, so the two agree.
    if (email.trim().toLowerCase() !== user.email) {
      logDeletion('light', `${DELETE_SOURCE} refused for user ${userId}: typed email does not match the account`);
      return res.status(400).json({ error: 'That email does not match this account' });
    }

    const refusal = hasPassword
      ? (await bcrypt.compare(password, user.passwordHash) ? null : 'wrong password')
      : await passkeyRefusal(req, user, passkey);
    if (refusal) {
      // Counted: a wrong password and a bad assertion are both failed
      // re-authentication. The typed-email mismatch above is not — it is the
      // confirmation the UI asks for, not a credential, and mistyping it
      // should not spend the budget for getting the password right.
      limiter(req).recordFailure(keys, DELETE_SOURCE);
      logDeletion('light', `${DELETE_SOURCE} refused for user ${userId}: ${refusal}`);
      // 403, not 401: the session is fine, the re-authentication was not, and
      // a 401 would tell the client it had been signed out.
      return res.status(403).json({ error: hasPassword ? 'Incorrect password' : 'Passkey confirmation failed' });
    }
    // Cleared even though the account is usually about to be deleted: a 409
    // below leaves it in place, and its owner should not then be locked out of
    // confirming by the tries it took to get here.
    limiter(req).reset(keys, DELETE_SOURCE);

    const result = await deleteAccount(userId, { source: DELETE_SOURCE });
    if (!result.ok && result.reason === 'member-elsewhere') {
      return res.status(409).json({
        error: 'This account belongs to workspaces it does not solely own; nothing was deleted',
        memberships: result.memberships,
      });
    }
    if (!result.ok) return res.status(404).json({ error: 'Account not found' });
  } catch (err) {
    // The deleter is ordered so that a failure part-way leaves the user and
    // their workspaces in place, which makes a retry the right advice.
    logDeletion('light', `${DELETE_SOURCE} failed for user ${userId}: ${err.message}`);
    return res.status(500).json({ error: 'Account deletion failed part-way; it is safe to try again' });
  }

  // Before destroy(), which takes req.session.cookie with it. Clearing with the
  // attributes the cookie was set with is what lets the browser match it: a
  // bare clearCookie misses a domain-scoped cookie entirely.
  clearSessionCookie(req, res);
  req.session.destroy((err) => {
    // The account is already gone, so this still answers 204. A session that
    // outlives it holds a dangling id, and every route that reads one refuses:
    // requireActor and resolveWorkspace look the user up, and GET /auth/me
    // above does too, destroying the session it finds dangling.
    if (err) logDeletion('light', `${DELETE_SOURCE}: user ${userId} deleted, but the session was not destroyed: ${err.message}`);
    res.status(204).end();
  });
});

export default router;
