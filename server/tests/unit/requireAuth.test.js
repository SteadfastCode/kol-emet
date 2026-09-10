/**
 * Unit tests for `requireAuth` in src/middleware/auth.js, and specifically for
 * one claim: an unset `BEARER_TOKEN` can never be matched by anything a client
 * can send.
 *
 * Why the claim needs a test at all. `/mcp` has its own gate, and that gate
 * used to read a missing `MCP_BEARER_TOKEN` as "no auth needed" — an open
 * endpoint on any box where the variable was forgotten (KOL-007 made it fail
 * closed instead). The obvious next question is whether the REST API's gate
 * has the same hole. It does not, but the reason lives in two easily-edited
 * details rather than anywhere it is written down:
 *
 *   1. The parser yields a string or `null`, never `undefined`, and the
 *      comparison is strict. An unset variable reads as `undefined`, so it is
 *      a value no request can produce. Loosen that comparison — `==`, a
 *      `String(...)` coercion, a substring match — and `Authorization: Bearer
 *      undefined` starts authenticating as the MCP client.
 *   2. The `token &&` guard is what makes an *empty* configured token
 *      (`BEARER_TOKEN=` in a .env file, which dotenv reads as `''`) fail
 *      closed. That is the same misconfiguration one character further along,
 *      so it gets its own group below.
 *
 * This file pins the property, not the implementation: whatever the middleware
 * looks like, an unset or empty `BEARER_TOKEN` must not let anything through
 * the bearer path.
 *
 * These are direct calls with hand-built `req`/`res` objects, not HTTP. The
 * function is synchronous, touches no database, and reads exactly two things
 * (`req.session?.userId` and the `authorization` header) — driving it through a
 * server would add a mount, a route and a body parser to a test whose subject
 * is a four-line comparison, and would make the failure harder to read, not
 * easier.
 *
 * `process.env.BEARER_TOKEN` is read per call rather than at module load, so
 * each group sets it in `before` and restores the ambient value in `after`;
 * nothing here depends on how the process was started.
 *
 * Falsification checks for this suite, all run red before this file landed:
 * compare against `String(process.env.BEARER_TOKEN)` in `src/middleware/
 * auth.js` and the `Bearer undefined` case in the unset group fails; drop the `token &&` guard
 * and the empty-token group fails; make the comparison a prefix match
 * (`process.env.BEARER_TOKEN?.startsWith(token)`) and the truncated-token case
 * fails; delete the session branch and the session case fails.
 *
 * Deliberately not covered: `requireActor`, which resolves the acting user for
 * writes and needs a database — `tests/http/tenancy.test.js` drives it over the
 * real stack.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { requireAuth } from '../../src/middleware/auth.js';

/** Minimal `res` double recording only what `requireAuth` uses. */
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

/**
 * Calls the middleware once.
 * `header === undefined` sends no Authorization header at all; any string is
 * sent verbatim, so the malformed shapes below reach the parser as written.
 */
function callRequireAuth({ header, session } = {}) {
  const req = { headers: header === undefined ? {} : { authorization: header }, session };
  const res = fakeRes();
  let passed = false;
  requireAuth(req, res, () => { passed = true; });
  return { passed, status: res.statusCode, body: res.body };
}

/** Asserts the middleware refused, and refused the same way it always does. */
function assertRefused(result, what) {
  assert.equal(result.passed, false, `${what} must not reach next()`);
  assert.equal(result.status, 401, `${what} should be 401, got ${result.status}`);
  assert.deepEqual(result.body, { error: 'Unauthorized' }, `${what} answered an unexpected body`);
}

const REAL_TOKEN = 'a-real-programmatic-token';

describe('requireAuth with BEARER_TOKEN unset', () => {
  let saved;

  before(() => {
    saved = process.env.BEARER_TOKEN;
    delete process.env.BEARER_TOKEN;
  });

  after(() => {
    if (saved === undefined) delete process.env.BEARER_TOKEN;
    else process.env.BEARER_TOKEN = saved;
  });

  test('no Authorization header is refused', () => {
    assertRefused(callRequireAuth(), 'a request with no Authorization header');
  });

  /**
   * The headers a caller can actually produce when the token they meant to
   * send is itself missing. Each one is a value that an unguarded
   * `token === process.env.BEARER_TOKEN` could be talked into accepting, or
   * that a sloppier parser would turn into `undefined` before comparing.
   */
  const CANNOT_MATCH = [
    ['an empty header', ''],
    ['a bearer with an empty token', 'Bearer '],
    ['the literal string undefined', 'Bearer undefined'],
    ['the literal string null', 'Bearer null'],
    ['a stringified template hole', 'Bearer ${process.env.BEARER_TOKEN}'],
    ['the word Bearer with no token', 'Bearer'],
    ['a lowercase scheme', 'bearer '],
    ['a different scheme entirely', 'Basic dXNlcjpwYXNz'],
  ];

  for (const [what, header] of CANNOT_MATCH) {
    test(`${what} is refused`, () => {
      assertRefused(callRequireAuth({ header }), `${what} (${JSON.stringify(header)})`);
    });
  }

  test('a session still authenticates, so the refusals above are the bearer path', () => {
    // Without this the group would also pass if requireAuth refused
    // everything unconditionally.
    const result = callRequireAuth({ session: { userId: 'abc123' } });
    assert.equal(result.passed, true, 'a session-bearing request must reach next()');
    assert.equal(result.status, null, 'an authenticated request must not get a status');
  });
});

describe('requireAuth with BEARER_TOKEN set to an empty string', () => {
  // `BEARER_TOKEN=` with nothing after it is what a half-filled .env leaves
  // behind, and dotenv reads it as '' rather than leaving it unset — so this
  // is a *configured* token that every `Bearer ` header trivially matches on a
  // bare string comparison. It has to fail closed like the unset case.
  let saved;

  before(() => {
    saved = process.env.BEARER_TOKEN;
    process.env.BEARER_TOKEN = '';
  });

  after(() => {
    if (saved === undefined) delete process.env.BEARER_TOKEN;
    else process.env.BEARER_TOKEN = saved;
  });

  test('a bearer with an empty token is refused', () => {
    assertRefused(callRequireAuth({ header: 'Bearer ' }), 'an empty token against an empty BEARER_TOKEN');
  });

  test('no Authorization header is refused', () => {
    assertRefused(callRequireAuth(), 'a request with no Authorization header');
  });

  test('a non-empty token is refused', () => {
    assertRefused(callRequireAuth({ header: 'Bearer anything' }), 'a token against an empty BEARER_TOKEN');
  });
});

describe('requireAuth with BEARER_TOKEN configured', () => {
  let saved;

  before(() => {
    saved = process.env.BEARER_TOKEN;
    process.env.BEARER_TOKEN = REAL_TOKEN;
  });

  after(() => {
    if (saved === undefined) delete process.env.BEARER_TOKEN;
    else process.env.BEARER_TOKEN = saved;
  });

  test('the exact token authenticates', () => {
    // The other half of the proof: the unset-token group above is refusing
    // because there is nothing to match, not because this path never works.
    const result = callRequireAuth({ header: `Bearer ${REAL_TOKEN}` });
    assert.equal(result.passed, true, 'the configured token must reach next()');
  });

  test('a prefix of the token is refused', () => {
    assertRefused(callRequireAuth({ header: `Bearer ${REAL_TOKEN.slice(0, -1)}` }), 'a truncated token');
  });

  test('the token with anything appended is refused', () => {
    assertRefused(callRequireAuth({ header: `Bearer ${REAL_TOKEN}x` }), 'an extended token');
  });

  test('the literal string undefined is still refused', () => {
    assertRefused(callRequireAuth({ header: 'Bearer undefined' }), 'the literal string undefined');
  });
});
