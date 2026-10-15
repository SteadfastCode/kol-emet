import User from '../models/User.js';
import { getMcpUser } from '../lib/mcpUserStore.js';
import { clearSessionCookie } from '../lib/sessionCookie.js';

// ─── Signing out everywhere (KOL-076) ────────────────────────────────────────
// A session is a row in the session store keyed by its own id, and that store
// cannot be searched *by user*: connect-mongo holds each session serialized, so
// "end every session this account has" is not a query anything here can write.
// Rather than keep a second register of live sessions — a list that would have
// to stay true through every expiry, every store swap and every instance — each
// session carries the millisecond it was issued at and the account carries the
// millisecond its credentials were last revoked (`User.credentialsChangedAt`).
// A session issued before that moment is over, and this is where it is noticed:
// one comparison on the session path of each middleware below, which is every
// request a browser makes.
//
// So the store is never asked for anything it cannot answer, and the two facts
// live exactly where the thing that needs them already looks.
//
// ─── Tiered debug logging ────────────────────────────────────────────────────
// SESSION_REVOKE_LOG_LEVEL = off | light | normal | verbose (default light).
// Signing a lost device out is by nature hard to watch happen: the device that
// is refused is not the device that asked, and the refusal is a 401 among
// thousands. Ids and timestamps only, never an email or a credential.
//   light   — every session this check ends, naming the user, the session, and
//             both timestamps, so the log says *what change* ended it
//   normal  — light, plus every session stamped at a sign-in and every
//             revoke-all, naming the route that did it
//   verbose — normal, plus each accepted session's comparison (one line per
//             request; for a "why is this session still alive" question)

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

/** Writes `msg` when SESSION_REVOKE_LOG_LEVEL is at least `level`. */
export function logSessions(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.SESSION_REVOKE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[auth/sessions:${level}] ${msg}`);
}

/**
 * Stamps `session` as issued now (or at `at`), which is what every sign-in does
 * before it saves: `POST /auth/login`, `POST /auth/register` and the WebAuthn
 * login completion, plus the re-stamp `POST /auth/sessions/revoke-all` gives
 * the device that asked so it stays signed in.
 *
 * Epoch milliseconds, not a `Date`: a session is JSON in the store, so a Date
 * would come back as a string from Mongo and as a Date from a MemoryStore —
 * a comparison that behaved differently in tests than in production.
 *
 * @returns {number} the stamp written
 */
export function stampSession(session, at = Date.now()) {
  session.issuedAt = at;
  return at;
}

/**
 * Whether a session stamped `issuedAt` predates `credentialsChangedAt` and is
 * therefore over. Pure, and the only place the rule is written.
 *
 * Two deliberate asymmetries:
 *  - **No `credentialsChangedAt` means nothing was ever revoked**, so the
 *    session stands. An account registered before KOL-076 has no such field,
 *    and reading the absence as "revoked at the dawn of time" would sign out
 *    every existing user of the product on deploy.
 *  - **A session with no `issuedAt` on an account that *has* revoked** is over.
 *    It was issued before the stamp existed, so it cannot be shown to postdate
 *    the revocation — and the whole point of the feature is that the device
 *    holding it may not be in its owner's hands.
 *
 * Equal timestamps stand: the revoke-all route re-stamps the calling session
 * with the very millisecond it writes to the account.
 */
export function sessionOutlivedCredentials(session, credentialsChangedAt) {
  if (!credentialsChangedAt) return false;
  const revokedAt = credentialsChangedAt instanceof Date
    ? credentialsChangedAt.getTime()
    : new Date(credentialsChangedAt).getTime();
  if (!Number.isFinite(revokedAt)) return false;

  const issuedAt = Number(session?.issuedAt);
  if (!Number.isFinite(issuedAt)) return true;
  return issuedAt < revokedAt;
}

/**
 * Ends the revoked session this request came in on and answers 401.
 *
 * The cookie is cleared with the attributes it was set with — before
 * `destroy()`, which takes `req.session.cookie` off the request — exactly as
 * `GET /auth/me` and `DELETE /auth/account` do it (lib/sessionCookie.js). Still
 * 401 if the store could not drop the record: the caller is not authenticated
 * either way, and leaving it holding the cookie would only make it ask again.
 */
function refuseRevoked(req, res, { userId, credentialsChangedAt, source }) {
  logSessions('light', `session ${req.sessionID} for user ${userId} was issued ${req.session?.issuedAt ? `at ${new Date(Number(req.session.issuedAt)).toISOString()}` : 'before sessions were stamped'} and this account revoked everything up to ${new Date(credentialsChangedAt).toISOString()}; ending it (source: ${source}, the change came from POST /auth/sessions/revoke-all)`);
  clearSessionCookie(req, res);
  req.session.destroy((err) => {
    if (err) logSessions('light', `session ${req.sessionID} for user ${userId} was refused but not destroyed: ${err.message} (source: ${source})`);
    res.status(401).json({ error: 'Unauthorized' });
  });
}

/**
 * The revocation check both middlewares run on their session path, given the
 * account the session names.
 *
 * `credentialsChangedAt` is passed in rather than looked up here, so the lookup
 * `requireActor` already makes is not made twice.
 *
 * @returns {boolean} true when it has answered the request
 */
function refusedRevokedSession(req, res, { userId, credentialsChangedAt, source }) {
  if (!sessionOutlivedCredentials(req.session, credentialsChangedAt)) {
    logSessions('verbose', `session ${req.sessionID} for user ${userId} stands: issued ${req.session?.issuedAt ?? '(unstamped)'}, credentials last revoked ${credentialsChangedAt ? new Date(credentialsChangedAt).getTime() : '(never)'} (source: ${source})`);
    return false;
  }
  refuseRevoked(req, res, { userId, credentialsChangedAt, source });
  return true;
}

const REQUIRE_AUTH_SOURCE  = 'requireAuth';
const REQUIRE_ACTOR_SOURCE = 'requireActor';

export async function requireAuth(req, res, next) {
  // Session-based auth (browser clients)
  if (req.session?.userId) {
    const userId = req.session.userId;
    let user;
    try {
      user = await User.findById(userId).select('credentialsChangedAt').lean();
    } catch (err) {
      // A lookup that did not answer is not a 401: that would claim the session
      // had ended when nothing here ended it, and a database blip must not sign
      // the whole deployment out. The error handler answers 500 and the session
      // survives, so the next request once the database is back goes through.
      logSessions('light', `could not check whether session ${req.sessionID} for user ${userId} is still valid: ${err.message} (source: ${REQUIRE_AUTH_SOURCE}, User.findById)`);
      return next(err);
    }
    // A session naming an account that is gone is left exactly as it was: it
    // holds a dangling id, every tenant route refuses it and `GET /auth/me`
    // ends it (KOL-038). Not this check's business.
    if (user && refusedRevokedSession(req, res, {
      userId,
      credentialsChangedAt: user.credentialsChangedAt,
      source: REQUIRE_AUTH_SOURCE,
    })) return;
    return next();
  }

  // Bearer token auth (MCP server / programmatic access). No session, so
  // nothing to revoke: a connector's access is ended by rotating the token or
  // (KOL-014) its own identity, not by this.
  const header = req.headers['authorization'] ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token && token === process.env.BEARER_TOKEN) return next();

  res.status(401).json({ error: 'Unauthorized' });
}

// Resolves req.actor for write operations.
// Session → { type: 'user', userId, label: email }
// Bearer  → { type: 'mcp',  userId, label: "email via AI" }
// Bearer with no associated user → 401 (must re-authorize)
export async function requireActor(req, res, next) {
  try {
    const header = req.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const isMcp = token && token === process.env.BEARER_TOKEN;

    let userId;
    let actorType;

    if (isMcp) {
      userId = await getMcpUser();
      if (!userId) {
        return res.status(401).json({ error: 'MCP connector not authorized — re-authorize in wiki settings' });
      }
      actorType = 'mcp';
    } else {
      userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      actorType = 'user';
    }

    // credentialsChangedAt rides along with the email this already reads, so
    // the revocation check below costs no second query.
    const user = await User.findById(userId).select('email credentialsChangedAt').lean();
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Session callers only: the bearer path above carries no session, so there
    // is no `issuedAt` to compare and nothing for a revocation to end.
    if (actorType === 'user' && refusedRevokedSession(req, res, {
      userId,
      credentialsChangedAt: user.credentialsChangedAt,
      source: REQUIRE_ACTOR_SOURCE,
    })) return;

    req.actor = {
      type:    actorType,
      userId,
      label:   actorType === 'mcp' ? `${user.email} via AI` : user.email,
    };
    next();
  } catch (err) {
    next(err);
  }
}
