import { Router } from 'express';
import bcrypt from 'bcrypt';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';

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

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId = user._id.toString();
    res.status(201).json({ ok: true });
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
    res.json({ ok: true });
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
    res.json({ ok: true });
  });
});

export default router;
