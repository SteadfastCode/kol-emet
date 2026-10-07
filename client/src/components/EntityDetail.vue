<template>
  <div class="entity-detail">
    <BreadcrumbBar
      :breadcrumbs="breadcrumbs"
      @crumb-click="$emit('crumb-click', $event)"
    />

    <div v-if="loading" class="detail-loading">Loading…</div>

    <template v-else-if="entity">
      <EntityHeader
        :entity="entity"
        @save="saveHeader"
        @set-tag="$emit('set-tag', $event)"
      />

      <div class="blocks-section">
        <BlockList
          :blocks="entity.blocks"
          :can-edit="true"
          @save-block="saveBlock"
          @delete-block="deleteBlock"
          @add-block="addBlock"
        />
      </div>

      <RelationshipsSection
        :entity="entity"
        :can-edit="true"
        @refresh="$emit('refresh')"
      />

      <section class="history-section">
        <button type="button" class="btn-sm history-toggle" @click="toggleHistory">
          {{ historyOpen ? 'Hide history' : 'History' }}
        </button>

        <template v-if="historyOpen">
          <p v-if="historyLoading" class="history-note">Loading history…</p>
          <template v-else>
            <!-- Above the list, not instead of it: a refused restore has to
                 leave the row it came from on screen, because the row is where
                 the choice that fixes it is made. -->
            <p v-if="historyError" class="history-error" role="alert">{{ historyError }}</p>
            <p v-else-if="!history.length" class="history-note">
              No recorded changes. History covers the last 30 days.
            </p>
          </template>
          <ul v-if="!historyLoading && history.length" class="history-list">
            <li v-for="entry in history" :key="entry._id" class="history-item">
              <div class="history-info">
                <span class="history-when">{{ when(entry) }}</span>
                <span class="history-what">{{ describe(entry) }}</span>
                <span class="history-who">{{ entry.actorLabel }}</span>
              </div>

              <!-- An entry whose snapshot names an entity type the workspace no
                   longer has cannot be restored as recorded, so the row asks
                   which type to restore it under before the click. -->
              <div v-if="entry.snapshotCategoryMissing" class="history-choice">
                <p class="history-stale">
                  Saved under “{{ entry.snapshot?.category }}”, which is no longer an entity
                  type here. Choose one to restore it under:
                </p>
                <select
                  v-model="chosenCategory[entry._id]"
                  class="history-category"
                  :aria-label="`Entity type to restore this version under`"
                  :disabled="busy === entry._id"
                >
                  <option value="">Choose a type…</option>
                  <option v-for="name in categoryChoices(entry)" :key="name" :value="name">
                    {{ name }}
                  </option>
                </select>
                <button
                  type="button"
                  class="btn-sm"
                  :disabled="busy === entry._id || !chosenCategory[entry._id]"
                  @click="restore(entry)"
                >
                  {{ busy === entry._id ? 'Restoring…' : 'Restore' }}
                </button>
              </div>
              <button
                v-else-if="entry.snapshot"
                type="button"
                class="btn-sm"
                :disabled="busy === entry._id"
                @click="restore(entry)"
              >
                {{ busy === entry._id ? 'Restoring…' : 'Restore' }}
              </button>
            </li>
          </ul>
        </template>
      </section>

      <div class="entity-footer">
        <button class="btn-sm danger" @click="confirmDelete">Delete entity</button>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import BreadcrumbBar from './BreadcrumbBar.vue';
import EntityHeader from './EntityHeader.vue';
import BlockList from './BlockList.vue';
import RelationshipsSection from './RelationshipsSection.vue';
import { getEntityHistory, rollbackEntity } from '../api/entities.js';
import { useEntityTypes } from '../composables/useEntityTypes.js';

/**
 * An entity's page, and below it its change history (KOL-059).
 *
 * History is fetched when the section is opened, not on mount: most views of an
 * entity never ask for it, and it is one request per entity.
 *
 * A version saved before its entity type was renamed or deleted holds a
 * category the workspace no longer has, and the server will not restore it
 * blind — `GET /entities/:id/history` marks such an entry
 * `snapshotCategoryMissing` and `POST .../rollback/:logId` answers 409 unless
 * the body names a type. So the row for one of those offers the workspace's
 * types (from `useEntityTypes`, the same list the pills read) and sends the
 * choice. A 409 arriving anyway — a type renamed while the list was on screen —
 * turns that row into the same picker, from the types the refusal named.
 *
 * Tiered debug logging: set localStorage.HISTORY_LOG_LEVEL to
 * off | light | normal | verbose (default light). The server logs its side on
 * its own CHANGELOG_LOG_LEVEL.
 *   light   — every restore sent from here and how it ended, naming where the
 *             category came from, plus a failed history load
 *   normal  — light, plus each history load and how many entries need a choice
 *   verbose — normal, plus every entry loaded
 */

const props = defineProps({
  entity: Object,
  loading: Boolean,
  breadcrumbs: Array,
});

const emit = defineEmits(['crumb-click', 'follow-link', 'set-tag', 'saved', 'deleted', 'refresh']);

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  let configured = null;
  try { configured = localStorage.getItem('HISTORY_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((LEVELS[configured] ?? LEVELS.light) >= LEVELS[level]) console.log(`[history:${level}] ${msg}`);
}

const { names: categoryNames } = useEntityTypes();

const historyOpen = ref(false);
const historyLoading = ref(false);
const historyError = ref('');
const history = ref([]);
/** The type picked in a stale entry's picker, by log id. */
const chosenCategory = ref({});
/** The log id of the restore in flight, or null. */
const busy = ref(null);

// A different entity is a different history; nothing of the last one's carries
// over, including a half-made choice.
watch(() => props.entity?._id, () => {
  historyOpen.value = false;
  history.value = [];
  chosenCategory.value = {};
  historyError.value = '';
  busy.value = null;
});

async function toggleHistory() {
  historyOpen.value = !historyOpen.value;
  if (historyOpen.value) await loadHistory();
}

async function loadHistory() {
  historyLoading.value = true;
  historyError.value = '';
  try {
    const entries = await getEntityHistory(props.entity._id);
    history.value = Array.isArray(entries) ? entries : [];
    const stale = history.value.filter(e => e.snapshotCategoryMissing).length;
    log('normal', `loaded ${history.value.length} history entr${history.value.length === 1 ? 'y' : 'ies'} for ${props.entity._id}, ${stale} needing an entity type chosen (source: GET /entities/:id/history)`);
    for (const e of history.value) {
      log('verbose', `${e._id} ${e.changeType} by ${e.actorLabel} at ${e.createdAt}${e.snapshotCategoryMissing ? ` — snapshot category "${e.snapshot?.category}" is gone` : ''}`);
    }
  } catch (err) {
    historyError.value = err.message;
    log('light', `loading history for ${props.entity._id} failed: ${err.status ?? ''} ${err.message} (source: History section opened)`);
  } finally {
    historyLoading.value = false;
  }
}

/** The types a stale entry offers: what a 409 named, else the workspace's. */
function categoryChoices(entry) {
  return entry.availableCategories ?? categoryNames.value;
}

async function restore(entry) {
  const category = entry.snapshotCategoryMissing ? chosenCategory.value[entry._id] : undefined;
  busy.value = entry._id;
  historyError.value = '';
  try {
    await rollbackEntity(props.entity._id, entry._id, { category });
    log('light', `restored ${props.entity._id} from ${entry._id}${category ? ` as "${category}" (source: the picker on that history row; the snapshot holds "${entry.snapshot?.category}")` : ' (source: the snapshot, unchanged)'}`);
    historyOpen.value = false;
    emit('refresh');
  } catch (err) {
    historyError.value = err.message;
    // 409 = the snapshot's entity type went between the load and the click.
    // Grow the picker from the types the refusal named rather than making the
    // user reopen the section to find out.
    if (err.status === 409 && err.body?.availableCategories) {
      entry.snapshotCategoryMissing = true;
      entry.availableCategories = err.body.availableCategories;
      log('light', `restoring ${props.entity._id} from ${entry._id} was refused: "${err.body.snapshotCategory}" is no longer an entity type (source: 409 from POST /entities/:id/rollback/:logId); offering ${err.body.availableCategories.length} type(s)`);
    } else {
      log('light', `restoring ${props.entity._id} from ${entry._id} failed: ${err.status ?? ''} ${err.message} (source: Restore on that history row)`);
    }
  } finally {
    busy.value = null;
  }
}

function when(entry) {
  const at = new Date(entry.createdAt);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString();
}

function describe(entry) {
  if (entry.changeType !== 'updated') return entry.changeType;
  const parts = [];
  const fields = entry.changes?.fieldsChanged ?? [];
  if (fields.length) parts.push(fields.join(', '));
  for (const [key, label] of [['blocksAdded', 'added'], ['blocksUpdated', 'edited'], ['blocksDeleted', 'deleted']]) {
    const count = entry.changes?.[key]?.length ?? 0;
    if (count) parts.push(`${count} block${count === 1 ? '' : 's'} ${label}`);
  }
  return parts.length ? parts.join(' · ') : 'updated';
}

async function saveHeader(headerData) {
  emit('saved', props.entity._id, {
    ...headerData,
    blocks: props.entity.blocks,
  });
}

async function saveBlock(updatedBlock) {
  const blocks = props.entity.blocks.map(b =>
    b._id === updatedBlock._id ? updatedBlock : b
  );
  emit('saved', props.entity._id, { blocks });
}

async function deleteBlock(blockId) {
  const blocks = props.entity.blocks.filter(b => b._id !== blockId);
  emit('saved', props.entity._id, { blocks });
}

async function addBlock(newBlock) {
  const blocks = [...props.entity.blocks, newBlock];
  emit('saved', props.entity._id, { blocks });
}

function confirmDelete() {
  if (confirm(`Delete "${props.entity.title}"? This cannot be undone.`)) {
    emit('deleted', props.entity._id);
  }
}
</script>

<style scoped>
.entity-detail {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.detail-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #444;
  font-size: 14px;
}

.blocks-section {
  margin-top: 20px;
  flex: 1;
  padding: 0 24px;
}

.history-section {
  padding: 16px 24px 0;
  border-top: 1px solid #1e1e1e;
  margin-top: 24px;
}

.history-note,
.history-stale,
.history-error {
  font-size: 13px;
  color: #777;
  margin: 12px 0 0;
}

.history-error {
  color: #c66;
}

.history-list {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
}

.history-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid #1a1a1a;
  font-size: 13px;
}

.history-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.history-when {
  color: #aaa;
}

.history-what,
.history-who {
  color: #666;
  font-size: 12px;
}

.history-choice {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  max-width: 320px;
}

.history-stale {
  margin: 0;
  text-align: right;
}

.history-category {
  background: #151515;
  color: #ccc;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 12px;
}

.entity-footer {
  padding: 16px 24px 32px;
  border-top: 1px solid #1e1e1e;
  margin-top: 24px;
}
</style>
