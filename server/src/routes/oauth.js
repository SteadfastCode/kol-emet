import express, { Router } from 'express';
import { randomUUID, createHash } from 'crypto';
import { setMcpUser } from '../lib/mcpUserStore.js';
// Approving a connector binds the MCP bearer identity to an account, so the
// approval form is behind a live-session guard rather than reading
// `req.session.userId` itself (KOL-098). See middleware/auth.js.
import { requireLoginSession, resolveLoginSession } from '../middleware/auth.js';

const router = Router();

// The form parser lives here rather than on the app (KOL-058): the two
// endpoints below are the only ones in this router that take a form body, and an
// app-wide express.urlencoded would let a cross-site simple POST form a body for
// every other route too. Mounted per-route, so adding a route here does not
// quietly widen it.
const form = express.urlencoded({ extended: false });

const MCP_TOKEN = process.env.MCP_BEARER_TOKEN;
// A client that discovers this origin's authorization server but wants the
// Steadfast bridge (`/bridge/mcp`, routes/bridge.js) says so with an RFC 8707
// `resource` parameter; the code remembers it and the token endpoint issues the
// bridge's token instead. The bridge also has its own path-based issuer under
// /bridge for clients that follow the 401's resource metadata — either path
// ends with the right token.
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const isBridgeResource = (resource) => typeof resource === 'string' && /\/bridge\/mcp\/?$/.test(resource);

/**
 * ─── Tiered debug logging (KOL-088) ─────────────────────────────────────────
 * OAUTH_LOG_LEVEL = off | light | normal | verbose (default light), the same
 * shape `middleware/workspace.js` and `routes/changelog.js` use.
 *
 * This router used to print `req.query` and `req.body` whole, which put the
 * one-time `code`, the PKCE `code_verifier` and both challenges into the log,
 * and a miss printed `[...authCodes.keys()]` — every code outstanding, for
 * every user. Each of those codes redeems for `MCP_BEARER_TOKEN`, the
 * workspace-wide write token, so anyone who could read the log could take the
 * workspace; on a hosted deployment the log is the deploy console. **No tier
 * prints a code, a verifier or a challenge.**
 *
 * What ties two lines to one exchange instead is a fingerprint: the first 8 hex
 * of SHA-256 of the code. Enough to follow an issue to its redemption, not
 * enough to redeem, and not reversible to a code — a code is a v4 UUID, so
 * there is nothing to guess back from 32 bits of its digest.
 *   off     — nothing
 *   light   — the source of every decision: the route, the grant type, the rule
 *             that refused it, and the fingerprint of the code it was about;
 *             plus the identity each approval binds (KOL-098)
 *   normal  — light, plus each code issued and redeemed (fingerprint and how
 *             many are outstanding), each expired-code sweep, and discovery
 *   verbose — normal, plus `redirect_uri` and `resource`. Never `state`: it is
 *             the client's own correlation value and ours to pass, not to keep.
 */
const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so a test can change it.
  const active = LEVELS[process.env.OAUTH_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[oauth:${level}] ${msg}`);
}

/**
 * A code's first 8 hex of SHA-256 — what the log says in place of the code.
 *
 * Takes whatever a query string or form body can produce (a missing field, an
 * array from a repeated parameter, an object from `a[b]=c`), because a
 * malformed request is exactly the case that has to reach its refusal line
 * rather than throw inside the logger.
 */
function fingerprint(code) {
  if (typeof code !== 'string' || !code) return 'none';
  return createHash('sha256').update(code).digest('hex').slice(0, 8);
}

/**
 * A caller-supplied, non-secret value as the log may print it: short, and
 * bounded, so a client cannot write a megabyte into the deploy console by
 * sending a megabyte `grant_type`.
 */
function brief(value) {
  if (value === undefined || value === null) return 'unset';
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

// Short-lived auth codes: code -> { codeChallenge, redirectUri, forBridge, expiresAt }
//
// In memory on purpose — a code lives five minutes, and a restart invalidating
// one costs the connector a retry — but in memory means this process owns
// whatever is in here for as long as it runs. `expiresAt` used to be read only
// at redemption, so a code nobody redeemed was never removed and `POST
// /authorize` grew the map without bound (KOL-088). Now every issue sweeps what
// has expired, and the map has a ceiling: past it an approval is refused with
// 503 rather than let in, because a server holding this many unredeemed codes
// is misconfigured or being abused and neither is the caller's fault — the same
// 503-not-401 reasoning the /mcp gate uses.
const authCodes = new Map();
const CODE_TTL_MS = 5 * 60 * 1000;

/**
 * The ceiling on outstanding codes. Read per request rather than at module
 * load, both so a deployment can raise it without a code change and so a test
 * can lower it to two instead of issuing five hundred codes.
 */
function maxPendingCodes() {
  const configured = Number(process.env.OAUTH_MAX_PENDING_CODES);
  return Number.isInteger(configured) && configured > 0 ? configured : 500;
}

/**
 * Drops every code whose five minutes are up. Called on issue, so the map is
 * bounded by what one five-minute window can hold rather than by uptime.
 *
 * @returns {number} how many were dropped
 */
function sweepExpiredCodes(now = Date.now()) {
  let dropped = 0;
  // Deleting through a Map's own iterator is defined to be safe.
  for (const [code, entry] of authCodes) {
    if (now > entry.expiresAt) {
      authCodes.delete(code);
      dropped++;
    }
  }
  return dropped;
}

// RFC 8414 discovery — Claude.ai fetches this first
router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const doc = {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/oauth/token`,
    grant_types_supported: ['authorization_code'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
  };
  log('normal', `discovery fetched (issuer: ${base})`);
  res.json(doc);
});

// GET /authorize — show approval page
router.get('/authorize', async (req, res) => {
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, resource } = req.query;
  log('verbose', `GET /authorize redirect_uri=${brief(redirect_uri)} resource=${brief(resource)}`);

  if (response_type !== 'code') {
    log('light', `GET /authorize refused: response_type must be "code" (source: the request, which sent ${brief(response_type)})`);
    return res.status(400).send('unsupported_response_type');
  }
  if (code_challenge_method !== 'S256') {
    log('light', `GET /authorize refused: code_challenge_method must be S256 (source: the request, which sent ${brief(code_challenge_method)})`);
    return res.status(400).send('code_challenge_method must be S256');
  }
  if (!code_challenge || !redirect_uri) {
    // Presence, never the value: `code_challenge` is half of the PKCE pair.
    log('light', `GET /authorize refused: missing required parameters (source: the request — code_challenge ${code_challenge ? 'present' : 'absent'}, redirect_uri ${redirect_uri ? 'present' : 'absent'})`);
    return res.status(400).send('missing required parameters');
  }

  // Who the page would approve as. `POST /authorize` refuses without a live
  // session, so a page that offered the button anyway would send the one user
  // who is allowed to do this into a bare 401. Fails *open* — a lookup that did
  // not answer still gets the button, because the POST is the gate and this is
  // only what the page says.
  const signedIn = await resolveLoginSession(req);
  const mayApprove = signedIn.reason === 'live' || signedIn.reason === 'lookup-failed';
  log('light', `GET /authorize serving the ${mayApprove ? 'Allow' : 'sign-in'} page for client_id ${brief(client_id)} (source: login session ${signedIn.reason})`);
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize — Kol Emet</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body { font-family: system-ui, sans-serif; background: #111; color: #eee; }
    .center { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 2rem; max-width: 400px; width: 90%; text-align: center; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { color: #aaa; font-size: 0.9rem; margin: 0 0 1.5rem; }
    .client { font-weight: 600; color: #eee; }
    .notice { color: #f59e0b; margin: 0; }
    button { background: #4f46e5; color: #fff; border: none; border-radius: 8px; padding: 0.75rem 2rem; font-size: 1rem; cursor: pointer; width: 100%; }
    button:hover { background: #4338ca; }
  </style>
</head>
<body>
  <div class="center"><div class="card">
    <h1>Authorize Access</h1>
    <p><span class="client">${escapeHtml(client_id ?? 'Unknown client')}</span> wants to read and write your Kol Emet wiki.</p>
    ${mayApprove ? `<form method="POST" action="/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(client_id ?? '')}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge)}">
      <input type="hidden" name="state" value="${escapeHtml(state ?? '')}">
      <input type="hidden" name="resource" value="${escapeHtml(resource ?? '')}">
      <button type="submit">Allow</button>
    </form>` : `<p class="notice">Sign in to Kol Emet in this browser first — the connector is granted access to the signed-in account, so there is nothing to approve as yet. Sign in, then start the connector's setup again.</p>`}
  </div></div>
</body>
</html>`);
});

// POST /authorize — issue code and redirect back
//
// `requireLoginSession` ahead of the handler (KOL-098): this is where the MCP
// bearer identity is bound to an account, so it takes a live, unrevoked login
// session — not a bearer token, and not nothing. A revoked session is refused
// *and ended* here; an anonymous caller gets 401 and no code, where it used to
// get a code and, if `mcpUserId` was already set, a token that acted as that
// account. See the KOL-098 note in middleware/auth.js.
router.post('/authorize', form, requireLoginSession, async (req, res) => {
  const { redirect_uri, code_challenge, state, resource } = req.body;
  log('verbose', `POST /authorize redirect_uri=${brief(redirect_uri)} resource=${brief(resource)}`);

  // Before the identity write, not after: a malformed approval must not
  // re-point `Settings.mcpUserId` on its way to a 400.
  if (!redirect_uri || !code_challenge) {
    log('light', `POST /authorize refused: missing required parameters (source: the form body — code_challenge ${code_challenge ? 'present' : 'absent'}, redirect_uri ${redirect_uri ? 'present' : 'absent'})`);
    return res.status(400).send('missing required parameters');
  }

  // The sweep comes before the ceiling, so a box that has been up for a month
  // is not refusing approvals over codes nobody will ever redeem.
  const dropped = sweepExpiredCodes();
  if (dropped) log('normal', `POST /authorize dropped ${dropped} expired code(s), ${authCodes.size} outstanding (source: the issue-time sweep)`);

  // Ahead of the identity write for the same reason the check above is: an
  // approval that cannot be completed must bind nothing.
  const ceiling = maxPendingCodes();
  if (authCodes.size >= ceiling) {
    log('light', `POST /authorize refused: ${authCodes.size} outstanding code(s) is at the ceiling of ${ceiling} (source: the pending-code cap, OAUTH_MAX_PENDING_CODES)`);
    return res.status(503).send('too many pending authorizations');
  }

  // Associate the MCP connector with the user this request is signed in as.
  await setMcpUser(req.loginUserId);
  log('light', `MCP user set to ${req.loginUserId} (source: POST /authorize with a live login session)`);

  const forBridge = isBridgeResource(resource);
  const code = randomUUID();
  authCodes.set(code, {
    codeChallenge: code_challenge,
    redirectUri: redirect_uri,
    forBridge,
    expiresAt: Date.now() + CODE_TTL_MS,
  });

  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);

  // Never `url.toString()`: it carries the code, and the client's state.
  log('normal', `POST /authorize issued code ${fingerprint(code)}, ${authCodes.size} outstanding (audience: ${forBridge ? 'bridge' : 'mcp'})`);
  res.redirect(url.toString());
});

// POST /oauth/token — exchange code for access token
router.post('/oauth/token', form, (req, res) => {
  const { grant_type, code, code_verifier, resource } = req.body;
  // The fingerprint, once, so every line below names the same exchange.
  const print = fingerprint(code);
  log('verbose', `POST /oauth/token code ${print} resource=${brief(resource)}`);

  if (grant_type !== 'authorization_code') {
    log('light', `POST /oauth/token refused code ${print}: grant_type must be authorization_code (source: the form body, which sent ${brief(grant_type)})`);
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  if (!MCP_TOKEN) {
    log('light', `POST /oauth/token refused code ${print}: MCP_BEARER_TOKEN is unset (source: the environment, read at module load)`);
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const stored = typeof code === 'string' ? authCodes.get(code) : undefined;
  if (!stored) {
    // The count, never the keys. The keys are every code still outstanding,
    // for every user, and each one redeems for the write token (KOL-088).
    log('light', `POST /oauth/token refused code ${print}: no such code (source: the pending map, ${authCodes.size} outstanding)`);
    return res.status(400).json({ error: 'invalid_grant', detail: 'code not found' });
  }
  if (Date.now() > stored.expiresAt) {
    log('light', `POST /oauth/token refused code ${print}: expired (source: its ${CODE_TTL_MS}ms lifetime)`);
    return res.status(400).json({ error: 'invalid_grant', detail: 'code expired' });
  }

  const challenge = createHash('sha256').update(code_verifier).digest('base64url');

  if (challenge !== stored.codeChallenge) {
    // Neither challenge at any tier, and no "computed vs stored" pair: the
    // stored challenge is what a verifier has to hash to, so printing it is
    // publishing the shape of the lock.
    log('light', `POST /oauth/token refused code ${print}: the verifier does not hash to the stored challenge (source: the S256 PKCE check)`);
    return res.status(400).json({ error: 'invalid_grant', detail: 'pkce mismatch' });
  }

  authCodes.delete(code);
  if (stored.forBridge && !BRIDGE_TOKEN) {
    log('light', `POST /oauth/token refused code ${print}: the code was issued for the bridge but BRIDGE_TOKEN is unset (source: the environment, read at module load)`);
    return res.status(500).json({ error: 'server_misconfigured' });
  }
  log('normal', `POST /oauth/token redeemed code ${print} → token issued, ${authCodes.size} outstanding (audience: ${stored.forBridge ? 'bridge' : 'mcp'})`);

  res.json({
    access_token: stored.forBridge ? BRIDGE_TOKEN : MCP_TOKEN,
    token_type: 'Bearer',
    expires_in: 315360000,
    ...(stored.forBridge ? { scope: 'bridge' } : {}),
  });
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default router;
