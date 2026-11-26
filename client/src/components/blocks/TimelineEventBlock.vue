<template>
  <div class="block timeline-event-block">
    <div class="block-toolbar">
      <span class="block-type-label">Timeline Event</span>
      <button v-if="!isEditing && canEdit" class="icon-btn" @click="startEdit"><PencilIcon /></button>
    </div>

    <div v-if="!isEditing" class="event-view">
      <div class="event-date">
        <span class="date-str">{{ block.data.date || 'Unknown date' }}</span>
        <span v-if="block.data.era" class="date-era">{{ block.data.era }}</span>
      </div>
      <p class="event-desc">{{ block.data.description }}</p>
      <span
        v-if="linkedEntry"
        class="event-link wiki-link"
        @click="followLink(linkedEntry._id, linkedEntry.title)"
      >→ {{ linkedEntry.title }}</span>
    </div>

    <div v-else class="block-edit">
      <div class="date-row">
        <input v-model="form.date" class="input" placeholder="Date (e.g. Year 42)" style="flex:2" />
        <input v-model.number="form.sortKey" class="input" placeholder="Sort #" type="number" style="flex:1" />
      </div>
      <input v-model="form.era" class="input" placeholder="Era (optional)" style="margin-top:6px" />
      <textarea v-model="form.description" class="block-textarea" placeholder="Description" rows="3" style="margin-top:6px" />
      <div class="block-edit-actions">
        <button class="btn-sm" @click="cancel">Cancel</button>
        <button class="btn-sm primary" :disabled="isSaving" @click="save">
          <span v-if="isSaving" class="spinner" /><span v-else>Save</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, inject, reactive } from 'vue';
import PencilIcon from '../icons/PencilIcon.vue';
import { commitInlineEdit } from '../../lib/inlineEdit.js';

const props = defineProps({
  block: Object,
  canEdit: Boolean,
  /**
   * The page's save for this block, as a function prop rather than an emit
   * (KOL-156): this editor may only close if the write actually landed, and
   * `emit` returns no handler result to tell it. `@save="…"` on this component
   * still fills it in. Resolves `true` when the entity was written; anything
   * else leaves the editor open with the draft. See lib/inlineEdit.js.
   */
  onSave: Function,
});

const entries = inject('entries', ref([]));
const followLink = inject('followLink', () => {});

const isEditing = ref(false);
const isSaving = ref(false);
const form = reactive({ date: '', sortKey: 0, era: '', description: '' });

const linkedEntry = computed(() =>
  props.block.data.linkedEntryId
    ? entries.value?.find(e => e._id === props.block.data.linkedEntryId)
    : null
);

function startEdit() {
  Object.assign(form, {
    date: props.block.data.date ?? '',
    sortKey: props.block.data.sortKey ?? 0,
    era: props.block.data.era ?? '',
    description: props.block.data.description ?? '',
  });
  isEditing.value = true;
}
function cancel() { isEditing.value = false; }
async function save() {
  isSaving.value = true;
  try {
    // Only a write that landed closes this editor: a refused save keeps the
    // fields and what was typed into them (KOL-156).
    const landed = await commitInlineEdit(props.onSave, { ...props.block.data, ...form }, `timeline event block ${props.block?._id ?? '(unsaved)'}`);
    if (landed) isEditing.value = false;
  } finally { isSaving.value = false; }
}
</script>

<style scoped>
.event-view { display: flex; flex-direction: column; gap: 6px; }
.event-date { display: flex; align-items: center; gap: 8px; }
.date-str { font-size: 13px; font-weight: 500; color: #FAC775; }
.date-era { font-size: 11px; color: #666; }
.event-desc { font-size: 14px; color: #ccc; line-height: 1.6; }
.event-link { font-size: 12px; color: #7ab4f5; cursor: pointer; }
.event-link:hover { text-decoration: underline; }

.date-row { display: flex; gap: 8px; }
.block-textarea {
  width: 100%; background: #0e0e0e; border: 1px solid #333; border-radius: 7px;
  color: #e0e0e0; font-family: inherit; font-size: 13px; padding: 8px 10px; resize: vertical;
}
.block-textarea:focus { outline: none; border-color: #555; }
</style>
