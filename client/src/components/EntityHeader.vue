<template>
  <div class="entity-header-wrap">
    <!-- View mode -->
    <template v-if="!isEditing">
      <div class="entity-header">
        <div class="header-top">
          <h2 class="entity-title">{{ entity.title }}</h2>
          <div class="header-right">
            <span class="entity-cat" :style="catStyle">{{ entity.category }}</span>
            <button class="icon-btn" title="Edit header" @click="startEdit"><PencilIcon /></button>
          </div>
        </div>
        <p class="entity-summary">{{ entity.summary }}</p>
        <div v-if="entity.tags?.length" class="entity-tags">
          <span
            v-for="tag in entity.tags" :key="tag"
            class="tag"
            @click="$emit('set-tag', tag)"
          >#{{ tag }}</span>
        </div>
        <div v-if="questions.length || canWrite" class="oq-list">
          <div class="oq-head">
            <span class="oq-label">Open questions</span>
            <!-- Open ones only: a resolved question is answered, and a badge
                 that kept counting it would never reach zero. -->
            <span
              v-if="openCount"
              class="oq-count"
              :title="`${openCount} unanswered`"
            >{{ openCount }}</span>
          </div>

          <!-- Above the list, not instead of it: a refused write has to leave
               the questions on screen, because the row is where the retry is. -->
          <p v-if="questionError" class="oq-error" role="alert">{{ questionError }}</p>

          <div
            v-for="oq in questions" :key="oq._id"
            class="oq-item"
            :class="{ 'oq-resolved': oq.status === 'resolved' }"
          >
            <button
              v-if="canWrite"
              type="button"
              class="oq-badge oq-badge-btn"
              :title="oq.status === 'resolved' ? 'Reopen this question' : 'Mark this question answered'"
              :disabled="pendingId === oq._id"
              @click.stop="toggleStatus(oq)"
            >{{ oq.status }}</button>
            <span v-else class="oq-badge">{{ oq.status }}</span>

            <template v-if="editingId === oq._id">
              <input
                v-model="editText"
                class="input oq-edit"
                aria-label="Question text"
                @click.stop
                @keyup.enter="commitEdit(oq)"
              />
              <button type="button" class="btn-sm" @click.stop="cancelQuestionEdit">Cancel</button>
              <button
                type="button" class="btn-sm primary"
                :disabled="!editText.trim() || pendingId === oq._id"
                @click.stop="commitEdit(oq)"
              >Save</button>
            </template>
            <template v-else>
              <span class="oq-text">{{ oq.question }}</span>

              <!-- The ✕ asks; it does not delete. `DELETE /open-questions/:id`
                   is permanent — this collection writes no ChangeLog and has no
                   rollback route — so a mis-click would destroy the question
                   outright. Inline rather than window.confirm, like the passkey
                   rows: the question stays on screen beside the choice, and the
                   other rows' controls stay usable. -->
              <template v-if="canWrite && confirmingId === oq._id">
                <span class="oq-confirm">Delete permanently?</span>
                <button
                  :ref="(el) => { if (el) confirmButton = el; }"
                  type="button" class="btn-sm danger"
                  title="Open questions keep no history, so this cannot be undone"
                  :disabled="pendingId === oq._id"
                  @click.stop="removeQuestion(oq)"
                >{{ pendingId === oq._id ? 'Deleting…' : 'Delete' }}</button>
                <button
                  type="button" class="btn-sm"
                  :disabled="pendingId === oq._id"
                  @click.stop="cancelDelete"
                >Keep</button>
              </template>
              <template v-else>
                <button
                  v-if="canWrite"
                  type="button" class="icon-btn oq-action"
                  title="Edit question"
                  :disabled="pendingId === oq._id"
                  @click.stop="startQuestionEdit(oq)"
                ><PencilIcon /></button>
                <button
                  v-if="canWrite"
                  type="button" class="icon-btn oq-action"
                  title="Delete question"
                  :disabled="pendingId === oq._id"
                  @click.stop="askDelete(oq)"
                >✕</button>
              </template>
            </template>
          </div>

          <form v-if="canWrite" class="oq-add" @submit.prevent="addQuestion">
            <input
              v-model="newQuestion"
              class="input oq-new"
              placeholder="Add a question"
              aria-label="Add a question"
              @click.stop
            />
            <button
              type="submit" class="btn-sm"
              :disabled="!newQuestion.trim() || addPending"
            >{{ addPending ? 'Adding…' : 'Add' }}</button>
          </form>
        </div>
      </div>
    </template>

    <!-- Edit mode -->
    <template v-else>
      <div class="header-edit">
        <input v-model="form.title" class="input edit-title" placeholder="Title" @click.stop />

        <div class="edit-row">
          <select v-model="form.category" class="input edit-select">
            <option v-for="cat in categoryNames" :key="cat">{{ cat }}</option>
          </select>
        </div>

        <input v-model="form.summary" class="input" placeholder="Summary" @click.stop />

        <input
          v-model="form.tagsRaw"
          class="input"
          placeholder="Tags (comma separated)"
          @click.stop
        />

        <div class="edit-actions">
          <button class="btn-sm" @click="cancelEdit">Cancel</button>
          <button class="btn-sm primary" :disabled="isSaving || !form.title.trim()" @click="save">
            <span v-if="isSaving" class="spinner" />
            <span v-else>Save</span>
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, reactive, watch, nextTick } from 'vue';
import { useEntityTypes } from '../composables/useEntityTypes.js';
import {
  createOpenQuestion,
  renameOpenQuestion,
  setOpenQuestionStatus,
  deleteOpenQuestion,
} from '../api/openQuestions.js';
import PencilIcon from './icons/PencilIcon.vue';

/**
 * The entity's header, and its open questions (KOL-104).
 *
 * The open-question list used to be static text: the questions arrive already
 * populated on `GET /entities/:id`, and nothing under `client/src` so much as
 * fetched `/open-questions`. So a reader could see what the workspace did not
 * know yet and could not add to it, and a question an agent raised through
 * `add_open_question` could never be marked answered from the UI. The four
 * routes now have a caller: api/openQuestions.js.
 *
 * The rows are held locally rather than written back through the entity: an
 * open question is its own document, and `PUT /entities/:id` has no say over
 * it. Each write renders **what came back** — the created question, the renamed
 * text, the new status — because the server is the one that decides (it drops
 * `entry_ids` outside the workspace, and could normalize or refuse the text).
 * A refused write leaves the list exactly as it was and says so above it.
 *
 * Deleting asks first (KOL-115). The delete is the one write here with nothing
 * behind it: `/open-questions` writes no ChangeLog and has no rollback route,
 * so the question and its back-links are simply gone. The ✕ therefore opens an
 * inline Delete / Keep choice on the row — the same shape PasskeySettings uses,
 * and the same promise EntityDetail and RelationshipsSection make with
 * window.confirm — and only that Delete calls the route.
 *
 * The local rows are re-seeded whenever a fresh `entity.open_questions` array
 * arrives — a reopened panel, or the populated answer to an entity save — so
 * the server's account wins over ours as soon as there is one.
 *
 * `canWrite` false renders the list as it always was, with no controls: the
 * panel also shows deleted entities' snapshots, and a question written against
 * one would be stored with no link to anything (the entity is gone, so the
 * server drops its id from `entry_ids`).
 *
 * Tiered debug logging: set localStorage.OPEN_QUESTION_LOG_LEVEL to
 * off | light | normal | verbose (default light).
 *   light   — every write: the question id, the field that changed, and what
 *             asked for it. A status write and a text write are both a
 *             `PUT /open-questions/:id` and otherwise indistinguishable after
 *             the fact. Failed writes too, with their status.
 *   normal  — light, plus every re-seed from the entity prop and its row count,
 *             and every delete that was asked for and then kept — the write
 *             that did not happen is the one a surprised reader asks about
 *   verbose — normal, plus each row as the server returned it
 */

const props = defineProps({
  entity: Object,
  /** Whether this entity's open questions can be written. See above. */
  canWrite: { type: Boolean, default: true },
});
const emit = defineEmits(['save', 'set-tag']);

const isEditing = ref(false);
const isSaving = ref(false);
const form = reactive({ title: '', category: '', summary: '', tagsRaw: '' });

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  let configured = null;
  try { configured = localStorage.getItem('OPEN_QUESTION_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((LEVELS[configured] ?? LEVELS.light) >= LEVELS[level]) console.log(`[openQuestions:${level}] ${msg}`);
}

/** This entity's questions, as the server last described them. */
const questions = ref([]);
/** The id of the question being written, or null — one write at a time per row. */
const pendingId = ref(null);
/** Whether the add field's own write is in flight. */
const addPending = ref(false);
const questionError = ref('');
/** The id of the question whose text is open in the inline editor, or null. */
const editingId = ref(null);
const editText = ref('');
const newQuestion = ref('');
/** The id of the question whose ✕ has been clicked and not yet answered, or null. */
const confirmingId = ref(null);
/**
 * The Delete button of the row being confirmed, so the keyboard can reach it:
 * the ✕ that had focus is the element the confirmation replaces, and without
 * this a keyboard user would be tabbing from the top of the page to answer.
 * One row confirms at a time, so one plain handle is enough.
 */
let confirmButton = null;

/** Only what the entity populate carries, so a row's shape never varies. */
const asRow = (q) => ({ _id: String(q._id), question: q.question, status: q.status });

// A fresh array from the server replaces ours; a re-render with the same array
// identity leaves our writes alone.
watch(() => props.entity?.open_questions, (rows) => {
  questions.value = (rows ?? []).map(asRow);
  questionError.value = '';
  editingId.value = null;
  confirmingId.value = null;
  pendingId.value = null;
  addPending.value = false;
  newQuestion.value = '';
  log('normal', `seeded ${questions.value.length} question(s) for ${props.entity?._id} (source: entity.open_questions)`);
  for (const row of questions.value) log('verbose', `${row._id} [${row.status}] ${JSON.stringify(row.question)}`);
}, { immediate: true });

/** Unanswered only — the badge's whole point. */
const openCount = computed(() => questions.value.filter(q => q.status !== 'resolved').length);

function failed(what, id, err) {
  questionError.value = err.message;
  log('light', `${what} ${id ?? '(new)'} failed: ${err.status ?? ''} ${err.message} (source: the open-questions section of ${props.entity?._id})`);
}

async function addQuestion() {
  const text = newQuestion.value.trim();
  if (!text || addPending.value) return;
  addPending.value = true;
  questionError.value = '';
  try {
    // Linked to the entity whose panel this is, which is the only entity this
    // section knows about. The server drops the id if it is not in the
    // workspace, so the question that comes back is what was actually linked.
    const created = await createOpenQuestion({ question: text, entry_ids: [props.entity._id] });
    questions.value = [...questions.value, asRow(created)];
    newQuestion.value = '';
    log('light', `created ${created._id}: question + entry_ids [${props.entity._id}] (source: the "Add a question" field)`);
    log('verbose', `server returned ${JSON.stringify(created)}`);
  } catch (err) {
    // The typed text stays in the field: the question the server refused is not
    // put on the list, and retrying should not mean typing it again.
    failed('creating a question against', props.entity?._id, err);
  } finally {
    addPending.value = false;
  }
}

function startQuestionEdit(oq) {
  editingId.value = oq._id;
  editText.value = oq.question;
  questionError.value = '';
  confirmingId.value = null;   // rewriting a question is not deleting it
}

function cancelQuestionEdit() {
  editingId.value = null;
  editText.value = '';
}

async function commitEdit(oq) {
  const text = editText.value.trim();
  if (!text || pendingId.value) return;
  if (text === oq.question) return cancelQuestionEdit();
  pendingId.value = oq._id;
  questionError.value = '';
  try {
    const saved = await renameOpenQuestion(oq._id, text);
    replaceRow(saved);
    cancelQuestionEdit();
    log('light', `updated ${oq._id}: question ${JSON.stringify(oq.question)} → ${JSON.stringify(saved.question)} (source: the pencil on that row)`);
  } catch (err) {
    // The editor stays open holding the typed text; the row keeps the old one.
    failed('rewriting question', oq._id, err);
  } finally {
    pendingId.value = null;
  }
}

async function toggleStatus(oq) {
  if (pendingId.value) return;
  const next = oq.status === 'resolved' ? 'open' : 'resolved';
  pendingId.value = oq._id;
  questionError.value = '';
  try {
    const saved = await setOpenQuestionStatus(oq._id, next);
    replaceRow(saved);
    log('light', `updated ${oq._id}: status ${oq.status} → ${saved.status} (source: the status badge on that row)`);
  } catch (err) {
    failed('changing the status of question', oq._id, err);
  } finally {
    pendingId.value = null;
  }
}

/** Opens the row's Delete / Keep choice and puts the keyboard on Delete. */
async function askDelete(oq) {
  if (pendingId.value) return;
  confirmingId.value = oq._id;
  questionError.value = '';
  log('normal', `asked whether to delete ${oq._id} (source: the ✕ on that row)`);
  await nextTick();
  confirmButton?.focus();
}

function cancelDelete() {
  log('normal', `kept ${confirmingId.value} (source: the "Keep" button on that row)`);
  confirmingId.value = null;
  confirmButton = null;
}

async function removeQuestion(oq) {
  if (pendingId.value) return;
  // The guard lives here and not only in the template: nothing may delete a
  // question the reader was not asked about, so an unconfirmed call asks.
  if (confirmingId.value !== oq._id) return askDelete(oq);
  pendingId.value = oq._id;
  questionError.value = '';
  try {
    await deleteOpenQuestion(oq._id);
    questions.value = questions.value.filter(q => q._id !== oq._id);
    if (editingId.value === oq._id) cancelQuestionEdit();
    confirmingId.value = null;
    confirmButton = null;
    log('light', `deleted ${oq._id}: the whole question ${JSON.stringify(oq.question)} (source: the confirmed Delete on that row)`);
  } catch (err) {
    // The choice stays open on the row the error names, so the retry is still
    // one click away and no other row has quietly become armed.
    failed('deleting question', oq._id, err);
  } finally {
    pendingId.value = null;
  }
}

/** Swaps one row for the server's version of it, leaving the order alone. */
function replaceRow(saved) {
  const row = asRow(saved);
  questions.value = questions.value.map(q => (q._id === row._id ? row : q));
  log('verbose', `server returned ${JSON.stringify(saved)}`);
}

const { names: categoryNames, styleFor } = useEntityTypes();

// Text colour only: this pill has never been given a background here.
const catStyle = computed(() => ({ color: styleFor(props.entity.category).color }));

function startEdit() {
  form.title = props.entity.title;
  form.category = props.entity.category;
  form.summary = props.entity.summary;
  form.tagsRaw = (props.entity.tags ?? []).join(', ');
  isEditing.value = true;
}

function cancelEdit() { isEditing.value = false; }

async function save() {
  isSaving.value = true;
  try {
    await emit('save', {
      title: form.title.trim(),
      category: form.category,
      summary: form.summary.trim(),
      tags: form.tagsRaw.split(',').map(t => t.trim()).filter(Boolean),
    });
    isEditing.value = false;
  } finally {
    isSaving.value = false;
  }
}
</script>

<style scoped>
.entity-header-wrap { padding: 20px 24px 0; }

.entity-header { display: flex; flex-direction: column; gap: 10px; }

.header-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.entity-title { font-size: 1.4rem; font-weight: 600; color: #e0e0e0; }

.header-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

.entity-summary { font-size: 14px; color: #888; line-height: 1.5; }

.entity-tags { display: flex; gap: 6px; flex-wrap: wrap; }

.oq-list { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.oq-head { display: flex; align-items: center; gap: 8px; }
.oq-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #c07020; }
.oq-count {
  min-width: 18px; padding: 0 5px; border-radius: 9px;
  background: #c07020; color: #140c00;
  font-size: 11px; font-weight: 600; line-height: 18px; text-align: center;
}
.oq-error { font-size: 12px; color: #c66; }
.oq-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; background: #2a1800; border-radius: 7px; font-size: 12px; color: #f0a040;
}
.oq-item.oq-resolved { background: #171717; color: #777; }
.oq-text { flex: 1; min-width: 0; }
.oq-badge-btn {
  border: none; border-radius: 5px; padding: 2px 6px; cursor: pointer;
  background: #3a2200; color: inherit; font-size: 11px; font-family: inherit;
}
.oq-badge-btn:hover:not(:disabled) { background: #4a2c00; }
.oq-badge-btn:disabled { cursor: default; opacity: 0.6; }
.oq-item.oq-resolved .oq-badge-btn { background: #222; }
.oq-confirm { color: #e07070; flex-shrink: 0; }
.oq-action { color: #8a6030; flex-shrink: 0; }
.oq-action:hover:not(:disabled) { color: #f0a040; }
.oq-action:disabled { cursor: default; opacity: 0.5; }
.oq-edit { flex: 1; min-width: 0; font-size: 12px; }
.oq-add { display: flex; gap: 6px; align-items: center; }
.oq-new { flex: 1; font-size: 12px; }

/* Edit mode */
.header-edit { display: flex; flex-direction: column; gap: 8px; }
.edit-title { font-size: 15px; font-weight: 500; }
.edit-row { display: flex; gap: 8px; }
.edit-select { flex: 1; }
.edit-actions { display: flex; gap: 8px; justify-content: flex-end; }

.icon-btn {
  background: none; border: none; color: #444; cursor: pointer;
  font-size: 13px; padding: 2px 4px; border-radius: 4px; transition: color 0.1s;
}
.icon-btn:hover { color: #aaa; }
</style>
