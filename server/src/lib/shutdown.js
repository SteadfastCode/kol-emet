/**
 * Graceful shutdown: everything that has to happen between the SIGTERM a host
 * sends at every deploy and the process actually ending.
 *
 * Without a handler the signal's default action kills the process where it
 * stands. Two things break that nobody sees afterwards. A write caught between
 * its Mongo call and its `ChangeLog` append lands half done — the entity is
 * saved, the history entry it would be rolled back by never exists. And every
 * open `GET /events` stream dies at the socket with no close frame, which
 * `client/src/composables/useEvents.js` can only read as a network error:
 * indistinguishable, from the browser, from flaky wifi.
 *
 * Four stages, in order, each awaited before the next starts:
 *
 *   1. **Stop accepting connections** (`server.close`). Nothing new arrives
 *      from here on, and the listener's own callback is what later says the
 *      sockets it still holds have finished.
 *   2. **End every live stream**, with a reason the client receives as an SSE
 *      `error` frame before the socket closes. This is also what lets stage 3
 *      finish at all: an SSE connection is held open for hours, so a
 *      `server.close` with streams still attached would wait out the entire
 *      grace period on every single deploy.
 *   3. **Wait for in-flight requests**, up to `SHUTDOWN_GRACE_MS` (10s).
 *   4. **Disconnect Mongoose.**
 *
 * The server, the stream closer, the disconnect and the exit are all injected,
 * so `tests/unit/shutdown.test.js` drives the real sequencing with no listener,
 * no signal, and nothing that could end the test runner's own process. The
 * factory shape exists for the latch: "a shutdown is already running" is state,
 * and state at module level is state a test cannot reset.
 *
 * ─── Why it ends with an exit, always ────────────────────────────────────────
 * The last act is `exit(code)` — 0 when every stage completed, 1 when the grace
 * period expired or a stage failed. The forced case is the queue item's reason:
 * one hung request must not be able to hold a deploy open. The clean case is
 * this deployment's: `createApp` builds its session store with
 * `MongoStore.create({ mongoUrl })`, which owns a MongoClient of its own that
 * `mongoose.disconnect()` does not touch, so the event loop does **not** drain
 * when the stages finish and a "clean" shutdown that merely resolved would hang
 * until the platform's SIGKILL — the exact failure this module exists to stop.
 * Exiting on both paths and distinguishing them by code is one mechanism with
 * one outcome, rather than a clean path whose correctness depends on no library
 * anywhere holding a handle. A stage that throws is not special either: a
 * failed disconnect must not be the thing that keeps the process alive.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * SHUTDOWN_LOG_LEVEL = off | light | normal | verbose (default light)
 * A shutdown leaves nothing behind to inspect — the process is gone and so is
 * every connection — so the log is the only account of what happened.
 *   off     — nothing
 *   light   — what started it (which signal), the outcome of each stage, a
 *             second signal ignored, and the exit with its code
 *   normal  — light, plus each stage as it starts
 *   verbose — normal, plus the stack of a stage that threw
 */

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.SHUTDOWN_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[shutdown:${level}] ${msg}`);
}

/** How long in-flight work gets when SHUTDOWN_GRACE_MS says nothing. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

/** What the stream closer is told, and through it every connected client. */
export const STREAM_CLOSE_REASON = 'the server is shutting down';

/**
 * The grace period, read per call so a deployment (and a test) can change it
 * without reloading this module.
 *
 * A value that is not a positive integer is the default rather than an
 * accidental zero: `SHUTDOWN_GRACE_MS=` in a half-filled `.env` must not parse
 * as "abandon every request immediately".
 */
export function shutdownGraceMs() {
  const raw = process.env.SHUTDOWN_GRACE_MS;
  if (raw === undefined || raw === '') return DEFAULT_SHUTDOWN_GRACE_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    log('light', `SHUTDOWN_GRACE_MS=${raw} is not a positive integer — using ${DEFAULT_SHUTDOWN_GRACE_MS}ms (source: lib/shutdown.js)`);
    return DEFAULT_SHUTDOWN_GRACE_MS;
  }
  return parsed;
}

/** Resolved by the deadline timer, and by nothing else a stage could return. */
const TIMED_OUT = Symbol('shutdown-deadline');

/**
 * One deadline for the whole shutdown, which every awaited stage races. A
 * single ceiling rather than a timeout per stage: what matters to the host is
 * that the process is gone within the grace period, not which step was slow.
 */
function armDeadline(graceMs) {
  let timer = null;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), graceMs);
    // unref'd: a deadline is a ceiling on a shutdown, never a reason for the
    // process to stay up. If nothing else holds the loop open, there is nothing
    // left to wait for either.
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Runs one stage: records what it did, catches what it threw, and gives up on
 * it the moment the grace period expires.
 *
 * A failure is recorded and the stages after it still run. The disconnect is
 * the case that matters: if a thrown error short-circuited the sequence, a
 * failed disconnect would be what kept the process alive.
 *
 * @param {Array} stages collected outcomes, in the order they ran
 * @param {{promise: Promise<symbol>}} deadline
 * @param {string} name
 * @param {() => any} work resolves to a string describing what it did
 */
async function stage(stages, deadline, name, work) {
  const began = Date.now();
  log('normal', `${name}: starting`);

  const settled = Promise.resolve().then(work).then(
    (detail) => ({ status: 'ok', detail }),
    (err) => ({ status: 'failed', err }),
  );
  const outcome = await Promise.race([settled, deadline.promise]);
  const ms = Date.now() - began;

  let record;
  if (outcome === TIMED_OUT) {
    record = { name, status: 'abandoned', detail: 'the grace period expired', ms };
    log('light', `${name}: abandoned after ${ms}ms — the grace period expired (source: SHUTDOWN_GRACE_MS)`);
  } else if (outcome.status === 'failed') {
    record = { name, status: 'failed', detail: outcome.err?.message ?? String(outcome.err), ms };
    log('light', `${name}: failed after ${ms}ms — ${record.detail} (source: the stage threw; the stages after it still run)`);
    log('verbose', `${name}: ${outcome.err?.stack ?? '(no stack)'}`);
  } else {
    record = { name, status: 'ok', detail: outcome.detail, ms };
    log('light', `${name}: ${outcome.detail} (${ms}ms)`);
  }
  stages.push(record);
  return record;
}

async function run(signal, { server, closeStreams, disconnect, exit, graceMs }) {
  const began = Date.now();
  const deadline = armDeadline(graceMs);
  const stages = [];

  log('light', `${signal} received — shutting down with ${graceMs}ms of grace (source: SHUTDOWN_GRACE_MS)`);

  // Resolved by the listener's own callback, once every socket it still held
  // has finished. Built here so stage 1 can register the callback and stage 3
  // can wait on it.
  let drained;
  const inFlightFinished = new Promise((resolve) => { drained = resolve; });

  const stopped = await stage(stages, deadline, 'stop accepting connections', () => {
    if (typeof server?.close !== 'function') {
      drained('there was no listener');
      return 'there was no listener to close';
    }
    server.close((err) => drained(err ? `the listener reported ${err.message}` : 'every socket finished'));
    return 'the listener is closed to new connections';
  });
  if (stopped.status !== 'ok') {
    // A close that threw leaves a callback that will never fire, and waiting on
    // it would burn the whole grace period for nothing.
    drained('the listener never closed');
  }

  await stage(stages, deadline, 'end every live stream', async () => {
    if (typeof closeStreams !== 'function') return 'no stream closer was injected';
    const closed = await closeStreams(`${signal}: ${STREAM_CLOSE_REASON}`);
    return `closed ${closed ?? 0} live stream(s), each told why first`;
  });

  await stage(stages, deadline, 'wait for in-flight requests', async () => {
    const how = await inFlightFinished;
    return `in-flight requests are done — ${how}`;
  });

  await stage(stages, deadline, 'disconnect from MongoDB', async () => {
    if (typeof disconnect !== 'function') return 'no disconnect was injected';
    await disconnect();
    return 'Mongoose is disconnected';
  });

  deadline.cancel();

  const unfinished = stages.filter((s) => s.status !== 'ok');
  const forced = unfinished.length > 0;
  const code = forced ? 1 : 0;
  const ms = Date.now() - began;

  log('light', forced
    ? `forcing exit (code ${code}) after ${ms}ms — ${unfinished.map((s) => `${s.name} ${s.status}`).join(', ')}`
    : `shutdown complete in ${ms}ms — exiting (code ${code})`);

  exit(code);
  return { signal, forced, code, ms, stages };
}

/**
 * Builds the signal handler.
 *
 * @param {object}   deps
 * @param {import('http').Server} deps.server        the listening HTTP server
 * @param {(reason: string) => number|Promise<number>} deps.closeStreams
 *   ends every open SSE stream and returns how many — `closeAllStreams` from
 *   `lib/broadcaster.js` in the app, a fake in the test
 * @param {() => Promise<void>} deps.disconnect      `mongoose.disconnect`
 * @param {(code: number) => void} [deps.exit]       defaults to `process.exit`
 * @param {number} [deps.graceMs]                    defaults to SHUTDOWN_GRACE_MS
 * @returns {(signal?: string) => Promise<object>} idempotent: the first call
 *   starts the shutdown, every later one is logged and handed the same promise,
 *   so a host that sends SIGTERM twice cannot start a second sequence over the
 *   top of the first.
 */
export function createShutdown({ server, closeStreams, disconnect, exit, graceMs } = {}) {
  let running = null;
  let startedBy = null;

  // Deliberately not `async`: a second call has to return the *same* promise
  // object, which is what makes "the second signal was ignored" observable
  // rather than merely likely.
  return function shutdown(signal = 'shutdown') {
    if (running) {
      log('light', `${signal} ignored — the shutdown ${startedBy} started is already running (source: lib/shutdown.js, one per process)`);
      return running;
    }
    startedBy = signal;
    running = run(signal, {
      server,
      closeStreams,
      disconnect,
      // Wrapped rather than defaulted to the bare method, so it is called on
      // `process` however this module is bundled.
      exit: exit ?? ((code) => process.exit(code)),
      graceMs: graceMs ?? shutdownGraceMs(),
    });
    return running;
  };
}
