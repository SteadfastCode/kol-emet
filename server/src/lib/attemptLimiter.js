/**
 * Fixed-window counters for the auth routes: failed sign-ins, and the one
 * success anything here counts — a created account.
 *
 * Until this existed, `POST /auth/login` ran a bcrypt compare for every
 * request that carried an email and a password. A hash at cost 12 is deliberate
 * work — roughly a tenth of a second of CPU — so an unthrottled login route is
 * both an online guessing oracle and a way to spend the API's CPU for the price
 * of a POST. The Decision Log recorded the gap twice (KOL-021's account-deletion
 * entry, and the enumeration note in tests/http/auth.test.js); this closes it.
 *
 * ─── What is counted ────────────────────────────────────────────────────────
 * **On the sign-in routes, failures only.** A successful sign-in costs nothing, and a request that is
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
 * ─── The one thing counted here that is not a failure ───────────────────────
 * `POST /auth/register` is keyed by `req.ip` under its own kind, `signup`, and
 * what it counts is a **success**: an account that now exists. Registration is
 * open by design (CLAUDE.md) and every success spends a bcrypt hash at cost 12
 * and then writes a `User`, a `Workspace` and a whole template seed — 38
 * relationship types plus starter content (lib/workspaceSeeder.js) — so
 * unthrottled it let one unauthenticated client fill this database and spend
 * this API's CPU as fast as it could post. Three consequences of counting the
 * success and not the attempt:
 *   - A 400 (no password, unknown template) and a 409 (address already taken)
 *     cost the caller nothing. A typo at the signup form is not a spent
 *     signup, and "is this address taken?" is not a way to burn the budget of
 *     everyone else behind the same address.
 *   - It is `record`, not `recordFailure`. Same counter and the same
 *     arithmetic; only the log wording differs, because a line reading
 *     "failure" about somebody who just signed up successfully would send
 *     whoever is reading it the wrong way.
 *   - **Its window is its own.** 15 minutes is the unit for a password guess,
 *     where the job is to make a long run of tries slow. An hour is the unit
 *     for account creation, where the job is a ceiling on how many tenants one
 *     address can mint. So `signupWindowMs` is a separate setting (60 minutes)
 *     and the signup counter runs on its own clock entirely: it can be blocked
 *     while an email counter is free, and free while one is blocked.
 * 10 per hour is deliberately loose, for the same reason the ip limit is: a
 * team or a classroom signing up together is one address, and refusing the
 * fourth of them would be the worse failure. It is a bound on scripted mass
 * registration, not a queue for humans.
 *
 * ─── Why in-process, and what that does not cover ───────────────────────────
 * The counters are a `Map` in this process. One API instance runs today, so
 * that is the whole story; the moment a second one does, each enforces the
 * limit separately and the effective ceiling multiplies by the instance count.
 * The fix then is a shared store (Redis, or a Mongo collection with a TTL
 * index) behind this same interface — the routes call `blocked`, `record`,
 * `recordFailure` and `reset` and would not change. Also not covered here:
 * CAPTCHA, email verification, account lockout, and rate limits on
 * `/oauth/token` and `/drafts`.
 *
 * ─── Tiered debug logging ───────────────────────────────────────────────────
 * AUTH_LIMIT_LOG_LEVEL = off | light | normal | verbose (default light).
 * **An email address is never logged at any tier** — a log that named the
 * addresses being guessed would be a list of this product's users, written by
 * the defence. Only the *kind* of key ever appears for an email.
 *   light   — every block, with the key kind, the route that was refused, the
 *             count and how long the caller must wait
 *   normal  — light, plus every failure and every signup recorded and every
 *             counter reset, each naming the route it came from
 *   verbose — normal, plus ip, signup and user-id key values (never an email)
 *             and the number of live counters
 */

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

export function logAuthLimit(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.AUTH_LIMIT_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[auth/limit:${level}] ${msg}`);
}

/** The defaults, as shipped. Overridable per app (createApp) and by env. */
export const AUTH_LIMIT_DEFAULTS = Object.freeze({
  perEmail:       10,
  perIp:          100,
  perSignupIp:    10,
  windowMs:       15 * 60 * 1000,
  signupWindowMs: 60 * 60 * 1000,
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
    perEmail:       positiveInt(env.AUTH_LIMIT_MAX_PER_EMAIL,      AUTH_LIMIT_DEFAULTS.perEmail),
    perIp:          positiveInt(env.AUTH_LIMIT_MAX_PER_IP,         AUTH_LIMIT_DEFAULTS.perIp),
    perSignupIp:    positiveInt(env.AUTH_LIMIT_MAX_SIGNUPS_PER_IP, AUTH_LIMIT_DEFAULTS.perSignupIp),
    windowMs:       positiveInt(env.AUTH_LIMIT_WINDOW_MS,          AUTH_LIMIT_DEFAULTS.windowMs),
    signupWindowMs: positiveInt(env.AUTH_LIMIT_SIGNUP_WINDOW_MS,   AUTH_LIMIT_DEFAULTS.signupWindowMs),
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
 * The four counters the auth routes share, plus the helpers they call.
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
 * @param {number} [limits.perEmail]    failed sign-ins per email per window
 * @param {number} [limits.perIp]       failed sign-ins per client address per window
 * @param {number} [limits.perUser]     failed re-authentications per account per window
 *                                      (defaults to perEmail — it is the same kind of guess)
 * @param {number} [limits.perSignupIp] accounts created per client address per
 *                                      *signup* window — a success, not a guess
 * @param {number} [limits.windowMs]       the sign-in window
 * @param {number} [limits.signupWindowMs] the signup window, deliberately separate
 * @param {function} [limits.now]       clock, for tests
 */
export function createAuthLimiter(limits = {}) {
  const env = authLimitsFromEnv();
  const perEmail    = limits.perEmail    ?? env.perEmail;
  const perIp       = limits.perIp       ?? env.perIp;
  const perUser     = limits.perUser     ?? perEmail;
  const perSignupIp = limits.perSignupIp ?? env.perSignupIp;
  const windowMs       = limits.windowMs       ?? env.windowMs;
  const signupWindowMs = limits.signupWindowMs ?? env.signupWindowMs;
  const now         = limits.now;

  const counters = {
    email: createAttemptLimiter({ max: perEmail, windowMs, now }),
    ip:    createAttemptLimiter({ max: perIp,    windowMs, now }),
    user:  createAttemptLimiter({ max: perUser,  windowMs, now }),
    // The one counter on a different clock: an hour, not the sign-in window,
    // and counting a created account rather than a wrong guess. See the header.
    signup: createAttemptLimiter({ max: perSignupIp, windowMs: signupWindowMs, now }),
  };

  /**
   * [kind, key] for each named kind that has a usable value, in check order.
   * `signup` is last because it is the newest, not because anything depends on
   * it: `POST /auth/register` is the only route that passes it and it passes
   * nothing else, so the `blocked` it gets back always names `signup`.
   */
  function pairs(keys) {
    return ['email', 'ip', 'user', 'signup']
      .filter(kind => keys[kind] !== undefined && keys[kind] !== null && keys[kind] !== '')
      .map(kind => [kind, String(keys[kind])]);
  }

  /** What may be logged for a key: an email address never is, not even hashed. */
  const shown = (kind, key) => (kind === 'email' ? 'an email key' : `${kind} ${key}`);

  /**
   * What a counter's number means, in words. Every kind but `signup` counts
   * failures; a block that said "10 failures" about ten accounts somebody
   * successfully created would read to whoever finds it as an attack, when it
   * is a ceiling being reached by ordinary use.
   */
  const counted = (kind, n) => (kind === 'signup' ? `${n} recorded` : `${n} failures`);

  /**
   * Counts one event against every named key. The two public recorders differ
   * only in the words that reach the log: `recordFailure` counts a guess that
   * was wrong, `record` counts something that happened — today, one created
   * account. Sharing the arithmetic is the point, so the signup counter cannot
   * drift away from the ones the sign-in routes use.
   */
  function tally(keys, source, noun, subject) {
    for (const [kind, key] of pairs(keys)) {
      const count = counters[kind].fail(key);
      logAuthLimit('normal', `${noun} ${count}/${counters[kind].max} for a ${kind} key (source: ${source})`);
      logAuthLimit('verbose', `the ${subject} key was ${shown(kind, key)} (source: ${source})`);
    }
  }

  return {
    counters,
    limits: { perEmail, perIp, perUser, perSignupIp, windowMs, signupWindowMs },

    /**
     * The first key over its limit, as `{ kind, count, retryAfter }`, or null.
     * Callers must ask **before** doing the credential work, so a blocked key
     * costs neither a bcrypt compare nor a signature verification.
     */
    blocked(keys, source) {
      for (const [kind, key] of pairs(keys)) {
        const over = counters[kind].check(key);
        if (over) {
          logAuthLimit('light', `blocked: ${kind} key over its limit of ${counters[kind].max} (source: ${source}), ${counted(kind, over.count)}, retry after ${over.retryAfter}s`);
          logAuthLimit('verbose', `the blocked key was ${shown(kind, key)}; ${counters[kind].size()} live ${kind} counters (source: ${source})`);
          return { kind, ...over };
        }
      }
      return null;
    },

    /** Records one failure against every named key. */
    recordFailure(keys, source) {
      tally(keys, source, 'failure', 'failing');
    },

    /**
     * Records one *neutral* event against every named key — a thing that
     * happened rather than a guess that was wrong. `POST /auth/register` calls
     * this for a signup, after the account exists, so a refused registration
     * costs the caller nothing (see the header).
     */
    record(keys, source) {
      tally(keys, source, 'recorded', 'counted');
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
