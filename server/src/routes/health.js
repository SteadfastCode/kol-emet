/**
 * GET /health — is this instance alive, and can it reach its database?
 *
 * Every other route in `createApp` is behind `requireAuth` (bar `/auth`,
 * `/oauth`, `/templates`, `/mcp` and the bridge), so there was no way to ask a
 * deployed instance whether it works. The runbook's deploy signal is Railway's
 * own commit status, which says a container started — not that it can still
 * reach Mongo. That is the gap this closes, and the failure it is for is a
 * specific one: `index.js` listens only *after* the first connect succeeds, so
 * a boot with no database never serves at all; what does happen in production
 * is the connection dropping *later*. Mongoose keeps the process up and
 * reconnects in the background, so the API goes on answering while
 * `mongoose.connection.readyState` is 0 or 2 — and every tenant route turns
 * that window into a stall that reads to a user as their own connection. From
 * the outside it is indistinguishable from a healthy instance. Here it is a
 * 503.
 *
 * The body is three keys and deliberately nothing else: no version, no commit,
 * no collection counts, no environment or provider names. This is the one
 * unauthenticated route whose whole job is to be polled, and a status endpoint
 * that describes its deployment is a reconnaissance endpoint — so what it
 * publishes is "working / not working", which is what a monitor needs and all
 * it needs. `server/tests/http/health.test.js` asserts the exact key set, so a
 * fourth key has to be a deliberate change to that assertion.
 *
 * Mounted ahead of `requireAuth` in `app.js`. It needs no origin-guard
 * exemption: `originGuard` checks unsafe methods only, and this is a GET.
 *
 * Out of scope on purpose: the AI providers and every other outbound
 * dependency (an instance whose OpenRouter key is wrong is not down), metrics,
 * and a status page.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * HEALTH_LOG_LEVEL = off | light | normal | verbose (default light)
 * A monitor polls this every few seconds, so the default tier must not narrate
 * every poll — it logs the *transitions*.
 *   off     — nothing
 *   light   — one line each time the answer changes, naming what changed it:
 *             the previous answer, the new one, and the readyState behind it
 *   normal  — light, plus every answer
 *   verbose — normal, plus the caller's method and path
 */

import { Router } from 'express';
import mongoose from 'mongoose';

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

/** Mongoose's connection states, for a log line that names one rather than numbering it. */
const READY_STATES = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
  99: 'uninitialized',
};

/**
 * The last status answered, so the light tier can report a change and not a
 * poll. Module-level, which means per process: the deployment builds one app,
 * and a test building several shares it — it governs logging only, never the
 * response.
 */
let lastStatus = null;

function log(level, msg) {
  // Resolved per call, not at module load, so it cannot depend on import order.
  const active = LEVELS[process.env.HEALTH_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[health:${level}] ${msg}`);
}

const router = Router();

// GET /health (and HEAD, which Express routes here too — monitors send one).
// No auth, no session: a poller that had to hold a cookie could not tell an
// expired session from a dead instance, and one that created a session per poll
// would write a session document every few seconds.
router.get('/', (req, res) => {
  const { readyState } = mongoose.connection;
  const up = readyState === 1;
  const status = up ? 'ok' : 'degraded';
  const db = up ? 'up' : 'down';
  const code = up ? 200 : 503;

  const because = `mongoose.connection.readyState ${readyState} (${READY_STATES[readyState] ?? 'unknown'})`;
  if (status !== lastStatus) {
    log('light', `answer changed: ${lastStatus ?? 'none yet'} → ${status} (source: ${because})`);
    lastStatus = status;
  }
  log('normal', `${code} ${status}/${db} (source: ${because})`);
  log('verbose', `asked by ${req.method} ${req.originalUrl ?? req.url}`);

  // A cached 200 from a proxy in front of this would outlive the state it
  // describes, which for the one endpoint whose answer is the point is worse
  // than no endpoint.
  res.set('Cache-Control', 'no-store');
  res.status(code).json({ status, db, uptimeSeconds: Math.round(process.uptime()) });
});

export default router;
