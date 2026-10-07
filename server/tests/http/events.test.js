/**
 * `GET /events` over real sockets: what a live SSE stream is allowed to be.
 *
 * The route authenticates once with `requireAuth` and then holds the response
 * open indefinitely, pushing **whole entity documents** at every write in the
 * workspace. That shape has two consequences a multi-tenant API cannot leave
 * standing, and this file is where both are pinned (KOL-062):
 *
 *   **A stream must not outlive its session.** After `POST /auth/logout` — or
 *   after the account is deleted — the socket used to keep receiving
 *   `entity:created`/`entity:updated` payloads, so the browser on a shared
 *   machine that "signed out" still had the workspace's content arriving. Two
 *   mechanisms are asserted below: logout closes the session's streams at once,
 *   and the keep-alive sweep closes a stream whose session has left the store
 *   by any other route (expiry, a logout on another instance, a store wiped).
 *
 *   **One tenant must not be able to open an unbounded number.** Each
 *   connection is a held socket plus a write every 30 seconds on the single
 *   process every tenant shares, so `EVENTS_MAX_STREAMS_PER_USER` (default 10)
 *   refuses a further one — and must refuse it *per user*, so one tenant at its
 *   ceiling cannot deny another tenant their first connection.
 *
 * Why this file exists next to `tests/unit/broadcaster.test.js`: that one drives
 * the broadcaster with fake `res` objects, which is the right subject for the
 * workspace filter but cannot show that the *route* records the session, that
 * `createApp` injects a resolver that really reads the session store, or that a
 * refused connection ends as a readable SSE frame on a real socket rather than
 * a hung request. Everything here is real — `createApp()` on an ephemeral port,
 * `POST /auth/register`, mongod, and raw `http.request` connections kept open
 * and read chunk by chunk. `supertest` cannot serve: it buffers a response to
 * completion, and every response here is deliberately never completed.
 *
 * The session store is an `express-session` MemoryStore this file holds a
 * reference to, so "the session is gone" can be arranged the way expiry does it
 * — `store.destroy(sid)` — rather than by going through the logout route that
 * is itself under test.
 *
 * Broadcasts are triggered by calling `broadcast()` directly rather than by
 * writing an entity over HTTP: the subject is which sockets a payload reaches
 * and how long they live, and the write path's own fan-out (`changeLogger`,
 * `excludeClientId`) is covered where it belongs. Same module instance as the
 * app's — one process, one `clients` map.
 *
 * Falsification checks, each run red against the pre-KOL-062 route:
 *   - Don't record `req.sessionID` in `addClient` and both "stops receiving"
 *     tests fail (nothing ties a socket to a session).
 *   - Skip the cap and the eleventh connection is accepted.
 *   - Make the cap global rather than per user and "another user can still
 *     connect" fails.
 *   - Drop `closeStreamsForSession` from `POST /auth/logout` and the logout
 *     test fails on its 2-second wait rather than needing a sweep.
 *   - Record a session id for the bearer path too and nothing here fails, which
 *     is why that case is a unit test instead (no session is stored for it, so
 *     the first sweep would drop such a stream).
 *
 * Deliberately not covered: the 30-second keep-alive *timer* (the sweep it runs
 * is called directly; waiting for the tick would cost the suite 30 seconds),
 * reconnect/backoff in `client/src/composables/useEvents.js`, and the
 * cross-instance limit — this map is in-process, so the cap is per instance and
 * a stream is only swept by the instance holding it (the same bound KOL-035
 * recorded for the auth counters).
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_EVENTS_LOG_LEVEL = off | light | normal | verbose (default light)
 * When a stream assertion fails the missing information is always *which*
 * socket ended and why, and that is exactly what a timed-out wait cannot say.
 *   off     — nothing
 *   light   — one line per fixture user and per stream opened or closed, naming
 *             the call responsible
 *   normal  — light, plus every broadcast and sweep this file triggers
 *   verbose — normal, plus every frame each stream received
 */

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import session from 'express-session';

// Every session write is checked against CLIENT_ORIGIN (src/middleware/originGuard.js),
// so this suite names one below and its agents send a matching Origin.
import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';

import * as db from '../helpers/db.js';
// Registration is throttled per client address, and these suites register
// their fixtures through the real endpoint from one address. See the helper.
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';

// createApp() reads NODE_ENV when called and the OAuth router reads its token at
// module load, so the environment is in place before src/app.js is imported —
// hence the dynamic import below. NODE_ENV must not be 'production' here: that
// arms secure/none/domain-scoped session cookies, which neither supertest's
// agent nor the raw requests below would send back.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
// Unset on purpose: with no bearer token configured, no stray Authorization
// header can satisfy requireAuth and open a stream with no session at all.
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
// The broadcaster narrates every connect, drop and broadcast; readable when a
// stream problem is being chased, noise otherwise.
process.env.SSE_LOG_LEVEL ??= 'off';
// Left unset on purpose: the cap test asserts the shipped default of 10.
delete process.env.EVENTS_MAX_STREAMS_PER_USER;

const { createApp } = await import('../../src/app.js');
const { broadcast, sweepClients, DEFAULT_MAX_STREAMS_PER_USER } =
  await import('../../src/lib/broadcaster.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_EVENTS_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/events:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

/** The session store the app is built with, so a test can destroy a session directly. */
const store = new session.MemoryStore();

let app;
let server;
let port;

/** Every stream opened by the current test, destroyed in afterEach. */
let opened = [];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Registers a user through the real endpoint and returns everything a stream
 * test needs: an agent, the cookie header to put on a raw request, the session
 * id inside that cookie, and the ids registration created.
 */
async function registerUser(email) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  assert.ok(user && workspace, `registration should have created a user and a workspace for ${email}`);

  const cookie = cookieHeader(res.headers['set-cookie']);
  const who = {
    agent,
    email,
    cookie,
    sessionId: sessionIdFrom(cookie),
    userId: String(user._id),
    workspaceId: String(workspace._id),
  };
  log('light', `registered ${email} (source: POST /auth/register) → user ${who.userId}, workspace ${who.workspaceId}, session ${who.sessionId}`);
  return who;
}

/** `Set-Cookie` as a `Cookie` request header: names and values only. */
const cookieHeader = (setCookie) => (setCookie ?? []).map((c) => c.split(';')[0]).join('; ');

/**
 * The session id inside a signed `connect.sid` cookie.
 *
 * express-session stores under the bare id while the cookie carries
 * `s:<id>.<hmac>`, so a test that wants to destroy the session the way expiry
 * does has to unwrap it. Asserted rather than assumed: a silent miss here would
 * make the sweep test pass for the wrong reason (destroying nothing, and the
 * stream surviving a check that never ran).
 */
function sessionIdFrom(cookie) {
  const raw = /connect\.sid=([^;]+)/.exec(cookie)?.[1];
  assert.ok(raw, `no connect.sid in the cookie header: ${cookie}`);
  const decoded = decodeURIComponent(raw);
  const id = decoded.startsWith('s:') ? decoded.slice(2).split('.')[0] : decoded;
  assert.ok(id.length > 10, `unexpected session cookie shape: ${decoded}`);
  return id;
}

/**
 * Opens a `GET /events` connection and keeps it open, collecting frames.
 *
 * Resolves as soon as the response head arrives — the body never ends, so
 * waiting for that would hang. `endedByServer` distinguishes a clean EOF (the
 * server closed the stream, which is what several tests assert) from this
 * file's own teardown.
 */
function openStream(label, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/events',
      method: 'GET',
      headers: { Cookie: cookie, Accept: 'text/event-stream' },
    });
    req.on('error', reject);
    req.on('response', (res) => {
      const stream = { label, req, res, status: res.statusCode, chunks: [], endedByServer: false };
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        stream.chunks.push(chunk);
        log('verbose', `${label} received: ${JSON.stringify(chunk)}`);
      });
      res.on('end', () => {
        stream.endedByServer = true;
        log('light', `${label} was ended by the server`);
      });
      opened.push(stream);
      log('light', `${label} opened (status ${res.statusCode})`);
      resolve(stream);
    });
    req.end();
  });
}

/** Every complete SSE frame a stream has received, as `{ event, data }`. */
function frames(stream) {
  return stream.chunks
    .join('')
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? null;
      const raw = /^data: (.*)$/m.exec(block)?.[1] ?? null;
      if (event === null && raw === 'ping') return { event: 'ping', data: null };
      let data = null;
      try { data = raw === null ? null : JSON.parse(raw); } catch { data = raw; }
      return { event, data };
    });
}

const framesNamed = (stream, event) => frames(stream).filter((f) => f.event === event);

/** Polls `check` until it is true, failing with `label` rather than hanging. */
async function waitFor(check, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await delay(10);
  }
}

/** Opens a stream and waits until the server has assigned it a client id. */
async function openReadyStream(label, who) {
  const stream = await openStream(label, who.cookie);
  assert.equal(stream.status, 200);
  await waitFor(() => framesNamed(stream, 'client:id').length === 1, `${label} to be assigned a client id`);
  return stream;
}

function send(event, data, workspaceId) {
  log('normal', `broadcasting ${event} to workspace ${workspaceId} (source: this test)`);
  broadcast(event, data, { workspaceId });
}

let alice;
let bob;

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: store, authLimits: SUITE_AUTH_LIMITS });
  // A listening server of this file's own: supertest buffers a response to
  // completion, and no response here is ever completed.
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  port = server.address().port;
  log('light', `app listening on 127.0.0.1:${port} (source: app.listen(0))`);

  alice = await registerUser('alice@example.com');
  bob = await registerUser('bob@example.com');
});

afterEach(async () => {
  for (const stream of opened) stream.req.destroy();
  opened = [];
  // The route drops a client on its own `req.on('close')`, which fires after
  // this tick. Nothing here depends on the count, but the cap tests do, so give
  // the server its event loop back before the next test registers anything.
  await delay(25);
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await db.disconnect();
});

describe('a workspace\'s streams', () => {
  test('two streams for one user both receive a broadcast', async () => {
    const first = await openReadyStream('alice/tab-1', alice);
    const second = await openReadyStream('alice/tab-2', alice);

    const firstId = framesNamed(first, 'client:id')[0].data.clientId;
    const secondId = framesNamed(second, 'client:id')[0].data.clientId;
    assert.notEqual(firstId, secondId, 'two connections were given the same client id');

    send('entity:created', { _id: 'e1', title: 'Iron Gate' }, alice.workspaceId);

    await waitFor(() => framesNamed(first, 'entity:created').length === 1, 'the first stream to receive the broadcast');
    await waitFor(() => framesNamed(second, 'entity:created').length === 1, 'the second stream to receive the broadcast');
    assert.deepEqual(framesNamed(second, 'entity:created')[0].data, { _id: 'e1', title: 'Iron Gate' });
  });

  test('a second workspace\'s stream receives nothing', async () => {
    // The tenancy boundary, end to end: bob's EventSource is open and
    // authenticated, and alice's workspace is busy.
    const mine = await openReadyStream('alice/tab-1', alice);
    const theirs = await openReadyStream('bob/tab-1', bob);

    send('entity:created', { _id: 'e1', title: 'Iron Gate' }, alice.workspaceId);
    send('entity:updated', { _id: 'e1', title: 'Iron Gate II' }, alice.workspaceId);

    await waitFor(() => framesNamed(mine, 'entity:updated').length === 1, 'alice\'s stream to receive both broadcasts');
    assert.deepEqual(frames(theirs).map((f) => f.event), ['client:id'],
      `bob's stream received another workspace's traffic: ${JSON.stringify(frames(theirs))}`);
  });
});

describe('the per-user stream cap', () => {
  test('the eleventh stream is refused, and says why', async () => {
    const capped = await registerUser('capped@example.com');

    const open = [];
    for (let i = 0; i < DEFAULT_MAX_STREAMS_PER_USER; i += 1) {
      open.push(await openReadyStream(`capped/tab-${i}`, capped));
    }

    const refused = await openStream('capped/tab-eleven', capped.cookie);

    // 200 with an SSE error frame, not a status code: an EventSource reports a
    // non-200 as an indistinguishable network error, and a client that cannot
    // tell "too many tabs" from "the wifi dropped" reconnects forever.
    assert.equal(refused.status, 200);
    await waitFor(() => framesNamed(refused, 'error').length === 1, 'the refused stream to be told why');
    assert.deepEqual(framesNamed(refused, 'error')[0].data,
      { error: 'too-many-streams', limit: DEFAULT_MAX_STREAMS_PER_USER });
    await waitFor(() => refused.endedByServer, 'the refused stream to be closed by the server');
    assert.equal(framesNamed(refused, 'client:id').length, 0,
      'a refused connection was given a client id it could tag writes with');

    // The ten it already had are untouched: the cap refuses the new connection
    // rather than disturbing the ones the user is working in.
    send('entity:created', { _id: 'e1' }, capped.workspaceId);
    await waitFor(() => framesNamed(open[0], 'entity:created').length === 1, 'the first accepted stream to keep working');
    await waitFor(() => framesNamed(open[9], 'entity:created').length === 1, 'the tenth accepted stream to keep working');
  });

  test('another user can still connect while one is at the cap', async () => {
    // The cap must be per user. A global one would hand every tenant a way to
    // deny every other tenant their live updates.
    const hog = await registerUser('hog@example.com');
    for (let i = 0; i < DEFAULT_MAX_STREAMS_PER_USER; i += 1) {
      await openReadyStream(`hog/tab-${i}`, hog);
    }
    const refused = await openStream('hog/tab-eleven', hog.cookie);
    await waitFor(() => framesNamed(refused, 'error').length === 1, 'the hog\'s eleventh stream to be refused');

    const neighbour = await openReadyStream('bob/tab-1', bob);

    assert.deepEqual(frames(neighbour).map((f) => f.event), ['client:id'],
      'another user was refused, or mis-served, because someone else was at the cap');

    send('entity:created', { _id: 'e1' }, bob.workspaceId);
    await waitFor(() => framesNamed(neighbour, 'entity:created').length === 1,
      'the neighbour\'s stream to receive its own workspace\'s broadcast');
  });
});

describe('a stream does not outlive its session', () => {
  test('the keep-alive sweep closes a stream whose session has left the store', async () => {
    const who = await registerUser('expires@example.com');
    const stream = await openReadyStream('expires/tab-1', who);

    // How expiry, a logout on another instance, or an operator clearing the
    // store all look to this process: the session is simply no longer there.
    await new Promise((resolve, reject) => {
      store.destroy(who.sessionId, (err) => (err ? reject(err) : resolve()));
    });
    await new Promise((resolve, reject) => {
      store.get(who.sessionId, (err, found) => {
        if (err) return reject(err);
        assert.equal(found, undefined, 'the session was still in the store, so the sweep would have nothing to notice');
        resolve();
      });
    });

    log('normal', 'running one keep-alive sweep (source: this test, standing in for the 30s timer)');
    const result = await sweepClients();
    assert.ok(result.dropped >= 1, `the sweep dropped nothing: ${JSON.stringify(result)}`);

    await waitFor(() => stream.endedByServer, 'the stream to be closed by the server');
    assert.deepEqual(framesNamed(stream, 'error').map((f) => f.data), [{ error: 'session-ended' }],
      'the dropped stream was not told why');

    const before = stream.chunks.join('');
    send('entity:created', { _id: 'e1', title: 'After the session ended' }, who.workspaceId);
    await delay(50);
    assert.equal(stream.chunks.join(''), before,
      'a stream whose session is gone still received an entity document');
  });

  test('logging out closes the stream at once, without waiting for a sweep', async () => {
    const who = await registerUser('signs-out@example.com');
    const stream = await openReadyStream('signs-out/tab-1', who);
    const other = await openReadyStream('bob/tab-1', bob);

    const logout = await who.agent.post('/auth/logout').send({});
    assert.equal(logout.status, 200, `POST /auth/logout failed: ${logout.status} ${JSON.stringify(logout.body)}`);

    // No sweepClients() call here on purpose: this is what the route itself did.
    await waitFor(() => stream.endedByServer, 'the signed-out stream to be closed by the server');
    assert.deepEqual(framesNamed(stream, 'error').map((f) => f.data), [{ error: 'session-ended' }]);

    const before = stream.chunks.join('');
    send('entity:created', { _id: 'e1', title: 'After the logout' }, who.workspaceId);
    send('entity:created', { _id: 'e2' }, bob.workspaceId);
    await waitFor(() => framesNamed(other, 'entity:created').length === 1, 'another session\'s stream to keep working');
    assert.equal(stream.chunks.join(''), before,
      'a signed-out browser still received the workspace\'s entity documents');
  });

  test('deleting the account closes its streams, including another browser\'s', async () => {
    // Account deletion destroys only the caller's own session — the store
    // cannot be searched by user — so without closing by user id the account's
    // other browsers would keep receiving until their sessions expired.
    const who = await registerUser('deletes@example.com');
    const secondBrowser = { ...who, ...await signIn(who.email) };
    const here = await openReadyStream('deletes/tab-1', who);
    const elsewhere = await openReadyStream('deletes/other-browser', secondBrowser);

    const deleted = await who.agent.delete('/auth/account').send({ email: who.email, password: PASSWORD });
    assert.equal(deleted.status, 204, `DELETE /auth/account failed: ${deleted.status} ${JSON.stringify(deleted.body)}`);

    await waitFor(() => here.endedByServer, 'the deleting browser\'s stream to be closed');
    await waitFor(() => elsewhere.endedByServer, 'the account\'s other browser\'s stream to be closed');
  });
});

/** A second signed-in browser for an existing account. */
async function signIn(email) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/login').send({ email, password: PASSWORD });
  assert.equal(res.status, 200, `POST /auth/login (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = cookieHeader(res.headers['set-cookie']);
  log('light', `signed ${email} in a second time (source: POST /auth/login) → session ${sessionIdFrom(cookie)}`);
  return { agent, cookie, sessionId: sessionIdFrom(cookie) };
}
