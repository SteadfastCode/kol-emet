<template>
  <div ref="cardEl" class="entry-card" :class="{ open: expanded, editing: isEditing }" @click="handleCardClick">
    <div class="entry-header">
      <div class="entry-meta">
        <input
          v-if="isEditing"
          v-model="form.title"
          class="edit-input title-input"
          @click.stop
        />
        <span v-else class="entry-title">{{ entry.title }}</span>
        <span v-if="!isEditing && entry.open_questions?.length" class="oq-badge">
          {{ entry.open_questions.length === 1 ? 'open question' : `${entry.open_questions.length} open questions` }}
        </span>
      </div>
      <select v-if="isEditing" v-model="form.category" class="edit-select" @click.stop>
        <option v-for="cat in CATEGORIES" :key="cat">{{ cat }}</option>
      </select>
      <span v-else class="entry-cat" :style="catStyle">{{ entry.category }}</span>
    </div>

    <input
      v-if="isEditing"
      v-model="form.summary"
      class="edit-input summary-input"
      placeholder="Summary"
      @click.stop
    />
    <div v-else class="entry-summary">{{ entry.summary }}</div>

    <div v-if="expanded || isEditing" class="entry-body" @click.stop>
      <template v-if="isEditing">
        <textarea v-model="form.body" class="edit-textarea" placeholder="Full notes…" />
        <div class="edit-tags-row">
          <input v-model="form.tagsRaw" class="edit-input" placeholder="Tags (comma separated)" />
        </div>
      </template>
      <template v-else>
        <p v-for="(para, i) in bodyParagraphs" :key="i">{{ para }}</p>
        <div v-if="entry.open_questions?.length" class="linked-oqs">
          <div class="oq-label">Open questions</div>
          <div v-for="oq in entry.open_questions" :key="oq._id" class="linked-oq">
            {{ oq.question }}
          </div>
        </div>
        <div v-if="entry.tags.length" class="entry-tags">
          <span v-for="tag in entry.tags" :key="tag" class="tag"
            @click.stop="$emit('tag-click', tag)">#{{ tag }}</span>
        </div>
      </template>

      <div class="entry-actions">
        <template v-if="isEditing">
          <button class="btn-sm" :disabled="isSaving" @click.stop="cancelOrUndo">
            {{ isDirty ? 'Undo' : 'Cancel' }}
          </button>
          <button class="btn-sm primary" :disabled="isSaving" @click.stop="handleSave">
            <span v-if="isSaving" class="spinner" />
            <span v-else>Save</span>
          </button>
        </template>
        <template v-else>
          <button class="btn-sm" @click.stop="startEdit">Edit</button>
          <button class="btn-sm danger" @click.stop="handleDelete">Delete</button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, reactive, nextTick } from 'vue';
import { updateEntry } from '../api/entries.js';

const CATEGORIES = ['Characters', 'Worlds', 'Organizations', 'Lore & Mechanics', 'Timeline'];

const props = defineProps({ entry: Object, expanded: Boolean });
const emit = defineEmits(['toggle', 'tag-click', 'delete', 'saved']);

const CAT_COLORS = {
  'Characters':      { bg: '#B5D4F4', color: '#0C447C' },
  'Worlds':          { bg: '#9FE1CB', color: '#085041' },
  'Organizations':   { bg: '#F5C4B3', color: '#712B13' },
  'Lore & Mechanics':{ bg: '#CECBF6', color: '#3C3489' },
  'Timeline':        { bg: '#FAC775', color: '#633806' },
};

const cardEl = ref(null);
const isEditing = ref(false);
const isSaving = ref(false);

const form = reactive({ title: '', category: '', summary: '', body: '', tagsRaw: '' });

const catStyle = computed(() => CAT_COLORS[props.entry.category] ?? { bg: '#333', color: '#aaa' });

const bodyParagraphs = computed(() =>
  props.entry.body.split('\n').filter(p => p.trim())
);

const isDirty = computed(() =>
  form.title !== props.entry.title ||
  form.category !== props.entry.category ||
  form.summary !== props.entry.summary ||
  form.body !== props.entry.body ||
  form.tagsRaw !== props.entry.tags.join(', ')
);

function handleCardClick() {
  if (isEditing.value) return;
  emit('toggle');
}

function startEdit() {
  form.title = props.entry.title;
  form.category = props.entry.category;
  form.summary = props.entry.summary;
  form.body = props.entry.body;
  form.tagsRaw = props.entry.tags.join(', ');
  isEditing.value = true;
  nextTick(() => {
    cardEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function resetForm() {
  form.title = props.entry.title;
  form.category = props.entry.category;
  form.summary = props.entry.summary;
  form.body = props.entry.body;
  form.tagsRaw = props.entry.tags.join(', ');
}

function cancelOrUndo() {
  if (isDirty.value) {
    resetForm();
  } else {
    isEditing.value = false;
  }
}

async function handleSave() {
  if (isSaving.value) return;
  isSaving.value = true;
  try {
    const updated = await updateEntry(props.entry._id, {
      title: form.title.trim(),
      category: form.category,
      summary: form.summary.trim(),
      body: form.body.trim(),
      tags: form.tagsRaw.split(',').map(t => t.trim()).filter(Boolean),
    });
    isEditing.value = false;
    emit('saved', updated);
  } finally {
    isSaving.value = false;
  }
}

function handleDelete() {
  if (confirm(`Delete "${props.entry.title}"?`)) emit('delete');
}
</script>

<style scoped>
.edit-input {
  width: 100%;
  background: #0e0e0e;
  border: 1px solid #444;
  border-radius: 6px;
  color: #e0e0e0;
  font-family: inherit;
  font-size: 13px;
  padding: 5px 8px;
}
.edit-input:focus { outline: none; border-color: #666; }

.title-input { font-size: 14px; font-weight: 500; }
.summary-input { margin-top: 6px; color: #aaa; }

.edit-select {
  background: #0e0e0e;
  border: 1px solid #444;
  border-radius: 6px;
  color: #e0e0e0;
  font-family: inherit;
  font-size: 11px;
  padding: 3px 7px;
  flex-shrink: 0;
}
.edit-select:focus { outline: none; border-color: #666; }

.edit-textarea {
  width: 100%;
  min-height: 120px;
  resize: vertical;
  background: #0e0e0e;
  border: 1px solid #444;
  border-radius: 6px;
  color: #e0e0e0;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.7;
  padding: 7px 8px;
}
.edit-textarea:focus { outline: none; border-color: #666; }

.edit-tags-row { margin-top: 8px; }

.spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 2px solid #444;
  border-top-color: #e0e0e0;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  vertical-align: middle;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
