/**
 * The auth-throttle limits the HTTP suites build their apps with (KOL-050).
 *
 * `POST /auth/register` is throttled per client address — 10 created accounts
 * per hour, by default (src/lib/attemptLimiter.js). Every suite in tests/http
 * registers its fixtures through that real endpoint, from one address
 * (127.0.0.1), within seconds: tests/http/passkeys.test.js alone registers
 * twenty accounts and tests/http/auth.test.js fourteen. A suite that said
 * nothing would therefore start answering 429 partway through and fail on
 * something that has nothing to do with what it is asserting.
 *
 * So suites opt out explicitly — `createApp({ authLimits: SUITE_AUTH_LIMITS })`
 * — rather than the throttle being weakened, made conditional on NODE_ENV, or
 * quietly given a limit no deployment would use. The throttle's own behaviour
 * is asserted against small limits, in the 'signup throttling' group of
 * tests/http/auth.test.js and in tests/unit/attemptLimiter.test.js.
 *
 * Spread it when a suite also needs a small sign-in limit:
 *   createApp({ authLimits: { ...SUITE_AUTH_LIMITS, perEmail: 3 } })
 */
export const SUITE_AUTH_LIMITS = Object.freeze({ perSignupIp: 10_000 });

export default SUITE_AUTH_LIMITS;
