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
import { deleteAccount } from '../lib/accountDeleter.js';
import {
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

// POST /auth/register
router.post('/register', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const existing = await User.findOne({ email });
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
  const seed = await seedWorkspace(workspace._id, req.body?.template);
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
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = await User.findOne({ email });
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

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
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// GET /auth/me
router.get('/me', (req, res) => {
  if (req.session?.userId) return res.json({ authenticated: true });
  res.status(401).json({ authenticated: false });
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
  if (email) {
    const user = await User.findOne({ email });
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

  // The browser's id, matched against both stored forms. Anything but a
  // non-empty string names no credential and must not reach the query.
  const browserId = typeof req.body?.id === 'string' ? req.body.id : '';
  logPasskey('verbose', `sign-in lookup for credential ${shortId(browserId)} (source: ${LOGIN_SOURCE})`);
  const user = browserId ? await User.findOne(credentialIdQuery(browserId)) : null;
  const found = user && findPasskey(user.passkeys, browserId);
  if (!found) {
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
    logPasskey('normal', `passkey sign-in refused for user ${user._id}: ${err.message} (source: ${LOGIN_SOURCE})`);
    return res.status(400).json({ error: err.message });
  }

  if (!verification.verified) {
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
      logDeletion('light', `${DELETE_SOURCE} refused for user ${userId}: ${refusal}`);
      // 403, not 401: the session is fine, the re-authentication was not, and
      // a 401 would tell the client it had been signed out.
      return res.status(403).json({ error: hasPassword ? 'Incorrect password' : 'Passkey confirmation failed' });
    }

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

  // Read before destroy(), which takes req.session.cookie with it. Clearing
  // with the attributes the cookie was set with is what lets the browser match
  // it: a bare clearCookie misses the domain-scoped production cookie.
  const { path, domain, secure, sameSite, httpOnly } = req.session.cookie;
  req.session.destroy((err) => {
    // The account is already gone, so this still answers 204. A session that
    // outlives it holds a dangling id: requireActor and resolveWorkspace look
    // the user up and refuse; only GET /auth/me, which reads the session
    // alone, would still say authenticated.
    if (err) logDeletion('light', `${DELETE_SOURCE}: user ${userId} deleted, but the session was not destroyed: ${err.message}`);
    res.clearCookie('connect.sid', { path, domain, secure, sameSite, httpOnly });
    res.status(204).end();
  });
});

export default router;
