<template>
  <div class="oq-panel">
    <div class="oq-toolbar">
      <span class="oq-panel-title">Open questions</span>

      <!-- Server-side, not a filter over the rows already here: `?status=` is
           part of the query the walk below runs, so switching reloads from the
           route (see `setStatus`). Filtering the loaded page in the browser
           would show "the open questions among the ones this tab happens to
           hold", which is a different sentence. -->
      <div class="oq-filters">
        <span
          v-for="choice in STATUS_CHOICES" :key="choice.value"
          class="oq-pill"
          :class="{ active: status === choice.value }"
          role="button"
          :aria-pressed="status === choice.value"
          @click="setStatus(choice.value)"
        >{{ choice.label }}</span>
      </div>

      <span v-if="!loading" class="oq-stats">
        {{ rows.length }} question{{ rows.length === 1 ? '' : 's' }}
      </span>
      <button class="oq-panel-close" title="Close open questions (Escape)" @click="$emit('close')">✕</button>
    </div>

    <!-- A refused write stays above the list rather than replacing it: the row
         is where the retry is (the same rule EntityHeader's section follows). -->
    <p v-if="writeError" class="oq-error" role="alert">{{ writeError }}</p>

    <!-- A walk that stopped partway leaves a list that looks finished — the
         spinner is cleared after the first page — so it says so, with the
         retry that finishes it. -->
    <div v-if="loadError" class="oq-load-failed" role="status">
      <span>{{ loadError.message }}<template v-if="loadError.loaded"> Showing {{ loadError.loaded }} question{{ loadError.loaded === 1 ? '' : 's' }}.</template></span>
      <button class="oq-btn" @click="reload('the Retry button on the failed-load notice')">Retry</button>
    </div>

    <div v-if="loading" class="oq-empty">Loading…</div>

    <div v-else-if="rows.length" class="oq-scroll">
      <ul class="oq-rows">
        <li
          v-for="row in rows" :key="row._id"
          class="oq-row"
          :class="{ 'oq-row-resolved': row.status === 'resolved' }"
        >
          <!-- The write gate (KOL-150): a viewer reads the status, an editor
               changes it. `PUT /open-questions/:id` is refused for a viewer
               with 403 NOT_WORKSPACE_EDITOR, so this would be a control whose
               click can only fail. -->
          <button
            v-if="canWrite"
            type="button"
            class="oq-status oq-status-btn"
            :title="row.status === 'resolved' ? 'Reopen this question' : 'Mark this question answered'"
            :disabled="pendingId === row._id"
            @click.stop="toggleStatus(row)"
          >{{ row.status }}</button>
          <span v-else class="oq-status">{{ row.status }}</span>

          <div class="oq-row-body">
            <!-- The question is the row: a click opens the entity it is
                 attached to, through the layout's `openEntry`. A question with
                 several entities names them all below, each its own way in. -->
            <button
              v-if="row.entities.length"
              type="button"
              class="oq-question oq-question-btn"
              :title="`Open ${row.entities[0].title}`"
              @click="open(row.entities[0])"
            >{{ row.question }}</button>
            <span v-else class="oq-question">{{ row.question }}</span>

            <div class="oq-attached">
              <button
                v-for="entity in row.entities" :key="entity._id"
                type="button"
                class="oq-entity"
                :title="`Open ${entity.title}`"
                @click.stop="open(entity)"
              >{{ entity.title }}</button>
              <!-- Possible: `POST /open-questions` takes an empty `entry_ids`,
                   and the server drops ids outside the workspace. Said rather
                   than left as an empty line, because this row is the only
                   place in the product such a question is visible at all. -->
              <span v-if="!row.entities.length" class="oq-unattached">Not attached to an entity</span>
            </div>
          </div>
        </li>
      </ul>
    </div>

    <!-- Three different nothings, and they want different answers: a status
         filter that matched nothing wants the filter cleared, a failed first
         page wants a retry (above), and a workspace with no questions at all
         wants to be told what would put one here. -->
    <div v-else-if="status !== 'all'" class="oq-empty">
      <p class="oq-empty-title">No {{ status }} questions</p>
      <p class="oq-empty-body">Nothing in this workspace is marked {{ status }}.</p>
      <button class="oq-btn" @click="setStatus('all')">Show all questions</button>
    </div>
    <div v-else-if="!loadError" class="oq-empty">
      <p class="oq-empty-title">Nothing unanswered here</p>
      <p class="oq-empty-body">
        An open question is what the graph does not know yet. Add one from an entity's panel, or let
        an AI client raise one while it reads — they all collect here.
      </p>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { getOpenQuestionPage, setOpenQuestionStatus, QUESTION_PAGE_SIZE } from '../api/openQuestions.js';

/**
 * The workspace's open questions, in one place (KOL-152).
 *
 * `GET /open-questions` has answered the whole workspace's questions
 * newest-first, with `?status=` and a bare-id cursor, since KOL-092, and
 * `getOpenQuestionPage` has wrapped it since KOL-104 — with no caller at all.
 * Questions were reachable one entity at a time, through the section in
 * `EntityHeader.vue` that renders the `open_questions` arriving populated on
 * `GET /entities/:id`. So the product's answer to "what is still unanswered in
 * here" was to open every entity in turn. On a graph an agent maintains, the
 * list of what the graph does not know yet is a first-class view.
 *
 * Four things this panel is deliberately *not*:
 *
 *   **Not a second filter over a list the browser holds.** The status pills
 *   re-run the query (`setStatus` → `load`), because the route filters and a
 *   filter applied here would narrow whatever pages happened to have arrived.
 *
 *   **Not a one-page view.** It walks pages exactly as the sidebar walks
 *   entities (`composables/useEntities.js`): append, paint after the *first*
 *   page, and a page that fails keeps what arrived and says so, because a walk
 *   that stops halfway leaves a list indistinguishable from a complete one.
 *
 *   **Not a refetcher.** The three `question:*` frames KOL-116 broadcasts carry
 *   the row and the ids it links to, which is enough to move, drop or insert a
 *   row in place — so a question answered in another tab arrives here without a
 *   request. `applyFrame` is what the layout hands them to.
 *
 *   **Not a writer of anything but `status`.** Creating a question needs an
 *   entity picker (every question is attached to at least one entity), and
 *   rewriting one belongs where it is read in context. Resolve and reopen are
 *   the two writes a list of unanswered things is actually for, and they go
 *   through `setOpenQuestionStatus`, the single-field `PUT` (KOL-104).
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * localStorage.OPEN_QUESTION_PANEL_LOG_LEVEL = off | light | normal | verbose
 * (default light). Nothing here is visible after the fact: a row that moved
 * could have moved because of a frame, a write of this tab's own, or a reload,
 * and a row that is missing could be a dropped page or a filter.
 *   light   — every change to the list that did not come from a plain page
 *             (each frame applied and what it did, each status write and how it
 *             ended, each failed page), always naming what caused it
 *   normal  — light, plus every load and page that landed with its source, and
 *             every page discarded because a newer load took the list
 *   verbose — normal, plus the row ids each page brought, in order
 */

const props = defineProps({
  /**
   * Whether this session may write in the workspace (KOL-150). False for a
   * viewer: the status badge is text rather than a button, since the route
   * refuses the write with 403 NOT_WORKSPACE_EDITOR.
   */
  canWrite: { type: Boolean, default: true },
  /**
   * The entity list the layout already holds, used to name an entity a *frame*
   * links a question to — `entry_ids` on a frame is always bare string ids
   * (KOL-116), while the ids on a loaded row arrive populated. Handed in rather
   * than fetched, exactly as the Tags group takes it.
   */
  entities: { type: Array, default: () => [] },
});

const emit = defineEmits(['close', 'open-entry']);

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  let configured = null;
  try { configured = localStorage.getItem('OPEN_QUESTION_PANEL_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((LEVELS[configured] ?? LEVELS.light) >= LEVELS[level]) console.log(`[questionPanel:${level}] ${msg}`);
}

/** The pills, and the only three queries this panel runs. */
const STATUS_CHOICES = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
];

const SESSION_EXPIRED = 'Your session has expired. Sign in again to see the rest of your questions.';
const LOAD_FAILED = 'Some of this workspace’s questions could not be loaded.';

/** The questions on screen, newest first — the order the route answers in. */
const rows = ref([]);
/** Which pill is down; `'all'` sends no `?status=` at all. */
const status = ref('all');
const loading = ref(true);
/** `{ message, loaded }` when a page of the walk failed, null otherwise. */
const loadError = ref(null);
/** What a refused status write said, or ''. */
const writeError = ref('');
/** The id of the question whose status is being written, or null. */
const pendingId = ref(null);

/**
 * Which `load` run owns `rows`. A load is several requests and three things
 * start one — the mount, a pill, the retry — so two can overlap; without this
 * the slower run's later pages would append onto the faster run's list and the
 * same question would be listed twice under the wrong filter.
 */
let loadToken = 0;

/** The entity this question is attached to, as a row can name it. */
function entityFor(link) {
  if (link && typeof link === 'object' && link._id) {
    return { _id: String(link._id), title: link.title ?? titleFor(String(link._id)) };
  }
  const id = String(link);
  return { _id: id, title: titleFor(id) };
}

/**
 * An entity's title from the list the layout holds. Only a frame needs this —
 * its `entry_ids` are bare ids — and an id the sidebar has not loaded yet is
 * still a working way in, so it gets a label rather than being dropped.
 */
function titleFor(id) {
  return props.entities.find((e) => String(e._id) === id)?.title ?? 'An entity';
}

/**
 * A question as this panel renders it. `links` overrides the row's own
 * `entry_ids` for a frame, which carries them separately.
 */
function asRow(question, links = null) {
  return {
    _id: String(question._id),
    question: question.question,
    status: question.status,
    entities: (links ?? question.entry_ids ?? []).map(entityFor),
  };
}

/** Whether a row with this status belongs under the pill that is down. */
const matchesFilter = (rowStatus) => status.value === 'all' || rowStatus === status.value;

/** What `?status=` the query carries: nothing under "All". */
const queryStatus = () => (status.value === 'all' ? null : status.value);

/**
 * The workspace's questions, a page at a time.
 *
 * Shaped on `loadEntities` (`composables/useEntities.js`): append, clear
 * `loading` after the first page so the list paints while the rest arrives, and
 * record a failed page instead of throwing — there is no caller above to catch
 * one, and the rows that did arrive are worth keeping.
 *
 * A server from before KOL-092's cap answers the bare array however it is
 * asked; the client and the API deploy independently (Netlify and Railway), so
 * a browser on this build can be talking to an older API. Then the array is the
 * whole answer and there is nothing to page.
 */
async function load(source) {
  const token = ++loadToken;
  const asked = queryStatus();
  loading.value = true;
  loadError.value = null;
  writeError.value = '';
  const collected = [];
  let after = null;
  let pageNo = 0;

  try {
    do {
      const page = await getOpenQuestionPage({ status: asked, limit: QUESTION_PAGE_SIZE, after });
      if (token !== loadToken) {
        log('normal', `discarded page ${pageNo + 1} of the load from ${source}: a newer load owns the list`);
        return;
      }
      pageNo += 1;

      if (Array.isArray(page)) {
        rows.value = page.map((q) => asRow(q));
        loading.value = false;
        log('normal', `load from ${source}: an unpaged bare array of ${page.length} question(s) — an API from before the page cap`);
        return;
      }

      collected.push(...page.items.map((q) => asRow(q)));
      // Replaced rather than mutated, so the list repaints on the new array.
      rows.value = [...collected];
      loading.value = false;
      after = page.nextAfter;
      log('normal', `load from ${source}: page ${pageNo} brought ${page.items.length} question(s), ${collected.length} on screen, next ${after ?? '(none)'}`);
      log('verbose', `load from ${source}: page ${pageNo} ids: ${page.items.map((q) => q._id).join(', ')}`);
    } while (after);

    log('normal', `load from ${source} finished: ${collected.length} question(s) over ${pageNo} page(s), status ${asked ?? '(any)'}`);
  } catch (err) {
    if (token !== loadToken) {
      log('normal', `ignored a failed page ${pageNo + 1} from the load from ${source}: a newer load owns the list (${err.message})`);
      return;
    }
    loadError.value = {
      message: err.status === 401 ? SESSION_EXPIRED : LOAD_FAILED,
      loaded: collected.length,
    };
    log('light', `load from ${source} failed on page ${pageNo + 1} with ${collected.length} question(s) on screen: ${err.status ?? 'no status'} ${err.message}`);
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

/** Awaitable, and exposed, so the layout and the retry can both ask for one. */
function reload(source = 'a reload') {
  return load(source);
}

/**
 * A pill. The query changes, so the list is re-read from the route rather than
 * narrowed here — see the template.
 */
function setStatus(next) {
  if (next === status.value) return;
  const from = status.value;
  status.value = next;
  log('normal', `status filter ${from} → ${next} (source: a status pill); re-querying the route`);
  return load(`the status filter set to ${next}`);
}

function open(entity) {
  log('normal', `opening ${entity._id} "${entity.title}" (source: a click on its question row)`);
  emit('open-entry', entity._id, entity.title);
}

/**
 * Resolve or reopen, in place. The row is replaced with **what came back**: the
 * server decides what the write did, and `setOpenQuestionStatus` sends `status`
 * alone so a stale question text on screen cannot ride along with it (KOL-104).
 *
 * A question that no longer matches the pill that is down leaves the list — it
 * is no longer part of the answer to the query this panel is showing.
 */
async function toggleStatus(row) {
  if (pendingId.value) return;
  const next = row.status === 'resolved' ? 'open' : 'resolved';
  pendingId.value = row._id;
  writeError.value = '';
  try {
    const saved = await setOpenQuestionStatus(row._id, next);
    const savedRow = asRow(saved);
    if (matchesFilter(savedRow.status)) {
      rows.value = rows.value.map((r) => (r._id === savedRow._id ? savedRow : r));
      log('light', `updated ${row._id}: status ${row.status} → ${savedRow.status} (source: the status badge on that row)`);
    } else {
      rows.value = rows.value.filter((r) => r._id !== savedRow._id);
      log('light', `updated ${row._id}: status ${row.status} → ${savedRow.status}, and dropped from the list (source: the status badge on that row; the "${status.value}" filter no longer matches it)`);
    }
  } catch (err) {
    writeError.value = err.status === 401
      ? 'Your session has expired. Sign in again to change a question.'
      : err.message;
    log('light', `changing the status of ${row._id} to ${next} failed: ${err.status ?? 'no status'} ${err.message} (source: the status badge on that row)`);
  } finally {
    pendingId.value = null;
  }
}

/**
 * A `question:*` frame from another tab or an AI client, applied to the list
 * without a request (KOL-116's payload is what makes that possible: the row,
 * plus the bare ids it links to).
 *
 * The frame is applied **against the pill that is down**, which is the only way
 * this list can stay the answer to the query it ran: a question resolved
 * elsewhere leaves an "Open" list, one reopened joins it, and the newest-first
 * order the route answers in puts a created question at the top — its `_id` is
 * the largest, and `_id` descending is the route's sort.
 *
 * @param {'question:created'|'question:updated'|'question:deleted'} frame
 * @param {{ question?: object, questionId?: string, entry_ids?: string[] }} payload
 */
function applyFrame(frame, payload = {}) {
  const id = String(payload.questionId ?? payload.question?._id ?? '');
  if (!id) {
    log('light', `dropped a ${frame} frame naming no question (source: the /events stream)`);
    return;
  }
  const held = rows.value.some((r) => r._id === id);

  if (frame === 'question:deleted') {
    if (!held) return log('normal', `${frame} for ${id}: not listed here, nothing to drop (source: the /events stream)`);
    rows.value = rows.value.filter((r) => r._id !== id);
    return log('light', `dropped ${id} from the list (source: a ${frame} frame)`);
  }

  if (!payload.question) {
    log('light', `dropped a ${frame} frame for ${id} carrying no row (source: the /events stream)`);
    return;
  }
  const row = asRow(payload.question, payload.entry_ids);
  log('verbose', `${frame} frame for ${id}: ${JSON.stringify(payload.question)} on [${(payload.entry_ids ?? []).join(', ')}]`);

  if (!matchesFilter(row.status)) {
    if (!held) return log('normal', `${frame} for ${id}: status "${row.status}" is outside the "${status.value}" filter (source: the /events stream)`);
    rows.value = rows.value.filter((r) => r._id !== id);
    return log('light', `dropped ${id} from the list: its status is now "${row.status}", outside the "${status.value}" filter (source: a ${frame} frame)`);
  }

  if (held) {
    rows.value = rows.value.map((r) => (r._id === id ? row : r));
    return log('light', `moved ${id} in place: status "${row.status}", ${row.entities.length} entity(ies) (source: a ${frame} frame)`);
  }
  // Newest first, so a question this list has not seen goes to the top. On a
  // `question:updated` that means one whose status just joined the filter.
  rows.value = [row, ...rows.value];
  log('light', `added ${id} at the top of the list: status "${row.status}" (source: a ${frame} frame)`);
}

onMounted(() => load('the open-question panel opening'));

defineExpose({ applyFrame, reload });
</script>

<style scoped>
/* The same layer family as the graph overlay, one step over it: both are
   full-view overlays inside the layout, and the Escape order in WikiLayout is
   this stacking order (settings is 600, the cheatsheet 700). */
.oq-panel {
  position: absolute;
  inset: 0;
  z-index: 550;
  display: flex;
  flex-direction: column;
  background: #0a0a0a;
}

.oq-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid #1e1e1e;
  background: #0f0f0f;
}

.oq-panel-title { font-size: 13px; font-weight: 600; color: #ccc; }
.oq-stats { margin-left: auto; font-size: 11px; color: #555; }

.oq-panel-close {
  flex-shrink: 0;
  background: none;
  border: none;
  color: #666;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 4px;
}
.oq-panel-close:hover { color: #ccc; }

.oq-filters { display: flex; gap: 5px; }

.oq-pill {
  padding: 3px 10px;
  font-size: 11px;
  color: #888;
  background: #161616;
  border: 1px solid #262626;
  border-radius: 999px;
  cursor: pointer;
  user-select: none;
}
.oq-pill:hover { color: #ccc; }
.oq-pill.active { color: #0a0a0a; background: #9aa7b4; border-color: #9aa7b4; }

.oq-error {
  margin: 0;
  padding: 8px 16px;
  font-size: 12px;
  color: #e07070;
  background: #1c1212;
  border-bottom: 1px solid #3a2020;
}

.oq-load-failed {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  font-size: 12px;
  line-height: 1.4;
  color: #e0c070;
  background: #1a1508;
  border-bottom: 1px solid #332a10;
}

.oq-scroll { flex: 1; min-height: 0; overflow-y: auto; }

.oq-rows { list-style: none; margin: 0; padding: 8px 0; display: flex; flex-direction: column; }

.oq-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid #141414;
}
.oq-row:hover { background: #101010; }
.oq-row-resolved .oq-question { color: #666; text-decoration: line-through; }

.oq-status {
  flex: 0 0 auto;
  margin-top: 1px;
  padding: 2px 8px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #c9a227;
  background: #1a1508;
  border: 1px solid #332a10;
  border-radius: 999px;
}
.oq-row-resolved .oq-status { color: #6a8a6a; background: #0f1a0f; border-color: #1e331e; }

.oq-status-btn { cursor: pointer; font-family: inherit; }
.oq-status-btn:hover:not(:disabled) { filter: brightness(1.4); }
.oq-status-btn:disabled { opacity: 0.4; cursor: default; }

.oq-row-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }

.oq-question {
  font-size: 13px;
  line-height: 1.5;
  color: #d0d0d0;
  text-align: left;
}
.oq-question-btn {
  padding: 0;
  background: none;
  border: none;
  font-family: inherit;
  cursor: pointer;
}
.oq-question-btn:hover { color: #fff; }

.oq-attached { display: flex; flex-wrap: wrap; gap: 5px; }

.oq-entity {
  padding: 1px 7px;
  font-size: 11px;
  font-family: inherit;
  color: #8a9aa8;
  background: #121a20;
  border: 1px solid #1e2a33;
  border-radius: 4px;
  cursor: pointer;
}
.oq-entity:hover { color: #cfe0ec; border-color: #2e4150; }

.oq-unattached { font-size: 11px; font-style: italic; color: #555; }

.oq-empty {
  padding: 40px 20px;
  color: #444;
  font-size: 13px;
  text-align: center;
}
.oq-empty-title { margin: 0 0 6px; color: #888; font-size: 14px; font-weight: 600; }
.oq-empty-body { margin: 0 auto 14px; max-width: 320px; color: #555; line-height: 1.5; }

.oq-btn {
  flex-shrink: 0;
  padding: 5px 10px;
  background: none;
  border: 1px solid #2a2a2a;
  border-radius: 6px;
  color: #aaa;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}
.oq-btn:hover { background: #1a1a1a; }
</style>
