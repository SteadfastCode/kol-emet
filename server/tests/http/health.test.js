/**
 * `GET /health` over the real stack (KOL-078).
 *
 * The point of the route is that it answers for a monitor — something with no
 * account, no cookie and no origin of ours — and that it stops answering 200
 * when this instance cannot reach its database. Both halves only mean anything
 * through the whole app: the mount has to sit ahead of `requireAuth`, the
 * origin guard has to let a GET past, and the readyState it reports has to be
 * the one the tenant routes would have queried on.
 *
 * What this file defends:
 *   - **200 `{ status: 'ok', db: 'up' }` with no session and no cookie**, and
 *     no `Set-Cookie` on the way back — a poller that had to hold a session
 *     could not tell an expired one from a dead instance, and one that *made* a
 *     session every few seconds would write a session document every few
 *     seconds. `GET /entities` is probed in the same app for 401, so the 200 is
 *     this route being public and not auth being off in the harness.
 *   - **503 `{ status: 'degraded', db: 'down' }` when the connection is not
 *     ready** — once by really closing it (`mongoose.disconnect()`, readyState
 *     0), once with it merely *connecting* (readyState 2), which is the state
 *     production actually sits in while Mongoose reconnects in the background.
 *     Only 1 is up; nothing else is.
 *   - **exactly the three documented keys**, asserted as a set on both answers.
 *     This is the one unauthenticated route whose whole job is to be polled, so
 *     a fourth key — a version, a commit, a provider name — has to be a
 *     deliberate change to an assertion here and not something that arrives in
 *     passing. See the header comment in `src/routes/health.js`.
 *   - **a cross-origin GET is not refused**, so a monitor on someone else's
 *     domain is not a 403. `originGuard` checks unsafe methods only
 *     (`src/middleware/originGuard.js`), and this test is what says so from the
 *     outside.
 *   - **`HEAD /health` answers**, with the same status as the GET in both
 *     states, because that is what some monitors send.
 *   - **`Cache-Control: no-store`**, so a proxy cannot serve a cached 200 that
 *     outlives the state it describes.
 *
 * Falsification: move the mount below `requireAuth` in `src/app.js` and the
 * first group 401s; map any readyState other than 1 to `ok` and the degraded
 * cases fail; add a key to the body and the key-set assertions name it.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_HEALTH_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per readyState this suite forces, naming how it forced it
 *   normal  — light, plus every probe with its status and body
 *   verbose — normal, plus the response headers of every probe
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';
import session from 'express-session';
import request from 'supertest';

// The origin a session write would have to come from. Nothing here signs in —
// it is set so the guard is configured exactly as in the other suites, and so
// EVIL_ORIGIN below is genuinely *not* the allowed one.
import { CLIENT_ORIGIN } from '../helpers/origin.js';
import * as db from '../helpers/db.js';

// The environment has to be in place before src/app.js is imported — same
// reasoning as tests/http/tenancy.test.js, hence the dynamic import below.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
// Unset on purpose: `GET /entities` is probed for 401 below, and a stray
// bearer token in the environment would satisfy requireAuth and mask it.
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.HEALTH_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_HEALTH_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/health:${level}] ${msg}`);
}

/** The keys the route publishes, and the whole of them. Change one, change docs/api.md. */
const BODY_KEYS = ['db', 'status', 'uptimeSeconds'];

const EVIL_ORIGIN = 'https://evil.test';

let app;
/** The in-memory mongod's URI, kept so a test can close the connection and reopen it. */
let uri;

/** A probe, logged at `normal`/`verbose` so a failure says what came back. */
async function probe(method, path, headers = {}) {
  let req = request(app)[method](path);
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  const res = await req;
  log('normal', `${method.toUpperCase()} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
  log('verbose', `headers: ${JSON.stringify(res.headers)}`);
  return res;
}

/**
 * Runs `fn` with `mongoose.connection.readyState` reporting `state`.
 *
 * An own data property shadows the accessor Mongoose defines on the prototype,
 * which is the only way to stage a *transient* state (2, connecting) — the one
 * production sits in while the driver reconnects, and one no amount of
 * disconnecting can hold still. `delete` restores the real getter.
 */
async function withReadyState(state, fn) {
  Object.defineProperty(mongoose.connection, 'readyState', { value: state, configurable: true });
  log('light', `forced readyState ${state} (source: own property shadowing Connection.prototype.readyState)`);
  try {
    await fn();
  } finally {
    delete mongoose.connection.readyState;
    log('light', `restored readyState ${mongoose.connection.readyState} (source: deleted the shadowing property)`);
  }
}

describe('GET /health', () => {
  before(async () => {
    uri = await db.connect();
    // MemoryStore, so session handling never reaches for Mongo: this suite
    // closes the connection on purpose and nothing about that may depend on
    // where sessions live.
    app = createApp({ sessionStore: new session.MemoryStore() });
    log('light', `app built with a MemoryStore; readyState ${mongoose.connection.readyState} (source: tests/helpers/db.js connect())`);
  });

  after(async () => {
    await db.disconnect();
  });

  describe('a connected instance', () => {
    test('answers 200 ok/up to a caller with no session and no cookie', async () => {
      assert.equal(mongoose.connection.readyState, 1, 'precondition: the harness is connected');

      const res = await probe('get', '/health');

      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
      assert.equal(res.body.db, 'up');
      assert.equal(res.headers['set-cookie'], undefined, 'polling must not establish a session');
    });

    test('publishes exactly the three documented keys', async () => {
      const res = await probe('get', '/health');

      assert.deepEqual(Object.keys(res.body).sort(), BODY_KEYS,
        'the body is status/db/uptimeSeconds and nothing else — adding a key is a deliberate change here');
      assert.ok(Number.isInteger(res.body.uptimeSeconds), 'uptimeSeconds is whole seconds');
      assert.ok(res.body.uptimeSeconds >= 0);
    });

    test('is public because it is mounted ahead of requireAuth, not because the harness is open', async () => {
      const entities = await probe('get', '/entities');

      assert.equal(entities.status, 401, 'the same app refuses an authenticated route without a session');
    });

    test('forbids caching, so a proxy cannot answer for a state that has passed', async () => {
      const res = await probe('get', '/health');

      assert.match(res.headers['cache-control'] ?? '', /no-store/);
    });

    test('is not refused when the GET comes from another origin', async () => {
      const res = await probe('get', '/health', { Origin: EVIL_ORIGIN });

      assert.equal(res.status, 200, 'originGuard checks unsafe methods only; a monitor is not a write');
      assert.notEqual(res.body.error, 'CROSS_ORIGIN_REQUEST');
    });

    test('answers a HEAD, which is what some monitors send', async () => {
      const res = await probe('head', '/health');

      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.body), [], 'a HEAD carries no body');
    });
  });

  describe('an instance that cannot reach its database', () => {
    test('answers 503 degraded/down once the connection is really closed', async () => {
      await mongoose.disconnect();
      log('light', `forced readyState ${mongoose.connection.readyState} (source: mongoose.disconnect())`);

      try {
        assert.equal(mongoose.connection.readyState, 0, 'precondition: the connection is closed');

        const res = await probe('get', '/health');

        assert.equal(res.status, 503);
        assert.equal(res.body.status, 'degraded');
        assert.equal(res.body.db, 'down');
        assert.deepEqual(Object.keys(res.body).sort(), BODY_KEYS,
          'a degraded body publishes the same three keys — no reason, no error text');

        const head = await probe('head', '/health');
        assert.equal(head.status, 503, 'a HEAD reports the same state as the GET');
      } finally {
        // The suite's own repair: mongod is still running, only Mongoose let go.
        await mongoose.connect(uri);
        log('light', `restored readyState ${mongoose.connection.readyState} (source: mongoose.connect(${uri ? 'harness uri' : 'unknown'}))`);
      }
    });

    test('answers 503 while the driver is merely reconnecting', async () => {
      await withReadyState(2, async () => {
        const res = await probe('get', '/health');

        assert.equal(res.status, 503, 'only readyState 1 is up — a reconnecting instance stalls every tenant route');
        assert.equal(res.body.status, 'degraded');
        assert.equal(res.body.db, 'down');
      });

      assert.equal(mongoose.connection.readyState, 1, 'the real connection survived the stub');
    });
  });
});
