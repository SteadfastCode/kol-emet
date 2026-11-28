<template>
  <div class="type-settings">
    <p class="type-note">
      The entity types this workspace can use: every entity carries one, and these are the pills
      and the picker entries. Renaming a type moves every entity that holds it, and each move is
      recorded in that entity's history. A type nothing uses can be removed; one still in use
      cannot.
    </p>

    <p v-if="!rows.length" class="type-note">No entity types yet.</p>
    <ul v-else class="type-list">
      <li v-for="t in rows" :key="t._id" class="type-item">
        <!-- The swatch is the *stored* row, so it still reads the old name while an edit is open
             or after one was refused: the screen never shows a change that did not land. -->
        <span class="type-pill" :style="pillStyle(t)">{{ t.icon ? `${t.icon} ` : '' }}{{ t.name }}</span>

        <form v-if="editingId === t._id" class="type-edit" @submit.prevent="save(t)">
          <input
            v-model="draft.name"
            class="type-input"
            type="text"
            :aria-label="`Name of ${t.name}`"
            :disabled="!!busy"
          />
          <input
            v-model="draft.icon"
            class="type-input type-input-icon"
            type="text"
            maxlength="4"
            :aria-label="`Icon for ${t.name}`"
            :disabled="!!busy"
          />
          <input
            v-model="draft.bg"
            class="type-swatch-input"
            type="color"
            :aria-label="`Background colour for ${t.name}`"
            :disabled="!!busy"
          />
          <input
            v-model="draft.text"
            class="type-swatch-input"
            type="color"
            :aria-label="`Text colour for ${t.name}`"
            :disabled="!!busy"
          />
          <input
            v-model="draft.order"
            class="type-input type-input-order"
            type="number"
            :aria-label="`Order of ${t.name}`"
            :disabled="!!busy"
          />
          <button type="submit" class="mini" :disabled="!!busy || !draft.name.trim()">
            {{ busy === t._id ? 'Saving…' : 'Save' }}
          </button>
          <button type="button" class="mini" :disabled="!!busy" @click="reset">Cancel</button>
        </form>
        <template v-else>
          <div class="type-info">
            <span class="type-name">{{ t.name }}</span>
            <span class="type-meta">order {{ t.order ?? 0 }}</span>
          </div>
          <div v-if="canWrite && confirmingId === t._id" class="type-actions">
            <button type="button" class="mini danger" :disabled="!!busy" @click="remove(t)">
              {{ busy === t._id ? 'Removing…' : 'Remove' }}
            </button>
            <button type="button" class="mini" :disabled="!!busy" @click="reset">Keep</button>
          </div>
          <div v-else-if="canWrite" class="type-actions">
            <button type="button" class="mini" :disabled="!!busy" @click="startEdit(t)">Edit</button>
            <button type="button" class="mini" :disabled="!!busy" @click="startRemove(t)">Remove</button>
          </div>
        </template>

        <!-- Both beside the row they are about (KOL-150): a refusal is shown where it happened,
             and the near-duplicate warning is a warning, not an error — that type was created. -->
        <p v-if="rowError.id === t._id" class="type-error" role="alert">{{ rowError.message }}</p>
        <p v-if="warning.id === t._id" class="type-warning" role="status">{{ warning.message }}</p>
      </li>
    </ul>

    <form v-if="canWrite" class="type-add" @submit.prevent="add">
      <input
        v-model="newName"
        class="type-input"
        type="text"
        placeholder="New entity type"
        aria-label="New entity type name"
        :disabled="!!busy"
      />
      <button type="submit" class="mini" :disabled="!!busy || !newName.trim()">
        {{ busy === ADDING ? 'Adding…' : 'Add' }}
      </button>
    </form>

    <p v-if="addError" class="type-error" role="alert">{{ addError }}</p>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { createEntityType, updateEntityType, deleteEntityType } from '../api/entityTypes.js';
import { useEntityTypes } from '../composables/useEntityTypes.js';

/**
 * The Entity types group in Settings (KOL-158) — the registry's only screen.
 *
 * Phase 6 dropped `Entity.category`'s hardcoded enum so that a workspace could
 * have a vocabulary of its own, which `docs/roadmap.md` calls the change that
 * "unblocks every vertical". The server finished that work: `/entity-types`
 * lists, creates, renames (with KOL-151's audited, bounded cascade behind it)
 * and deletes. The browser had **one** of those four verbs —
 * `getEntityTypes` — so a workspace's vocabulary was whatever its template
 * seeded, and the only client that could change it was an MCP connector.
 *
 * Four decisions are in here:
 *
 *   **The list is the shared registry, not a fetch of its own.** `useEntityTypes`
 *   holds one module-level copy that the pills, the category pickers and every
 *   category colour already read, and the three `entity-type:*` frames keep it
 *   honest. So this group asks for nothing when it opens, and every write it
 *   makes patches that one list — which repaints the pills in the layout behind
 *   Settings without a refetch. The *order* is computed here rather than taken
 *   from the array, so the screen's rows are in the order the server would give
 *   them (`order`, then name) whatever order a load or a frame left behind.
 *
 *   **Every refusal is shown where it happened** (KOL-150's rule). This
 *   registry refuses in sentences a person has to read to recover: the in-use
 *   409 names the entities and relationship types still holding the type, the
 *   last-type 409 says a workspace keeps at least one, and the 413 names the
 *   count and the limit. Each of those lands beside the row it is about, and
 *   the row goes on showing its **stored** name — a refused rename must not
 *   leave the new name on screen, which would read as a change that landed.
 *
 *   **The near-duplicate `warning` is a warning.** `POST /entity-types` creates
 *   the type *and* says a similar name exists, so showing that as an error
 *   would claim nothing happened. It renders in its own class beside the row
 *   that was created.
 *
 *   **A refused write keeps the editor open** with what was typed, the
 *   convention KOL-156 settled for the entity editors: an editor wrongly left
 *   open costs a click on Cancel, one wrongly closed costs everything typed
 *   into it.
 *
 * Gated on `canWrite`: a viewer gets the list and no control at all, because
 * `requireWriteRole` refuses all three writes with 403 (KOL-150).
 *
 * Out of scope, and deliberately: drag-to-reorder (the `order` number is
 * editable), icon artwork (the field takes whatever character a user pastes),
 * a field schema per type, and reassigning entities when a type is deleted —
 * the 409 stands.
 *
 * Tiered debug logging: set localStorage.ENTITY_TYPE_LOG_LEVEL to
 * off | light | normal | verbose (default light) — the same key the shared
 * registry and the server's own route use, so one setting narrates a write end
 * to end.
 *   light   — every write sent from here and how it ended, naming the control
 *             that started it and, for a refusal, the status and the server's
 *             own sentence
 *   normal  — light, plus the patch a save actually sent (a save that posts
 *             nothing because nothing changed is the quiet failure here), and
 *             each row the list was built from
 *   verbose — normal, plus the colours and icons per row
 */

const props = defineProps({
  /** The write gate, derived once in WikiLayout (KOL-150). */
  canWrite: { type: Boolean, default: true },
});

/**
 * `changed` fires only for a write that moved entities — a rename cascade — and
 * carries both names, so the layout can refetch its entity list and move a
 * category filter standing on the old name. A create moves nothing, and a
 * delete is refused while anything uses the type, so neither needs it.
 */
const emit = defineEmits(['changed']);

const { types, applyEntityTypeUpdate, applyEntityTypeCreated, applyEntityTypeDeleted } = useEntityTypes();

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  let configured = null;
  try { configured = localStorage.getItem('ENTITY_TYPE_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((LEVELS[configured] ?? LEVELS.light) >= LEVELS[level]) console.log(`[entityTypes/settings:${level}] ${msg}`);
}

/** What a row with no colour of its own is painted with — `useEntityTypes`' fallback. */
const FALLBACK_BG = '#333333';
const FALLBACK_TEXT = '#aaaaaa';

/** `busy` while the add form is in flight; no type's id can collide with it. */
const ADDING = '__adding__';

const editingId    = ref(null);   // the type whose edit form is open
const confirmingId = ref(null);   // the type whose Remove is armed
const draft        = ref({ name: '', icon: '', bg: FALLBACK_BG, text: FALLBACK_TEXT, order: 0 });
const newName      = ref('');
const busy         = ref(null);   // null, or the id a request is in flight for
const rowError     = ref({ id: null, message: '' });
const warning      = ref({ id: null, message: '' });
const addError     = ref('');

const SESSION_EXPIRED = 'Your session has expired. Sign in again to manage entity types.';

/** The rows as the server would order them: `order`, then name. */
const rows = computed(() => {
  const list = [...types.value].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name)),
  );
  log('normal', `${list.length} entity type(s) (source: the shared registry in useEntityTypes)`);
  log('verbose', `rows: ${list.map(t => `${t.name}[order ${t.order ?? 0}, icon ${t.icon ?? 'none'}, ${t.color?.bg ?? 'no bg'}/${t.color?.text ?? 'no text'}]`).join(', ') || 'none'}`);
  return list;
});

function pillStyle(t) {
  return { background: t.color?.bg || FALLBACK_BG, color: t.color?.text || FALLBACK_TEXT };
}

function reset() {
  editingId.value = null;
  confirmingId.value = null;
  rowError.value = { id: null, message: '' };
}

function startEdit(t) {
  reset();
  warning.value = { id: null, message: '' };
  editingId.value = t._id;
  draft.value = {
    name: t.name,
    icon: t.icon ?? '',
    // The colour the row is *painted* with, so leaving the picker alone sends
    // no colour at all rather than writing the fallback as a choice.
    bg: t.color?.bg || FALLBACK_BG,
    text: t.color?.text || FALLBACK_TEXT,
    order: t.order ?? 0,
  };
}

function startRemove(t) {
  reset();
  warning.value = { id: null, message: '' };
  confirmingId.value = t._id;
}

/**
 * What a refusal says. The 409s, the 413 and a 400 are the server's own
 * sentences and each names what the caller needs — "3 entities use
 * \"Characters\"", "a workspace keeps at least one entity type" — so they are
 * shown as written; a 403 is the write gate, and anything else is a fallback.
 */
function messageFor(err, verb) {
  if (err.status === 401) return SESSION_EXPIRED;
  if (err.status === 403) return 'You do not have permission to change this workspace\'s entity types.';
  if ([400, 404, 409, 413].includes(err.status)) return err.message;
  return `Could not ${verb} the entity type. Please try again.`;
}

function failed(id, err, verb, source) {
  log('light', `${verb} failed: ${err.status ?? 'no status'} ${err.message} (source: ${source})`);
  rowError.value = { id, message: messageFor(err, verb) };
}

/** The fields of `draft` that differ from the stored row — a patch, or null. */
function patchFor(t) {
  const patch = {};
  const name = draft.value.name.trim();
  if (name && name !== t.name) patch.name = name;

  const icon = String(draft.value.icon ?? '').trim();
  const storedIcon = t.icon ?? '';
  if (icon !== storedIcon) patch.icon = icon || null;

  const color = {};
  if (draft.value.bg !== (t.color?.bg || FALLBACK_BG)) color.bg = draft.value.bg;
  if (draft.value.text !== (t.color?.text || FALLBACK_TEXT)) color.text = draft.value.text;
  if (Object.keys(color).length) patch.color = color;

  const order = Number(draft.value.order);
  if (Number.isFinite(order) && order !== (t.order ?? 0)) patch.order = order;

  return Object.keys(patch).length ? patch : null;
}

async function save(t) {
  const patch = patchFor(t);
  if (!patch) {
    log('light', `nothing to save for "${t.name}" (source: Settings → Entity types → Save, with no field changed)`);
    reset();
    return;
  }

  rowError.value = { id: null, message: '' };
  warning.value = { id: null, message: '' };
  busy.value = t._id;
  log('normal', `saving "${t.name}": ${JSON.stringify(patch)} (source: Settings → Entity types → Save)`);
  try {
    const updated = await updateEntityType(t._id, patch);
    // The writing tab is excluded from its own frame, so it applies the row it
    // was answered with — which is what repaints the pills behind Settings.
    // `relabelled` is this response's own report of the cascade, not part of
    // the row, so it does not go into the shared registry.
    const { relabelled, ...row } = updated ?? {};
    applyEntityTypeUpdate(row, 'Settings → Entity types → Save');
    const moved = relabelled?.entities ?? 0;
    log('light', `saved "${t.name}"${patch.name ? ` → "${patch.name}", moving ${moved} entit${moved === 1 ? 'y' : 'ies'}` : ''} (source: Settings → Entity types → Save)`);
    reset();
    // A rename is the only one of these writes that touches entities.
    if (patch.name) emit('changed', { from: t.name, to: updated?.name ?? patch.name });
  } catch (err) {
    // The form stays open with what was typed (KOL-156), and the row above it
    // still shows the stored name: nothing changed, and the screen says so.
    failed(t._id, err, 'save', 'Settings → Entity types → Save');
  } finally {
    busy.value = null;
  }
}

async function remove(t) {
  rowError.value = { id: null, message: '' };
  warning.value = { id: null, message: '' };
  busy.value = t._id;
  try {
    await deleteEntityType(t._id);
    applyEntityTypeDeleted(t._id, 'Settings → Entity types → Remove');
    log('light', `removed "${t.name}" (source: Settings → Entity types → Remove)`);
    reset();
  } catch (err) {
    // The row stays, which is the truth: an in-use type and a workspace's last
    // type are both still there, and the sentence beside it says why.
    failed(t._id, err, 'remove', 'Settings → Entity types → Remove');
  } finally {
    busy.value = null;
  }
}

async function add() {
  const name = newName.value.trim();
  if (!name) return;

  reset();
  addError.value = '';
  warning.value = { id: null, message: '' };
  busy.value = ADDING;
  try {
    const created = await createEntityType({ name });
    // As in `save`: `warning` is about this request, not a field of the row.
    const { warning: similar, ...row } = created ?? {};
    applyEntityTypeCreated(row, 'Settings → Entity types → Add');
    newName.value = '';
    // The type *was* created; a similar name is a warning beside its new row.
    if (similar) warning.value = { id: row._id, message: similar };
    log('light', `added "${row.name ?? name}"${similar ? ` with a warning: ${similar}` : ''} (source: Settings → Entity types → Add)`);
  } catch (err) {
    log('light', `adding "${name}" failed: ${err.status ?? 'no status'} ${err.message} (source: Settings → Entity types → Add)`);
    addError.value = messageFor(err, 'add');
  } finally {
    busy.value = null;
  }
}
</script>

<style scoped>
.type-settings { display: flex; flex-direction: column; gap: 8px; }

.type-note    { font-size: 12px; color: #777; line-height: 1.5; margin: 0; }
.type-error   { font-size: 12px; color: #e07070; margin: 0; width: 100%; }
.type-warning { font-size: 12px; color: #d9a742; margin: 0; width: 100%; }

.type-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }

.type-item {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 12px;
  background: #111;
  border: 1px solid #1e1e1e;
  border-radius: 8px;
}

.type-pill {
  flex-shrink: 0;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.type-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.type-name { font-size: 14px; color: #ccc; overflow-wrap: anywhere; }
.type-meta { font-size: 12px; color: #777; }

.type-actions { display: flex; gap: 6px; }

.type-edit,
.type-add { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; flex: 1; min-width: 0; }

.type-input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  background: #0b0b0b;
  border: 1px solid #2a2a2a;
  border-radius: 6px;
  color: #ccc;
  font-size: 14px;
  font-family: inherit;
}
.type-input:focus { outline: none; border-color: #3a3a3a; }
.type-input-icon  { flex: 0 0 46px; text-align: center; }
.type-input-order { flex: 0 0 72px; }

.type-swatch-input {
  flex: 0 0 32px;
  height: 30px;
  padding: 2px;
  background: #0b0b0b;
  border: 1px solid #2a2a2a;
  border-radius: 6px;
  cursor: pointer;
}

.mini {
  flex-shrink: 0;
  padding: 6px 10px;
  background: none;
  border: 1px solid #2a2a2a;
  border-radius: 6px;
  color: #aaa;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}
.mini:hover:not(:disabled) { background: #1a1a1a; }
.mini:disabled { opacity: 0.4; cursor: default; }
.mini.danger { color: #e07070; border-color: #3a1a1a; }
</style>
