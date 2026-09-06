<template>
  <div class="review">
    <div v-if="loading" class="centred">Loading draft…</div>

    <template v-else-if="draft">
      <!-- summary bar -->
      <div class="bar">
        <div class="tally">
          <strong>{{ counts.total }}</strong> proposed
          <span v-if="counts.flagged" class="needs">· {{ counts.flagged }} need{{ counts.flagged === 1 ? 's' : '' }} a look</span>
          <span v-if="counts.accepted + counts.edited" class="keep">· {{ counts.accepted + counts.edited }} keeping</span>
          <span v-if="counts.rejected" class="skip">· {{ counts.rejected }} skipped</span>
        </div>
        <div class="bar-actions">
          <button
            class="btn-sm"
            :disabled="!canBulk || working"
            :title="counts.flagged ? 'Flagged items are left for you to decide' : ''"
            @click="onAcceptClean"
          >Keep all clear ones</button>
          <button class="btn-sm primary" :disabled="!readyToApply || working" @click="onApply">
            {{ working ? 'Adding…' : applyLabel }}
          </button>
        </div>
      </div>

      <p v-if="bulkNote" class="note">{{ bulkNote }}</p>
      <p v-if="error" class="error">{{ error }}</p>

      <!-- items -->
      <div class="list">
        <DraftItemCard
          v-for="item in ordered"
          :key="item._id"
          :item="item"
          :busy="busyIds.has(item._id)"
          :blocked="blockedReason(item)"
          :duplicate-title="duplicateTitleFor(item)"
          @accept="i => decide(i, 'accepted')"
          @reject="i => decide(i, 'rejected')"
          @undo="i => decide(i, 'accepted')"
          @edit="openEditor"
          @merge="onMerge"
          @keep-separate="i => retarget(i, null)"
        />
      </div>

      <p v-if="draft.counts?.dropped" class="dropped">
        {{ draft.counts.dropped }} item{{ draft.counts.dropped === 1 ? " wasn't" : "s weren't" }} usable
        and {{ draft.counts.dropped === 1 ? 'was' : 'were' }} left out.
        <button class="link" @click="showDrops = !showDrops">{{ showDrops ? 'hide' : 'why?' }}</button>
      </p>
      <ul v-if="showDrops" class="drop-list">
        <li v-for="(r, i) in draft.diagnostics?.dropReasons ?? []" :key="i">{{ r }}</li>
      </ul>

      <!-- edit uses the real editor, so an edited item comes back in exactly
           the shape the server revalidates against -->
      <div v-if="editing" class="editor-scrim" @click.self="editing = null">
        <div class="editor-host">
          <EntityEditor
            :initial="editing.accepted ?? editing.proposed"
            @saved="onEdited"
            @cancel="editing = null"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted, computed, inject } from 'vue';
import DraftItemCard from './DraftItemCard.vue';
import EntityEditor from '../EntityEditor.vue';
import { useDraftReview } from '../../composables/useDraftReview.js';

const props = defineProps({ draftId: { type: String, required: true } });
const emit = defineEmits(['applied']);

const {
  draft, ordered, counts, loading, error, busyIds,
  readyToApply, blockedReason,
  load, decide, retarget, acceptAllClean, apply,
} = useDraftReview();

const editing  = ref(null);
const working  = ref(false);
const bulkNote = ref('');
const showDrops = ref(false);

// Provided by WikiLayout; used only to name a duplicate candidate.
const allEntities = inject('entities', ref([]));

onMounted(() => load(props.draftId));

const canBulk = computed(() => counts.value.pending > counts.value.flagged);
const applyLabel = computed(() => {
  const n = counts.value.accepted + counts.value.edited;
  return n ? `Add ${n} to wiki` : 'Add to wiki';
});

function duplicateTitleFor(item) {
  if (!item.duplicateOf) return '';
  const hit = (allEntities.value ?? []).find(e => String(e._id) === String(item.duplicateOf));
  return hit?.title ?? '';
}

function openEditor(item) { editing.value = item; }

async function onEdited(payload) {
  const item = editing.value;
  editing.value = null;
  await decide(item, 'edited', { payload });
}

function onMerge(item) {
  if (item.duplicateOf) retarget(item, item.duplicateOf);
}

async function onAcceptClean() {
  working.value = true;
  bulkNote.value = '';
  try {
    const res = await acceptAllClean();
    // The server refuses flagged items and says how many; echoing that is the
    // whole point — a silent bulk accept would be the rubber stamp this avoids.
    if (res) bulkNote.value = res.message;
  } finally { working.value = false; }
}

async function onApply() {
  working.value = true;
  try {
    const res = await apply();
    if (res) emit('applied', res);
  } finally { working.value = false; }
}
</script>

<style scoped>
.review { display: flex; flex-direction: column; gap: 12px; }
.centred { padding: 48px; text-align: center; color: #666; font-size: 13px; }

.bar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  background: #0f0f0f;
  border-bottom: 1px solid #1e1e1e;
}
.tally { font-size: 12px; color: #888; }
.tally strong { color: #ddd; }
.needs { color: #c08a30; }
.keep  { color: #6a9a5a; }
.skip  { color: #666; }
.bar-actions { display: flex; gap: 8px; }

.note {
  margin: 0; padding: 8px 12px; border-radius: 6px;
  background: #1a2018; border: 1px solid #26361f; color: #9ac08a; font-size: 12px;
}
.error {
  margin: 0; padding: 8px 12px; border-radius: 6px;
  background: #2a1616; border: 1px solid #4a2020; color: #e0a0a0; font-size: 12px;
}

.list { display: flex; flex-direction: column; gap: 8px; }

.dropped { margin: 4px 0 0; font-size: 11px; color: #777; }
.drop-list {
  margin: 0; padding-left: 18px;
  font-size: 11px; line-height: 1.6; color: #666;
}

.link {
  background: none; border: none; padding: 0 0 0 4px;
  color: #6a8ab5; font-size: 11px; text-decoration: underline; cursor: pointer;
}

.editor-scrim {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(0, 0, 0, 0.6);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 40px 20px; overflow-y: auto;
}
.editor-host {
  width: 100%; max-width: 720px;
  background: #111; border: 1px solid #262626; border-radius: 10px; overflow: hidden;
}
</style>
