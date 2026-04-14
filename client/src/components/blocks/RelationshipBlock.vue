<template>
  <div class="block relationship-block">
    <div class="block-toolbar">
      <span class="block-type-label">Relationship</span>
      <button v-if="!isEditing && canEdit" class="icon-btn" @click="startEdit"><PencilIcon /></button>
    </div>

    <!-- View mode -->
    <div v-if="!isEditing" class="rel-view">
      <span class="rel-type">{{ block.data.relationshipType || 'Unknown type' }}</span>
      <span class="rel-arrow">→</span>
      <span
        v-if="targetEntry"
        class="rel-target wiki-link"
        @click="followLink(targetEntry._id, targetEntry.title)"
      >{{ targetEntry.title }}</span>
      <span v-else class="rel-target rel-dangling">
        {{ block.data.targetTitle || 'Unknown' }}
      </span>
      <p v-if="block.data.notes" class="rel-notes">{{ block.data.notes }}</p>
    </div>

    <!-- Edit mode -->
    <div v-else class="block-edit">
      <RelationshipTypeInput v-model="draftType" />

      <div class="target-search" style="margin-top:8px">
        <input
          v-model="targetSearch"
          class="input"
          placeholder="Target entry (search…)"
          @input="filterTargets"
        />
        <div v-if="targetResults.length" class="target-dropdown">
          <div
            v-for="e in targetResults" :key="e._id"
            class="target-option"
            @click="selectTarget(e)"
          >{{ e.title }}</div>
        </div>
        <div v-if="draftTargetId" class="selected-target">
          ✓ {{ draftTargetTitle }}
          <button class="icon-btn" @click="clearTarget">✕</button>
        </div>
      </div>

      <textarea
        v-model="draftNotes"
        class="block-textarea"
        placeholder="Notes (optional)"
        rows="3"
        style="margin-top:8px"
      />

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
import { ref, computed, inject } from 'vue';
import RelationshipTypeInput from '../RelationshipTypeInput.vue';
import PencilIcon from '../icons/PencilIcon.vue';

const props = defineProps({ block: Object, canEdit: Boolean });
const emit = defineEmits(['save']);

const entries = inject('entries', ref([]));
const followLink = inject('followLink', () => {});

const isEditing = ref(false);
const isSaving = ref(false);
const draftType = ref('');
const draftTargetId = ref(null);
const draftTargetTitle = ref('');
const draftNotes = ref('');
const targetSearch = ref('');
const targetResults = ref([]);

const targetEntry = computed(() =>
  props.block.data.targetId
    ? entries.value?.find(e => e._id === props.block.data.targetId)
    : null
);

function filterTargets() {
  const q = targetSearch.value.toLowerCase();
  if (!q) { targetResults.value = []; return; }
  targetResults.value = (entries.value ?? [])
    .filter(e => e.title.toLowerCase().includes(q))
    .slice(0, 8);
}

function selectTarget(e) {
  draftTargetId.value = e._id;
  draftTargetTitle.value = e.title;
  targetSearch.value = e.title;
  targetResults.value = [];
}

function clearTarget() {
  draftTargetId.value = null;
  draftTargetTitle.value = '';
  targetSearch.value = '';
}

function startEdit() {
  draftType.value = props.block.data.relationshipType ?? '';
  draftTargetId.value = props.block.data.targetId ?? null;
  draftTargetTitle.value = props.block.data.targetTitle ?? '';
  targetSearch.value = draftTargetTitle.value;
  draftNotes.value = props.block.data.notes ?? '';
  isEditing.value = true;
}

function cancel() { isEditing.value = false; }

async function save() {
  isSaving.value = true;
  try {
    await emit('save', {
      relationshipType: draftType.value,
      targetId: draftTargetId.value,
      notes: draftNotes.value,
    });
    isEditing.value = false;
  } finally { isSaving.value = false; }
}
</script>

<style scoped>
.rel-view { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; }
.rel-type {
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  background: #1e2a3a; color: #7ab4f5; border: 1px solid #2a4a6a;
}
.rel-arrow { color: #444; font-size: 12px; }
.rel-target { font-size: 14px; color: #e0e0e0; }
.rel-target.wiki-link { color: #7ab4f5; cursor: pointer; }
.rel-target.wiki-link:hover { text-decoration: underline; }
.rel-dangling { color: #f5a07a; }
.rel-notes { font-size: 12px; color: #666; margin-top: 4px; width: 100%; }

.target-dropdown {
  background: #1a1a1a; border: 1px solid #333; border-radius: 7px;
  margin-top: 4px; max-height: 160px; overflow-y: auto;
}
.target-option {
  padding: 7px 10px; font-size: 13px; cursor: pointer; color: #ccc;
}
.target-option:hover { background: #252525; }

.selected-target {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: #6dca6d; margin-top: 4px;
}

.block-textarea {
  width: 100%; background: #0e0e0e; border: 1px solid #333; border-radius: 7px;
  color: #e0e0e0; font-family: inherit; font-size: 13px; padding: 8px 10px; resize: vertical;
}
.block-textarea:focus { outline: none; border-color: #555; }
</style>
