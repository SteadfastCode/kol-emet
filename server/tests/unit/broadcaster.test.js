/**
 * Unit tests for the SSE broadcaster in src/lib/broadcaster.js.
 *
 * The subject is a push channel that carries **full entity documents** to every
 * connected browser. That makes its workspace filter a tenancy boundary in the
 * same sense a `where workspaceId = ?` clause is: a payload delivered to the
 * wrong socket is a cross-tenant disclosure, not a cosmetic bug. It has already
 * leaked once (`0367f08 Fix cross-tenant leak in the SSE live-update channel`),
 * which is why the filter gets its own file rather than being covered
 * incidentally by an HTTP test.
 *
 * What each group defends:
 *
 *   A broadcast with no `workspaceId` must reach **nobody**. The dangerous
 *   version of this function is the obvious one — iterate every client and
 *   write — and that is what it used to be. The guard exists so that a future
 *   caller who forgets the option produces a missing live update (annoying,
 *   visible, fixable) instead of a silent disclosure.
 *
 *   Scoping: a client only ever sees traffic for the workspace it connected
 *   with. Both sides of the comparison are `String(...)`-normalised because one
 *   side arrives as a Mongoose ObjectId and the other as a string from a query
 *   parameter; drop either coercion and every broadcast silently matches
 *   nothing, which looks exactly like "live sync is a bit laggy".
 *
 *   `excludeClientId` keeps the originating tab from echoing its own write back
 *   to itself (`23fd29d`). It must not affect anyone else's delivery.
 *
 *   Eviction: a client whose socket has gone away throws on `res.write`. That
 *   must remove it and let the loop continue — one dead socket cannot be
 *   allowed to abort delivery to the clients queued behind it, and it must not
 *   be retried on every subsequent broadcast for the life of the process.
 *
 *   The per-user cap (`EVENTS_MAX_STREAMS_PER_USER`, default 10, KOL-062). A
 *   connection is a held socket plus a write every 30 seconds on the one
 *   process every tenant shares, so one valid session must not be able to open
 *   thousands. The cap is per *user* and never global: one tenant at its
 *   ceiling cannot be allowed to refuse another tenant's first connection.
 *
 *   The keep-alive sweep's session check (KOL-062). `GET /events`
 *   authenticates on connect and then holds the response open, so a stream
 *   that outlives its session keeps pushing whole entity documents to a browser
 *   that has signed out. The sweep asks an injected resolver whether each
 *   connection's session is still in the store and closes the ones whose is
 *   not. Injected, not imported, so this file can drive the behaviour with a
 *   `Set` of live ids and the module keeps no store or Mongo dependency.
 *
 *   `closeStreamsForSession` / `closeStreamsForUser`: the same drop, now, for
 *   the two routes that know a session has ended before the next sweep would
 *   — `POST /auth/logout` and `DELETE /auth/account`.
 *
 * Fake `res` objects rather than real sockets: the function reads exactly one
 * thing off `res` (`write`), and "the socket is gone" is trivially expressible
 * as a throwing method but genuinely awkward to arrange against a real server.
 * Driving this over HTTP would test Express's response lifecycle, not the
 * filter.
 *
 * Note on process exit: importing this module starts a 30-second keep-alive
 * `setInterval`. It is `.unref()`d in the source, so it does not by itself hold
 * the event loop open and this file terminates when its assertions do. Remove
 * that `.unref()` and `yarn test` hangs for good rather than failing — a
 * failure mode worth recognising if it ever comes back.
 *
 * Falsification checks for this suite, all run red against a deliberately
 * broken broadcaster:
 *   - Make the missing-`workspaceId` case fall through to "send to everyone"
 *     (the pre-`0367f08` behaviour) and the unscoped group fails.
 *   - Delete the `console.error` from that guard and the "the drop is
 *     reported" test fails. That test is doing real work: because no client's
 *     workspace can equal `null`, simply *deleting* the early return still
 *     delivers to nobody, so the log line is the only externally visible
 *     evidence the guard is there at all.
 *   - Drop the `clientWs !== target` check and the scoping group fails.
 *   - Drop the `String(...)` coercion in `addClient` or in `broadcast` and the
 *     ObjectId test fails.
 *   - Drop the `clientId === excludeClientId` check and the exclusion group
 *     fails.
 *   - Replace the `try`/`catch` around `res.write` with a bare call and the
 *     eviction group fails (the broadcast throws out to the caller).
 *   - Change the `catch` to swallow without `clients.delete(...)` and the
 *     "not retried on the next broadcast" test fails.
 *   - Count every open stream instead of the connecting user's own and the
 *     "the cap is per user" test fails; drop the cap check entirely and the
 *     refusal group fails.
 *   - Have the sweep treat a thrown resolver as "session gone" and the
 *     fail-open test fails; have it check connections with no session id and
 *     the bearer test fails.
 *
 * Deliberately not covered: the keep-alive interval's own *timer* (the sweep it
 * runs is called directly here; asserting the 30-second tick would cost the
 * suite 30 seconds of wall clock, or a fake-timer harness whose subject would
 * be the timer rather than the sweep), and `usageMeter`'s database paths, which
 * are out of scope for this item. The HTTP behaviour the cap and the sweep
 * produce — a refused eleventh connection, a stream that stops receiving once
 * its session is destroyed — is covered over real sockets in
 * `tests/http/events.test.js`.
 *
 * Debug logging: `TEST_SSE_LOG_LEVEL=off|light|normal|verbose`, default
 * `light`. The broadcaster narrates every connect, disconnect and broadcast on
 * `console`, which is useful in production and unreadable in a test run, so
 * this file captures those lines instead of printing them. `normal` reports
 * each fixture's setup and teardown; `verbose` additionally replays every
 * captured broadcaster line, tagged with which test produced it.
 */

import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  addClient,
  removeClient,
  broadcast,
  sweepClients,
  closeStreamsForSession,
  closeStreamsForUser,
  maxStreamsPerUser,
  DEFAULT_MAX_STREAMS_PER_USER,
} from '../../src/lib/broadcaster.js';

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

// Captured before the console is stubbed, so the suite's own logging still
// reaches the terminal while the subject's is being swallowed.
const realLog = console.log;
const realError = console.error;

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_SSE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) realLog(`[tests/sse:${level}] ${msg}`);
}

/** Every line the broadcaster wrote to console during the current test. */
let captured = [];

before(() => {
  console.log = (...args) => { captured.push(args.join(' ')); };
  console.error = (...args) => { captured.push(args.join(' ')); };
});

after(() => {
  console.log = realLog;
  console.error = realError;
});

/**
 * Client ids registered by the current test, so it can be torn down without
 * reaching into the broadcaster's private Map.
 */
let connected = [];

beforeEach(() => { captured = []; connected = []; });

afterEach((t) => {
  for (const clientId of connected) removeClient(clientId);
  log('normal', `${t.name} — disconnected ${connected.length} client(s)`);
  for (const line of captured) log('verbose', `  ${t.name} | ${line}`);
});

/**
 * Distinct workspace per test. The broadcaster's client map is module-level
 * state shared by every test in this file, so scoping each fixture to its own
 * workspace makes the tests independent of each other's leftovers and of the
 * order the runner happens to choose.
 */
let wsCounter = 0;
const uniqueWs = () => `ws-${(wsCounter += 1)}`;

/**
 * Minimal `res` double recording only what the broadcaster uses.
 * `throwOnWrite` models a socket the client has already closed: the write
 * attempt is still counted, so a test can tell "tried and failed" from
 * "never tried because it was evicted".
 *
 * `end()` is here because the server now closes streams of its own accord (the
 * cap and the session sweep), and "was this socket closed?" is the assertion
 * those cases turn on.
 */
function fakeRes({ throwOnWrite = false } = {}) {
  const res = { writes: [], attempts: 0, ended: false };
  res.write = (chunk) => {
    res.attempts += 1;
    if (throwOnWrite) throw new Error('EPIPE: socket already closed');
    res.writes.push(chunk);
    return true;
  };
  res.end = () => { res.ended = true; };
  return res;
}

/**
 * Registers a client with the broadcaster and returns its fake `res`, with the
 * `addClient` result on it as `res.added` — that result is how the route learns
 * a connection was refused, so it is part of what these tests assert.
 *
 * `opts` carries both the double's own setting (`throwOnWrite`) and the
 * registration fields (`userId`, `sessionId`, `sessionAlive`).
 */
function connect(clientId, workspaceId, opts = {}) {
  const { throwOnWrite = false, ...registration } = opts;
  const res = fakeRes({ throwOnWrite });
  res.added = addClient(clientId, res, workspaceId, registration);
  connected.push(clientId);
  log('normal', `connected ${clientId} to workspace ${workspaceId}${registration.userId ? ` as user ${registration.userId}` : ''} — ${res.added.accepted ? 'accepted' : `refused (${res.added.reason})`}`);
  return res;
}

/** The parsed `data:` payloads a fake `res` received, in order. */
const received = (res) => res.writes.map((chunk) => JSON.parse(chunk.match(/^data: (.*)$/m)[1]));

/**
 * Every frame a fake `res` received, as `{ event, data }`. Unlike `received()`
 * this survives a keep-alive ping (`data: ping`, which is not JSON) and names
 * the event, so the sweep's mixed traffic can be asserted on.
 */
const frames = (res) => res.writes.map((chunk) => {
  if (chunk === 'data: ping\n\n') return { event: 'ping', data: null };
  const event = chunk.match(/^event: (.*)$/m)?.[1] ?? null;
  const data = chunk.match(/^data: (.*)$/m)?.[1] ?? null;
  return { event, data: data === null ? null : JSON.parse(data) };
});

const pings = (res) => frames(res).filter((f) => f.event === 'ping').length;
const errors = (res) => frames(res).filter((f) => f.event === 'error').map((f) => f.data);

/**
 * A stand-in for the resolver `createApp` injects: answers from a `Set` of
 * live session ids and records every lookup, so a test can assert that a
 * connection was *not* checked as well as that it was.
 */
function fakeSessions(live = []) {
  const alive = new Set(live);
  const asked = [];
  return {
    alive,
    asked,
    resolve: async (sessionId) => { asked.push(sessionId); return alive.has(sessionId); },
  };
}

/**
 * Runs `fn` with `EVENTS_MAX_STREAMS_PER_USER` set, restoring whatever was
 * there (usually nothing) afterwards. The variable is read per call inside the
 * subject, so this is enough — no module reload needed.
 */
async function withCap(value, fn) {
  const restore = setCap(value);
  try {
    return await fn();
  } finally {
    restore();
  }
}

/** `withCap` for a synchronous body — `finally` would fire too early otherwise. */
function withCapSync(value, fn) {
  const restore = setCap(value);
  try {
    return fn();
  } finally {
    restore();
  }
}

function setCap(value) {
  const before = process.env.EVENTS_MAX_STREAMS_PER_USER;
  process.env.EVENTS_MAX_STREAMS_PER_USER = value;
  return () => {
    if (before === undefined) delete process.env.EVENTS_MAX_STREAMS_PER_USER;
    else process.env.EVENTS_MAX_STREAMS_PER_USER = before;
  };
}

describe('broadcast without a workspaceId', () => {
  // The whole point of the guard: an unscoped payload is dropped rather than
  // fanned out. Each case below is a way a caller can arrive without a usable
  // workspace — a forgotten option, an entity whose `workspaceId` is still
  // null, a lookup that returned nothing.
  const NO_TARGET = [
    ['omitted entirely', undefined],
    ['an explicit undefined', { workspaceId: undefined }],
    ['an explicit null', { workspaceId: null }],
    ['null alongside a valid excludeClientId', { workspaceId: null, excludeClientId: 'tab-1' }],
  ];

  for (const [what, opts] of NO_TARGET) {
    test(`with ${what}, writes to nobody`, () => {
      const a = connect('tab-1', uniqueWs());
      const b = connect('tab-2', uniqueWs());

      if (opts === undefined) broadcast('entity:updated', { _id: 'e1' });
      else broadcast('entity:updated', { _id: 'e1' }, opts);

      assert.equal(a.attempts, 0, `an unscoped broadcast (${what}) reached tab-1`);
      assert.equal(b.attempts, 0, `an unscoped broadcast (${what}) reached tab-2`);
    });
  }

  test('reports the drop, naming the event', () => {
    // Without this assertion the group above would still pass if the guard
    // were deleted outright: no client's workspace can compare equal to
    // `null`, so the loop would drop the payload anyway — silently, and one
    // refactor away from delivering it to everyone. The log line is the only
    // observable proof the deliberate refusal is still there.
    connect('tab-1', uniqueWs());

    broadcast('entity:deleted', { _id: 'e1' });

    const complaint = captured.find((line) => /no workspaceId/i.test(line));
    assert.ok(complaint, `expected a complaint about the missing workspaceId, got:\n${captured.join('\n')}`);
    assert.match(complaint, /entity:deleted/, 'the complaint should name the event that was dropped');
  });

  test('the same clients do receive a correctly scoped broadcast', () => {
    // Proves the group above fails for the stated reason rather than because
    // the fixture never delivers anything.
    const workspaceId = uniqueWs();
    const a = connect('tab-1', workspaceId);

    broadcast('entity:updated', { _id: 'e1' }, { workspaceId });

    assert.deepEqual(received(a), [{ _id: 'e1' }]);
  });
});

describe('broadcast workspace scoping', () => {
  test('delivers only to clients in the matching workspace', () => {
    const mine = uniqueWs();
    const theirs = uniqueWs();
    const a = connect('tab-a', mine);
    const b = connect('tab-b', mine);
    const outsider = connect('tab-c', theirs);

    broadcast('entity:created', { _id: 'e1', title: 'Iron Gate' }, { workspaceId: mine });

    assert.deepEqual(received(a), [{ _id: 'e1', title: 'Iron Gate' }]);
    assert.deepEqual(received(b), [{ _id: 'e1', title: 'Iron Gate' }]);
    assert.equal(outsider.attempts, 0, 'a client in another workspace was written to');
  });

  test('writes a well-formed SSE frame', () => {
    // The wire format is the contract with EventSource on the client: a named
    // event, one `data:` line of JSON, terminated by a blank line.
    const workspaceId = uniqueWs();
    const a = connect('tab-a', workspaceId);

    broadcast('entity:updated', { _id: 'e1', tags: ['gate'] }, { workspaceId });

    assert.equal(a.writes.length, 1);
    assert.equal(a.writes[0], 'event: entity:updated\ndata: {"_id":"e1","tags":["gate"]}\n\n');
  });

  test('a workspace with no clients is a no-op, not an error', () => {
    connect('tab-a', uniqueWs());
    assert.doesNotThrow(() => broadcast('entity:updated', { _id: 'e1' }, { workspaceId: uniqueWs() }));
  });

  test('matches an ObjectId-shaped workspaceId against its string form', () => {
    // Real callers are asymmetric: `addClient` receives whatever the SSE route
    // resolved (a Mongoose ObjectId), while `broadcast` is handed the
    // `workspaceId` off an entity document. They are equal only after the
    // `String(...)` on both sides — `objectId === '65f...'` is false.
    const hex = '65f0000000000000000000aa';
    const asObjectId = { toString: () => hex };
    const connectedByObject = connect('tab-a', asObjectId);
    const connectedByString = connect('tab-b', hex);

    broadcast('entity:updated', { _id: 'e1' }, { workspaceId: asObjectId });
    broadcast('entity:updated', { _id: 'e2' }, { workspaceId: hex });

    assert.deepEqual(received(connectedByObject), [{ _id: 'e1' }, { _id: 'e2' }]);
    assert.deepEqual(received(connectedByString), [{ _id: 'e1' }, { _id: 'e2' }]);
  });

  test('a disconnected client stops receiving', () => {
    const workspaceId = uniqueWs();
    const a = connect('tab-a', workspaceId);

    removeClient('tab-a');
    broadcast('entity:updated', { _id: 'e1' }, { workspaceId });

    assert.equal(a.attempts, 0, 'a removed client was still written to');
  });
});

describe('broadcast excludeClientId', () => {
  test('skips the excluded client and nobody else', () => {
    const workspaceId = uniqueWs();
    const origin = connect('tab-origin', workspaceId);
    const other = connect('tab-other', workspaceId);
    const third = connect('tab-third', workspaceId);

    broadcast('entity:updated', { _id: 'e1' }, { workspaceId, excludeClientId: 'tab-origin' });

    assert.equal(origin.attempts, 0, 'the originating client was echoed its own write');
    assert.deepEqual(received(other), [{ _id: 'e1' }]);
    assert.deepEqual(received(third), [{ _id: 'e1' }]);
  });

  test('an omitted or null excludeClientId excludes nobody', () => {
    const workspaceId = uniqueWs();
    const a = connect('tab-a', workspaceId);

    broadcast('entity:updated', { _id: 'e1' }, { workspaceId });
    broadcast('entity:updated', { _id: 'e2' }, { workspaceId, excludeClientId: null });

    assert.deepEqual(received(a), [{ _id: 'e1' }, { _id: 'e2' }]);
  });

  test('an id belonging to another workspace does not suppress delivery here', () => {
    // Client ids are unique per connection, but nothing stops one from being
    // passed alongside a workspace it does not belong to. The workspace filter
    // has to run first, so this must be a plain no-op.
    const mine = uniqueWs();
    const theirs = uniqueWs();
    const a = connect('tab-a', mine);
    const outsider = connect('tab-b', theirs);

    broadcast('entity:updated', { _id: 'e1' }, { workspaceId: mine, excludeClientId: 'tab-b' });

    assert.deepEqual(received(a), [{ _id: 'e1' }]);
    assert.equal(outsider.attempts, 0);
  });

  test('an unknown excludeClientId excludes nobody', () => {
    const workspaceId = uniqueWs();
    const a = connect('tab-a', workspaceId);

    broadcast('entity:updated', { _id: 'e1' }, { workspaceId, excludeClientId: 'tab-that-left' });

    assert.deepEqual(received(a), [{ _id: 'e1' }]);
  });
});

describe('broadcast eviction of dead clients', () => {
  test('a throwing res.write does not abort delivery to the clients behind it', () => {
    // Registration order matters: the dead client is added first, so if the
    // throw escaped the loop the healthy client queued behind it would never
    // be written to. That is the outage this try/catch prevents — one closed
    // laptop lid silencing live sync for the whole workspace.
    const workspaceId = uniqueWs();
    const dead = connect('tab-dead', workspaceId, { throwOnWrite: true });
    const healthy = connect('tab-healthy', workspaceId);

    assert.doesNotThrow(() => broadcast('entity:updated', { _id: 'e1' }, { workspaceId }));

    assert.equal(dead.attempts, 1, 'the dead client should have been tried exactly once');
    assert.deepEqual(received(healthy), [{ _id: 'e1' }]);
  });

  test('the evicted client is not retried on later broadcasts', () => {
    const workspaceId = uniqueWs();
    const dead = connect('tab-dead', workspaceId, { throwOnWrite: true });
    const healthy = connect('tab-healthy', workspaceId);

    broadcast('entity:updated', { _id: 'e1' }, { workspaceId });
    broadcast('entity:updated', { _id: 'e2' }, { workspaceId });
    broadcast('entity:updated', { _id: 'e3' }, { workspaceId });

    assert.equal(dead.attempts, 1, 'a dead socket was retried instead of being evicted');
    assert.deepEqual(received(healthy), [{ _id: 'e1' }, { _id: 'e2' }, { _id: 'e3' }]);
  });

  test('every client failing leaves the broadcast harmless', () => {
    const workspaceId = uniqueWs();
    const one = connect('tab-one', workspaceId, { throwOnWrite: true });
    const two = connect('tab-two', workspaceId, { throwOnWrite: true });

    assert.doesNotThrow(() => broadcast('entity:deleted', { _id: 'e1' }, { workspaceId }));
    broadcast('entity:deleted', { _id: 'e2' }, { workspaceId });

    assert.equal(one.attempts, 1);
    assert.equal(two.attempts, 1);
  });
});

describe('the per-user stream cap', () => {
  test('refuses the eleventh stream for one user, at the default limit', async () => {
    // The shipped default, asserted through the real environment (nothing set)
    // rather than a test-only limit: 10 is the number a deployment gets, and a
    // suite that only ever exercised an injected 2 would not notice it change.
    const workspaceId = uniqueWs();
    const userId = 'user-at-the-cap';
    const open = [];
    for (let i = 0; i < DEFAULT_MAX_STREAMS_PER_USER; i += 1) {
      open.push(connect(`tab-${i}`, workspaceId, { userId }));
    }
    assert.ok(open.every((res) => res.added.accepted), 'the first ten streams should all be accepted');

    const refused = connect('tab-eleven', workspaceId, { userId });

    assert.equal(refused.added.accepted, false, 'the eleventh stream was accepted');
    assert.equal(refused.added.reason, 'over-cap');
    assert.equal(refused.added.limit, DEFAULT_MAX_STREAMS_PER_USER);
    // Refused means not registered, not merely reported: the route writes an
    // error frame and closes, and nothing may be pushed to that socket after.
    broadcast('entity:created', { _id: 'e1' }, { workspaceId });
    assert.equal(refused.attempts, 0, 'a refused connection was written to');
    assert.equal(open[0].writes.length, 1, 'an accepted connection missed the broadcast');
  });

  test('the cap is per user, not global', async () => {
    // The failure this guards against is one tenant's script denying every
    // other tenant their first live connection.
    await withCap('2', () => {
      const workspaceId = uniqueWs();
      connect('greedy-1', workspaceId, { userId: 'greedy' });
      connect('greedy-2', workspaceId, { userId: 'greedy' });
      const greedyThird = connect('greedy-3', workspaceId, { userId: 'greedy' });
      const other = connect('other-1', uniqueWs(), { userId: 'someone-else' });

      assert.equal(greedyThird.added.accepted, false, 'the third stream for the capped user was accepted');
      assert.equal(other.added.accepted, true, 'another user was refused because of someone else\'s streams');
    });
  });

  test('a closed stream frees the slot', async () => {
    await withCap('1', () => {
      const workspaceId = uniqueWs();
      connect('tab-a', workspaceId, { userId: 'u1' });
      assert.equal(connect('tab-b', workspaceId, { userId: 'u1' }).added.accepted, false);

      removeClient('tab-a');

      assert.equal(connect('tab-c', workspaceId, { userId: 'u1' }).added.accepted, true,
        'closing a stream did not free the user\'s slot — a reconnecting browser would be locked out');
    });
  });

  test('connections with no user share one bucket', async () => {
    // The BEARER_TOKEN path has no user to key on. Those connections share one
    // credential, so they share one allowance rather than being unbounded.
    await withCap('1', () => {
      const workspaceId = uniqueWs();
      const first = connect('bearer-1', workspaceId);
      const second = connect('bearer-2', workspaceId);

      assert.equal(first.added.accepted, true);
      assert.equal(second.added.accepted, false, 'bearer connections were counted separately, so they are unbounded');
    });
  });

  test('reports a refusal, naming the user and the limit', async () => {
    // The light tier's job: a user whose eleventh tab goes quiet should be
    // explainable from the log alone.
    await withCap('1', () => {
      const workspaceId = uniqueWs();
      connect('tab-a', workspaceId, { userId: 'noisy' });
      connect('tab-b', workspaceId, { userId: 'noisy' });

      const line = captured.find((l) => /refused/.test(l) && /noisy/.test(l));
      assert.ok(line, `expected a refusal line naming the user, got:\n${captured.join('\n')}`);
      assert.match(line, /limit 1/);
    });
  });

  test('a limit that is not a positive integer is the default', () => {
    // `EVENTS_MAX_STREAMS_PER_USER=` in a half-filled .env must not parse as 0
    // and refuse every stream the product has.
    for (const bad of ['', '0', '-1', 'ten', '2.5']) {
      const got = withCapSync(bad, () => maxStreamsPerUser());
      assert.equal(got, DEFAULT_MAX_STREAMS_PER_USER, `EVENTS_MAX_STREAMS_PER_USER=${JSON.stringify(bad)} should fall back to the default`);
    }
    assert.equal(withCapSync('3', () => maxStreamsPerUser()), 3, 'a valid limit should be honoured');
    assert.equal(maxStreamsPerUser(), DEFAULT_MAX_STREAMS_PER_USER, 'unset should be the default');
  });
});

describe('the keep-alive sweep', () => {
  test('closes a connection whose session the resolver no longer knows', async () => {
    const workspaceId = uniqueWs();
    const sessions = fakeSessions(['sid-live']);
    const gone = connect('tab-gone', workspaceId, { userId: 'u1', sessionId: 'sid-gone', sessionAlive: sessions.resolve });
    const live = connect('tab-live', workspaceId, { userId: 'u2', sessionId: 'sid-live', sessionAlive: sessions.resolve });

    await sweepClients();

    assert.deepEqual(errors(gone), [{ error: 'session-ended' }], 'the dropped stream was not told why');
    assert.equal(gone.ended, true, 'the socket of a session-less stream was left open');
    assert.equal(pings(gone), 0, 'a stream being dropped was also pinged');
    assert.equal(pings(live), 1, 'a stream whose session is still there should have been pinged');

    // The point of the whole exercise: no more entity documents.
    broadcast('entity:updated', { _id: 'e1' }, { workspaceId });
    assert.equal(errors(gone).length, 1, 'a dropped stream received a broadcast');
    assert.equal(frames(live).filter((f) => f.event === 'entity:updated').length, 1);
  });

  test('reports why it dropped the connection', async () => {
    const sessions = fakeSessions();
    connect('tab-gone', uniqueWs(), { userId: 'u1', sessionId: 'sid-gone', sessionAlive: sessions.resolve });

    await sweepClients();

    const line = captured.find((l) => /tab-gone/.test(l) && /session/i.test(l));
    assert.ok(line, `expected a line saying the session was gone, got:\n${captured.join('\n')}`);
  });

  test('a resolver that throws keeps the stream', async () => {
    // Fail open. A Mongo blip must not be the thing that drops every live
    // stream in the deployment; the next sweep asks again.
    const workspaceId = uniqueWs();
    const res = connect('tab-a', workspaceId, {
      userId: 'u1',
      sessionId: 'sid-1',
      sessionAlive: async () => { throw new Error('connection reset by peer'); },
    });

    await sweepClients();

    assert.equal(res.ended, false, 'a store error closed a live stream');
    assert.equal(pings(res), 1);
    broadcast('entity:updated', { _id: 'e1' }, { workspaceId });
    assert.equal(frames(res).filter((f) => f.event === 'entity:updated').length, 1);
    assert.ok(captured.find((l) => /session check failed/.test(l)), 'the failed lookup was not reported');
  });

  test('a connection with no session id is never checked', async () => {
    // The BEARER_TOKEN path: `req.sessionID` exists but no session is stored,
    // so checking one would drop the stream on the first sweep.
    const sessions = fakeSessions();
    const res = connect('tab-bearer', uniqueWs(), { sessionAlive: sessions.resolve });

    await sweepClients();

    assert.deepEqual(sessions.asked, [], 'a connection with no session id was looked up anyway');
    assert.equal(res.ended, false, 'a bearer-authenticated stream was dropped');
    assert.equal(pings(res), 1);
  });

  test('a connection with no resolver is pinged, not dropped', async () => {
    // createApp always injects one; a caller that did not (a REPL, an older
    // mount) must not have its streams quietly closed.
    const res = connect('tab-a', uniqueWs(), { userId: 'u1', sessionId: 'sid-1' });

    await sweepClients();

    assert.equal(res.ended, false);
    assert.equal(pings(res), 1);
  });

  test('one dropped connection does not stop the sweep reaching the rest', async () => {
    const sessions = fakeSessions(['sid-live']);
    const gone = connect('tab-gone', uniqueWs(), { userId: 'u1', sessionId: 'sid-gone', sessionAlive: sessions.resolve });
    const dead = connect('tab-dead', uniqueWs(), { userId: 'u2', sessionId: 'sid-live', sessionAlive: sessions.resolve, throwOnWrite: true });
    const live = connect('tab-live', uniqueWs(), { userId: 'u3', sessionId: 'sid-live', sessionAlive: sessions.resolve });

    const result = await sweepClients();

    assert.equal(gone.ended, true);
    assert.equal(dead.attempts, 1, 'the dead socket should have been tried exactly once');
    assert.equal(pings(live), 1, 'the client queued behind a dropped and a dead one was not pinged');
    assert.deepEqual(result, { swept: 3, pinged: 1, dropped: 2 });
  });

  test('a dropped connection frees its user\'s slot', async () => {
    await withCap('1', async () => {
      const sessions = fakeSessions();
      connect('tab-a', uniqueWs(), { userId: 'u1', sessionId: 'sid-gone', sessionAlive: sessions.resolve });

      await sweepClients();

      assert.equal(connect('tab-b', uniqueWs(), { userId: 'u1' }).added.accepted, true,
        'a swept stream still counted against the cap');
    });
  });
});

describe('closing streams for a session or a user', () => {
  test('closeStreamsForSession closes only that session\'s streams', async () => {
    const workspaceId = uniqueWs();
    const mine1 = connect('tab-1', workspaceId, { userId: 'u1', sessionId: 'sid-1' });
    const mine2 = connect('tab-2', workspaceId, { userId: 'u1', sessionId: 'sid-1' });
    // Same user, another browser: still signed in there, so it keeps its stream.
    const other = connect('tab-3', workspaceId, { userId: 'u1', sessionId: 'sid-2' });

    const closed = closeStreamsForSession('sid-1', 'POST /auth/logout');

    assert.equal(closed, 2);
    assert.equal(mine1.ended, true);
    assert.equal(mine2.ended, true);
    assert.deepEqual(errors(mine1), [{ error: 'session-ended' }]);
    assert.equal(other.ended, false, 'another session of the same user was closed');

    broadcast('entity:created', { _id: 'e1' }, { workspaceId });
    assert.equal(errors(mine1).length, 1, 'a closed stream received a broadcast');
    assert.equal(frames(other).filter((f) => f.event === 'entity:created').length, 1);
  });

  test('closeStreamsForUser closes every session that user has open', async () => {
    const workspaceId = uniqueWs();
    const one = connect('tab-1', workspaceId, { userId: 'u1', sessionId: 'sid-1' });
    const two = connect('tab-2', workspaceId, { userId: 'u1', sessionId: 'sid-2' });
    const someoneElse = connect('tab-3', workspaceId, { userId: 'u2', sessionId: 'sid-3' });

    const closed = closeStreamsForUser('u1', 'DELETE /auth/account');

    assert.equal(closed, 2, 'account deletion must reach the account\'s other browsers too');
    assert.equal(one.ended, true);
    assert.equal(two.ended, true);
    assert.equal(someoneElse.ended, false, 'another user\'s stream was closed');
  });

  test('an id matching nothing, or a missing one, is a no-op', () => {
    const res = connect('tab-1', uniqueWs(), { userId: 'u1', sessionId: 'sid-1' });

    assert.equal(closeStreamsForSession('sid-nobody'), 0);
    assert.equal(closeStreamsForSession(undefined), 0);
    assert.equal(closeStreamsForUser(null), 0);
    assert.equal(closeStreamsForUser('u-nobody'), 0);
    assert.equal(res.ended, false, 'an unmatched close ended a live stream');
  });

  test('matches an ObjectId-shaped user id against its stored string form', () => {
    // `req.actor.userId` is a string on one path and an ObjectId on another;
    // the stored form is normalised, so the lookup has to be too.
    const hex = '65f0000000000000000000bb';
    const res = connect('tab-1', uniqueWs(), { userId: { toString: () => hex }, sessionId: 'sid-1' });

    assert.equal(closeStreamsForUser(hex), 1);
    assert.equal(res.ended, true);
  });
});
