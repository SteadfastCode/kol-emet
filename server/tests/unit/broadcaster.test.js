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
 *
 * Deliberately not covered: the keep-alive interval's own ping (it would cost
 * the suite 30 seconds of wall clock, or a fake-timer harness whose subject
 * would be the timer rather than the filter), and `usageMeter`'s database
 * paths, which are out of scope for this item.
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

import { addClient, removeClient, broadcast } from '../../src/lib/broadcaster.js';

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
 * Minimal `res` double recording only what `broadcast` uses.
 * `throwOnWrite` models a socket the client has already closed: the write
 * attempt is still counted, so a test can tell "tried and failed" from
 * "never tried because it was evicted".
 */
function fakeRes({ throwOnWrite = false } = {}) {
  const res = { writes: [], attempts: 0 };
  res.write = (chunk) => {
    res.attempts += 1;
    if (throwOnWrite) throw new Error('EPIPE: socket already closed');
    res.writes.push(chunk);
    return true;
  };
  return res;
}

/** Registers a client with the broadcaster and returns its fake `res`. */
function connect(clientId, workspaceId, opts) {
  const res = fakeRes(opts);
  addClient(clientId, res, workspaceId);
  connected.push(clientId);
  log('normal', `connected ${clientId} to workspace ${workspaceId}`);
  return res;
}

/** The parsed `data:` payloads a fake `res` received, in order. */
const received = (res) => res.writes.map((chunk) => JSON.parse(chunk.match(/^data: (.*)$/m)[1]));

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
