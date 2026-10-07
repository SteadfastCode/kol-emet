/**
 * The SSE live-update channel: every open `GET /events` connection, and the
 * fan-out that writes to them.
 *
 * clients: Map of clientId -> {
 *   res,            // the held response
 *   workspaceId,    // String; the tenancy filter every broadcast runs through
 *   userId,         // String|null; null when the caller authenticated with BEARER_TOKEN
 *   sessionId,      // String|null; the express-session id, when there is one
 *   sessionAlive,   // (sessionId) => Promise<boolean>; injected, see below
 * }
 *
 * Every payload is workspace-scoped. This is a push channel carrying full
 * entity documents, so an unscoped broadcast leaks content across tenants
 * exactly as an unscoped query would — the filter here is load-bearing, not
 * a nicety.
 *
 * Two bounds beyond that filter (KOL-062), because a held socket authenticated
 * once at connect time is otherwise unbounded in both lifetime and number:
 *
 *   **A stream must not outlive its session.** `GET /events` authenticates on
 *   connect and then holds the response open, so without this a browser that
 *   signed out — a shared machine, say — kept receiving entity documents for
 *   the workspace it had just left. Each connection therefore records the
 *   session it was opened by, the keep-alive sweep asks whether that session is
 *   still in the store, and a connection whose session is gone is closed. The
 *   lookup is *injected* (`sessionAlive`, built by `createApp` from the session
 *   store it already has) rather than imported: this module stays free of
 *   express-session and of Mongo, and its unit test keeps driving it with
 *   nothing but fake `res` objects.
 *
 *   **One user must not be able to open an unbounded number.** Each is a held
 *   socket plus a write every 30 seconds, on the single process every tenant
 *   shares, so `addClient` refuses past `EVENTS_MAX_STREAMS_PER_USER` (default
 *   10) and the route answers the refusal as one SSE `error` event.
 *
 * Known limit, the same one KOL-035 recorded for the auth counters: this map is
 * in-process. A second API instance has its own, so the cap is per instance and
 * a stream is only swept by the instance holding it. Both bounds move to shared
 * state with the rest of that work, not before.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * SSE_LOG_LEVEL = off | light | normal | verbose (default light)
 * A dropped stream looks, from the browser, exactly like a flaky network: the
 * point of the light tier is that the server can always say *why* a connection
 * ended, not just that the count changed.
 *   off     — nothing (the refusal to broadcast unscoped still reports; see below)
 *   light   — every connection that ends and its reason (closed by the client,
 *             session gone, over the cap, socket refused a write), plus every
 *             refused connection and every failed session lookup
 *   normal  — light, plus connections accepted, each broadcast's fan-out, and
 *             one line per keep-alive sweep
 *   verbose — normal, plus per-client detail inside a sweep
 */

const clients = new Map();

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.SSE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[sse:${level}] ${msg}`);
}

/** Streams one user may hold open at once when EVENTS_MAX_STREAMS_PER_USER says nothing. */
export const DEFAULT_MAX_STREAMS_PER_USER = 10;

/** How often the keep-alive sweep runs: one ping, and one session check, per client. */
export const KEEPALIVE_MS = 30_000;

/**
 * The per-user stream cap, read per call so a deployment (and a test) can
 * change it without reloading this module.
 *
 * A value that is not a positive integer is the default rather than an
 * accidental ceiling: `EVENTS_MAX_STREAMS_PER_USER=` in a half-filled `.env`
 * must not parse as 0 and refuse every stream the product has.
 */
export function maxStreamsPerUser() {
  const raw = process.env.EVENTS_MAX_STREAMS_PER_USER;
  if (raw === undefined || raw === '') return DEFAULT_MAX_STREAMS_PER_USER;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    log('light', `EVENTS_MAX_STREAMS_PER_USER=${raw} is not a positive integer — using ${DEFAULT_MAX_STREAMS_PER_USER} (source: lib/broadcaster.js)`);
    return DEFAULT_MAX_STREAMS_PER_USER;
  }
  return parsed;
}

/**
 * The bucket a connection is counted in.
 *
 * Connections with no user — the `BEARER_TOKEN` path through `requireAuth` —
 * share one bucket, because they share one credential: a single secret handed
 * to an AI connector should not be the one way to open unlimited streams.
 */
const streamKey = (userId) => (userId == null ? 'bearer' : String(userId));

const openFor = (key) => {
  let n = 0;
  for (const { userId } of clients.values()) if (streamKey(userId) === key) n += 1;
  return n;
};

/**
 * Registers a connection, or refuses it because its user already holds the
 * most streams this deployment allows.
 *
 * @param {string} clientId
 * @param {import('express').Response} res
 * @param {any} workspaceId
 * @param {object} [opts]
 * @param {any}    [opts.userId]  the signed-in user, or null for a bearer caller
 * @param {string} [opts.sessionId] express-session id; null means "never sweep
 *   this connection for a missing session". A bearer-authenticated request has
 *   a `req.sessionID` but no *stored* session (saveUninitialized is false), so
 *   recording one would drop the stream on the first sweep.
 * @param {(sessionId: string) => Promise<boolean>} [opts.sessionAlive]
 * @returns {{accepted: boolean, limit: number, open: number, reason?: string}}
 *   `open` is the count for this user, after a successful add.
 */
export function addClient(clientId, res, workspaceId, opts = {}) {
  const { userId = null, sessionId = null, sessionAlive = null } = opts;
  const key = streamKey(userId);
  const limit = maxStreamsPerUser();
  const open = openFor(key);

  if (open >= limit) {
    log('light', `connection refused (${clientId}) for ${key} — ${open} stream(s) already open, limit ${limit} (source: EVENTS_MAX_STREAMS_PER_USER)`);
    return { accepted: false, reason: 'over-cap', limit, open };
  }

  clients.set(clientId, {
    res,
    workspaceId: String(workspaceId),
    userId: userId == null ? null : String(userId),
    sessionId: sessionId == null ? null : String(sessionId),
    sessionAlive,
  });
  log('normal', `client connected (${clientId}) for ${key} in workspace ${String(workspaceId)} — ${open + 1}/${limit} for this user, ${clients.size} total`);
  return { accepted: true, limit, open: open + 1 };
}

/**
 * Forgets a connection whose socket is already going away.
 *
 * `reason` is what the light tier reports: the default is the ordinary case
 * (the route's own `req.on('close')`), and every other caller names itself.
 */
export function removeClient(clientId, reason = 'closed by the client') {
  if (!clients.delete(clientId)) return false;
  log('light', `client disconnected (${clientId}) — ${reason}; total: ${clients.size}`);
  return true;
}

/**
 * Drops a connection *and closes it* — the server's decision rather than the
 * client's, so the socket is ended here and the client is told why first.
 *
 * One `event: error` line, because an `EventSource` cannot read a non-200 body:
 * refusing with a status code would reach the browser as an indistinguishable
 * network failure, and this channel's whole problem is that a silently dead
 * stream looks exactly like a flaky one.
 */
function endStream(clientId, reason, detail) {
  const client = clients.get(clientId);
  if (!client) return false;
  clients.delete(clientId);
  try {
    if (detail) client.res.write(streamErrorFrame(detail));
    client.res.end();
  } catch (err) {
    // Already gone. The entry is out of the map either way, which is the part
    // that matters; the socket is the operating system's problem now.
    log('normal', `stream ${clientId} could not be closed cleanly: ${err.message}`);
  }
  log('light', `client disconnected (${clientId}) — ${reason}; total: ${clients.size}`);
  return true;
}

/**
 * The SSE frame the server sends before closing a stream it is ending. Shared
 * so the route's refusal and the sweep's drop are one shape for the client.
 */
export function streamErrorFrame(detail) {
  return `event: error\ndata: ${JSON.stringify(detail)}\n\n`;
}

/**
 * Closes every stream opened by one session. Called by `POST /auth/logout` so
 * signing out ends the push channel at once rather than within a sweep.
 *
 * @returns {number} how many were closed
 */
export function closeStreamsForSession(sessionId, reason = 'its session ended') {
  if (!sessionId) return 0;
  const target = String(sessionId);
  let closed = 0;
  for (const [clientId, client] of clients) {
    if (client.sessionId === target) closed += endStream(clientId, reason, { error: 'session-ended' }) ? 1 : 0;
  }
  log('normal', `closed ${closed} stream(s) for a session — ${reason}`);
  return closed;
}

/**
 * Closes every stream belonging to one user, in this process.
 *
 * `DELETE /auth/account` uses this rather than the session form: the session
 * store cannot be searched by user (see `GET /auth/me`), so a deleted account's
 * *other* browsers would otherwise keep receiving entity documents until their
 * own sessions expired. Those sessions do outlive the account — that is a known
 * limit recorded in the Decision Log — but their push channels do not have to.
 *
 * @returns {number} how many were closed
 */
export function closeStreamsForUser(userId, reason = 'its account was deleted') {
  if (userId == null) return 0;
  const target = String(userId);
  let closed = 0;
  for (const [clientId, client] of clients) {
    if (client.userId === target) closed += endStream(clientId, reason, { error: 'session-ended' }) ? 1 : 0;
  }
  log('normal', `closed ${closed} stream(s) for user ${target} — ${reason}`);
  return closed;
}

/**
 * One pass over every open connection: drop the ones whose session has gone,
 * ping the rest.
 *
 * The ping keeps SSE alive through proxies; it is also what notices a socket
 * that went away without a `close` event. The session check rides along because
 * this loop already exists — re-validating on a 30-second tick is what makes a
 * logout on another instance, or a session expiry, eventually end the stream,
 * without putting a store lookup on the broadcast path.
 *
 * Exported so the test suite can run a sweep rather than wait 30 seconds for
 * one, and so an operator can trigger one from a REPL.
 */
export async function sweepClients() {
  const started = clients.size;
  let pinged = 0;
  let dropped = 0;

  for (const [clientId, client] of clients) {
    if (client.sessionId && client.sessionAlive) {
      let alive = true;
      try {
        alive = await client.sessionAlive(client.sessionId);
      } catch (err) {
        // Fail open: a store that did not answer must not be the thing that
        // ends every live stream in the deployment. The next sweep asks again.
        log('light', `session check failed for ${clientId}: ${err.message} — keeping the stream (source: injected sessionAlive threw)`);
        alive = true;
      }
      if (!alive) {
        endStream(clientId, 'its session is no longer in the session store', { error: 'session-ended' });
        dropped += 1;
        continue;
      }
      log('verbose', `session still present for ${clientId} (user ${client.userId ?? 'bearer'})`);
    }

    try {
      client.res.write('data: ping\n\n');
      pinged += 1;
    } catch {
      removeClient(clientId, 'the socket refused a keep-alive ping');
      dropped += 1;
    }
  }

  log('normal', `keep-alive swept ${started} client(s): ${pinged} pinged, ${dropped} dropped`);
  return { swept: started, pinged, dropped };
}

// Keep SSE connections alive through proxies, and re-check each one's session.
//
// unref'd so it is not on its own a reason for the process to stay alive: the
// listening server holds the loop open in the deployed app, while a test that
// merely imports this module must still be able to exit.
setInterval(() => {
  sweepClients().catch((err) => log('light', `keep-alive sweep failed: ${err.message}`));
}, KEEPALIVE_MS).unref();

/**
 * @param {string} eventName
 * @param {object} data
 * @param {{workspaceId: any, excludeClientId?: string|null}} opts
 *
 * workspaceId is required. A missing or unmatched one delivers to nobody
 * rather than to everybody: if a future caller forgets it, the failure is a
 * missing live update, not a cross-tenant disclosure.
 */
export function broadcast(eventName, data, opts = {}) {
  const { workspaceId, excludeClientId = null } = opts;
  const target = workspaceId == null ? null : String(workspaceId);

  if (target === null) {
    // Unconditional, and on console.error: this is a bug in the caller, not
    // debug output, so SSE_LOG_LEVEL=off must not be able to hide it.
    console.error(`[sse] refusing to broadcast ${eventName} — no workspaceId supplied`);
    return;
  }

  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  let sent = 0;
  for (const [clientId, { res, workspaceId: clientWs }] of clients) {
    if (clientWs !== target) continue;
    if (clientId === excludeClientId) continue;
    try { res.write(payload); sent++; } catch { removeClient(clientId, 'the socket refused a broadcast'); }
  }
  log('normal', `broadcast ${eventName} to ${sent}/${clients.size} client(s) in workspace ${target}${excludeClientId ? ` (excluding ${excludeClientId})` : ''}`);
}
