<template>
  <div class="deleted-settings">
    <p class="deleted-note">
      A deleted entity can be put back for 30 days, while its snapshot is still in the change log.
      It comes back at the same id, with its blocks, tags and open questions — but its links to
      other entities are not rebuilt, because the delete removed the relationship groups it was in.
    </p>

    <p v-if="loading" class="deleted-note">Loading…</p>
    <p v-else-if="loadError" class="deleted-error" role="alert">{{ loadError }}</p>
    <template v-else>
      <!-- Above the list, not instead of it: a refused restore has to leave the
           row it came from on screen, because the row is where the choice that
           fixes it is made. -->
      <p v-if="error" class="deleted-error" role="alert">{{ error }}</p>
      <p v-if="!entries.length" class="deleted-note">Nothing deleted in the last 30 days.</p>
      <ul v-else class="deleted-list">
        <li v-for="entry in entries" :key="entry._id" class="deleted-item">
          <div class="deleted-info">
            <span class="deleted-title">{{ entry.entityTitle }}</span>
            <span class="deleted-meta">
              Deleted {{ when(entry) }} by {{ entry.actorLabel }}{{ entry.category ? ` · ${entry.category}` : '' }}
            </span>
          </div>

          <!-- Saved under an entity type the workspace no longer has, so the row
               asks which type to restore it under before the click. -->
          <div v-if="entry.snapshotCategoryMissing" class="deleted-choice">
            <p class="deleted-stale">
              Saved under “{{ entry.category }}”, which is no longer an entity type here.
              Choose one to restore it under:
            </p>
            <select
              v-model="chosenCategory[entry._id]"
              class="deleted-category"
              aria-label="Entity type to restore this entity under"
              :disabled="busy === entry._id"
            >
              <option value="">Choose a type…</option>
              <option v-for="name in categoryChoices(entry)" :key="name" :value="name">{{ name }}</option>
            </select>
            <button
              type="button"
              class="mini"
              :disabled="busy === entry._id || !chosenCategory[entry._id]"
              @click="restore(entry)"
            >{{ busy === entry._id ? 'Restoring…' : 'Restore' }}</button>
          </div>
          <button
            v-else
            type="button"
            class="mini"
            :disabled="busy === entry._id"
            @click="restore(entry)"
          >{{ busy === entry._id ? 'Restoring…' : 'Restore' }}</button>
        </li>
      </ul>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { getDeletedEntities, restoreEntity } from '../api/entities.js';
import { useEntityTypes } from '../composables/useEntityTypes.js';

/**
 * The "Recently deleted" group in Settings (KOL-060) — the way back to a
 * deleted entity that outlives the toast.
 *
 * `DELETE /entities/:id` keeps the whole document in the `deleted` change log
 * entry's snapshot for 30 days, and the delete broadcast carries it so another
 * open tab can open a read-only `[DELETED]` panel. Once that toast is dismissed
 * nothing else could reach the snapshot: the entity is gone from the list and
 * its history route is keyed by an id the user no longer has. So this group
 * lists `GET /deleted` and restores a row through the rollback route, which
 * recreates the document at its original id.
 *
 * A row whose snapshot names an entity type the workspace no longer has (a type
 * renamed or deleted since) carries `snapshotCategoryMissing`, and the server
 * will not restore it blind — so the row offers the workspace's types (from
 * `useEntityTypes`, the same list the pills read) and sends the choice, exactly
 * as a stale history row does in EntityDetail.vue. A 409 arriving anyway grows
 * the picker from the types the refusal named.
 *
 * Mounted only while Settings shows, so the list is fetched fresh on each open
 * and never on page load.
 *
 * Tiered debug logging: set localStorage.DELETED_LOG_LEVEL to
 * off | light | normal | verbose (default light). The server logs its side on
 * its own CHANGELOG_LOG_LEVEL.
 *   light   — every restore sent from here and how it ended, naming where the
 *             category came from, plus a failed load
 *   normal  — light, plus each list load and how many rows needed a choice
 *   verbose — normal, plus every row listed
 */

const emit = defineEmits(['restored']);

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  let configured = null;
  try { configured = localStorage.getItem('DELETED_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((LEVELS[configured] ?? LEVELS.light) >= LEVELS[level]) console.log(`[deleted:${level}] ${msg}`);
}

const { names: categoryNames } = useEntityTypes();

const entries = ref([]);
const loading = ref(true);
const loadError = ref('');
const error = ref('');
/** The type picked in a stale row's picker, by log id. */
const chosenCategory = ref({});
/** The log id of the restore in flight, or null. */
const busy = ref(null);

const SESSION_EXPIRED = 'Your session has expired. Sign in again to restore an entity.';

function when(entry) {
  const at = new Date(entry.createdAt);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString();
}

/** The types a stale row offers: what a 409 named, else the workspace's. */
function categoryChoices(entry) {
  return entry.availableCategories ?? categoryNames.value;
}

async function load() {
  loading.value = true;
  try {
    const listed = await getDeletedEntities();
    entries.value = Array.isArray(listed) ? listed : [];
    loadError.value = '';
    const stale = entries.value.filter(e => e.snapshotCategoryMissing).length;
    log('normal', `${entries.value.length} restorable deleted entit${entries.value.length === 1 ? 'y' : 'ies'}, ${stale} needing an entity type chosen (source: GET /deleted)`);
    for (const e of entries.value) {
      log('verbose', `${e.entityId} "${e.entityTitle}" deleted by ${e.actorLabel} at ${e.createdAt}${e.snapshotCategoryMissing ? ` — snapshot category "${e.category}" is gone` : ''} (log entry ${e._id})`);
    }
  } catch (err) {
    log('light', `loading the deleted list failed: ${err.status ?? ''} ${err.message} (source: GET /deleted on Settings open)`);
    loadError.value = err.status === 401 ? SESSION_EXPIRED : 'Could not load what was recently deleted.';
  } finally {
    loading.value = false;
  }
}

async function restore(entry) {
  const category = entry.snapshotCategoryMissing ? chosenCategory.value[entry._id] : undefined;
  busy.value = entry._id;
  error.value = '';
  try {
    await restoreEntity(entry.entityId, entry._id, { category });
    log('light', `restored "${entry.entityTitle}" (${entry.entityId}) from deleted entry ${entry._id}${category ? ` as "${category}" (source: the picker on that row; the snapshot holds "${entry.category}")` : ' (source: the snapshot, unchanged)'}`);
    // Dropped from the list rather than refetched: the row is gone for the same
    // reason the server would stop listing it — that id is live again.
    entries.value = entries.value.filter(e => e._id !== entry._id);
    emit('restored', entry.entityId);
  } catch (err) {
    error.value = err.status === 401 ? SESSION_EXPIRED : err.message;
    if (err.status === 409 && err.body?.availableCategories) {
      // The snapshot's entity type went between the load and the click. Grow the
      // picker from the types the refusal named rather than making the user
      // reopen Settings to find out.
      entry.snapshotCategoryMissing = true;
      entry.availableCategories = err.body.availableCategories;
      entry.category = err.body.snapshotCategory ?? entry.category;
      log('light', `restoring "${entry.entityTitle}" was refused: "${err.body.snapshotCategory}" is no longer an entity type (source: 409 from the rollback route); offering ${err.body.availableCategories.length} type(s)`);
    } else if (err.status === 409) {
      // Something is live at that id again, so this row can never be restored.
      log('light', `restoring "${entry.entityTitle}" was refused: ${entry.entityId} is live again (source: 409 from the rollback route); reloading the list`);
      await load();
    } else {
      log('light', `restoring "${entry.entityTitle}" failed: ${err.status ?? ''} ${err.message} (source: Restore on that row)`);
    }
  } finally {
    busy.value = null;
  }
}

onMounted(load);
</script>

<style scoped>
.deleted-settings { display: flex; flex-direction: column; gap: 8px; }

.deleted-note { font-size: 12px; color: #777; line-height: 1.5; margin: 0; }
.deleted-error { font-size: 12px; color: #e07070; margin: 0; }
.deleted-stale { font-size: 12px; color: #c9a227; line-height: 1.4; margin: 0; }

.deleted-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }

.deleted-item {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 12px;
  background: #111;
  border: 1px solid #1e1e1e;
  border-radius: 8px;
}

.deleted-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.deleted-title { font-size: 14px; color: #ccc; }
.deleted-meta { font-size: 12px; color: #777; }

.deleted-choice { flex: 1 0 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }

.deleted-category {
  padding: 6px 8px;
  background: #0d0d0d;
  border: 1px solid #2a2a2a;
  border-radius: 6px;
  color: #ccc;
  font-size: 12px;
  font-family: inherit;
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
</style>
