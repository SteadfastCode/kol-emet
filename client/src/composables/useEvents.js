import { onMounted, onUnmounted } from 'vue';

const BASE = import.meta.env.VITE_API_URL ?? '';

// Module-level so the API layer can read it for X-SSE-Client-Id headers
export let sseClientId = null;

/**
 * The browser end of `GET /events`: the live-sync channel, and the only thing
 * that keeps a second tab honest about a workspace someone else is editing.
 *
 * Three rules this file is built around (KOL-102):
 *
 *   **Every frame the server sends has a listener here.** It used to register
 *   four (`client:id` and the three `entity:*`) and silently drop the rest, so
 *   a bulk write — a 30-item draft apply, a whole-graph import — was invisible
 *   in every other tab until a reload. A bulk write deliberately broadcasts
 *   *one* frame rather than a burst of per-entity events (see
 *   `server/src/lib/changeLogger.js`), which is cheap on the wire and useless
 *   if nothing listens: `draft:applied` and `workspace:imported` are therefore
 *   first-class here, each reloading the list rather than patching it, because
 *   one frame cannot say which rows moved.
 *
 *   **A frame the server wrote is a stop, not a retry.** An `EventSource`
 *   reports two unrelated things as `error`: a transport failure (no `data`),
 *   and a `event: error` frame the server wrote before ending the stream on
 *   purpose (`data`, carrying a reason — see `lib/broadcaster.js`). Treating
 *   them alike had a tab whose session was revoked, or one over
 *   `EVENTS_MAX_STREAMS_PER_USER`, re-dial a refusal every 3 seconds for as
 *   long as it stayed open. So `e.data` decides: a `session-ended` or
 *   `too-many-streams` frame ends the loop and says so to the user, anything
 *   else — including the `server-restarting` a deploy sends — is retried with a
 *   growing, jittered, capped delay instead of a fixed 3000 ms.
 *
 *   **The log tier is a tier, not `console.log`.** This channel pushed whole
 *   entity documents through `console.log` on every frame, which is both the
 *   noisiest and the most sensitive output in the client.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * localStorage.SSE_LOG_LEVEL = off | light | normal | verbose (default light).
 * A dead stream looks exactly like a quiet workspace, so the light tier's job
 * is that the console can always say why this tab is or is not connected.
 *   off     — nothing
 *   light   — every connect, every ending with the source that caused it (which
 *             frame, or which transport failure), and every reconnect with its
 *             attempt number and delay. No payload.
 *   normal  — light, plus each frame's event name and the id it is about
 *   verbose — normal, plus the frame itself (entity bodies included)
 */

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  let configured = null;
  try { configured = localStorage.getItem('SSE_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((LEVELS[configured] ?? LEVELS.light) >= LEVELS[level]) console.log(`[sse:${level}] ${msg}`);
}

/** The first retry's delay; it doubles per consecutive failure. */
export const RECONNECT_BASE_MS = 1000;

/** The ceiling the doubling stops at — a tab left open overnight still retries. */
export const RECONNECT_MAX_MS = 30_000;

/** How far either side of the backoff a delay is spread. */
export const RECONNECT_JITTER = 0.25;

/**
 * How long to wait before the `attempt`-th consecutive reconnect.
 *
 * Exponential so a server that is down is asked once a half-minute rather than
 * twenty times a minute by every open tab; jittered because every tab in the
 * deployment lost its stream at the same instant and a fixed delay would have
 * them all come back in the same instant too. ±25 % keeps successive delays
 * strictly growing whatever `random` returns, which is what makes the backoff
 * assertable.
 *
 * @param {number} attempt 1 for the first retry after a healthy connection
 * @param {() => number} [random] injected for tests
 */
export function reconnectDelay(attempt, random = Math.random) {
  const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(backoff + (random() * 2 - 1) * backoff * RECONNECT_JITTER);
}

/**
 * The server frames that end the loop, and what the user is told.
 *
 * Both mean "this credential will not be served again": reconnecting would
 * fetch the same refusal forever. Anything else the server sends is a planned
 * end (a deploy's `server-restarting`) or a code this client does not know
 * yet — retried, because a stop that is wrong leaves a tab permanently blind.
 *
 * That last clause is a contract the *server* has to keep, and it was broken
 * once (KOL-112): `POST /auth/sessions/revoke-all` closed every stream the
 * account held, the caller's own included, assuming this file would reconnect.
 * It does not, by design — so the tab that asked went blind for good and was
 * told it had been signed out in another window while the same screen said it
 * was still signed in. `session-ended` now reaches a stream only when that
 * stream's session really is finished (`server/src/lib/broadcaster.js`); a
 * server that wants a stream to come back sends any other code.
 */
export const STOP_REASONS = Object.freeze({
  'session-ended': () =>
    'Live updates stopped: you were signed out in another window. Reload the page to sign in again.',
  'too-many-streams': ({ limit }) =>
    `Live updates stopped: this account already has ${limit ?? 'the maximum number of'} live connections open. Close another tab, then reload this one.`,
});

/**
 * @param {object} handlers
 * @param {(payload: object) => void} [handlers.onEntityCreated]
 * @param {(payload: object) => void} [handlers.onEntityUpdated]
 * @param {(payload: object) => void} [handlers.onEntityDeleted]
 * @param {(payload: object) => void} [handlers.onDraftApplied]     one bulk write: a draft reached the graph
 * @param {(payload: object) => void} [handlers.onWorkspaceImported] one bulk write: a graph was imported
 * @param {(ended: {reason: string, message: string, limit: number|null}) => void} [handlers.onStreamEnded]
 *   the server ended this stream for good; nothing will reconnect
 */
export function useEvents({
  onEntityCreated,
  onEntityUpdated,
  onEntityDeleted,
  onDraftApplied,
  onWorkspaceImported,
  onStreamEnded,
} = {}) {
  let es = null;
  let reconnectTimer = null;
  /** Consecutive failed connections; reset by a connection that opened. */
  let failures = 0;
  /** Set once the server has ended this stream for good, or the view is gone. */
  let stopped = false;

  /**
   * Registers a frame listener that parses once, logs at the right tier, and
   * hands the payload on.
   *
   * `subject` names the row a frame is about — an id or a count, never content
   * — so the normal tier can say *which* without the light tier ever carrying a
   * payload. A handler that throws is reported and swallowed: one bad frame
   * must not take the listener down with it.
   */
  function onFrame(name, subject, run) {
    es.addEventListener(name, (e) => {
      log('verbose', `${name} frame: ${e.data}`);
      let payload;
      try {
        payload = JSON.parse(e.data);
      } catch (err) {
        log('light', `dropped a ${name} frame (source: JSON.parse: ${err.message})`);
        return;
      }
      log('normal', `${name} — ${subject(payload ?? {})}`);
      try {
        run(payload);
      } catch (err) {
        console.error(`[sse] the ${name} handler threw:`, err);
      }
    });
  }

  /** Forgets the socket, whoever ended it. */
  function dropSocket() {
    try { es?.close(); } catch { /* already gone */ }
    es = null;
    sseClientId = null;
  }

  function scheduleReconnect(source) {
    failures += 1;
    const delay = reconnectDelay(failures);
    log('light', `reconnecting in ${delay}ms (attempt ${failures}) (source: ${source})`);
    reconnectTimer = setTimeout(connect, delay);
  }

  /**
   * The one `error` path, for both of the unrelated things that arrive on it.
   * `e.data` is the discriminator: only a frame the server wrote has one.
   *
   * `socket` is the connection the listener was registered on, and anything
   * from one this composable has already moved on from is ignored: a socket the
   * server ended can report it twice (the frame it wrote, then the close), and
   * a late word from a replaced socket must not close the live one.
   */
  function handleError(e, socket) {
    if (stopped || socket !== es) return;
    const raw = typeof e?.data === 'string' ? e.data : null;
    const readyState = socket.readyState;
    dropSocket();

    if (raw === null) {
      log('light', `stream ended (source: a transport failure, readyState ${readyState ?? 'unknown'})`);
      return scheduleReconnect('a transport failure');
    }

    let detail = null;
    try { detail = JSON.parse(raw); } catch { /* the server's own frame, unreadable */ }
    const reason = typeof detail?.error === 'string' ? detail.error : 'unknown';
    log('verbose', `server error frame: ${raw}`);

    const describe = STOP_REASONS[reason];
    if (!describe) {
      // A planned end (a deploy's server-restarting) or a code this build does
      // not know: come back, with the same backoff a dropped socket gets.
      log('light', `stream ended (source: a server '${reason}' frame)`);
      return scheduleReconnect(`a server '${reason}' frame`);
    }

    stopped = true;
    log('light', `stream ended for good, not retrying (source: a server '${reason}' frame)`);
    onStreamEnded?.({ reason, message: describe(detail ?? {}), limit: detail?.limit ?? null });
  }

  function connect() {
    if (stopped) return;
    reconnectTimer = null;
    log('light', `connecting to ${BASE}/events${failures ? ` (attempt ${failures + 1})` : ''}`);
    es = new EventSource(`${BASE}/events`, { withCredentials: true });
    const socket = es;

    socket.addEventListener('open', () => {
      if (socket !== es) return;
      failures = 0;
      log('light', `connected to ${BASE}/events`);
    });

    onFrame('client:id', (p) => `client ${p.clientId}`, (p) => { sseClientId = p.clientId; });

    onFrame('entity:created', (p) => `entity ${p.entity?._id}`, (p) => onEntityCreated?.(p));
    onFrame('entity:updated', (p) => `entity ${p.entity?._id}`, (p) => onEntityUpdated?.(p));
    onFrame('entity:deleted', (p) => `entity ${p.entityId}`, (p) => onEntityDeleted?.(p));

    // The two bulk writes. One frame each, covering a write the client cannot
    // reconstruct row by row — so each handler refetches rather than patches.
    onFrame('draft:applied', (p) => `draft ${p.draftId}, ${p.applied ?? 0} item(s) applied`,
      (p) => onDraftApplied?.(p));
    onFrame('workspace:imported', (p) => `${p.imported?.entities ?? 0} entities imported`,
      (p) => onWorkspaceImported?.(p));

    socket.addEventListener('error', (e) => handleError(e, socket));
  }

  onMounted(connect);

  onUnmounted(() => {
    stopped = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    log('light', 'stream ended (source: the view was unmounted)');
    dropSocket();
  });
}
