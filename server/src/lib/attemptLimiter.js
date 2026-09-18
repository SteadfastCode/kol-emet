/**
 * Fixed-window failure counters for the sign-in routes.
 *
 * Until this existed, `POST /auth/login` ran a bcrypt compare for every
 * request that carried an email and a password. A hash at cost 12 is deliberate
 * work — roughly a tenth of a second of CPU — so an unthrottled login route is
 * both an online guessing oracle and a way to spend the API's CPU for the price
 * of a POST. The Decision Log recorded the gap twice (KOL-021's account-deletion
 * entry, and the enumeration note in tests/http/auth.test.js); this closes it.
 *
 * ─── What is counted ────────────────────────────────────────────────────────
 * **Failures only.** A successful sign-in costs nothing, and a request that is
 * already blocked is refused *before* the credential check, so it never
 * increments either. That matters for the window to actually expire: counting
 * blocked attempts would turn a fixed window into an indefinite ban for anyone
 * whose client retries.
 *
 * Two keys are checked on a password login, in this order:
 *   email — the lowercased address the request *claimed*, looked at before any
 *           database read, so an unknown address is throttled exactly like a
 *           known one. An attacker working one account hits this.
 *   ip    — `req.ip` (`trust proxy` is set in src/app.js, so behind Railway
 *           this is the client, not the proxy). Deliberately much higher than
 *           the email limit: a NAT, a school or an office is one address for
 *           hundreds of people, so this is a ceiling on spraying many accounts
 *           from one place, not a per-person limit.
 * The passkey login route has no email in its body and is keyed by ip alone;
 * re-authentication for account deletion already knows who is asking and is
 * keyed by the user id.
 *
 * ─── Why in-process, and what that does not cover ───────────────────────────
 * The counters are a `Map` in this process. One API instance runs today, so
 * that is the whole story; the moment a second one does, each enforces the
 * limit separately and the effective ceiling multiplies by the instance count.
 * The fix then is a shared store (Redis, or a Mongo collection with a TTL
 * index) behind this same interface — the routes call `blocked`,
 * `recordFailure` and `reset` and would not change. Also not covered here:
 * CAPTCHA, signup throttling, account lockout, and `/oauth/token`.
 *
 * ─── Tiered debug logging ───────────────────────────────────────────────────
 * AUTH_LIMIT_LOG_LEVEL = off | light | normal | verbose (default light).
 * **An email address is never logged at any tier** — a log that named the
 * addresses being guessed would be a list of this product's users, written by
 * the defence. Only the *kind* of key ever appears for an email.
 *   light   — every block, with the key kind, the route that was refused, the
 *             count and how long the caller must wait
 *   normal  — light, plus every failure recorded and every counter reset, each
 *             naming the route it came from
 *   verbose — normal, plus ip and user-id key values (never an email) and the
 *             number of live counters
 */

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

export function logAuthLimit(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.AUTH_LIMIT_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[auth/limit:${level}] ${msg}`);
}

/** The defaults, as shipped. Overridable per app (createApp) and by env. */
export const AUTH_LIMIT_DEFAULTS = Object.freeze({
  perEmail: 10,
  perIp:    100,
  windowMs: 15 * 60 * 1000,
});

/** The 429 body. One constant, so every route's refusal is byte-identical. */
export const TOO_MANY_ATTEMPTS = Object.freeze({ error: 'Too many attempts. Try again later.' });

/** A positive integer from `raw`, or `fallback` when it is unset or nonsense. */
function positiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The shipped defaults with any AUTH_LIMIT_* overrides from the environment applied. */
export function authLimitsFromEnv(env = process.env) {
  return {
    perEmail: positiveInt(env.AUTH_LIMIT_MAX_PER_EMAIL, AUTH_LIMIT_DEFAULTS.perEmail),
    perIp:    positiveInt(env.AUTH_LIMIT_MAX_PER_IP,    AUTH_LIMIT_DEFAULTS.perIp),
    windowMs: positiveInt(env.AUTH_LIMIT_WINDOW_MS,     AUTH_LIMIT_DEFAULTS.windowMs),
  };
}

/**
 * One fixed-window counter set.
 *
 * A key's first failure opens a window of `windowMs`; the `max`-th failure
 * inside it is still answered normally, and everything after it is blocked
 * until the window ends. `now` is injectable so the tests can drive the clock
 * rather than sleep through a real window.
 *
 * @param {object}   options
 * @param {number}   options.max       failures allowed per window (>= 1)
 * @param {number}   options.windowMs  window length in milliseconds (>= 1)
 * @param {function} [options.now]     clock, defaults to Date.now
 */
export function createAttemptLimiter({ max, windowMs, now = Date.now } = {}) {
  if (!Number.isInteger(max) || max < 1) {
    throw new TypeError(`attemptLimiter: max must be a positive integer, got ${max}`);
  }
  if (!Number.isFinite(windowMs) || windowMs < 1) {
    throw new TypeError(`attemptLimiter: windowMs must be a positive number, got ${windowMs}`);
  }

  /** key → { count, resetAt }. Every entry is live; expired ones are dropped on access. */
  const hits = new Map();
  let nextSweep = now() + windowMs;

  /**
   * Drop every expired entry, at most once per window. Without this the map
   * grows by one entry per distinct address anyone ever types — an attacker
   * with a word list would be writing into the API's memory, unbounded. Doing
   * it on a timer would keep the process awake for a counter no one is reading,
   * so it rides on whatever request comes next instead.
   */
  function sweep(at) {
    if (at < nextSweep) return;
    for (const [key, entry] of hits) if (entry.resetAt <= at) hits.delete(key);
    nextSweep = at + windowMs;
  }

  /** The key's live entry, or null — an expired one is deleted rather than returned. */
  function live(key, at) {
    const entry = hits.get(key);
    if (!entry) return null;
    if (entry.resetAt <= at) {
      hits.delete(key);
      return null;
    }
    return entry;
  }

  return {
    max,
    windowMs,

    /**
     * `null` when the key may try again, otherwise why not:
     * `{ count, retryAfter }` with `retryAfter` in whole seconds (never 0, so a
     * Retry-After header always asks for a real wait).
     */
    check(key) {
      const at = now();
      sweep(at);
      const entry = live(key, at);
      if (!entry || entry.count < max) return null;
      return { count: entry.count, retryAfter: Math.max(1, Math.ceil((entry.resetAt - at) / 1000)) };
    },

    /** Records one failure against the key and returns its new count. */
    fail(key) {
      const at = now();
      sweep(at);
      let entry = live(key, at);
      if (!entry) {
        entry = { count: 0, resetAt: at + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return entry.count;
    },

    /** Forgets the key. True when there was something to forget. */
    reset(key) {
      return hits.delete(key);
    },

    /** Live counters, for logging and tests. */
    size() {
      return hits.size;
    },
  };
}

/**
 * The three counters the auth routes share, plus the helpers they call.
 *
 * Built once per app in `createApp` so that every test app — and every future
 * second app in one process — starts with its own counters rather than
 * inheriting whatever an earlier suite left in a module-level map.
 *
 * Keys are passed as a plain object naming the kinds in play, e.g.
 * `{ email, ip }`; kinds whose value is missing or empty are skipped, and the
 * order below is the order they are checked in.
 *
 * @param {object} [limits]
 * @param {number} [limits.perEmail] failed sign-ins per email per window
 * @param {number} [limits.perIp]    failed sign-ins per client address per window
 * @param {number} [limits.perUser]  failed re-authentications per account per window
 *                                   (defaults to perEmail — it is the same kind of guess)
 * @param {number} [limits.windowMs]
 * @param {function} [limits.now]    clock, for tests
 */
export function createAuthLimiter(limits = {}) {
  const env = authLimitsFromEnv();
  const perEmail = limits.perEmail ?? env.perEmail;
  const perIp    = limits.perIp    ?? env.perIp;
  const perUser  = limits.perUser  ?? perEmail;
  const windowMs = limits.windowMs ?? env.windowMs;
  const now      = limits.now;

  const counters = {
    email: createAttemptLimiter({ max: perEmail, windowMs, now }),
    ip:    createAttemptLimiter({ max: perIp,    windowMs, now }),
    user:  createAttemptLimiter({ max: perUser,  windowMs, now }),
  };

  /** [kind, key] for each named kind that has a usable value, in check order. */
  function pairs(keys) {
    return ['email', 'ip', 'user']
      .filter(kind => keys[kind] !== undefined && keys[kind] !== null && keys[kind] !== '')
      .map(kind => [kind, String(keys[kind])]);
  }

  /** What may be logged for a key: an email address never is, not even hashed. */
  const shown = (kind, key) => (kind === 'email' ? 'an email key' : `${kind} ${key}`);

  return {
    counters,
    limits: { perEmail, perIp, perUser, windowMs },

    /**
     * The first key over its limit, as `{ kind, count, retryAfter }`, or null.
     * Callers must ask **before** doing the credential work, so a blocked key
     * costs neither a bcrypt compare nor a signature verification.
     */
    blocked(keys, source) {
      for (const [kind, key] of pairs(keys)) {
        const over = counters[kind].check(key);
        if (over) {
          logAuthLimit('light', `blocked: ${kind} key over its limit of ${counters[kind].max} (source: ${source}), ${over.count} failures, retry after ${over.retryAfter}s`);
          logAuthLimit('verbose', `the blocked key was ${shown(kind, key)}; ${counters[kind].size()} live ${kind} counters (source: ${source})`);
          return { kind, ...over };
        }
      }
      return null;
    },

    /** Records one failure against every named key. */
    recordFailure(keys, source) {
      for (const [kind, key] of pairs(keys)) {
        const count = counters[kind].fail(key);
        logAuthLimit('normal', `failure ${count}/${counters[kind].max} for a ${kind} key (source: ${source})`);
        logAuthLimit('verbose', `the failing key was ${shown(kind, key)} (source: ${source})`);
      }
    },

    /** Forgets every named key — what a successful sign-in does to its own email. */
    reset(keys, source) {
      for (const [kind, key] of pairs(keys)) {
        if (counters[kind].reset(key)) {
          logAuthLimit('normal', `counter cleared for a ${kind} key after a successful sign-in (source: ${source})`);
        }
      }
    },

    /**
     * Answers 429 with the one shared body and a Retry-After. The body is a
     * constant on purpose: a blocked known address and a blocked unknown one
     * must be byte-identical, or the throttle becomes the account-enumeration
     * oracle the 401s are careful not to be (tests/http/auth.test.js).
     */
    refuse(res, block) {
      res.set('Retry-After', String(block.retryAfter));
      return res.status(429).json(TOO_MANY_ATTEMPTS);
    },
  };
}

export default createAuthLimiter;
