/**
 * Origin guard: a cookie-authenticated write has to come from this
 * deployment's own client.
 *
 * ─── Why CORS was never the gate it looks like ───────────────────────────────
 * The session cookie is issued with `sameSite: 'none'` in production
 * (lib/sessionCookie.js), because the client and the API answer on sibling
 * subdomains and a `lax` cookie would not be sent on the client's own
 * cross-site requests. A browser therefore attaches it to *any* cross-site
 * request to the API, including one an attacker's page makes.
 *
 * `cors()` does not stop that. CORS is a read gate: a **simple** request — a
 * form POST, `application/x-www-form-urlencoded`, no custom headers — is sent
 * with no preflight, the server runs it, and only the *response* is withheld
 * from the attacker's script. The write has already happened. (PUT, PATCH and
 * DELETE are not simple, so they are preflighted and already refused; POST is
 * the hole.) What reached every cookie-authenticated POST before this guard:
 * `POST /entities` creating content, `POST /drafts` spending the victim's AI
 * allowance, `POST /entities/:id/rollback/:logId` and `POST /auth/logout`
 * needing no body at all, and `POST /authorize` re-pointing
 * `Settings.mcpUserId` at whoever is signed in.
 *
 * So the gate is the one thing an attacker's page cannot forge: `Origin`.
 * Browsers set it on every unsafe-method request and script cannot override it.
 *
 * ─── What is checked ─────────────────────────────────────────────────────────
 * For POST, PUT, PATCH and DELETE from a **session** caller (`req.session.userId`
 * is set — a request with no signed-in session has no authority to ride), the
 * request's origin must be either `CLIENT_ORIGIN` or this API's own origin, and
 * anything else is 403 `{ error: 'CROSS_ORIGIN_REQUEST' }`.
 *
 * Its own origin is allowed because two pages this API itself serves post back
 * to it: the OAuth approval forms at `POST /authorize` (routes/oauth.js) and
 * `POST /bridge/authorize` (routes/bridge.js).
 *
 * A `Bearer` caller is exempt. MCP and the bridge send a token and no cookie,
 * so there is no session for a browser to ride — and `Authorization` is not a
 * CORS-safelisted header, so a cross-site *simple* request cannot carry one at
 * all. The exemption is on the header's presence, not on which token it holds:
 * whether the token is valid is the business of the gates behind this one.
 *
 * `Referer` is the fallback, read only when `Origin` is absent. A present but
 * unusable `Origin` (`null`, from a sandboxed iframe or an opaque origin) is a
 * refusal rather than a reason to look at a second header an attacker also
 * influences.
 *
 * ─── Scope ──────────────────────────────────────────────────────────────────
 * Deliberately not a double-submit or synchronizer CSRF token: every client of
 * this API is either a browser on one known origin or a bearer caller, so the
 * header check is the whole fix and costs no per-request state. Not
 * `sameSite: 'lax'` either — that would break the cross-subdomain deployment
 * this product ships as. The second layer against a forged simple request is
 * body parsing: `express.urlencoded` is mounted only on the four form-encoded
 * OAuth endpoints that need it (routes/oauth.js, routes/bridge.js) rather than
 * on the app, so a cross-site form POST cannot form a body any other route
 * will read.
 *
 * ─── Tiered debug logging ───────────────────────────────────────────────────
 * ORIGIN_GUARD_LOG_LEVEL = off | light | normal | verbose (default light).
 * A 403 nobody can explain is this change's failure mode, so the light tier
 * names what was read and what it was compared against, not just the verdict.
 *   off     — nothing
 *   light   — every refusal, with the method, the path, which header the origin
 *             came from and the allowlist it missed; plus the resolved policy
 *             at app construction and a production deployment with no
 *             CLIENT_ORIGIN configured
 *   normal  — light, plus every guarded request that passed and the header it
 *             was judged on
 *   verbose — normal, plus every request waved through unchecked and why
 *             (safe method, bearer caller, no session)
 */

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

export function logOriginGuard(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.ORIGIN_GUARD_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[origin-guard:${level}] ${msg}`);
}

/** The methods that can change state, and so the ones that are checked. */
export const GUARDED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The scheme-host-port of a URL or origin string, or null when there isn't one.
 *
 * `null` (an opaque origin's literal value) and a blank string both come back
 * null: `.env.example` ships `CLIENT_ORIGIN` with a value, but a deployment can
 * blank it, and an empty allowlist entry must never match an empty header.
 */
function originOf(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'null') return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

/**
 * Where the request says it came from.
 *
 * @returns {{header: 'Origin'|'Referer'|null, raw: string|null, origin: string|null}}
 */
export function readRequestOrigin(req) {
  const headers = req.headers ?? {};
  const origin = headers.origin;
  if (typeof origin === 'string' && origin.trim() !== '') {
    return { header: 'Origin', raw: origin.trim(), origin: originOf(origin) };
  }
  // Express normalizes neither spelling for us; `referrer` is the rarer one.
  const referer = headers.referer ?? headers.referrer;
  if (typeof referer === 'string' && referer.trim() !== '') {
    return { header: 'Referer', raw: referer.trim(), origin: originOf(referer) };
  }
  return { header: null, raw: null, origin: null };
}

/**
 * The origins a session write may come from: this deployment's client, and the
 * API's own origin (the OAuth approval pages post to themselves).
 *
 * Read per request rather than captured at construction so a deployment that
 * changes `CLIENT_ORIGIN` needs a restart, not a redeploy of this file's
 * assumptions — and so a test can drive both answers against one app.
 */
export function allowedOrigins(req, env = process.env) {
  const configured = originOf(env.CLIENT_ORIGIN);
  // `req.get` honours X-Forwarded-Host behind the trusted proxy; the raw header
  // is the fallback for a bare request object (unit tests).
  const host = typeof req.get === 'function' ? req.get('host') : req.headers?.host;
  const own = originOf(`${req.protocol ?? 'http'}://${host ?? ''}`);
  return [configured, own].filter((value, index, all) => value && all.indexOf(value) === index);
}

/**
 * Refuse an unsafe method from a session caller whose origin is not ours.
 *
 * Mounted in `createApp` directly after the session middleware (it reads
 * `req.session`) and ahead of every router, so a route added later cannot land
 * outside it.
 */
export function originGuard(req, res, next) {
  const path = req.originalUrl ?? req.url ?? '';

  if (!GUARDED_METHODS.has(req.method)) {
    logOriginGuard('verbose', `allowed ${req.method} ${path} unchecked (source: safe method)`);
    return next();
  }

  const auth = req.headers?.authorization ?? '';
  if (auth.startsWith('Bearer ')) {
    logOriginGuard('verbose', `allowed ${req.method} ${path} unchecked (source: Authorization: Bearer — no cookie for a browser to ride)`);
    return next();
  }

  if (!req.session?.userId) {
    logOriginGuard('verbose', `allowed ${req.method} ${path} unchecked (source: no signed-in session)`);
    return next();
  }

  const allowed = allowedOrigins(req);
  const found = readRequestOrigin(req);

  if (found.origin && allowed.includes(found.origin)) {
    logOriginGuard('normal', `allowed ${req.method} ${path} from ${found.origin} (source: ${found.header} header)`);
    return next();
  }

  const sawIt = found.header
    ? `${found.header}: ${found.raw}${found.origin ? '' : ' (not a usable origin)'}`
    : 'neither Origin nor Referer';
  logOriginGuard('light', `refused ${req.method} ${path} with 403 for a session caller: read ${sawIt}, which is not in the allowlist [${allowed.join(', ')}] (source: CLIENT_ORIGIN=${process.env.CLIENT_ORIGIN ?? 'unset'} plus the request's own origin)`);
  res.status(403).json({ error: 'CROSS_ORIGIN_REQUEST' });
}

/**
 * The resolved policy, logged once where the guard is mounted — the same thing
 * `sessionCookieOptions` does with the cookie's attributes, and for the same
 * reason: a refusal nobody expected is debugged from what the process started
 * with.
 */
export function logOriginGuardStartup(env = process.env) {
  const configured = originOf(env.CLIENT_ORIGIN);
  logOriginGuard('light', configured
    ? `enforcing on ${[...GUARDED_METHODS].join('/')} from a session caller; allowlist: ${configured} and the request's own origin (source: CLIENT_ORIGIN)`
    : `enforcing on ${[...GUARDED_METHODS].join('/')} from a session caller; allowlist: the request's own origin only (source: CLIENT_ORIGIN unset or blank)`);
  if (env.NODE_ENV === 'production' && !configured) {
    logOriginGuard('light', 'production with no CLIENT_ORIGIN: every write from the client on another origin is refused with 403 — and cors() is answering Access-Control-Allow-Origin: *, which no browser uses with credentials, so that client is already broken (source: CLIENT_ORIGIN unset)');
  }
}

export default originGuard;
