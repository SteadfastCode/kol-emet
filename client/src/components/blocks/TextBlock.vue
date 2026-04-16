<template>
  <div class="block text-block">
    <div class="block-toolbar">
      <span class="block-type-label">Text</span>
      <button v-if="!isEditing && canEdit" class="icon-btn" @click="startEdit"><PencilIcon /></button>
    </div>

    <!-- View mode -->
    <div
      v-if="!isEditing"
      class="markdown-body"
      v-html="renderedMarkdown"
      @click="handleClick"
    />

    <!-- Edit mode -->
    <div v-else class="block-edit">
      <textarea v-model="draft" class="block-textarea" rows="8" />
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
import PencilIcon from '../icons/PencilIcon.vue';
import { marked } from 'marked';

marked.use({ breaks: true, gfm: true });

const props = defineProps({
  block: Object,
  canEdit: Boolean,
});
const emit = defineEmits(['save']);

const entities = inject('entities', ref([]));
const followLink = inject('followLink', () => {});

const isEditing = ref(false);
const isSaving = ref(false);
const draft = ref('');

function processWikiLinks(text) {
  return text.replace(/\[\[([^\]]+)\]\]/g, (_, title) => {
    const entity = entities.value?.find(e => e.title.toLowerCase() === title.toLowerCase());
    const cls = entity ? 'wiki-link' : 'wiki-link wiki-link--dangling';
    const id = entity?._id ?? '';
    return `<span class="${cls}" data-wiki-id="${id}" data-wiki-title="${title}">${title}</span>`;
  });
}

const renderedMarkdown = computed(() => {
  const processed = processWikiLinks(props.block.data.markdown ?? '');
  return marked.parse(processed);
});

function handleClick(e) {
  const el = e.target.closest('[data-wiki-id]');
  if (!el) return;
  const id = el.dataset.wikiId;
  const title = el.dataset.wikiTitle;
  if (id) followLink(id, title);
}

function cancel() {
  isEditing.value = false;
}

async function save() {
  isSaving.value = true;
  try {
    await emit('save', { ...props.block.data, markdown: draft.value });
    isEditing.value = false;
  } finally {
    isSaving.value = false;
  }
}

// Populate draft when entering edit mode
function startEdit() {
  draft.value = props.block.data.markdown ?? '';
  isEditing.value = true;
}
</script>

<style scoped>
.text-block { }

/* Markdown output — :deep needed because v-html content is not scoped */
.markdown-body :deep(p) { margin-bottom: 0.75em; line-height: 1.7; font-size: 14px; color: #ccc; }
.markdown-body :deep(p:last-child) { margin-bottom: 0; }
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3) { color: #e0e0e0; margin-bottom: 0.5em; margin-top: 1em; }
.markdown-body :deep(strong) { color: #e0e0e0; }
.markdown-body :deep(code) {
  background: #1e1e1e; border-radius: 4px; padding: 1px 5px;
  font-size: 12px; color: #c8c8c8;
}
.markdown-body :deep(pre) {
  background: #1e1e1e; border-radius: 7px; padding: 12px;
  overflow-x: auto; margin-bottom: 0.75em;
}
.markdown-body :deep(ul), .markdown-body :deep(ol) {
  padding-left: 1.5em; margin-bottom: 0.75em; font-size: 14px; color: #ccc;
}
.markdown-body :deep(blockquote) {
  border-left: 3px solid #333; padding-left: 12px; color: #777; margin-bottom: 0.75em;
}

/* Wiki links */
.markdown-body :deep(.wiki-link) {
  color: #7ab4f5; cursor: pointer; border-bottom: 1px solid transparent;
  transition: border-color 0.1s;
}
.markdown-body :deep(.wiki-link:hover) { border-bottom-color: #7ab4f5; }
.markdown-body :deep(.wiki-link--dangling) { color: #f5a07a; }

.block-textarea {
  width: 100%; background: #0e0e0e; border: 1px solid #333; border-radius: 7px;
  color: #e0e0e0; font-family: inherit; font-size: 13px; line-height: 1.7;
  padding: 8px 10px; resize: vertical;
}
.block-textarea:focus { outline: none; border-color: #555; }
</style>
