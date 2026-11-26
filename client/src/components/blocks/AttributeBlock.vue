<template>
  <div class="block attribute-block">
    <div class="block-toolbar">
      <span class="attr-label">{{ block.data.label || 'Attribute' }}</span>
      <button v-if="!isEditing && canEdit" class="icon-btn" @click="startEdit"><PencilIcon /></button>
    </div>

    <div v-if="!isEditing" class="attr-value">{{ block.data.value || '—' }}</div>

    <div v-else class="block-edit">
      <input v-model="draftLabel" class="input" placeholder="Label" />
      <input v-model="draftValue" class="input" placeholder="Value" style="margin-top:6px" />
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
import { ref } from 'vue';
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

const isEditing = ref(false);
const isSaving = ref(false);
const draftLabel = ref('');
const draftValue = ref('');

function startEdit() {
  draftLabel.value = props.block.data.label ?? '';
  draftValue.value = props.block.data.value ?? '';
  isEditing.value = true;
}
function cancel() { isEditing.value = false; }
async function save() {
  isSaving.value = true;
  try {
    // Only a write that landed closes this editor: a refused save keeps the
    // fields and what was typed into them (KOL-156).
    const landed = await commitInlineEdit(props.onSave, { label: draftLabel.value, value: draftValue.value }, `attribute block ${props.block?._id ?? '(unsaved)'}`);
    if (landed) isEditing.value = false;
  } finally { isSaving.value = false; }
}
</script>

<style scoped>
.attribute-block { }
.attr-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #666; }
.attr-value { font-size: 14px; color: #ccc; margin-top: 2px; }
</style>
