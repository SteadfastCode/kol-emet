<template>
  <div class="rtype-settings">
    <p class="rtype-note">
      The label vocabulary this workspace offers wherever a relationship label is typed. A
      <strong>group label</strong> names the whole relationship — "Marriage", "Depends on" — and a
      <strong>member role</strong> names one end of it — "Wife", "Dependency". The generator writes
      its edges from this list too. Renaming a type changes what is offered from now on; labels
      already stored on groups and members keep the words they were given.
    </p>

    <p v-if="loading" class="rtype-note">Loading…</p>
    <p v-else-if="loadError" class="rtype-error" role="alert">
      {{ loadError }}
      <!-- Not gated on `canWrite`: reading the vocabulary is not a write, and a viewer
           whose first load failed needs the retry as much as an editor does. -->
      <button type="button" class="mini" @click="load('Retry')">Retry</button>
    </p>
    <p v-else-if="!rows.length" class="rtype-note">No relationship types yet.</p>

    <ul v-if="rows.length" class="rtype-list">
      <li v-for="t in rows" :key="t._id" class="rtype-item">
        <!-- The badge is the *stored* row, so it still reads the old name and scope while an edit
             is open or after one was refused: the screen never shows a change that did not land. -->
        <span class="rtype-scope" :class="t.scope === 'group' ? 'is-group' : 'is-member'">
          {{ SCOPE_LABELS[t.scope] ?? SCOPE_LABELS.member }}
        </span>

        <form v-if="editingId === t._id" class="rtype-edit" @submit.prevent="save(t)">
          <input
            v-model="draft.name"
            class="rtype-input"
            type="text"
            :aria-label="`Name of ${t.name}`"
            :disabled="!!busy"
          />
          <select
            v-model="draft.scope"
            class="rtype-input rtype-select"
            :aria-label="`Where ${t.name} is offered`"
            :disabled="!!busy"
          >
            <option v-for="s in SCOPES" :key="s" :value="s">{{ SCOPE_LABELS[s] }}</option>
          </select>
          <button type="submit" class="mini" :disabled="!!busy || !draft.name.trim()">
            {{ busy === t._id ? 'Saving…' : 'Save' }}
          </button>
          <button type="button" class="mini" :disabled="!!busy" @click="reset">Cancel</button>
        </form>
        <template v-else>
          <div class="rtype-info">
            <span class="rtype-name">{{ t.name }}</span>
            <span v-if="t.sourceCategory || t.targetCategory" class="rtype-meta">
              {{ t.sourceCategory ?? 'any' }} → {{ t.targetCategory ?? 'any' }}
            </span>
          </div>
          <div v-if="canWrite && confirmingId === t._id" class="rtype-actions">
            <button type="button" class="mini danger" :disabled="!!busy" @click="remove(t)">
              {{ busy === t._id ? 'Removing…' : 'Remove' }}
            </button>
            <button type="button" class="mini" :disabled="!!busy" @click="reset">Keep</button>
          </div>
          <div v-else-if="canWrite" class="rtype-actions">
            <button type="button" class="mini" :disabled="!!busy" @click="startEdit(t)">Rename</button>
            <button type="button" class="mini" :disabled="!!busy" @click="startRemove(t)">Remove</button>
          </div>
        </template>

        <!-- Both beside the row they are about (KOL-150): a refusal is shown where it happened, and
             the near-duplicate warning is a warning, not an error — that type was created. -->
        <p v-if="rowError.id === t._id" class="rtype-error" role="alert">{{ rowError.message }}</p>
        <p v-if="warning.id === t._id" class="rtype-warning" role="status">{{ warning.message }}</p>
      </li>
    </ul>

    <form v-if="canWrite && !loading" class="rtype-add" @submit.prevent="add">
      <input
        v-model="newName"
        class="rtype-input"
        type="text"
        placeholder="New relationship type"
        aria-label="New relationship type name"
        :disabled="!!busy"
      />
      <select
        v-model="newScope"
        class="rtype-input rtype-select"
        aria-label="Where the new type is offered"
        :disabled="!!busy"
      >
        <option v-for="s in SCOPES" :key="s" :value="s">{{ SCOPE_LABELS[s] }}</option>
      </select>
      <button type="submit" class="mini" :disabled="!!busy || !newName.trim()">
        {{ busy === ADDING ? 'Adding…' : 'Add' }}
      </button>
    </form>

    <p v-if="addError" class="rtype-error" role="alert">{{ addError }}</p>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import {
  createRelationshipType, deleteRelationshipType, getRelationshipTypes, updateRelationshipType,
  SCOPES, SCOPE_LABELS,
} from '../api/relationshipTypes.js';

/**
 * The Relationship types group in Settings (KOL-159) — the vocabulary's only screen.
 *
 * `workspaceSeeder.js` says of the relationship types it puts in every new
 * workspace that "without them the relationship picker is empty and the core
 * feature of the product looks broken on first use". There was no picker, and
 * no screen either: `/relationship-types` had all four verbs and **no client
 * caller at all**, so the Software Architecture template's *depends-on*,
 * *owned-by* and *calls* sat in the database where their owner could not read
 * them, let alone add to them. This group and the suggestion lists in
 * `RelationshipsSection.vue` are the two halves of giving them back.
 *
 * Four decisions are in here:
 *
 *   **`scope` is a field on the screen, not a detail.** A relationship carries
 *   labels in two places and they are different vocabularies — a group is a
 *   "Marriage", a member of it is a "Wife" — and the suggestion lists filter on
 *   exactly this, so a type whose scope is wrong is offered in the wrong place.
 *   It is therefore in the add form and in the rename form, and the row shows
 *   it as a badge. Both server writes had to learn to read it first: `POST` and
 *   `PUT` destructured three fields and not this one, so every type any client
 *   created took the model's `member` default and a `group`-scoped type was
 *   reachable only by seeding.
 *
 *   **It fetches on mount, and holds no shared copy.** Unlike the entity-type
 *   registry there is no module-level store for this collection — nothing else
 *   in the app holds it, and `RelationshipsSection` fetches it per mount too —
 *   so the list here is this group's own and is loaded fresh each time Settings
 *   opens, which is also the only way it is refreshed. A failed load keeps a
 *   Retry rather than reading as an empty vocabulary: "this workspace has no
 *   types" is a claim about the workspace and must not be made about a request
 *   that failed.
 *
 *   **Every refusal is shown where it happened** (KOL-150's rule), in the
 *   server's own words. The exact-name 409 is across scopes — one workspace
 *   cannot hold "Owner" as both a group label and a member role — so its
 *   sentence is the only thing that explains a refused rename, and it lands
 *   beside the row, which goes on showing its **stored** name and scope. A
 *   refused write keeps its editor open with what was typed (KOL-156).
 *
 *   **The near-duplicate `warning` is a warning.** `POST /relationship-types`
 *   creates the type *and* says a similar name exists, which is the whole point
 *   of it here — "Owns" beside "owned by" is the drift this screen exists to
 *   stop — so rendering it as an error would claim nothing happened.
 *
 * Gated on `canWrite`: a viewer gets the list and no control at all, because
 * `requireWriteRole` refuses all three writes with 403 (KOL-150).
 *
 * Out of scope, and deliberately: editing `sourceCategory`/`targetCategory`
 * (the row shows them; narrowing suggestions by them is its own item), a rename
 * cascading onto the labels already stored on groups and members, and inverse
 * pairs or directionality.
 *
 * Tiered debug logging: set localStorage.RELATIONSHIP_TYPE_LOG_LEVEL to
 * off | light | normal | verbose (default light) — the same key the suggestion
 * lists and the server route read, so one setting narrates a write end to end.
 *   light   — every write sent from here and how it ended, naming the control
 *             that started it and, for a refusal, the status and the server's
 *             own sentence
 *   normal  — light, plus the load and the patch a save actually sent (a save
 *             that posts nothing because nothing changed is the quiet failure)
 *   verbose — normal, plus each row the list was built from, with its scope
 */

const props = defineProps({
  /** The write gate, derived once in WikiLayout (KOL-150). */
  canWrite: { type: Boolean, default: true },
});

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  let configured = null;
  try { configured = localStorage.getItem('RELATIONSHIP_TYPE_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((LEVELS[configured] ?? LEVELS.light) >= LEVELS[level]) console.log(`[relationshipTypes/settings:${level}] ${msg}`);
}

/** `busy` while the add form is in flight; no type's id can collide with it. */
const ADDING = '__adding__';

const types        = ref([]);
const loading      = ref(true);
const loadError    = ref('');
const editingId    = ref(null);   // the type whose rename form is open
const confirmingId = ref(null);   // the type whose Remove is armed
const draft        = ref({ name: '', scope: 'member' });
const newName      = ref('');
const newScope     = ref('member');
const busy         = ref(null);   // null, or the id a request is in flight for
const rowError     = ref({ id: null, message: '' });
const warning      = ref({ id: null, message: '' });
const addError     = ref('');

const SESSION_EXPIRED = 'Your session has expired. Sign in again to manage relationship types.';

/** Group labels first, then member roles, each by name — the two vocabularies, kept apart. */
const rows = computed(() => {
  const rank = t => (t?.scope === 'group' ? 0 : 1);
  const list = [...types.value].sort(
    (a, b) => rank(a) - rank(b) || String(a?.name).localeCompare(String(b?.name)),
  );
  log('verbose', `rows: ${list.map(t => `${t.name} (${t.scope ?? 'member'})`).join(', ') || 'none'}`);
  return list;
});

onMounted(() => load('mount'));

async function load(source) {
  loading.value = true;
  loadError.value = '';
  try {
    const fetched = await getRelationshipTypes();
    types.value = Array.isArray(fetched) ? fetched : [];
    log('normal', `loaded ${types.value.length} relationship type(s) (source: Settings → Relationship types ${source})`);
  } catch (err) {
    // Not an empty list: a workspace with no vocabulary and a request that
    // failed are different facts, and only one of them has a Retry.
    log('light', `loading the vocabulary failed: ${err.status ?? 'no status'} ${err.message} (source: Settings → Relationship types ${source})`);
    loadError.value = err.status === 401 ? SESSION_EXPIRED : 'Could not load the relationship types.';
  } finally {
    loading.value = false;
  }
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
  draft.value = { name: t.name, scope: t.scope === 'group' ? 'group' : 'member' };
}

function startRemove(t) {
  reset();
  warning.value = { id: null, message: '' };
  confirmingId.value = t._id;
}

/**
 * What a refusal says. The 409 names the type that already holds the name and
 * the 400 names the scopes that are allowed, so both are shown as written; a
 * 403 is the write gate, and anything else is a fallback.
 */
function messageFor(err, verb) {
  if (err.status === 401) return SESSION_EXPIRED;
  if (err.status === 403) return 'You do not have permission to change this workspace\'s relationship types.';
  if ([400, 404, 409, 413].includes(err.status)) return err.message;
  return `Could not ${verb} the relationship type. Please try again.`;
}

/** The fields of `draft` that differ from the stored row — a patch, or null. */
function patchFor(t) {
  const patch = {};
  const name = draft.value.name.trim();
  if (name && name !== t.name) patch.name = name;
  const stored = t.scope === 'group' ? 'group' : 'member';
  if (draft.value.scope !== stored) patch.scope = draft.value.scope;
  return Object.keys(patch).length ? patch : null;
}

/** Replaces the row with `updated`, in place, so the list does not jump. */
function replaceRow(updated) {
  types.value = types.value.map(t => (t._id === updated._id ? { ...t, ...updated } : t));
}

async function save(t) {
  const patch = patchFor(t);
  if (!patch) {
    log('light', `nothing to save for "${t.name}" (source: Settings → Relationship types → Save, with no field changed)`);
    reset();
    return;
  }

  rowError.value = { id: null, message: '' };
  warning.value = { id: null, message: '' };
  busy.value = t._id;
  log('normal', `saving "${t.name}": ${JSON.stringify(patch)} (source: Settings → Relationship types → Save)`);
  try {
    const updated = await updateRelationshipType(t._id, patch);
    replaceRow(updated ?? { _id: t._id, ...patch });
    log('light', `saved "${t.name}" → "${updated?.name ?? patch.name ?? t.name}" scope ${updated?.scope ?? patch.scope ?? t.scope} (source: Settings → Relationship types → Save)`);
    reset();
  } catch (err) {
    // The form stays open with what was typed (KOL-156), and the badge beside it
    // still reads the stored name and scope: nothing changed, and the screen says so.
    log('light', `saving "${t.name}" failed: ${err.status ?? 'no status'} ${err.message} (source: Settings → Relationship types → Save)`);
    rowError.value = { id: t._id, message: messageFor(err, 'save') };
  } finally {
    busy.value = null;
  }
}

async function remove(t) {
  rowError.value = { id: null, message: '' };
  warning.value = { id: null, message: '' };
  busy.value = t._id;
  try {
    await deleteRelationshipType(t._id);
    types.value = types.value.filter(row => row._id !== t._id);
    log('light', `removed "${t.name}" (source: Settings → Relationship types → Remove)`);
    reset();
  } catch (err) {
    // The row stays, which is the truth, and the sentence beside it says why.
    log('light', `removing "${t.name}" failed: ${err.status ?? 'no status'} ${err.message} (source: Settings → Relationship types → Remove)`);
    rowError.value = { id: t._id, message: messageFor(err, 'remove') };
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
    // `scope` goes on every create: the server defaults to 'member', and a
    // group label picked in this form must not quietly become a member role.
    const created = await createRelationshipType({ name, scope: newScope.value });
    // `warning` is about this request, not a field of the row.
    const { warning: similar, ...row } = created ?? {};
    types.value = [...types.value, row];
    newName.value = '';
    // The type *was* created; a similar name is a warning beside its new row.
    if (similar) warning.value = { id: row._id, message: similar };
    log('light', `added "${row.name ?? name}" scope ${row.scope ?? newScope.value}${similar ? ` with a warning: ${similar}` : ''} (source: Settings → Relationship types → Add)`);
  } catch (err) {
    log('light', `adding "${name}" failed: ${err.status ?? 'no status'} ${err.message} (source: Settings → Relationship types → Add)`);
    addError.value = messageFor(err, 'add');
  } finally {
    busy.value = null;
  }
}
</script>

<style scoped>
.rtype-settings { display: flex; flex-direction: column; gap: 8px; }

.rtype-note    { font-size: 12px; color: #777; line-height: 1.5; margin: 0; }
.rtype-note strong { color: #999; font-weight: 600; }
.rtype-error   { font-size: 12px; color: #e07070; margin: 0; width: 100%; display: flex; align-items: center; gap: 8px; }
.rtype-warning { font-size: 12px; color: #d9a742; margin: 0; width: 100%; }

.rtype-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }

.rtype-item {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 12px;
  background: #111;
  border: 1px solid #1e1e1e;
  border-radius: 8px;
}

.rtype-scope {
  flex-shrink: 0;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 11px;
  white-space: nowrap;
}
.rtype-scope.is-group  { background: #3a2a14; color: #d9a742; }
.rtype-scope.is-member { background: #1e2a3a; color: #7ab4f5; }

.rtype-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.rtype-name { font-size: 14px; color: #ccc; overflow-wrap: anywhere; }
.rtype-meta { font-size: 12px; color: #777; }

.rtype-actions { display: flex; gap: 6px; }

.rtype-edit,
.rtype-add { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; flex: 1; min-width: 0; }

.rtype-input {
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
.rtype-input:focus { outline: none; border-color: #3a3a3a; }
.rtype-select { flex: 0 0 auto; }

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
