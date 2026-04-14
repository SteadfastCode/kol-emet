<template>
  <div class="block quote-block">
    <div class="block-toolbar">
      <span class="block-type-label">Quote</span>
      <button v-if="!isEditing && canEdit" class="icon-btn" @click="startEdit"><PencilIcon /></button>
    </div>

    <div v-if="!isEditing" class="quote-view">
      <blockquote class="quote-text">{{ block.data.text }}</blockquote>
      <div v-if="block.data.attribution" class="quote-attr">— {{ block.data.attribution }}</div>
    </div>

    <div v-else class="block-edit">
      <textarea v-model="draftText" class="block-textarea" rows="4" placeholder="Quote text…" />
      <input v-model="draftAttr" class="input" placeholder="Attribution (optional)" style="margin-top:6px" />
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

const props = defineProps({ block: Object, canEdit: Boolean });
const emit = defineEmits(['save']);

const isEditing = ref(false);
const isSaving = ref(false);
const draftText = ref('');
const draftAttr = ref('');

function startEdit() {
  draftText.value = props.block.data.text ?? '';
  draftAttr.value = props.block.data.attribution ?? '';
  isEditing.value = true;
}
function cancel() { isEditing.value = false; }
async function save() {
  isSaving.value = true;
  try {
    await emit('save', { text: draftText.value, attribution: draftAttr.value });
    isEditing.value = false;
  } finally { isSaving.value = false; }
}
</script>

<style scoped>
.quote-view { display: flex; flex-direction: column; gap: 6px; }
.quote-text {
  border-left: 3px solid #444; padding-left: 14px;
  font-size: 14px; color: #aaa; line-height: 1.7; font-style: italic;
}
.quote-attr { font-size: 12px; color: #555; padding-left: 17px; }
.block-textarea {
  width: 100%; background: #0e0e0e; border: 1px solid #333; border-radius: 7px;
  color: #e0e0e0; font-family: inherit; font-size: 13px; line-height: 1.7;
  padding: 8px 10px; resize: vertical;
}
.block-textarea:focus { outline: none; border-color: #555; }
</style>
