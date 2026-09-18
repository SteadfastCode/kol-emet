/**
 * The session cookie's attributes, in one place: how it is set and how it is
 * cleared.
 *
 * `createApp` used to hardcode the first deployment's own domain whenever
 * NODE_ENV was production — the one instance domain anywhere in `server/src`.
 * Any other deployment of this product issued a cookie scoped to a domain its
 * own browsers are not on, and a browser drops such a cookie without a word.
 * The symptom is a sign-in that answers 200, sets nothing, and lands back on
 * the login form: unreproducible locally, because development never set a
 * domain at all. The domain now comes from `SESSION_COOKIE_DOMAIN`, and an
 * unset variable means a host-only cookie — the right default for localhost,
 * for a single-host deploy, and for a deployment that has not thought about it
 * yet.
 *
 * ─── Why clearing needs the same attributes ─────────────────────────────────
 * A browser matches a clearing Set-Cookie against the cookie it holds by name,
 * domain and path. `res.clearCookie('connect.sid')` with no options expires a
 * host-only cookie at `/`, so against a domain-scoped cookie it does nothing:
 * the response *looks* like a logout, and the browser keeps sending the
 * original. Worse, it can leave two `connect.sid` cookies — a host-only empty
 * one and the live domain-scoped one — and which the browser sends is then a
 * matter of cookie-store ordering. So both places that end a session read the
 * attributes back off `req.session.cookie`, which is what express-session
 * actually set, and clear with those.
 *
 * `req.session.cookie` also carries `maxAge` and `expires`, and those must not
 * reach `res.clearCookie`: Express passes options through to `res.cookie`,
 * which recomputes `expires` from `maxAge` — a "clear" that instead issues a
 * fresh seven-day cookie, and a deprecation warning. Hence the explicit pick in
 * `sessionAttributes`, never a spread.
 *
 * Read it *before* `req.session.destroy()`. Destroy deletes `req.session` off
 * the request synchronously, before its callback runs, so a helper called in
 * that callback has nothing left to read. The fallback below covers that case
 * by rebuilding the attributes from the environment — correct, because
 * `createApp` configured the cookie from the same function and the same
 * `process.env` — but it is a safety net, not the intended path.
 *
 * Out of scope here: the cookie *name* (express-session's `connect.sid`
 * default), CORS and the WebAuthn RP settings, which are already env-driven.
 *
 * ─── Tiered debug logging ───────────────────────────────────────────────────
 * SESSION_COOKIE_LOG_LEVEL = off | light | normal | verbose (default light).
 * A cookie a browser silently refuses leaves nothing behind to debug, so the
 * light tier says where every attribute came from rather than only what it is.
 *   light   — the resolved policy each time the cookie options are built (at
 *             app construction), naming the source of each attribute; a
 *             production app with no domain configured; and any clear that had
 *             to fall back to the environment because the session was gone
 *   normal  — light, plus every cookie cleared (logout, account deletion) and
 *             the source of the attributes it used
 *   verbose — normal, plus the domain value and the full attribute set
 */

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

export function logSessionCookie(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.SESSION_COOKIE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[session/cookie:${level}] ${msg}`);
}

/** express-session's default cookie name. Not configurable here on purpose. */
export const SESSION_COOKIE_NAME = 'connect.sid';

/** Seven days, as the session cookie has always had. */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * express-session's default path, stated rather than left implicit: a clear
 * that falls back to these options has to name the path it is clearing, and
 * "whatever Express defaults to at each end" is not a match anyone can read.
 */
export const SESSION_COOKIE_PATH = '/';

/**
 * `SESSION_COOKIE_DOMAIN`, or undefined when it is unset or blank.
 *
 * Blank counts as unset because `.env.example` ships the key with no value and
 * a copied-out `.env` therefore defines it as `''`. An empty string would
 * otherwise serialize as `Domain=`, which is not a cookie a browser keeps.
 */
function configuredDomain(env) {
  const configured = typeof env.SESSION_COOKIE_DOMAIN === 'string' ? env.SESSION_COOKIE_DOMAIN.trim() : '';
  return configured === '' ? undefined : configured;
}

/**
 * The `cookie` block for express-session.
 *
 * @param {object} [env] the environment to read; `process.env` by default.
 * @returns {{httpOnly: true, secure: boolean, sameSite: 'none'|'lax', domain: string|undefined, maxAge: number}}
 */
export function sessionCookieOptions(env = process.env) {
  const isProd = env.NODE_ENV === 'production';
  const domain = configuredDomain(env);

  // `sameSite: 'none'` requires `secure`, and both together are what lets the
  // client on one origin send the cookie to the API on another; development
  // runs over plain http, where a secure cookie would never be sent at all.
  logSessionCookie('light', `secure=${isProd}, sameSite=${isProd ? 'none' : 'lax'} (source: NODE_ENV=${env.NODE_ENV ?? 'unset'})`);
  logSessionCookie('light', domain
    ? 'domain scoped (source: SESSION_COOKIE_DOMAIN)'
    : 'host-only cookie (source: SESSION_COOKIE_DOMAIN unset)');
  if (isProd && !domain) {
    logSessionCookie('light', 'production with no SESSION_COOKIE_DOMAIN: the cookie is host-only, so a client on a sibling subdomain of the API will not send it (source: SESSION_COOKIE_DOMAIN unset)');
  }
  logSessionCookie('verbose', `domain=${domain ?? 'unset'}, maxAge=${SESSION_MAX_AGE_MS}ms`);

  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    domain,
    path: SESSION_COOKIE_PATH,
    maxAge: SESSION_MAX_AGE_MS,
  };
}

/**
 * The attributes a clearing Set-Cookie has to repeat, picked one by one.
 *
 * Never a spread: `maxAge` and `expires` must not reach `res.clearCookie` (see
 * the module comment), and `req.session.cookie` exposes both as getters.
 */
function sessionAttributes({ path, domain, secure, sameSite, httpOnly }) {
  return { path, domain, secure, sameSite, httpOnly };
}

/**
 * Expire the session cookie in the browser, with the attributes it was set
 * with. Call it *before* `req.session.destroy()`.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function clearSessionCookie(req, res) {
  const live = req.session?.cookie;
  if (!live) {
    logSessionCookie('light', 'no live session on the request, so the clearing attributes were rebuilt from the environment — call clearSessionCookie before req.session.destroy() (source: req.session absent)');
  }
  const attributes = sessionAttributes(live ?? sessionCookieOptions());
  const source = live ? 'req.session.cookie' : 'the environment';

  logSessionCookie('normal', `clearing ${SESSION_COOKIE_NAME}: path=${attributes.path ?? '/'}, sameSite=${attributes.sameSite ?? 'unset'}, secure=${Boolean(attributes.secure)}, httpOnly=${Boolean(attributes.httpOnly)}, ${attributes.domain ? 'domain scoped' : 'host-only'} (source: ${source})`);
  logSessionCookie('verbose', `clearing attributes: ${JSON.stringify(attributes)} (source: ${source})`);

  res.clearCookie(SESSION_COOKIE_NAME, attributes);
}

export default sessionCookieOptions;
