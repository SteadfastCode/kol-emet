/**
 * Unit tests for the sign-in failure counters in src/lib/attemptLimiter.js.
 *
 * The subject is the only thing standing between `POST /auth/login` and an
 * unlimited online password-guessing budget, so the properties asserted here
 * are the ones that make it a limit at all rather than a speed bump:
 *
 *   **It blocks at max+1, not at max.** Off by one in the permissive direction
 *   is an extra guess per window forever; off by one the other way locks a
 *   real person out one try early. Both are asserted from the outside — count
 *   the answers, not the internals.
 *
 *   **The window ends.** A counter that never expires is an account lockout,
 *   which this deliberately is not: a wrong password must stop costing the
 *   person who typed it once the window passes. The clock is injected, so this
 *   is asserted by stepping time rather than by sleeping 15 minutes.
 *
 *   **A success clears the key.** Nine wrong tries then the right one must
 *   leave a clean slate, or a habitual typo would eventually lock someone out
 *   of an account they can sign into.
 *
 *   **Keys are independent, and expired ones are swept.** One address's
 *   failures must not touch another's (otherwise anyone can lock out anyone),
 *   and the map must not grow by one entry per address an attacker invents —
 *   that would make a word list a memory-exhaustion tool against the API.
 *
 *   **A blocked attempt is not counted.** Counting it would extend the window
 *   on every retry, quietly turning a 15-minute throttle into a permanent ban
 *   for any client that retries on a timer.
 *
 * The composite (`createAuthLimiter`) is covered for the parts the routes rely
 * on that the single counters cannot show: the three kinds are separate
 * counters, `blocked` reports the first kind over its limit in a fixed order,
 * and `refuse` writes one byte-identical body with a Retry-After. The routes'
 * own use of it — which call sites check, count and clear — is asserted over
 * HTTP in tests/http/auth.test.js, where it can be wrong in ways a unit test
 * cannot see.
 *
 * Falsification checks, each run red against a deliberately broken limiter:
 *   - `entry.count <= max` instead of `< max` in check() → the max+1 test fails.
 *   - Drop the `resetAt <= at` branch in live() → the expiry tests fail.
 *   - Make reset() a no-op → the reset test and the success-clears test fail.
 *   - Key the map on a constant → the independence test fails.
 *   - Delete the sweep → the pruning test fails (the map keeps every key).
 *   - Have blocked() call fail() as well → the "a block is not a failure" test
 *     fails on the count it reports afterwards.
 *   - Give refuse() a body that names the key → the enumeration test in
 *     tests/http/auth.test.js fails rather than this file.
 *
 * Debug logging: AUTH_LIMIT_LOG_LEVEL=off|light|normal|verbose. Forced to
 * 'off' below — this file drives hundreds of failures on purpose and the
 * limiter's own light tier would bury the assertions.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_LIMIT_LOG_LEVEL = 'off';

const {
  createAttemptLimiter,
  createAuthLimiter,
  authLimitsFromEnv,
  AUTH_LIMIT_DEFAULTS,
  TOO_MANY_ATTEMPTS,
} = await import('../../src/lib/attemptLimiter.js');

const WINDOW = 15 * 60 * 1000;

/** A clock the tests move by hand: `clock.now()` is what the limiter reads. */
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) { t += ms; return t; },
    set(ms) { t = ms; return t; },
  };
}

describe('createAttemptLimiter: one fixed window', () => {
  let clock;
  let limiter;

  beforeEach(() => {
    clock = fakeClock();
    limiter = createAttemptLimiter({ max: 3, windowMs: WINDOW, now: clock.now });
  });

  test('allows exactly max failures and blocks the one after', () => {
    for (let i = 1; i <= 3; i += 1) {
      assert.equal(limiter.check('a@example.test'), null, `attempt ${i} of 3 must still be allowed`);
      assert.equal(limiter.fail('a@example.test'), i, 'fail() reports the running count');
    }

    const block = limiter.check('a@example.test');
    assert.ok(block, 'the 4th attempt must be blocked');
    assert.equal(block.count, 3);
    assert.equal(block.retryAfter, WINDOW / 1000, 'nothing has elapsed, so the wait is the whole window');
  });

  test('a blocked attempt is not itself counted, so the window still ends', () => {
    for (let i = 0; i < 3; i += 1) limiter.fail('a@example.test');

    // Ten refusals at the start of the window.
    for (let i = 0; i < 10; i += 1) assert.ok(limiter.check('a@example.test'));

    clock.advance(WINDOW);
    assert.equal(limiter.check('a@example.test'), null, 'retrying through the window must not extend it');
  });

  test('the window expires and the key starts over', () => {
    for (let i = 0; i < 3; i += 1) limiter.fail('a@example.test');
    assert.ok(limiter.check('a@example.test'), 'blocked to begin with');

    clock.advance(WINDOW - 1);
    assert.ok(limiter.check('a@example.test'), 'one millisecond short of the window, still blocked');

    clock.advance(1);
    assert.equal(limiter.check('a@example.test'), null, 'at the window boundary the key is free again');
    assert.equal(limiter.fail('a@example.test'), 1, 'and its count starts from one, not from four');
  });

  test('retryAfter counts down with the clock and never asks for a 0-second wait', () => {
    for (let i = 0; i < 3; i += 1) limiter.fail('a@example.test');

    clock.advance(WINDOW / 2);
    assert.equal(limiter.check('a@example.test').retryAfter, WINDOW / 2000);

    clock.advance(WINDOW / 2 - 10); // 10ms left
    assert.equal(limiter.check('a@example.test').retryAfter, 1, 'a sub-second remainder still asks for a real wait');
  });

  test('reset clears the key, and says whether there was anything to clear', () => {
    for (let i = 0; i < 3; i += 1) limiter.fail('a@example.test');
    assert.ok(limiter.check('a@example.test'), 'blocked before the reset');

    assert.equal(limiter.reset('a@example.test'), true);
    assert.equal(limiter.check('a@example.test'), null, 'a reset key is free immediately');
    assert.equal(limiter.reset('a@example.test'), false, 'resetting an unknown key is a no-op');
  });

  test('keys are independent: one blocked address does not touch another', () => {
    for (let i = 0; i < 5; i += 1) limiter.fail('victim@example.test');

    assert.ok(limiter.check('victim@example.test'));
    assert.equal(limiter.check('someone-else@example.test'), null, 'no key may lock out another');
    assert.equal(limiter.fail('someone-else@example.test'), 1, 'and its count is its own');
  });

  test('expired entries are swept, so a word list cannot grow the map without bound', () => {
    for (let i = 0; i < 500; i += 1) limiter.fail(`guess-${i}@example.test`);
    assert.equal(limiter.size(), 500);

    // Past the window, the next access sweeps everything that has expired.
    clock.advance(WINDOW + 1);
    limiter.fail('someone-real@example.test');

    assert.equal(limiter.size(), 1, 'only the live key survives');
    assert.equal(limiter.check('guess-0@example.test'), null);
  });

  test('a key that keeps failing is not swept out from under its own window', () => {
    for (let i = 0; i < 400; i += 1) limiter.fail(`guess-${i}@example.test`);

    clock.advance(WINDOW - 1_000); // still inside every key's window
    assert.equal(limiter.fail('guess-0@example.test'), 2, 'the entry is live, so its count continues rather than restarting');
    assert.equal(limiter.size(), 400, 'nothing has expired, so nothing may be dropped');
  });

  test('refuses a max or window that would disable it', () => {
    for (const max of [0, -1, 1.5, '3', undefined, null]) {
      assert.throws(() => createAttemptLimiter({ max, windowMs: WINDOW }), TypeError, `max=${JSON.stringify(max)} must throw`);
    }
    for (const windowMs of [0, -1, undefined, null, NaN]) {
      assert.throws(() => createAttemptLimiter({ max: 3, windowMs }), TypeError, `windowMs=${JSON.stringify(windowMs)} must throw`);
    }
  });

  test('the real clock is the default', () => {
    const live = createAttemptLimiter({ max: 1, windowMs: WINDOW });
    live.fail('a@example.test');
    const block = live.check('a@example.test');
    assert.ok(block.retryAfter > 0 && block.retryAfter <= WINDOW / 1000);
  });
});

describe('authLimitsFromEnv', () => {
  test('ships the documented defaults', () => {
    assert.deepEqual(authLimitsFromEnv({}), { perEmail: 10, perIp: 100, windowMs: WINDOW });
    assert.deepEqual({ ...AUTH_LIMIT_DEFAULTS }, { perEmail: 10, perIp: 100, windowMs: WINDOW });
  });

  test('reads the AUTH_LIMIT_* overrides, and ignores ones that would break it', () => {
    assert.deepEqual(
      authLimitsFromEnv({ AUTH_LIMIT_MAX_PER_EMAIL: '5', AUTH_LIMIT_MAX_PER_IP: '50', AUTH_LIMIT_WINDOW_MS: '60000' }),
      { perEmail: 5, perIp: 50, windowMs: 60_000 },
    );
    // A typo in the environment must not silently switch the throttle off.
    assert.deepEqual(
      authLimitsFromEnv({ AUTH_LIMIT_MAX_PER_EMAIL: 'ten', AUTH_LIMIT_MAX_PER_IP: '0', AUTH_LIMIT_WINDOW_MS: '' }),
      { perEmail: 10, perIp: 100, windowMs: WINDOW },
    );
  });
});

describe('createAuthLimiter: the three counters the routes share', () => {
  test('email, ip and user are separate counters with their own limits', () => {
    const clock = fakeClock();
    const auth = createAuthLimiter({ perEmail: 2, perIp: 4, windowMs: WINDOW, now: clock.now });

    assert.deepEqual(auth.limits, { perEmail: 2, perIp: 4, perUser: 2, windowMs: WINDOW });

    auth.recordFailure({ email: 'a@example.test', ip: '10.0.0.1' }, 'test');
    auth.recordFailure({ email: 'a@example.test', ip: '10.0.0.1' }, 'test');

    assert.ok(auth.blocked({ email: 'a@example.test' }, 'test'), 'the email is over its limit of 2');
    assert.equal(auth.blocked({ ip: '10.0.0.1' }, 'test'), null, 'the address has 2 of its 4');
    assert.equal(auth.blocked({ email: 'b@example.test', ip: '10.0.0.1' }, 'test'), null, 'a different email from the same address is free');
  });

  test('blocked() names the first kind over its limit, email before ip', () => {
    const auth = createAuthLimiter({ perEmail: 1, perIp: 1, windowMs: WINDOW });
    auth.recordFailure({ email: 'a@example.test', ip: '10.0.0.1' }, 'test');

    assert.equal(auth.blocked({ email: 'a@example.test', ip: '10.0.0.1' }, 'test').kind, 'email');
    assert.equal(auth.blocked({ ip: '10.0.0.1' }, 'test').kind, 'ip', 'the ip limit stands on its own');
  });

  test('missing and empty keys are skipped rather than counted as one shared key', () => {
    const auth = createAuthLimiter({ perIp: 1, windowMs: WINDOW });

    auth.recordFailure({ email: '', ip: undefined, user: null }, 'test');
    assert.equal(auth.counters.email.size(), 0, 'an empty email is no key at all');
    assert.equal(auth.counters.ip.size(), 0);
    assert.equal(auth.counters.user.size(), 0);
    assert.equal(auth.blocked({ email: '', ip: undefined }, 'test'), null);
  });

  // The other half of KOL-044, stated as the contract the routes must meet:
  // skipping is not leniency, it is absence. `emailKey()` in src/routes/auth.js
  // answers '' for anything that is not a string, so handing this an
  // unvalidated body's email meant the per-email limit did not exist for that
  // request. The route now refuses such a body outright; this pins why it has
  // to, since nothing here can tell "no email in this body" (the passkey route,
  // legitimately) from "an email this code could not read".
  test("an email key of '' is not a lenient key, it is no key at all", () => {
    const auth = createAuthLimiter({ perEmail: 1, perIp: 100, windowMs: WINDOW });

    for (let i = 0; i < 50; i += 1) auth.recordFailure({ email: '', ip: '10.0.0.2' }, 'test');

    assert.equal(auth.counters.email.size(), 0, 'nothing was counted on the email key');
    assert.equal(
      auth.blocked({ email: '', ip: '10.0.0.2' }, 'test'), null,
      'fifty guesses that a limit of one should have stopped after the first, held back only by the ip limit',
    );
  });

  test('reset clears only the kinds it is given', () => {
    const auth = createAuthLimiter({ perEmail: 1, perIp: 1, windowMs: WINDOW });
    auth.recordFailure({ email: 'a@example.test', ip: '10.0.0.1' }, 'test');

    auth.reset({ email: 'a@example.test' }, 'test');
    assert.equal(auth.blocked({ email: 'a@example.test' }, 'test'), null, 'the email was cleared');
    assert.ok(auth.blocked({ ip: '10.0.0.1' }, 'test'), 'the address was not, so one good password cannot launder a spray');
  });

  test('perUser follows perEmail unless it is given its own limit', () => {
    assert.equal(createAuthLimiter({ perEmail: 3 }).limits.perUser, 3);
    assert.equal(createAuthLimiter({ perEmail: 3, perUser: 7 }).limits.perUser, 7);
  });

  test('a fresh limiter per call, so no two apps share counters', () => {
    const a = createAuthLimiter({ perEmail: 1, windowMs: WINDOW });
    const b = createAuthLimiter({ perEmail: 1, windowMs: WINDOW });
    a.recordFailure({ email: 'a@example.test' }, 'test');

    assert.ok(a.blocked({ email: 'a@example.test' }, 'test'));
    assert.equal(b.blocked({ email: 'a@example.test' }, 'test'), null);
  });

  test('refuse() writes one 429, a Retry-After and the shared body', () => {
    const auth = createAuthLimiter({ perEmail: 1, windowMs: WINDOW });
    auth.recordFailure({ email: 'a@example.test' }, 'test');

    const headers = {};
    let status;
    let body;
    const res = {
      set: (k, v) => { headers[k] = v; return res; },
      status: (s) => { status = s; return res; },
      json: (b) => { body = b; return res; },
    };

    auth.refuse(res, auth.blocked({ email: 'a@example.test' }, 'test'));

    assert.equal(status, 429);
    assert.deepEqual(body, { error: 'Too many attempts. Try again later.' });
    assert.equal(body, TOO_MANY_ATTEMPTS, 'the one shared object, so no route can word its own');
    assert.equal(headers['Retry-After'], String(WINDOW / 1000));
    assert.match(headers['Retry-After'], /^\d+$/, 'Retry-After is whole seconds, not a float or a date');
  });
});
