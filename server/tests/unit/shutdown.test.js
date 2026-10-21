/**
 * Unit tests for the graceful-shutdown sequence in src/lib/shutdown.js.
 *
 * The subject runs exactly once per process, in response to a signal, and then
 * the process is gone — so there is no state afterwards to assert against and
 * no second attempt to observe. That makes the *sequencing* the whole contract,
 * and sequencing is what these tests pin:
 *
 *   **The stages run in order and each is awaited.** Each one depends on the
 *   one before: new connections have to stop arriving before it is meaningful
 *   to wait for the ones still open, and the streams have to be ended before
 *   that wait can finish at all (an SSE socket is held for hours, so a
 *   `server.close` with one attached drains only when the grace period runs
 *   out). The tests therefore hold each stage open with a deferred and assert
 *   the next one has *not* started — a version that fired all four off
 *   concurrently would pass an order-only check.
 *
 *   **The grace period is a ceiling.** A request that finishes inside it is
 *   waited for; one that does not is abandoned at the deadline and the exit is
 *   forced. One hung request must not hold a deploy open.
 *
 *   **A second signal is ignored.** A host sending SIGTERM twice, or a Ctrl-C
 *   pressed twice, must not start a second shutdown over the top of the first:
 *   two sequences would close the streams twice and disconnect twice.
 *
 *   **A stage that throws does not stop the stages after it,** and still ends
 *   in an exit. A failed disconnect is the case that matters — it must not be
 *   the thing that keeps the process alive.
 *
 * Everything is a fake: the server never listens, no signal is ever sent, and
 * `exit` is a recording function. A test that installed a real handler or
 * called the real `process.exit` would take the test runner down with it.
 *
 * `setImmediate` (as `settle()`) is how a test lets the sequence advance:
 * `node:test`'s mock timers replace `setTimeout` only, so an immediate is still
 * a real turn of the loop and drains the microtasks the awaits queue.
 *
 * The subject logs to `console`, which is useful in production and noise in a
 * test run, so the lines are captured instead of printed. Set
 * `TEST_SHUTDOWN_LOG_LEVEL=verbose` to replay them, tagged with their test.
 */

import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createShutdown,
  shutdownGraceMs,
  DEFAULT_SHUTDOWN_GRACE_MS,
  STREAM_CLOSE_REASON,
} from '../../src/lib/shutdown.js';

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

// Captured before the console is stubbed, so the suite's own logging still
// reaches the terminal while the subject's is being swallowed.
const realLog = console.log;
const realError = console.error;

function log(level, msg) {
  const active = LEVELS[process.env.TEST_SHUTDOWN_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) realLog(`[tests/shutdown:${level}] ${msg}`);
}

/** Every line the subject wrote to console during the current test. */
let captured = [];

before(() => {
  console.log = (...args) => { captured.push(args.join(' ')); };
  console.error = (...args) => { captured.push(args.join(' ')); };
});

after(() => {
  console.log = realLog;
  console.error = realError;
});

beforeEach(() => { captured = []; });

afterEach((t) => {
  for (const line of captured) log('verbose', `  ${t.name} | ${line}`);
});

/** One turn of the event loop: enough for every pending microtask to run. */
const settle = () => new Promise((resolve) => { setImmediate(resolve); });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Stand-in for the listening HTTP server. `close(cb)` stops accepting and
 * holds the callback, exactly as Node's does: the callback is what fires once
 * the sockets still open have finished, so the test decides when — or whether —
 * the in-flight requests complete.
 */
function fakeServer({ throwOnClose = false } = {}) {
  const server = { closeCalls: 0, done: null };
  server.close = (cb) => {
    server.closeCalls += 1;
    if (throwOnClose) throw new Error('ERR_SERVER_NOT_RUNNING');
    server.done = cb;
  };
  /** Every in-flight request has finished — what Node reports by calling back. */
  server.finishRequests = (err = null) => server.done?.(err);
  return server;
}

/** A recording `exit`, which is the only reason this suite is safe to run. */
function fakeExit() {
  const exit = (code) => { exit.codes.push(code); };
  exit.codes = [];
  return exit;
}

/** Captured lines matching a pattern, for asserting what the light tier said. */
const said = (pattern) => captured.filter((line) => pattern.test(line));

describe('the shutdown sequence', () => {
  test('runs the four stages in order, awaiting each before the next', async () => {
    const calls = [];
    const streams = deferred();
    const dbGone = deferred();
    const server = fakeServer();
    const exit = fakeExit();

    const running = createShutdown({
      server,
      closeStreams: (reason) => { calls.push(`streams:${reason}`); return streams.promise; },
      disconnect: () => { calls.push('disconnect'); return dbGone.promise; },
      exit,
      graceMs: 10_000,
    })('SIGTERM');

    await settle();
    assert.equal(server.closeCalls, 1, 'stage 1 did not stop the listener');
    assert.deepEqual(calls, [`streams:SIGTERM: ${STREAM_CLOSE_REASON}`], 'stage 2 did not start, or a later stage started with it');

    // Stage 2 is still open: nothing after it may have begun.
    server.finishRequests();
    await settle();
    assert.equal(calls.length, 1, 'the sequence moved on while the stream closer was still running');

    streams.resolve(3);
    await settle();
    assert.deepEqual(calls, [`streams:SIGTERM: ${STREAM_CLOSE_REASON}`, 'disconnect'], 'stage 4 did not follow the in-flight wait');
    assert.deepEqual(exit.codes, [], 'the process was exited while the disconnect was still running');

    dbGone.resolve();
    const result = await running;

    assert.equal(result.forced, false);
    assert.deepEqual(exit.codes, [0], 'a clean shutdown must still end the process — nothing drains the session store\'s own client');
    assert.deepEqual(result.stages.map((s) => s.name), [
      'stop accepting connections',
      'end every live stream',
      'wait for in-flight requests',
      'disconnect from MongoDB',
    ]);
    assert.ok(result.stages.every((s) => s.status === 'ok'), JSON.stringify(result.stages));
  });

  test('waits for the in-flight requests before disconnecting', async () => {
    const calls = [];
    const server = fakeServer();
    const exit = fakeExit();

    const running = createShutdown({
      server,
      closeStreams: () => 0,
      disconnect: () => { calls.push('disconnect'); },
      exit,
      graceMs: 10_000,
    })('SIGTERM');

    await settle();
    await settle();
    assert.deepEqual(calls, [], 'disconnected while a request was still in flight');

    // The listener reports its sockets drained — the only thing stage 3 waits on.
    server.finishRequests();
    const result = await running;

    assert.deepEqual(calls, ['disconnect']);
    assert.equal(result.forced, false);
    assert.deepEqual(exit.codes, [0]);
  });

  test('names the signal and the outcome of every stage at the light tier', async () => {
    const server = fakeServer();
    const running = createShutdown({
      server,
      closeStreams: () => 2,
      disconnect: async () => {},
      exit: fakeExit(),
      graceMs: 10_000,
    })('SIGTERM');

    await settle();
    server.finishRequests();
    await running;

    assert.equal(said(/SIGTERM received/).length, 1, 'the log does not say which signal started the shutdown');
    assert.equal(said(/stop accepting connections: the listener is closed/).length, 1);
    assert.equal(said(/closed 2 live stream\(s\)/).length, 1);
    assert.equal(said(/wait for in-flight requests: .*every socket finished/).length, 1);
    assert.equal(said(/disconnect from MongoDB: Mongoose is disconnected/).length, 1);
    assert.equal(said(/shutdown complete/).length, 1);
    assert.equal(said(/10000ms of grace/).length, 1, 'the grace period it is working to is not in the log');
  });

  test('SHUTDOWN_LOG_LEVEL=off silences it entirely', async () => {
    const before = process.env.SHUTDOWN_LOG_LEVEL;
    process.env.SHUTDOWN_LOG_LEVEL = 'off';
    try {
      const server = fakeServer();
      const running = createShutdown({
        server, closeStreams: () => 0, disconnect: async () => {}, exit: fakeExit(), graceMs: 10_000,
      })('SIGTERM');
      await settle();
      server.finishRequests();
      await running;
      assert.deepEqual(captured, []);
    } finally {
      if (before === undefined) delete process.env.SHUTDOWN_LOG_LEVEL;
      else process.env.SHUTDOWN_LOG_LEVEL = before;
    }
  });
});

describe('the grace period', () => {
  test('abandons a request that outlives it and forces the exit', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const server = fakeServer();
    const exit = fakeExit();

    // finishRequests is never called: this models the one hung request the
    // force-exit exists for.
    const running = createShutdown({
      server,
      closeStreams: () => 1,
      disconnect: async () => {},
      exit,
      graceMs: 10_000,
    })('SIGTERM');

    await settle();
    t.mock.timers.tick(9_999);
    await settle();
    assert.deepEqual(exit.codes, [], 'gave up before the grace period was over');

    t.mock.timers.tick(1);
    const result = await running;

    assert.equal(result.forced, true);
    assert.deepEqual(exit.codes, [1], 'a hung request held the deploy open');
    const waited = result.stages.find((s) => s.name === 'wait for in-flight requests');
    assert.equal(waited.status, 'abandoned');
    assert.equal(said(/grace period expired/).length >= 1, true, 'the log does not say the deadline was what ended it');
    assert.equal(said(/forcing exit \(code 1\)/).length, 1);
  });

  test('a request that finishes inside it is waited for, not abandoned', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const server = fakeServer();
    const exit = fakeExit();

    const running = createShutdown({
      server, closeStreams: () => 1, disconnect: async () => {}, exit, graceMs: 10_000,
    })('SIGTERM');

    await settle();
    t.mock.timers.tick(9_000);
    await settle();
    server.finishRequests();
    const result = await running;

    assert.equal(result.forced, false);
    assert.deepEqual(exit.codes, [0]);
    assert.equal(result.stages.find((s) => s.name === 'wait for in-flight requests').status, 'ok');
    assert.equal(said(/grace period expired/).length, 0);

    // The deadline is cancelled on the way out, so nothing fires later and
    // forces a second exit over a shutdown that already finished.
    t.mock.timers.tick(60_000);
    await settle();
    assert.deepEqual(exit.codes, [0], 'the deadline fired after a clean shutdown');
  });

  test('defaults to 10s, and ignores a value that is not a positive integer', () => {
    const before = process.env.SHUTDOWN_GRACE_MS;
    const set = (value) => {
      if (value === null) delete process.env.SHUTDOWN_GRACE_MS;
      else process.env.SHUTDOWN_GRACE_MS = value;
    };
    try {
      set(null);
      assert.equal(shutdownGraceMs(), DEFAULT_SHUTDOWN_GRACE_MS);
      assert.equal(DEFAULT_SHUTDOWN_GRACE_MS, 10_000);
      set('30000');
      assert.equal(shutdownGraceMs(), 30_000);
      // A half-filled .env must not read as "abandon every request at once".
      for (const bad of ['', '0', '-1', 'soon', '1.5']) {
        set(bad);
        assert.equal(shutdownGraceMs(), DEFAULT_SHUTDOWN_GRACE_MS, `SHUTDOWN_GRACE_MS=${bad} was honoured`);
      }
      assert.ok(said(/not a positive integer/).length >= 1, 'a rejected value was not reported');
    } finally {
      set(before === undefined ? null : before);
    }
  });
});

describe('a second signal', () => {
  test('is ignored while the first shutdown is running', async () => {
    const calls = [];
    const streams = deferred();
    const server = fakeServer();
    const exit = fakeExit();

    const shutdown = createShutdown({
      server,
      closeStreams: () => { calls.push('streams'); return streams.promise; },
      disconnect: () => { calls.push('disconnect'); },
      exit,
      graceMs: 10_000,
    });

    const first = shutdown('SIGTERM');
    const second = shutdown('SIGINT');
    const third = shutdown('SIGTERM');

    assert.equal(second, first, 'a second signal started its own sequence');
    assert.equal(third, first);

    await settle();
    assert.deepEqual(calls, ['streams'], 'the stream closer ran more than once');
    assert.equal(server.closeCalls, 1, 'the listener was closed twice');
    assert.equal(said(/ignored/).length, 2, 'the ignored signals are not in the log');
    assert.ok(said(/SIGINT ignored/)[0].includes('SIGTERM'), 'the log does not say which signal owns the running shutdown');

    streams.resolve(0);
    server.finishRequests();
    await first;

    assert.deepEqual(calls, ['streams', 'disconnect']);
    assert.deepEqual(exit.codes, [0], 'the process was exited once per signal');
  });

  test('is still ignored after the first shutdown has finished', async () => {
    const server = fakeServer();
    const exit = fakeExit();
    const shutdown = createShutdown({
      server, closeStreams: () => 0, disconnect: async () => {}, exit, graceMs: 10_000,
    });

    const first = shutdown('SIGTERM');
    await settle();
    server.finishRequests();
    await first;
    assert.deepEqual(exit.codes, [0]);

    await shutdown('SIGTERM');
    assert.equal(server.closeCalls, 1, 'a signal after the shutdown restarted it');
    assert.deepEqual(exit.codes, [0]);
  });
});

describe('a stage that fails', () => {
  test('does not stop the stages after it', async () => {
    const calls = [];
    const server = fakeServer();
    const exit = fakeExit();

    const running = createShutdown({
      server,
      closeStreams: () => { calls.push('streams'); throw new Error('the registry blew up'); },
      disconnect: () => { calls.push('disconnect'); return Promise.reject(new Error('the socket was already gone')); },
      exit,
      graceMs: 10_000,
    })('SIGTERM');

    await settle();
    server.finishRequests();
    const result = await running;

    assert.deepEqual(calls, ['streams', 'disconnect'], 'a throwing stage short-circuited the sequence');
    assert.equal(result.stages.find((s) => s.name === 'end every live stream').status, 'failed');
    assert.equal(result.stages.find((s) => s.name === 'wait for in-flight requests').status, 'ok');
    assert.equal(result.stages.find((s) => s.name === 'disconnect from MongoDB').status, 'failed');
    assert.deepEqual(exit.codes, [1], 'a failed disconnect was allowed to keep the process alive');
    assert.equal(said(/the registry blew up/).length, 1);
    assert.equal(said(/the socket was already gone/).length, 1);
  });

  test('a listener that refuses to close does not burn the grace period', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const server = fakeServer({ throwOnClose: true });
    const exit = fakeExit();

    // Nothing will ever call back, so the in-flight wait has to give up on its
    // own rather than hold the deploy open for the full ten seconds.
    const result = await createShutdown({
      server, closeStreams: () => 0, disconnect: async () => {}, exit, graceMs: 10_000,
    })('SIGTERM');

    assert.equal(result.stages[0].status, 'failed');
    assert.equal(result.stages.find((s) => s.name === 'disconnect from MongoDB').status, 'ok');
    assert.equal(result.forced, true);
    assert.deepEqual(exit.codes, [1]);
    assert.ok(result.ms < 10_000, 'the sequence waited out the grace period for a listener that never closed');
  });

  test('missing dependencies are reported, not thrown', async () => {
    const exit = fakeExit();
    const result = await createShutdown({ exit, graceMs: 10_000 })();

    assert.equal(result.signal, 'shutdown');
    assert.equal(result.forced, false);
    assert.deepEqual(exit.codes, [0]);
    assert.equal(said(/no listener to close/).length, 1);
    assert.equal(said(/no stream closer was injected/).length, 1);
    assert.equal(said(/no disconnect was injected/).length, 1);
  });
});
