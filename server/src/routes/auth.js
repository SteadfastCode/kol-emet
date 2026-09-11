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

const router = Router();

const RP_NAME = process.env.WEBAUTHN_RP_NAME ?? 'Kol Emet';
const RP_ID   = process.env.WEBAUTHN_RP_ID   ?? 'localhost';
const ORIGIN  = process.env.WEBAUTHN_ORIGIN  ?? 'http://localhost:5173';

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
    excludeCredentials: user.passkeys.map(pk => ({
      id: pk.credentialID,
      transports: pk.transports,
    })),
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

  const { credential } = verification.registrationInfo;
  user.passkeys.push({
    credentialID: Buffer.from(credential.id).toString('base64url'),
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? [],
  });
  await user.save();

  res.json({ ok: true });
});

// POST /auth/webauthn/login/begin
router.post('/webauthn/login/begin', async (req, res) => {
  const { email } = req.body ?? {};

  let allowCredentials = [];
  if (email) {
    const user = await User.findOne({ email });
    if (user) {
      allowCredentials = user.passkeys.map(pk => ({
        id: pk.credentialID,
        transports: pk.transports,
      }));
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

  const user = await User.findOne({ 'passkeys.credentialID': req.body.id });
  if (!user) return res.status(401).json({ error: 'Passkey not recognized' });

  const passkey = user.passkeys.find(pk => pk.credentialID === req.body.id);

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: Buffer.from(passkey.credentialID, 'base64url'),
        publicKey: new Uint8Array(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports,
      },
      requireUserVerification: false,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!verification.verified) {
    return res.status(401).json({ error: 'Passkey authentication failed' });
  }

  passkey.counter = verification.authenticationInfo.newCounter;
  await user.save();

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId = user._id.toString();
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: 'Session save error' });
      res.json({ ok: true });
    });
  });
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

  const passkey = user.passkeys.find(pk => pk.credentialID === response.id);
  if (!passkey) return 'the passkey is not registered to this account';

  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: passkey.credentialID,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports,
      },
      requireUserVerification: false,
    });
    if (!verification.verified) return 'the passkey assertion did not verify';
    // Kept current even though a success usually deletes the user: a 409
    // refusal leaves the account, and its passkey, in place.
    passkey.counter = verification.authenticationInfo.newCounter;
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
      allowCredentials: user.passkeys.map(pk => ({ id: pk.credentialID, transports: pk.transports })),
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
