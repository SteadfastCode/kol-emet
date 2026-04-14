import { Router } from 'express';
import { randomUUID, createHash } from 'crypto';

const router = Router();

const MCP_TOKEN = process.env.MCP_BEARER_TOKEN;

// Short-lived auth codes: code -> { codeChallenge, redirectUri, state, expiresAt }
const authCodes = new Map();

// RFC 8414 discovery — Claude.ai fetches this first
router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/oauth/token`,
    grant_types_supported: ['authorization_code'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
  });
});

// GET /authorize — show approval page
router.get('/authorize', (req, res) => {
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.query;

  if (response_type !== 'code') {
    return res.status(400).send('unsupported_response_type');
  }
  if (code_challenge_method !== 'S256') {
    return res.status(400).send('code_challenge_method must be S256');
  }
  if (!code_challenge || !redirect_uri) {
    return res.status(400).send('missing required parameters');
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize — Kol Emet</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #111; color: #eee; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 2rem; max-width: 400px; width: 90%; text-align: center; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { color: #aaa; font-size: 0.9rem; margin: 0 0 1.5rem; }
    .client { font-weight: 600; color: #eee; }
    button { background: #4f46e5; color: #fff; border: none; border-radius: 8px; padding: 0.75rem 2rem; font-size: 1rem; cursor: pointer; width: 100%; }
    button:hover { background: #4338ca; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize Access</h1>
    <p><span class="client">${escapeHtml(client_id ?? 'Unknown client')}</span> wants to read and write your Kol Emet wiki.</p>
    <form method="POST" action="/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(client_id ?? '')}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge)}">
      <input type="hidden" name="state" value="${escapeHtml(state ?? '')}">
      <button type="submit">Allow</button>
    </form>
  </div>
</body>
</html>`);
});

// POST /authorize — issue code and redirect back
router.post('/authorize', express_urlencoded, (req, res) => {
  const { redirect_uri, code_challenge, state } = req.body;

  if (!redirect_uri || !code_challenge) {
    return res.status(400).send('missing required parameters');
  }

  const code = randomUUID();
  authCodes.set(code, {
    codeChallenge: code_challenge,
    redirectUri: redirect_uri,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
  });

  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);

  res.redirect(url.toString());
});

// POST /oauth/token — exchange code for access token
router.post('/oauth/token', (req, res) => {
  const { grant_type, code, code_verifier } = req.body;

  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  if (!MCP_TOKEN) {
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const stored = authCodes.get(code);
  if (!stored || Date.now() > stored.expiresAt) {
    return res.status(400).json({ error: 'invalid_grant' });
  }

  // Verify PKCE: BASE64URL(SHA256(code_verifier)) must equal stored code_challenge
  const challenge = createHash('sha256')
    .update(code_verifier)
    .digest('base64url');

  if (challenge !== stored.codeChallenge) {
    return res.status(400).json({ error: 'invalid_grant' });
  }

  authCodes.delete(code);

  res.json({
    access_token: MCP_TOKEN,
    token_type: 'Bearer',
    expires_in: 315360000, // 10 years
  });
});

// Middleware to parse form bodies on the POST /authorize route only
function express_urlencoded(req, res, next) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    req.body = Object.fromEntries(new URLSearchParams(body));
    next();
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default router;
