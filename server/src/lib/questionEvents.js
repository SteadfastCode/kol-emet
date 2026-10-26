import { broadcast } from './broadcaster.js';

/**
 * The live-sync frames for `OpenQuestion` writes (KOL-116).
 *
 * Entity writes get their frames for free: every one of them goes through
 * `lib/changeLogger.js`, which writes the audit row *and* broadcasts
 * `entity:created` / `entity:updated` / `entity:deleted` from the same call.
 * This collection has no ChangeLog, so there was nothing to inherit and
 * `/open-questions` broadcast nothing at all — a second tab viewing the same
 * entity kept rendering a question that had been deleted, renamed or resolved
 * minutes earlier, and the `X-SSE-Client-Id` header the browser has sent on
 * every unsafe method since KOL-104 (`client/src/api/openQuestions.js`) was
 * inert because no frame ever carried an exclusion.
 *
 * So this module is the changeLogger's equivalent for questions, minus the
 * audit row (a ChangeLog trail and a rollback for this collection are their own
 * item — and the reason KOL-115 gave the delete a confirmation rather than an
 * undo). Three frames mirroring the entity vocabulary:
 *
 *   `question:created`  `{ question, entry_ids }`
 *   `question:updated`  `{ question, entry_ids }`
 *   `question:deleted`  `{ questionId, question, entry_ids }`
 *
 * `question` is the row as the panel renders it (`_id`, `question`, `status`,
 * timestamps) and `entry_ids` is **always plain string ids**, never populated
 * documents: a write path hands us either shape (`POST` answers with the raw
 * document, `PUT` with `entry_ids` populated to `{ title, category }`), and a
 * listener that has to branch on which one it got would be reading the server's
 * internals. Those ids are the whole point of the payload — they are what lets
 * a tab decide whether the entity it is showing is affected without a refetch.
 *
 * Every emit is workspace-scoped through `broadcast`, which delivers to nobody
 * rather than everybody when a caller forgets (`lib/broadcaster.js`), and
 * excludes the writing client by the id it echoed back.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * OPEN_QUESTION_SSE_LOG_LEVEL = off | light | normal | verbose (default light)
 * A frame that is not sent and a frame that is sent to nobody look identical
 * from the other tab — it just goes on showing a stale question — so the light
 * tier's job is that the server can always say which write asked for which
 * frame. (`SSE_LOG_LEVEL` covers the fan-out itself: how many sockets it
 * reached. This covers the decision to send.)
 *   off     — nothing
 *   light   — every frame: its name, the question id, the workspace, the client
 *             id excluded from it, and the write that asked for it
 *   normal  — light, plus the `entry_ids` the frame carried, which is what
 *             decides whether a listening tab refreshes
 *   verbose — normal, plus the row as it goes on the wire
 */

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.OPEN_QUESTION_SSE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[openQuestions/sse:${level}] ${msg}`);
}

/**
 * The row a frame carries: exactly the fields the open-questions section of
 * `client/src/components/EntityHeader.vue` renders, plus the timestamps a
 * listener might order by. Not the whole document — `entry_ids` rides at the
 * top level of the payload in one normalised shape (see below).
 */
export function questionRow(row) {
  return {
    _id: String(row._id),
    question: row.question,
    status: row.status,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

/**
 * `entry_ids` as plain string ids, whichever shape the caller holds: raw
 * ObjectIds from a `create`/`findOneAndDelete`, or documents from a populated
 * `findOneAndUpdate`.
 */
export function entryIds(row) {
  return (row?.entry_ids ?? []).map(entry => String(entry?._id ?? entry));
}

/**
 * @param {string} name  the frame name
 * @param {object} payload
 * @param {object} opts
 * @param {any}    opts.workspaceId      required; see `broadcast`
 * @param {string|null} [opts.excludeClientId]  the writer's own tab, which has the response
 * @param {string} opts.source  the write that asked for this frame, for the log
 */
function emit(name, payload, { workspaceId, excludeClientId = null, source }) {
  broadcast(name, payload, { workspaceId, excludeClientId });
  log('light', `${name} ${payload.question?._id ?? payload.questionId} → workspace ${workspaceId}${excludeClientId ? `, excluding client ${excludeClientId}` : ' (no client excluded)'} (source: ${source})`);
  log('normal', `  entry_ids: ${payload.entry_ids.length ? payload.entry_ids.join(', ') : '(none)'}`);
  log('verbose', `  row: ${JSON.stringify(payload.question)}`);
}

export function broadcastQuestionCreated(row, opts) {
  emit('question:created', { question: questionRow(row), entry_ids: entryIds(row) }, opts);
}

export function broadcastQuestionUpdated(row, opts) {
  emit('question:updated', { question: questionRow(row), entry_ids: entryIds(row) }, opts);
}

/**
 * The deleted row, mirroring `entity:deleted`: the id at the top level, because
 * that is all a listener needs to drop it, and the row itself behind it so a
 * toast can name the question that is gone. `entry_ids` is the set it was
 * linked to when it was deleted — the entities whose panels just changed.
 */
export function broadcastQuestionDeleted(row, opts) {
  emit('question:deleted', {
    questionId: String(row._id),
    question: questionRow(row),
    entry_ids: entryIds(row),
  }, opts);
}
