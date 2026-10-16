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
 * bearer path reads exactly two things (`req.session?.userId` and the
 * `authorization` header) and touches no database — driving it through a server
 * would add a mount, a route and a body parser to a test whose subject is a
 * four-line comparison, and would make the failure harder to read, not easier.
 *
 * The *session* path does touch the database since KOL-076: it reads the
 * account's `credentialsChangedAt` to end a session issued before the account
 * last signed everything out. So the middleware is async, every call here is
 * awaited, and the one session case below stubs that single read — it is a
 * positive control for the bearer refusals, not a test of the revocation rule,
 * which `tests/http/sessionRevocation.test.js` drives over the real stack.
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
 *
 * ─── And one rule of `requireLoginSession` (KOL-098) ─────────────────────────
 * The guard the two OAuth approval forms now sit behind takes a live login
 * session and refuses a bearer token outright. Its refusals are driven over the
 * real stack in `tests/http/oauth.test.js` and `tests/http/bridge.test.js`; the
 * group at the bottom of this file pins the one case HTTP cannot stage — the
 * account lookup *failing*. A database blip must reach the error handler as a
 * 500, never be answered as a 401, because a 401 here would claim a session had
 * ended when nothing ended it and would have the user re-authorizing a
 * connector that was never un-authorized.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { requireAuth, requireLoginSession } from '../../src/middleware/auth.js';
import User from '../../src/models/User.js';

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
async function callRequireAuth({ header, session } = {}) {
  const req = { headers: header === undefined ? {} : { authorization: header }, session };
  const res = fakeRes();
  let passed = false;
  await requireAuth(req, res, () => { passed = true; });
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

  test('no Authorization header is refused', async () => {
    assertRefused(await callRequireAuth(), 'a request with no Authorization header');
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
    test(`${what} is refused`, async () => {
      assertRefused(await callRequireAuth({ header }), `${what} (${JSON.stringify(header)})`);
    });
  }

  test('a session still authenticates, so the refusals above are the bearer path', async () => {
    // Without this the group would also pass if requireAuth refused
    // everything unconditionally.
    //
    // The one read the session path makes, stubbed: an account that has never
    // revoked anything (no `credentialsChangedAt`), which is the state every
    // account registered before KOL-076 is in. There is no mongod in a unit
    // test, and what this case is for is the bearer refusals above.
    const realFindById = User.findById;
    User.findById = () => ({ select: () => ({ lean: async () => ({ _id: 'abc123' }) }) });
    try {
      const result = await callRequireAuth({ session: { userId: 'abc123' } });
      assert.equal(result.passed, true, 'a session-bearing request must reach next()');
      assert.equal(result.status, null, 'an authenticated request must not get a status');
    } finally {
      User.findById = realFindById;
    }
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

  test('a bearer with an empty token is refused', async () => {
    assertRefused(await callRequireAuth({ header: 'Bearer ' }), 'an empty token against an empty BEARER_TOKEN');
  });

  test('no Authorization header is refused', async () => {
    assertRefused(await callRequireAuth(), 'a request with no Authorization header');
  });

  test('a non-empty token is refused', async () => {
    assertRefused(await callRequireAuth({ header: 'Bearer anything' }), 'a token against an empty BEARER_TOKEN');
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

  test('the exact token authenticates', async () => {
    // The other half of the proof: the unset-token group above is refusing
    // because there is nothing to match, not because this path never works.
    const result = await callRequireAuth({ header: `Bearer ${REAL_TOKEN}` });
    assert.equal(result.passed, true, 'the configured token must reach next()');
  });

  test('a prefix of the token is refused', async () => {
    assertRefused(await callRequireAuth({ header: `Bearer ${REAL_TOKEN.slice(0, -1)}` }), 'a truncated token');
  });

  test('the token with anything appended is refused', async () => {
    assertRefused(await callRequireAuth({ header: `Bearer ${REAL_TOKEN}x` }), 'an extended token');
  });

  test('the literal string undefined is still refused', async () => {
    assertRefused(await callRequireAuth({ header: 'Bearer undefined' }), 'the literal string undefined');
  });
});

// ─── requireLoginSession (KOL-098) ───────────────────────────────────────────

/** Calls the connector-grant guard once. */
async function callRequireLoginSession({ header, session } = {}) {
  const req = {
    headers: header === undefined ? {} : { authorization: header },
    session,
    sessionID: 'test-session-id',
    method: 'POST',
    originalUrl: '/authorize',
  };
  const res = fakeRes();
  let passed = false;
  let forwarded;
  await requireLoginSession(req, res, (err) => { passed = !err; forwarded = err; });
  return { passed, forwarded, status: res.statusCode, body: res.body, loginUserId: req.loginUserId };
}

/** Replaces the one read the guard makes, and puts it back afterwards. */
async function withFindById(impl, run) {
  const real = User.findById;
  User.findById = impl;
  try { return await run(); } finally { User.findById = real; }
}

describe('requireLoginSession', () => {
  let saved;

  before(() => {
    saved = process.env.BEARER_TOKEN;
    process.env.BEARER_TOKEN = REAL_TOKEN;
  });

  after(() => {
    if (saved === undefined) delete process.env.BEARER_TOKEN;
    else process.env.BEARER_TOKEN = saved;
  });

  test('a lookup that did not answer is forwarded, not answered as a 401', async () => {
    const blip = new Error('connection timed out');
    const result = await withFindById(
      () => ({ select: () => ({ lean: async () => { throw blip; } }) }),
      () => callRequireLoginSession({ session: { userId: 'abc123', issuedAt: Date.now() } }),
    );

    assert.equal(result.forwarded, blip, 'the error must reach the error handler');
    assert.equal(result.status, null, 'a database blip must not be reported as a refusal');
    assert.equal(result.loginUserId, undefined, 'and must not be taken as authorization either');
  });

  test('a live session is passed through with its user id', async () => {
    // The positive control: the refusals in this group are refusals of what
    // they name, not of everything.
    const result = await withFindById(
      () => ({ select: () => ({ lean: async () => ({ _id: 'abc123' }) }) }),
      () => callRequireLoginSession({ session: { userId: 'abc123', issuedAt: Date.now() } }),
    );

    assert.equal(result.passed, true, 'a live session must reach next()');
    assert.equal(result.loginUserId, 'abc123', 'and name the account the grant binds to');
  });

  test('the configured bearer token is not enough, and reads no account', async () => {
    // A connector that could re-point the identity it acts as is a connector
    // whose revocation does not hold — so this guard has no bearer path, and
    // the throwing stub proves it does not even look.
    const result = await withFindById(
      () => { throw new Error('requireLoginSession must not look an account up for a bearer caller'); },
      () => callRequireLoginSession({ header: `Bearer ${REAL_TOKEN}` }),
    );

    assertRefused(result, 'the configured bearer token at a connector-grant route');
  });
});
