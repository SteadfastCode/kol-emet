/**
 * Unit tests for src/lib/sessionCookie.js: which attributes the session cookie
 * is set with, and which a clearing Set-Cookie repeats.
 *
 * KOL-037: `createApp` hardcoded the first deployment's own domain for
 * every production build, so any other deployment of this product issued a
 * cookie scoped to a domain its browsers are not on — dropped silently, a
 * sign-in that answers 200 and leaves the user on the login form. Nothing in
 * development exercised that branch. These tests pin the three environments
 * that matter:
 *   - production with SESSION_COOKIE_DOMAIN: secure, SameSite=None, scoped to
 *     the configured domain and nothing else;
 *   - production without it: the same, host-only, and *no* fallback domain —
 *     the assertion that would have caught the hardcoded value;
 *   - development: no secure flag (it runs over plain http, where a secure
 *     cookie is never sent at all) and SameSite=Lax.
 *
 * Clearing is tested twice over, because it fails in a way nothing else would
 * notice: a browser matches a clearing cookie by name, domain and path, so a
 * clear with the wrong attributes leaves the live cookie in place while the
 * response still looks like a logout. Once against a fake response, for which
 * attributes are picked and from where, and once through a real Express
 * response, for what actually goes on the wire — that second one is what
 * catches `maxAge` reaching `res.clearCookie`, which Express turns back into a
 * fresh seven-day `Expires`.
 *
 * `process.env` is never mutated here: `sessionCookieOptions` takes the
 * environment as an argument, so each case passes its own object and the cases
 * cannot order-depend on each other.
 *
 * Falsification checks: have `sessionCookieOptions` substitute any default
 * domain and the production-without-the-variable test fails; make
 * `configuredDomain` return `''` rather than undefined for a blank value and
 * the blank test fails; spread `req.session.cookie` into the clear instead of
 * picking its fields and the round-trip test fails on its 1970 `Expires`; drop
 * the environment fallback and the post-destroy test throws. That `createApp`
 * asks this module for its cookie at all is pinned over HTTP in
 * tests/http/auth.test.js.
 *
 * Logging: SESSION_COOKIE_LOG_LEVEL, silenced below unless a run sets it.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import express from 'express';
import session from 'express-session';
import request from 'supertest';

import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  clearSessionCookie,
  sessionCookieOptions,
} from '../../src/lib/sessionCookie.js';

process.env.SESSION_COOKIE_LOG_LEVEL ??= 'off';

const DOMAIN = '.kol-emet.example.test';

/** A response that records what clearCookie was called with, and nothing else. */
function fakeRes() {
  const calls = [];
  return { calls, clearCookie: (name, options) => calls.push({ name, options }) };
}

/** An express-session-shaped cookie: the attributes, plus the two that must not be copied. */
function liveSessionCookie(attributes) {
  return {
    path: '/',
    httpOnly: true,
    ...attributes,
    // Real Cookie objects expose both, and `res.clearCookie` passing either
    // through to `res.cookie` is what un-expires a cleared cookie.
    maxAge: SESSION_MAX_AGE_MS,
    expires: new Date(Date.now() + SESSION_MAX_AGE_MS),
  };
}

/** The attributes of a Set-Cookie line for `connect.sid`, keyed lowercase; valueless flags are true. */
function setCookieAttributes(res) {
  const line = (res.headers['set-cookie'] ?? []).find(c => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  assert.ok(line, `the response set no ${SESSION_COOKIE_NAME} cookie`);
  const [pair, ...attributes] = line.split(';');
  const parsed = { value: pair.slice(`${SESSION_COOKIE_NAME}=`.length) };
  for (const attribute of attributes) {
    const [name, ...rest] = attribute.split('=');
    parsed[name.trim().toLowerCase()] = rest.length ? rest.join('=').trim() : true;
  }
  return parsed;
}

describe('sessionCookieOptions', () => {
  test('production with SESSION_COOKIE_DOMAIN scopes the cookie to it', () => {
    const options = sessionCookieOptions({ NODE_ENV: 'production', SESSION_COOKIE_DOMAIN: DOMAIN });

    assert.equal(options.domain, DOMAIN, 'the domain is the configured one, verbatim');
    assert.equal(options.secure, true);
    assert.equal(options.sameSite, 'none', 'the client is served from another origin than the API');
    assert.equal(options.httpOnly, true, 'script must never read the session cookie');
    assert.equal(options.path, '/', 'the whole API is behind one path');
    assert.equal(options.maxAge, SESSION_MAX_AGE_MS);
  });

  test('production without it is host-only, with no instance domain substituted', () => {
    const options = sessionCookieOptions({ NODE_ENV: 'production' });

    // The point of the item: a deployment that has not set the variable gets a
    // cookie its own host keeps, not one scoped to somebody else's domain.
    assert.equal(options.domain, undefined, 'no domain at all, rather than a default one');
    assert.equal(options.secure, true, 'production is https regardless');
    assert.equal(options.sameSite, 'none');
    assert.equal(options.httpOnly, true);
  });

  test('a blank SESSION_COOKIE_DOMAIN counts as unset', () => {
    // `.env.example` ships the key with no value, so a copied-out `.env`
    // defines it as ''. `Domain=` is not a cookie any browser keeps.
    for (const blank of ['', '   ', '\t']) {
      const options = sessionCookieOptions({ NODE_ENV: 'production', SESSION_COOKIE_DOMAIN: blank });
      assert.equal(options.domain, undefined, `blank value ${JSON.stringify(blank)} must not scope the cookie`);
    }
  });

  test('development is not secure and is SameSite=Lax', () => {
    const options = sessionCookieOptions({ NODE_ENV: 'development' });

    assert.equal(options.secure, false, 'a secure cookie is never sent over the dev server’s plain http');
    assert.equal(options.sameSite, 'lax');
    assert.equal(options.httpOnly, true, 'httpOnly does not depend on the environment');
    assert.equal(options.domain, undefined);
  });

  test('an unset NODE_ENV behaves as development, and a set domain is still honoured', () => {
    const bare = sessionCookieOptions({});
    assert.equal(bare.secure, false, 'only NODE_ENV=production arms the production attributes');
    assert.equal(bare.sameSite, 'lax');

    // Deliberately not gated on NODE_ENV: the variable is the whole setting, so
    // a developer pointing two local hostnames at one API can use it too.
    const scoped = sessionCookieOptions({ SESSION_COOKIE_DOMAIN: DOMAIN });
    assert.equal(scoped.domain, DOMAIN);
    assert.equal(scoped.secure, false, 'a domain does not imply production');
  });
});

describe('clearSessionCookie', () => {
  test('repeats the attributes the live session cookie was set with', () => {
    const attributes = { path: '/', domain: DOMAIN, secure: true, sameSite: 'none', httpOnly: true };
    const res = fakeRes();

    clearSessionCookie({ session: { cookie: liveSessionCookie(attributes) } }, res);

    assert.equal(res.calls.length, 1);
    assert.equal(res.calls[0].name, SESSION_COOKIE_NAME);
    assert.deepEqual(res.calls[0].options, attributes, 'exactly the matching attributes, and only those');
  });

  test('never passes maxAge or expires on, whatever the session carries', () => {
    const res = fakeRes();

    clearSessionCookie({ session: { cookie: liveSessionCookie({ domain: DOMAIN, secure: true, sameSite: 'none' }) } }, res);

    // Express recomputes `expires` from `maxAge` in `res.cookie`, so either one
    // reaching clearCookie turns the clear into a fresh seven-day cookie.
    assert.deepEqual(Object.keys(res.calls[0].options).sort(), ['domain', 'httpOnly', 'path', 'sameSite', 'secure']);
  });

  test('falls back to the environment when the session is already gone', () => {
    // `req.session.destroy()` deletes req.session synchronously, before its
    // callback runs, so a caller that clears in the callback lands here. The
    // rebuilt attributes are the ones createApp configured, from the same
    // function and the same process.env.
    const res = fakeRes();

    clearSessionCookie({}, res);

    const { domain, secure, sameSite, httpOnly, path } = sessionCookieOptions();
    assert.deepEqual(res.calls[0].options, { path, domain, secure, sameSite, httpOnly });
    assert.equal(path, '/', 'the fallback names the path rather than leaving it to a default');
    assert.ok(!('maxAge' in res.calls[0].options), 'the rebuilt attributes drop maxAge too');
  });
});

describe('through a real Express response', () => {
  /**
   * One app, two routes: `/set` starts a session (so express-session issues the
   * cookie), `/clear` ends it exactly as `POST /auth/logout` does.
   *
   * `trust proxy` is set because these cases build production cookies:
   * express-session refuses to send a secure cookie over a connection it
   * considers unencrypted, and supertest speaks plain http — so each request
   * below carries the `X-Forwarded-Proto` a hosted TLS terminator would add,
   * which is exactly how the deployed API sees its own traffic.
   */
  function appWith(env) {
    const app = express();
    app.set('trust proxy', 1);
    app.use(session({
      secret: 'test-session-cookie-secret',
      resave: false,
      saveUninitialized: false,
      store: new session.MemoryStore(),
      cookie: sessionCookieOptions(env),
    }));
    app.get('/set', (req, res) => { req.session.userId = 'someone'; res.json({ ok: true }); });
    app.get('/clear', (req, res) => {
      clearSessionCookie(req, res);
      req.session.destroy(() => res.json({ ok: true }));
    });
    return app;
  }

  /** Start a session, then end it with the cookie the first response issued. */
  async function setThenClear(app) {
    const issued = await request(app).get('/set').set('X-Forwarded-Proto', 'https');
    const pair = (issued.headers['set-cookie'] ?? [])[0]?.split(';')[0];
    assert.ok(pair, 'the session cookie must be issued before it can be cleared');

    // With the cookie, so the clear reads the attributes back off a session
    // rehydrated from the store, as logout does — not off a fresh one.
    const ended = await request(app).get('/clear').set('Cookie', pair).set('X-Forwarded-Proto', 'https');
    return { set: setCookieAttributes(issued), cleared: setCookieAttributes(ended) };
  }

  test('the clear expires the cookie and matches the attributes it was set with', async () => {
    const { set, cleared } = await setThenClear(appWith({ NODE_ENV: 'production', SESSION_COOKIE_DOMAIN: DOMAIN }));

    assert.ok(set.value, 'the session cookie was issued with a value');
    assert.equal(cleared.value, '', 'the clear sends an empty value');
    assert.equal(cleared.expires, 'Thu, 01 Jan 1970 00:00:00 GMT', 'and a date in the past');
    assert.equal(cleared['max-age'], undefined, 'a clear must not carry a Max-Age Express would re-expire from');

    for (const attribute of ['domain', 'path', 'httponly', 'samesite', 'secure']) {
      assert.equal(cleared[attribute], set[attribute], `${attribute} must match the cookie being cleared`);
    }
    assert.equal(cleared.domain, DOMAIN);
    assert.equal(cleared.samesite, 'None');
    assert.equal(cleared.secure, true);
  });

  test('a host-only deployment clears a host-only cookie', async () => {
    const { set, cleared } = await setThenClear(appWith({ NODE_ENV: 'production' }));

    assert.equal(set.domain, undefined, 'nothing scoped it');
    assert.equal(cleared.domain, undefined, 'and nothing scopes the clear either');
    assert.equal(cleared.expires, 'Thu, 01 Jan 1970 00:00:00 GMT');
  });
});
