import { Router } from 'express';
import bcrypt from 'bcrypt';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import User from '../models/User.js';
import { logSessions, requireAuth, requireActor, stampSession } from '../middleware/auth.js';
import {
  DEFAULT_WORKSPACE_NAME,
  WORKSPACE_NAME_MAX,
  workspaceLog,
  workspaceName,
} from '../middleware/workspace.js';
import { createWorkspace } from '../lib/workspaceSeeder.js';
import { hasTemplate } from '../config/templates.js';
import { deleteAccount } from '../lib/accountDeleter.js';
import { createAuthLimiter } from '../lib/attemptLimiter.js';
import { passwordProblem } from '../lib/passwordPolicy.js';
import { clearSessionCookie } from '../lib/sessionCookie.js';
import { closeStreamsForSession, closeStreamsForUser } from '../lib/broadcaster.js';
import {
  credentialConflictQuery,
  credentialDescriptors,
  credentialIdQuery,
  findPasskey,
  logPasskey,
  migrateCredentialId,
  newUserHandle,
  passkeyFromRegistration,
  passkeySummary,
  recordUse,
  shortId,
  userHandleBytes,
  webAuthnCredential,
} from '../lib/passkeyIds.js';

const router = Router();

const RP_NAME = process.env.WEBAUTHN_RP_NAME ?? 'Kol Emet';
const RP_ID   = process.env.WEBAUTHN_RP_ID   ?? 'localhost';
const ORIGIN  = process.env.WEBAUTHN_ORIGIN  ?? 'http://localhost:5173';

// Named in every passkey log line (PASSKEY_LOG_LEVEL, see lib/passkeyIds.js).
const REGISTER_BEGIN_SOURCE = 'POST /auth/webauthn/register/begin';
const REGISTER_SOURCE = 'POST /auth/webauthn/register/complete';
const LOGIN_SOURCE    = 'POST /auth/webauthn/login/complete';

// ─── Auth throttling ──────────────────────────────────────────────────────────
// Four routes below guess-check a credential: the password login, the passkey
// login, and the re-authentication that account deletion and a password change
// each demand — those last two keyed by the account and sharing one counter,
// since they are the same guess at the same secret. Each asks the limiter
// *before* doing that work — a blocked caller costs no bcrypt hash and no
// signature verification — records a failure after one, and clears its own key
// on success.
//
// `POST /auth/register` is the fourth, and the odd one out: it has no credential
// to guess at, so what it counts is a created account, keyed on the client
// address under its own kind and its own hour-long window. It is also the only
// one that knows *before* the expensive work whether this is a request it must
// charge for, so it takes its slot up front with `reserve` and hands it back
// with `release` on the one refusal that reaches past the gate — a ceiling
// read before the work and written after it is no ceiling at all for callers
// that arrive together (KOL-081). Limits, keys and logging
// (AUTH_LIMIT_LOG_LEVEL): see lib/attemptLimiter.js.

const PASSWORD_LOGIN_SOURCE = 'POST /auth/login';
const SIGNUP_SOURCE         = 'POST /auth/register';

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

/**
 * Puts `user` in a fresh session and answers `{ ok: true }`. Every sign-in here
 * ends in this one function — the password login, the passkey login and
 * registration — so the `issuedAt` stamp that `POST /auth/sessions/revoke-all`
 * is measured against cannot be forgotten by one of the three (KOL-076).
 *
 * `regenerate` first, as all three did before: a new session id for a new
 * sign-in is what keeps a pre-login id from being usable afterwards.
 */
function startSession(req, res, user, { status = 200, source }) {
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId = user._id.toString();
    const issuedAt = stampSession(req.session);
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: 'Session save error' });
      logSessions('normal', `session ${req.sessionID} issued for user ${user._id} at ${new Date(issuedAt).toISOString()} (source: ${source})`);
      res.status(status).json({ ok: true });
    });
  });
}

// POST /auth/register
router.post('/register', async (req, res) => {
  const { email, password, template, workspaceName: requestedName } = req.body ?? {};
  if (!usableEmail(email) || !usablePassword(password)) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  // The only rule about the password itself, from the module POST /auth/password
  // calls too, so what it takes to create an account and what it takes to change
  // one cannot drift apart (lib/passwordPolicy.js). Asked here: after the
  // missing-field refusal, which keeps its own wording, and before any counter,
  // any lookup and the hash — a password that could never be stored costs the
  // caller nothing and spends no signup budget, like every other 400 here.
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });
  // Naming no template gets the default; naming one that doesn't exist is
  // refused before anything is written, rather than quietly seeding the
  // default (getTemplate's fallback) into a workspace the user didn't pick.
  if (template !== undefined && !hasTemplate(template)) {
    return res.status(400).json({ error: 'Unknown template' });
  }
  // The new workspace's name (KOL-071). Optional: absent, it is the default
  // every account got before this, so an existing client is unaffected.
  // Present, it goes through the same rule `PATCH /workspace` uses
  // (middleware/workspace.js) and a bad one is refused here, next to the
  // template check and before any write — a 400 that creates no account is
  // strictly better than an account whose workspace is named something the
  // user did not ask for.
  const newWorkspaceName = requestedName === undefined
    ? DEFAULT_WORKSPACE_NAME
    : workspaceName(requestedName);
  if (!newWorkspaceName) {
    workspaceLog('light', `refused registration (source: POST /auth/register from ${req.ip}): workspaceName is not a name of 1–${WORKSPACE_NAME_MAX} characters, so no account was created`);
    return res.status(400).json({ error: 'INVALID_WORKSPACE_NAME' });
  }

  // The signup slot, taken here: after the refusals above, which cost no I/O
  // and are what a malformed body gets whatever anyone's budget says, and
  // before the duplicate lookup — so a blocked caller buys neither a database
  // read, nor the bcrypt hash, nor the workspace and the whole template seed
  // that follow it.
  //
  // `reserve` rather than `blocked` here, and no `record` further down, because
  // the gap between the two *was* the limit (KOL-081). The check sat above the
  // `User.findOne` and the count eighteen lines below it, past a lookup, a
  // cost-12 hash and two writes — three awaits. So a script that opened N
  // connections at once had every one of them read a counter none of them had
  // written yet, pass the gate, and create ~N accounts per window instead of
  // `perSignupIp`: the ceiling bound sequential callers only, which is the one
  // case it was not written for. `reserve` checks and counts in the same
  // synchronous step, so the N-th simultaneous caller sees the N-1 slots its
  // predecessors hold (lib/attemptLimiter.js).
  const signupKeys = { signup: req.ip };
  const signupBlock = limiter(req).reserve(signupKeys, SIGNUP_SOURCE);
  if (signupBlock) return limiter(req).refuse(res, signupBlock);

  // The stored form, not the raw body value: what is checked for a duplicate is
  // exactly what the schema would write, and the filter is a primitive string
  // rather than whatever the request sent (KOL-044).
  const existing = await User.findOne({ email: emailKey(email) });
  if (existing) {
    // The one path that reserves and then creates nothing, so the one that
    // hands the slot back: asking whether an address is taken must not burn
    // the budget of everyone else behind the same address. What is counted is
    // still a created account — the reservation only moves *when* that is
    // decided, from after the work to before it.
    limiter(req).release(signupKeys, SIGNUP_SOURCE);
    return res.status(409).json({ error: 'Email already registered' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  // Deliberately keeping the slot from here on, whatever happens next: the
  // hash is paid and the writes are under way, and that cost is the thing
  // being bounded. So the workspace rollback below stays counted, and so does
  // the E11000 a registration that lost a race to the same address rejects
  // with (the unique index on `User.email`; Express 4 does not catch it, which
  // is the documented gap at the top of tests/http/auth.test.js).
  const user = await User.create({ email, passwordHash });

  // Every user needs a workspace immediately — resolveWorkspace fails closed
  // without one, so a user created here but left workspace-less could not read
  // or write anything. The create, the template key stored on the document
  // (KOL-105) and the seed are one call since KOL-123, shared with
  // `POST /workspaces`: see lib/workspaceSeeder.js. Only a failure to *create*
  // throws — a partial seed is reported there and leaves a usable workspace.
  //
  // `template` is passed through as the request sent it, and is never `null`
  // here: a `template` naming no template is already a 400 above, so this is
  // either a key or `undefined` (the default). The empty workspace `null` asks
  // for is `POST /workspaces` only.
  try {
    await createWorkspace({
      name:     newWorkspaceName,
      ownerId:  user._id,
      template,
      source:   `${SIGNUP_SOURCE}, ${requestedName === undefined ? 'no workspaceName in the request → the default' : 'workspaceName from the request'}`,
    });
  } catch (err) {
    // Don't strand a user with an account but no workspace.
    workspaceLog('light', `failed to create a workspace for user ${user._id}, deleting the account rather than stranding it (source: ${SIGNUP_SOURCE}): ${err.message}`);
    await User.deleteOne({ _id: user._id });
    return res.status(500).json({ error: 'Could not create workspace' });
  }

  startSession(req, res, user, { status: 201, source: SIGNUP_SOURCE });
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

  startSession(req, res, user, { source: PASSWORD_LOGIN_SOURCE });
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
  // A `GET /events` stream authenticates once and is then held open for hours,
  // so signing out has to end it here: the broadcaster's keep-alive sweep would
  // get to it within 30 seconds, and for 30 seconds a browser that has signed
  // out would still be receiving this workspace's entity documents (KOL-062).
  closeStreamsForSession(req.sessionID, 'POST /auth/logout');
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

/**
 * The account's WebAuthn user handle, created here if the account predates it
 * (KOL-052). Null only when the account is gone.
 *
 * Every account created since carries one from the schema default, so this is
 * the backfill for the ones registered before — written on the first
 * registration that needs it rather than by a migration script, exactly as
 * KOL-024's credential ids are. The write is conditional on the field still
 * being unset, so two register/begin calls racing for the same account cannot
 * give it two handles: the loser reads the winner's and discards its own,
 * because a handle that changed between two registrations would be the very
 * thing this exists to prevent.
 */
async function accountUserHandle(user) {
  if (user.webauthnUserHandle) return user.webauthnUserHandle;

  const handle = newUserHandle();
  const claimed = await User.findOneAndUpdate(
    { _id: user._id, webauthnUserHandle: { $in: [null, ''] } },
    { $set: { webauthnUserHandle: handle } },
    { new: true },
  ).select('webauthnUserHandle').lean();
  if (claimed) {
    logPasskey('light', `user ${user._id}: WebAuthn user handle created, this account predates it (source: ${REGISTER_BEGIN_SOURCE})`);
    return claimed.webauthnUserHandle;
  }

  const current = await User.findById(user._id).select('webauthnUserHandle').lean();
  if (current?.webauthnUserHandle) {
    logPasskey('light', `user ${user._id}: WebAuthn user handle already created by a concurrent registration, using that one (source: ${REGISTER_BEGIN_SOURCE})`);
    return current.webauthnUserHandle;
  }
  logPasskey('light', `user ${user._id}: no WebAuthn user handle and the account is gone (source: ${REGISTER_BEGIN_SOURCE})`);
  return null;
}

// POST /auth/webauthn/register/begin
router.post('/webauthn/register/begin', requireAuth, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Passed as `userID`, so every passkey on this account is one WebAuthn user
  // rather than one per registration. Without it @simplewebauthn generates a
  // fresh random handle per ceremony and nothing stores it; see
  // lib/passkeyIds.js.
  const handle = await accountUserHandle(user);
  if (!handle) return res.status(404).json({ error: 'User not found' });

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: userHandleBytes(handle),
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
    // @simplewebauthn throws for a response it cannot verify — a mismatched
    // origin, a stale challenge, a malformed attestation. That is the caller's
    // mistake, so 400 stays (KOL-075 does not move a status a route chose);
    // what goes is the library's own sentence, which named this deployment's
    // expected origin and RP id. Same answer as the `!verified` branch below,
    // because to a client they are the same failure.
    logPasskey('normal', `passkey registration refused for user ${user._id}: ${err.message} (source: POST /auth/webauthn/register/complete)`);
    return res.status(400).json({ error: 'Passkey verification failed' });
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
    // 400 as before — a thrown assertion is the caller's, not ours — but with
    // this route's own sentence rather than the library's, which spelled out
    // the expected origin and RP id. Deliberately the same wording as the
    // `!verified` 401 below: the status tells the two apart, the body need not.
    return res.status(400).json({ error: 'Passkey authentication failed' });
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

  startSession(req, res, user, { source: LOGIN_SOURCE });
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

/**
 * What both routes answer. `hasPassword` tells Settings whether the last passkey
 * may go.
 *
 * `userHandle` and `rpId` are what the client needs to tell an authenticator
 * that a passkey is gone (`PublicKeyCredential.signalAllAcceptedCredentials`,
 * KOL-052) — the account's WebAuthn `user.id` and the relying party the
 * ceremonies actually ran under, which is `WEBAUTHN_RP_ID` and not necessarily
 * the host the client is loaded from. They are siblings of `passkeys` rather
 * than fields on each summary: `passkeySummary` stays the explicit field list
 * it is, so no public key can leak in. `userHandle` is null on an account
 * registered before KOL-052 that has not since added a passkey — a signal has
 * no user to name, so the client sends none.
 */
const passkeyList = (user) => ({
  passkeys: (user.passkeys ?? []).map(passkeySummary),
  hasPassword: Boolean(user.passwordHash),
  userHandle: user.webauthnUserHandle ?? null,
  rpId: RP_ID,
});

// GET /auth/webauthn/passkeys
router.get('/webauthn/passkeys', requireAuth, async (req, res) => {
  const userId = sessionUserId(req, res, LIST_SOURCE);
  if (!userId) return;
  try {
    const user = await User.findById(userId).select('passwordHash passkeys webauthnUserHandle').lean();
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

    res.json(passkeyList(await User.findById(userId).select('passwordHash passkeys webauthnUserHandle').lean()));
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

// ─── Re-authentication ───────────────────────────────────────────────────────
// Three routes demand a *fresh* proof of the account from a caller who is
// already signed in: DELETE /auth/account, POST /auth/password and
// POST /auth/sessions/revoke-all. All three take the current password or a
// passkey assertion, and the passkey half of all three is the two functions
// here — one verification, so the weaker of three copies cannot be the one
// guarding the irreversible route.
//
// Each route names its own session key for the challenge. A challenge minted to
// confirm a deletion must not be spendable on changing a password or on signing
// every other device out, nor any of them on signing in (`currentChallenge`),
// and a use spends exactly one.

const DELETE_CHALLENGE_KEY   = 'accountDeleteChallenge';
const PASSWORD_CHALLENGE_KEY = 'passwordChangeChallenge';
const REVOKE_CHALLENGE_KEY   = 'sessionRevokeChallenge';

/**
 * The WebAuthn options for a re-authentication challenge, left in the session
 * under `challengeKey`. Null when the account holds no passkey to assert with,
 * which is the caller's 400: there is nothing to challenge.
 */
async function issuePasskeyChallenge(req, { userId, challengeKey }) {
  const user = await User.findById(userId).select('passkeys').lean();
  if (!user?.passkeys?.length) return null;

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: credentialDescriptors(user.passkeys),
    userVerification: 'preferred',
  });
  req.session[challengeKey] = options.challenge;
  return options;
}

/** Null when `response` is a valid assertion by one of `user`'s own passkeys; otherwise why not. */
async function passkeyRefusal(req, user, response, { challengeKey, source }) {
  // Spent on every attempt, pass or fail, so one challenge buys one try.
  const expectedChallenge = req.session[challengeKey];
  delete req.session[challengeKey];
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
    // The use recorded, and a legacy id repaired, before the caller's route does
    // whatever it re-authenticated for. Worth doing even when that is a deletion
    // which takes the passkey with it: a 409 refusal leaves the account and its
    // passkey in place, and a password change always does.
    recordUse(found.passkey, verification.authenticationInfo, { userId: user._id, source });
    migrateCredentialId(found, response.id, { userId: user._id, source });
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
    // Under this route's own session key, never `currentChallenge`: see the
    // re-authentication section above.
    const options = await issuePasskeyChallenge(req, {
      userId: req.actor.userId,
      challengeKey: DELETE_CHALLENGE_KEY,
    });
    if (!options) return res.status(400).json({ error: 'This account has no passkey' });

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
      : await passkeyRefusal(req, user, passkey, { challengeKey: DELETE_CHALLENGE_KEY, source: DELETE_SOURCE });
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

  // Every live /events stream this account holds in this process, not only the
  // one this request came from: the session store cannot be searched by user
  // (see GET /auth/me above), so a deleted account's other browsers would keep
  // receiving the workspace's entity documents until their sessions expired.
  // Those sessions do outlive the account; their push channels need not.
  const closedStreams = closeStreamsForUser(userId, DELETE_SOURCE);
  if (closedStreams) logDeletion('light', `${DELETE_SOURCE}: closed ${closedStreams} live /events stream(s) for user ${userId} (source: lib/broadcaster.js)`);

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

// ─── Password change ─────────────────────────────────────────────────────────
// POST /auth/password replaces the signed-in account's password. Until KOL-074
// there was no route between the ones above and DELETE /auth/account that wrote
// `passwordHash` at all, so the only way out of a password its owner no longer
// trusted was deleting the account and rebuilding the workspace.
//
// Re-authentication is the deletion route's, for the same reason it has one: a
// session is a thing a borrowed laptop also has, and the whole premise of
// changing a password is that the old one may be known to someone else. The body
// carries the current password, or a passkey assertion against a single-use
// challenge from POST /auth/password/passkey-challenge, under this route's own
// session key (see the re-authentication section above). A failed one is **403,
// not 401** — the session is still good, and a 401 reads to a client as "you
// have been signed out", which is the Decision Log's reasoning for the deletion
// route and holds unchanged here.
//
// Session only, and deliberately *not* `requireActor`: that guard also admits
// the MCP bearer token, a single secret shared with an AI connector, and a
// connector does not get to change someone's password — with or without the old
// one. A bearer caller is 403, as it is at passkey management.
//
// The new password goes through lib/passwordPolicy.js, the same call
// POST /auth/register makes, so the two cannot drift apart; it is then hashed
// with bcrypt at 12 rounds, as registration hashes. Failed confirmations are
// counted by the shared limiter under the account's `user` key — the one
// DELETE /auth/account counts under too, on purpose: guessing the current
// password here is the same guess at the same secret, so it is throttled like
// guessing it at the sign-in form rather than given a second budget.
//
// What this does NOT do: end the account's other sessions. KOL-076 owns that,
// and until it lands a browser signed in elsewhere stays signed in on the
// changed account. This one does keep its session, which is the point of
// answering 200 rather than clearing the cookie.
//
// ─── Tiered debug logging ───────────────────────────────────────────────────
// PASSWORD_LOG_LEVEL = off | light | normal | verbose (default light). Neither
// password is ever logged at any tier, nor its length: a log line that recorded
// "11 characters" about a refusal would be written by the defence. Ids only.
//   light   — every refusal and failure, with its reason, the user id and which
//             credential the caller offered; and every password actually
//             changed, naming what re-authenticated it
//   normal  — light, plus each passkey challenge issued
//   verbose — normal, plus the session the change was made from

const CHANGE_PASSWORD_SOURCE    = 'POST /auth/password';
const PASSWORD_CHALLENGE_SOURCE = 'POST /auth/password/passkey-challenge';

function logPassword(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.PASSWORD_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[auth/password:${level}] ${msg}`);
}

/**
 * The session's own user id. `requireAuth` has already run, so a request with
 * neither a session nor the bearer token never gets here (401); what is left to
 * refuse is the bearer token itself, which answers 403 and returns null.
 */
function passwordSessionUserId(req, res, source) {
  if (req.session?.userId) return req.session.userId;
  logPassword('light', `${source} refused: bearer token, not a session`);
  res.status(403).json({ error: 'Changing your password needs a signed-in browser session' });
  return null;
}

// POST /auth/password/passkey-challenge
router.post('/password/passkey-challenge', requireAuth, async (req, res) => {
  const userId = passwordSessionUserId(req, res, PASSWORD_CHALLENGE_SOURCE);
  if (!userId) return;
  try {
    const options = await issuePasskeyChallenge(req, { userId, challengeKey: PASSWORD_CHALLENGE_KEY });
    if (!options) {
      logPassword('light', `${PASSWORD_CHALLENGE_SOURCE} refused for user ${userId}: the account holds no passkey to challenge`);
      return res.status(400).json({ error: 'This account has no passkey' });
    }
    logPassword('normal', `passkey challenge issued to user ${userId} (source: ${PASSWORD_CHALLENGE_SOURCE})`);
    res.json(options);
  } catch (err) {
    logPassword('light', `${PASSWORD_CHALLENGE_SOURCE} failed for user ${userId}: ${err.message}`);
    res.status(500).json({ error: 'Could not start passkey confirmation' });
  }
});

// POST /auth/password
router.post('/password', requireAuth, async (req, res) => {
  const userId = passwordSessionUserId(req, res, CHANGE_PASSWORD_SOURCE);
  if (!userId) return;

  try {
    const { currentPassword, newPassword, passkey } = req.body ?? {};
    const byPassword = usablePassword(currentPassword);
    const byPasskey  = !byPassword && passkey !== null && typeof passkey === 'object';
    if (!byPassword && !byPasskey) {
      logPassword('light', `${CHANGE_PASSWORD_SOURCE} refused for user ${userId}: no current password and no passkey assertion, so nothing was changed`);
      return res.status(400).json({ error: 'Confirm with your current password or a passkey' });
    }

    // The new password checked before the old one is: one that could never be
    // stored is a malformed request, so it costs no bcrypt compare and — like
    // the refusal above — spends none of the budget for getting the current
    // password right. The sentence is the policy module's, the same one
    // registration answers with (lib/passwordPolicy.js).
    const problem = passwordProblem(newPassword);
    if (problem) {
      logPassword('light', `${CHANGE_PASSWORD_SOURCE} refused for user ${userId}: the new password does not meet the policy, so nothing was changed`);
      return res.status(400).json({ error: problem });
    }

    // Before the bcrypt compare and before the passkey verification, keyed by
    // the account rather than an address: the caller is signed in, so who is
    // guessing is known, and a session is not a licence to try every password
    // its owner might have had.
    const keys = { user: String(userId) };
    const block = limiter(req).blocked(keys, CHANGE_PASSWORD_SOURCE);
    if (block) {
      logPassword('light', `${CHANGE_PASSWORD_SOURCE} refused for user ${userId}: too many failed confirmations, retry after ${block.retryAfter}s`);
      return limiter(req).refuse(res, block);
    }

    const user = await User.findById(userId).select('passwordHash passkeys');
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    let refusal = null;
    if (byPasskey) {
      refusal = await passkeyRefusal(req, user, passkey, {
        challengeKey: PASSWORD_CHALLENGE_KEY,
        source: CHANGE_PASSWORD_SOURCE,
      });
    } else if (!user.passwordHash) {
      // An account with no stored password has nothing to compare against; its
      // owner sets one with a passkey instead, which the branch above allows.
      refusal = 'the account has no password to confirm with';
    } else if (!await bcrypt.compare(currentPassword, user.passwordHash)) {
      refusal = 'the current password is wrong';
    }
    if (refusal) {
      // Counted: a wrong current password and a bad assertion are both failed
      // re-authentication, and share the account's counter with the deletion
      // route's confirmation (lib/attemptLimiter.js).
      limiter(req).recordFailure(keys, CHANGE_PASSWORD_SOURCE);
      logPassword('light', `${CHANGE_PASSWORD_SOURCE} refused for user ${userId}: ${refusal}, so nothing was changed`);
      // 403, not 401: the session is fine, the re-authentication was not.
      return res.status(403).json({ error: byPassword ? 'Incorrect password' : 'Passkey confirmation failed' });
    }
    // Cleared on success, so the tries it took to remember the old password do
    // not then lock its owner out of confirming the next thing.
    limiter(req).reset(keys, CHANGE_PASSWORD_SOURCE);

    const passwordHash = await bcrypt.hash(newPassword, 12);
    const result = await User.updateOne({ _id: userId }, { $set: { passwordHash } });
    if (!result.matchedCount) {
      // Deleted between the lookup and the write. Nothing was stored.
      logPassword('light', `${CHANGE_PASSWORD_SOURCE} failed for user ${userId}: the account was gone by the time the new hash was written`);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    logPassword('light', `user ${userId}: password changed, re-authenticated with ${byPassword ? 'the current password' : 'a passkey'} (source: ${CHANGE_PASSWORD_SOURCE})`);
    logPassword('verbose', `the change was made from session ${req.sessionID}; this account's other sessions are untouched (KOL-076 owns ending them)`);
    res.json({ ok: true });
  } catch (err) {
    logPassword('light', `${CHANGE_PASSWORD_SOURCE} failed for user ${userId}: ${err.message}`);
    res.status(500).json({ error: 'Could not change your password' });
  }
});

// ─── Signing out everywhere ──────────────────────────────────────────────────
// POST /auth/sessions/revoke-all ends every session this account holds except
// the one that asked. It is the answer to a laptop left signed in at a library
// and to a stolen phone: until KOL-076 there was none at all, because
// POST /auth/logout destroys only the session it is called from and the session
// store cannot be searched by user (see GET /auth/me above).
//
// What it writes is a timestamp — `User.credentialsChangedAt` — against which
// the `issuedAt` every sign-in stamps into its session is compared on each
// request, in middleware/auth.js. That module carries the reasoning for the
// design and the SESSION_REVOKE_LOG_LEVEL knob both halves log on. The short
// version: a second place that *lists* sessions is a second thing that has to
// stay true, and the store cannot populate it anyway.
//
// Re-authentication is DELETE /auth/account's, for the same reason that route
// has one: a session is a thing a borrowed laptop also has, and the premise of
// signing every other device out is that one of them may not be in its owner's
// hands. The body carries the current password, or a passkey assertion against
// a single-use challenge from POST /auth/sessions/passkey-challenge, under this
// route's own session key. A failed one is **403, not 401** — the session is
// still good, and a 401 reads to a client as "you have been signed out", which
// would be a particularly confusing answer from this route. Failed attempts are
// counted on the account's own key, the one the deletion and password routes
// count under: the same guess at the same secret.
//
// Deliberately **no typed email**, unlike the deletion route: that confirmation
// exists because deletion is irreversible, and this is undone by signing in
// again. POST /auth/password took the same reading (KOL-074).
//
// Session only, and not for the bearer token: a connector does not get to sign
// an account's devices out, with or without the password — as at passkey
// management and the password change.
//
// What this does NOT do: list the sessions it ends, with device, address or
// location. The store cannot enumerate them by user — that is precisely why
// this is a timestamp. Nor does it touch the MCP bearer token or OAuth grants
// (KOL-014 owns per-connector identity), and nothing bumps the timestamp
// automatically when a password changes or a passkey is removed; those routes
// say so where they answer.

const REVOKE_SOURCE           = 'POST /auth/sessions/revoke-all';
const REVOKE_CHALLENGE_SOURCE = 'POST /auth/sessions/passkey-challenge';

/** Answers 403 and returns true when the caller is the bearer token rather than a session. */
function refusedBearerRevoke(req, res, source) {
  if (req.actor.type === 'user') return false;
  logSessions('light', `${source} refused for user ${req.actor.userId}: bearer token, not a session`);
  res.status(403).json({ error: 'Signing out everywhere needs a signed-in browser session' });
  return true;
}

// POST /auth/sessions/passkey-challenge
router.post('/sessions/passkey-challenge', requireActor, async (req, res) => {
  if (refusedBearerRevoke(req, res, REVOKE_CHALLENGE_SOURCE)) return;
  try {
    const options = await issuePasskeyChallenge(req, {
      userId: req.actor.userId,
      challengeKey: REVOKE_CHALLENGE_KEY,
    });
    if (!options) {
      logSessions('light', `${REVOKE_CHALLENGE_SOURCE} refused for user ${req.actor.userId}: the account holds no passkey to challenge`);
      return res.status(400).json({ error: 'This account has no passkey' });
    }
    logSessions('normal', `passkey challenge issued to user ${req.actor.userId} (source: ${REVOKE_CHALLENGE_SOURCE})`);
    res.json(options);
  } catch (err) {
    logSessions('light', `${REVOKE_CHALLENGE_SOURCE} failed for user ${req.actor.userId}: ${err.message}`);
    res.status(500).json({ error: 'Could not start passkey confirmation' });
  }
});

// POST /auth/sessions/revoke-all
router.post('/sessions/revoke-all', requireActor, async (req, res) => {
  if (refusedBearerRevoke(req, res, REVOKE_SOURCE)) return;
  const { userId } = req.actor;

  try {
    const { password, passkey } = req.body ?? {};
    const byPassword = usablePassword(password);
    const byPasskey  = !byPassword && passkey !== null && typeof passkey === 'object';
    if (!byPassword && !byPasskey) {
      logSessions('light', `${REVOKE_SOURCE} refused for user ${userId}: no password and no passkey assertion, so nothing was revoked`);
      return res.status(400).json({ error: 'Confirm with your password or a passkey' });
    }

    // Before the bcrypt compare and the signature check, keyed by the account:
    // the caller is signed in, so who is guessing is known.
    const keys = { user: String(userId) };
    const block = limiter(req).blocked(keys, REVOKE_SOURCE);
    if (block) {
      logSessions('light', `${REVOKE_SOURCE} refused for user ${userId}: too many failed confirmations, retry after ${block.retryAfter}s`);
      return limiter(req).refuse(res, block);
    }

    const user = await User.findById(userId).select('passwordHash passkeys');
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    let refusal = null;
    if (byPasskey) {
      refusal = await passkeyRefusal(req, user, passkey, {
        challengeKey: REVOKE_CHALLENGE_KEY,
        source: REVOKE_SOURCE,
      });
    } else if (!user.passwordHash) {
      refusal = 'the account has no password to confirm with';
    } else if (!await bcrypt.compare(password, user.passwordHash)) {
      refusal = 'the password is wrong';
    }
    if (refusal) {
      limiter(req).recordFailure(keys, REVOKE_SOURCE);
      logSessions('light', `${REVOKE_SOURCE} refused for user ${userId}: ${refusal}, so nothing was revoked`);
      return res.status(403).json({ error: byPassword ? 'Incorrect password' : 'Passkey confirmation failed' });
    }
    limiter(req).reset(keys, REVOKE_SOURCE);

    // The calling session is re-stamped *before* the account is bumped, and
    // both with the same millisecond. The order is what decides who is signed
    // out when half of it fails: a stamp that is saved and never bumped revokes
    // nothing, while a bump saved before a failed stamp would sign out the very
    // device that asked — the one outcome this route promises not to produce.
    // Equal timestamps stand, which is what lets the two be the same instant
    // (see sessionOutlivedCredentials in middleware/auth.js).
    const revokedAt = Date.now();
    stampSession(req.session, revokedAt);
    try {
      await new Promise((resolve, reject) => {
        req.session.save((err) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      logSessions('light', `${REVOKE_SOURCE} failed for user ${userId}: this session could not be re-stamped (${err.message}), so nothing was revoked`);
      return res.status(500).json({ error: 'Could not sign your other devices out; nothing was changed' });
    }

    const result = await User.updateOne(
      { _id: userId },
      { $set: { credentialsChangedAt: new Date(revokedAt) } },
    );
    if (!result.matchedCount) {
      // Deleted between the lookup and the write. Nothing was stored, and the
      // account's sessions are refused by the id check KOL-038 added anyway.
      logSessions('light', `${REVOKE_SOURCE} failed for user ${userId}: the account was gone by the time the timestamp was written`);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Every live /events stream this account holds in this process *except the
    // caller's own*. A revoked session is not noticed until its browser next
    // asks the API for something, and an SSE stream has already asked: it would
    // go on receiving this workspace's entity documents until the broadcaster's
    // sweep found the session gone from the store (KOL-062).
    //
    // The exception is not a nicety (KOL-112). The frame that closes a stream
    // here is `session-ended`, which the browser treats as permanent — it stops
    // reconnecting for the life of the tab and says the account was signed out
    // elsewhere. This route promises the opposite to the browser it is called
    // from ("This browser stays signed in"), and nothing about that session
    // changed: it was re-stamped above and is as good as it was a line ago. So
    // its streams are left alone rather than closed in the hope that the
    // reconnect this file used to assume would happen ever did.
    const closedStreams = closeStreamsForUser(userId, REVOKE_SOURCE, { exceptSessionId: req.sessionID });

    logSessions('light', `user ${userId}: every session issued before ${new Date(revokedAt).toISOString()} is revoked, re-authenticated with ${byPassword ? 'the password' : 'a passkey'}; session ${req.sessionID} was re-stamped, stays signed in and keeps its live /events stream(s), and ${closedStreams} other live /events stream(s) were closed (source: ${REVOKE_SOURCE})`);
    res.json({ ok: true, revokedAt: new Date(revokedAt).toISOString() });
  } catch (err) {
    logSessions('light', `${REVOKE_SOURCE} failed for user ${userId}: ${err.message}`);
    res.status(500).json({ error: 'Could not sign your other devices out' });
  }
});

export default router;
