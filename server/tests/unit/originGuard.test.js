/**
 * Unit tests for the origin guard (src/middleware/originGuard.js).
 *
 * The guard is six lines of branching over two headers, and every branch is a
 * decision about whether a write happens: a wrong one either lets a cross-site
 * forgery through or 403s the real client. So each branch is driven directly
 * here, with a hand-built request, rather than only through the app — the HTTP
 * suite (tests/http/originGuard.test.js) proves it is mounted and that a refusal
 * writes nothing.
 *
 * Falsification check: invert any condition in `originGuard` and one of these
 * must fail.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { originGuard, readRequestOrigin, allowedOrigins } from '../../src/middleware/originGuard.js';

const CLIENT = 'https://wiki.example.com';
const API_HOST = 'api.example.com';
const API_ORIGIN = `https://${API_HOST}`;

/**
 * A request shaped like the one Express hands the guard: `headers` lowercased,
 * `get` resolving the host the way `req.get('host')` does, and a session only
 * when the caller is signed in.
 */
function req({ method = 'POST', url = '/entities', headers = {}, session = { userId: 'u1' } } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    url,
    originalUrl: url,
    protocol: 'https',
    headers: { host: API_HOST, ...lower },
    get: (name) => lower[name.toLowerCase()] ?? (name.toLowerCase() === 'host' ? API_HOST : undefined),
    session,
  };
}

/** A response that records the refusal instead of writing one. */
function res() {
  const sent = { status: null, body: null };
  return {
    sent,
    status(code) { sent.status = code; return this; },
    json(body) { sent.body = body; return this; },
  };
}

/** Runs the guard and reports whether it called next(). */
function run(request) {
  const response = res();
  let nexted = false;
  originGuard(request, response, () => { nexted = true; });
  return { nexted, ...response.sent };
}

let saved;
beforeEach(() => {
  saved = { CLIENT_ORIGIN: process.env.CLIENT_ORIGIN, level: process.env.ORIGIN_GUARD_LOG_LEVEL };
  process.env.CLIENT_ORIGIN = CLIENT;
  process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
});
afterEach(() => {
  if (saved.CLIENT_ORIGIN === undefined) delete process.env.CLIENT_ORIGIN;
  else process.env.CLIENT_ORIGIN = saved.CLIENT_ORIGIN;
  if (saved.level === undefined) delete process.env.ORIGIN_GUARD_LOG_LEVEL;
  else process.env.ORIGIN_GUARD_LOG_LEVEL = saved.level;
});

describe('originGuard', () => {
  test('a session write from CLIENT_ORIGIN is allowed', () => {
    const out = run(req({ headers: { Origin: CLIENT } }));
    assert.equal(out.nexted, true);
    assert.equal(out.status, null, 'nothing is answered when the request passes');
  });

  test('a session write from a foreign origin is 403 CROSS_ORIGIN_REQUEST', () => {
    const out = run(req({ headers: { Origin: 'https://evil.test' } }));
    assert.equal(out.nexted, false, 'the request must not reach the router');
    assert.equal(out.status, 403);
    assert.deepEqual(out.body, { error: 'CROSS_ORIGIN_REQUEST' });
  });

  test("a session write from the API's own origin is allowed — the OAuth approval pages post to themselves", () => {
    assert.equal(run(req({ url: '/authorize', headers: { Origin: API_ORIGIN } })).nexted, true);
  });

  test('with no Origin, a matching Referer is enough', () => {
    const out = run(req({ headers: { Referer: `${CLIENT}/entities/abc?edit=1` } }));
    assert.equal(out.nexted, true, "the Referer's origin is what is compared, not the whole URL");
  });

  test('with no Origin, a foreign Referer is still 403', () => {
    assert.equal(run(req({ headers: { Referer: 'https://evil.test/post.html' } })).status, 403);
  });

  test('a present but opaque Origin is refused rather than falling back to Referer', () => {
    const out = run(req({ headers: { Origin: 'null', Referer: `${CLIENT}/x` } }));
    assert.equal(out.status, 403, 'a sandboxed page must not get a second chance at a header it also sets');
  });

  test('neither header is 403', () => {
    const out = run(req());
    assert.equal(out.nexted, false);
    assert.equal(out.status, 403);
  });

  test('a safe method is never checked', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      assert.equal(run(req({ method, headers: { Origin: 'https://evil.test' } })).nexted, true, method);
    }
  });

  test('every unsafe method is checked', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(run(req({ method, headers: { Origin: 'https://evil.test' } })).status, 403, method);
    }
  });

  test('a bearer caller is exempt — it sends a token, not a cookie', () => {
    const out = run(req({ headers: { Origin: 'https://evil.test', Authorization: 'Bearer some-token' }, session: null }));
    assert.equal(out.nexted, true);
    // Still exempt when a session cookie rode along: Authorization is not a
    // CORS-safelisted header, so no cross-site simple request can carry one.
    assert.equal(run(req({ headers: { Origin: 'https://evil.test', Authorization: 'Bearer some-token' } })).nexted, true);
  });

  test('a caller with no signed-in session is not checked — there is nothing to ride', () => {
    assert.equal(run(req({ url: '/auth/login', headers: { Origin: 'https://evil.test' }, session: {} })).nexted, true);
    assert.equal(run(req({ url: '/auth/login', headers: { Origin: 'https://evil.test' }, session: null })).nexted, true);
  });

  test('CLIENT_ORIGIN unset leaves only the API\'s own origin allowed', () => {
    delete process.env.CLIENT_ORIGIN;
    assert.equal(run(req({ headers: { Origin: CLIENT } })).status, 403);
    assert.equal(run(req({ headers: { Origin: API_ORIGIN } })).nexted, true);
  });

  test('a blank CLIENT_ORIGIN never matches a blank header', () => {
    process.env.CLIENT_ORIGIN = '  ';
    assert.equal(run(req({ headers: { Origin: '' } })).status, 403);
  });
});

describe('readRequestOrigin', () => {
  test('Origin wins over Referer, and only its origin is kept', () => {
    const found = readRequestOrigin({ headers: { origin: 'https://a.test', referer: 'https://b.test/page' } });
    assert.deepEqual(found, { header: 'Origin', raw: 'https://a.test', origin: 'https://a.test' });
  });

  test('Referer is read when Origin is absent or blank, either spelling', () => {
    assert.equal(readRequestOrigin({ headers: { referer: 'https://b.test/page?q=1' } }).origin, 'https://b.test');
    assert.equal(readRequestOrigin({ headers: { origin: '   ', referrer: 'https://b.test/page' } }).header, 'Referer');
  });

  test('an unusable value is reported, not silently dropped', () => {
    const found = readRequestOrigin({ headers: { origin: 'not a url' } });
    assert.equal(found.header, 'Origin', 'the refusal log has to be able to name what it read');
    assert.equal(found.origin, null);
  });
});

describe('allowedOrigins', () => {
  test('CLIENT_ORIGIN is normalized, so a trailing slash or a path still matches', () => {
    assert.deepEqual(
      allowedOrigins(req({ headers: {} }), { CLIENT_ORIGIN: `${CLIENT}/` }),
      [CLIENT, API_ORIGIN],
    );
  });

  test('one entry when the client is this API', () => {
    assert.deepEqual(allowedOrigins(req({ headers: {} }), { CLIENT_ORIGIN: API_ORIGIN }), [API_ORIGIN]);
  });

  test('the own-origin entry follows the forwarded host behind a trusted proxy', () => {
    const forwarded = req({ headers: { host: 'proxy.internal' } });
    forwarded.get = (name) => (name.toLowerCase() === 'host' ? 'api.public.example' : undefined);
    assert.deepEqual(allowedOrigins(forwarded, {}), ['https://api.public.example']);
  });
});
