<template>
  <div class="entry-header-wrap">
    <!-- View mode -->
    <template v-if="!isEditing">
      <div class="entry-header">
        <div class="header-top">
          <h2 class="entry-title">{{ entry.title }}</h2>
          <div class="header-right">
            <span class="entry-cat" :style="catStyle">{{ entry.category }}</span>
            <button class="icon-btn" title="Edit header" @click="startEdit">✏</button>
          </div>
        </div>
        <p class="entry-summary">{{ entry.summary }}</p>
        <div v-if="entry.tags?.length" class="entry-tags">
          <span
            v-for="tag in entry.tags" :key="tag"
            class="tag"
            @click="$emit('set-tag', tag)"
          >#{{ tag }}</span>
        </div>
        <div v-if="entry.open_questions?.length" class="oq-list">
          <div class="oq-label">Open questions</div>
          <div v-for="oq in entry.open_questions" :key="oq._id" class="oq-item">
            <span class="oq-badge">{{ oq.status }}</span>
            {{ oq.question }}
          </div>
        </div>
      </div>
    </template>

    <!-- Edit mode -->
    <template v-else>
      <div class="header-edit">
        <input v-model="form.title" class="input edit-title" placeholder="Title" @click.stop />

        <div class="edit-row">
          <select v-model="form.category" class="input edit-select">
            <option v-for="cat in CATEGORIES" :key="cat">{{ cat }}</option>
          </select>
        </div>

        <input v-model="form.summary" class="input" placeholder="Summary" @click.stop />

        <input
          v-model="form.tagsRaw"
          class="input"
          placeholder="Tags (comma separated)"
          @click.stop
        />

        <div class="edit-actions">
          <button class="btn-sm" @click="cancelEdit">Cancel</button>
          <button class="btn-sm primary" :disabled="isSaving || !form.title.trim()" @click="save">
            <span v-if="isSaving" class="spinner" />
            <span v-else>Save</span>
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, reactive } from 'vue';
import { CAT_COLORS, CATEGORIES } from '../config/categories.js';

const props = defineProps({ entry: Object });
const emit = defineEmits(['save', 'set-tag']);

const isEditing = ref(false);
const isSaving = ref(false);
const form = reactive({ title: '', category: '', summary: '', tagsRaw: '' });

const catStyle = computed(() => CAT_COLORS[props.entry.category] ?? { bg: '#333', color: '#aaa' });

function startEdit() {
  form.title = props.entry.title;
  form.category = props.entry.category;
  form.summary = props.entry.summary;
  form.tagsRaw = (props.entry.tags ?? []).join(', ');
  isEditing.value = true;
}

function cancelEdit() { isEditing.value = false; }

async function save() {
  isSaving.value = true;
  try {
    await emit('save', {
      title: form.title.trim(),
      category: form.category,
      summary: form.summary.trim(),
      tags: form.tagsRaw.split(',').map(t => t.trim()).filter(Boolean),
    });
    isEditing.value = false;
  } finally {
    isSaving.value = false;
  }
}
</script>

<style scoped>
.entry-header-wrap { padding: 20px 24px 0; }

.entry-header { display: flex; flex-direction: column; gap: 10px; }

.header-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.entry-title { font-size: 1.4rem; font-weight: 600; color: #e0e0e0; }

.header-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

.entry-summary { font-size: 14px; color: #888; line-height: 1.5; }

.entry-tags { display: flex; gap: 6px; flex-wrap: wrap; }

.oq-list { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.oq-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #c07020; }
.oq-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; background: #2a1800; border-radius: 7px; font-size: 12px; color: #f0a040;
}

/* Edit mode */
.header-edit { display: flex; flex-direction: column; gap: 8px; }
.edit-title { font-size: 15px; font-weight: 500; }
.edit-row { display: flex; gap: 8px; }
.edit-select { flex: 1; }
.edit-actions { display: flex; gap: 8px; justify-content: flex-end; }

.icon-btn {
  background: none; border: none; color: #444; cursor: pointer;
  font-size: 13px; padding: 2px 4px; border-radius: 4px; transition: color 0.1s;
}
.icon-btn:hover { color: #aaa; }
</style>
