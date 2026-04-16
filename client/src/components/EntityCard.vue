<template>
  <div class="card-outer">
    <!-- Ghost placeholder holds layout space while card is fixed -->
    <div class="card-ghost" :style="ghostStyle" />

    <div
      ref="cardEl"
      class="entity-card"
      :class="{ open: expanded, editing: isEditing }"
      @click="handleCardClick"
    >
      <div class="entity-header">
        <div class="entity-meta">
          <input
            v-if="isEditing"
            v-model="form.title"
            class="edit-input title-input"
            @click.stop
          />
          <span v-else class="entity-title">{{ entity.title }}</span>
          <span v-if="!isEditing && entity.open_questions?.length" class="oq-badge">
            {{ entity.open_questions.length === 1 ? 'open question' : `${entity.open_questions.length} open questions` }}
          </span>
        </div>
        <select v-if="isEditing" v-model="form.category" class="edit-select" @click.stop>
          <option v-for="cat in CATEGORIES" :key="cat">{{ cat }}</option>
        </select>
        <span v-else class="entity-cat" :style="catStyle">{{ entity.category }}</span>
      </div>

      <input
        v-if="isEditing"
        v-model="form.summary"
        class="edit-input summary-input"
        placeholder="Summary"
        @click.stop
      />
      <div v-else class="entity-summary">{{ entity.summary }}</div>

      <!-- Animated body wrapper using CSS grid trick -->
      <div class="body-wrapper" :class="{ open: expanded || isEditing }">
        <div class="body-inner">
          <Transition name="mode" mode="out-in">
            <div v-if="isEditing" key="edit" class="body-content" @click.stop>
              <textarea v-model="form.body" class="edit-textarea" placeholder="Full notes…" />
              <input v-model="form.tagsRaw" class="edit-input tags-input" placeholder="Tags (comma separated)" />
            </div>
            <div v-else key="view" class="body-content">
              <p v-for="(para, i) in bodyParagraphs" :key="i">{{ para }}</p>
              <div v-if="entity.open_questions?.length" class="linked-oqs">
                <div class="oq-label">Open questions</div>
                <div v-for="oq in entity.open_questions" :key="oq._id" class="linked-oq">
                  {{ oq.question }}
                </div>
              </div>
              <div v-if="entity.tags.length" class="entity-tags">
                <span
                  v-for="tag in entity.tags" :key="tag"
                  class="tag"
                  @click.stop="$emit('tag-click', tag)"
                >#{{ tag }}</span>
              </div>
            </div>
          </Transition>

          <div class="entity-actions">
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
              <button class="btn-sm" :disabled="isAnotherEditing" @click.stop="startEdit">Edit</button>
              <button class="btn-sm danger" :disabled="isAnotherEditing" @click.stop="handleDelete">Delete</button>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, reactive, nextTick, onBeforeUnmount } from 'vue';
import { updateEntity } from '../api/entities.js';

const CATEGORIES = ['Characters', 'Worlds', 'Organizations', 'Lore & Mechanics', 'Timeline'];

const props = defineProps({
  entity: Object,
  expanded: Boolean,
  isAnotherEditing: Boolean,
});

const emit = defineEmits(['toggle', 'tag-click', 'delete', 'saved', 'edit-start', 'edit-end', 'edit-height']);

const CAT_COLORS = {
  'Characters':       { bg: '#B5D4F4', color: '#0C447C' },
  'Worlds':           { bg: '#9FE1CB', color: '#085041' },
  'Organizations':    { bg: '#F5C4B3', color: '#712B13' },
  'Lore & Mechanics': { bg: '#CECBF6', color: '#3C3489' },
  'Timeline':         { bg: '#FAC775', color: '#633806' },
};

const cardEl = ref(null);
const isEditing = ref(false);
const isSaving = ref(false);
let resizeObserver = null;

const form = reactive({ title: '', category: '', summary: '', body: '', tagsRaw: '' });

const catStyle = computed(() => CAT_COLORS[props.entity.category] ?? { bg: '#333', color: '#aaa' });

const bodyParagraphs = computed(() =>
  props.entity.body.split('\n').filter(p => p.trim())
);

const isDirty = computed(() =>
  form.title    !== props.entity.title    ||
  form.category !== props.entity.category ||
  form.summary  !== props.entity.summary  ||
  form.body     !== props.entity.body     ||
  form.tagsRaw  !== props.entity.tags.join(', ')
);

const ghostStyle = computed(() => ({ height: '0px' }));

function handleCardClick() {
  if (isEditing.value) return;
  emit('toggle');
}

function populateForm() {
  form.title    = props.entity.title;
  form.category = props.entity.category;
  form.summary  = props.entity.summary;
  form.body     = props.entity.body;
  form.tagsRaw  = props.entity.tags.join(', ');
}

function startEdit() {
  populateForm();
  isEditing.value = true;
  emit('edit-start');
  nextTick(() => {
    resizeObserver = new ResizeObserver(() => {
      emit('edit-height', cardEl.value?.getBoundingClientRect().height ?? 0);
    });
    resizeObserver.observe(cardEl.value);
  });
}

function stopEditTracking() {
  resizeObserver?.disconnect();
  resizeObserver = null;
  emit('edit-height', 0);
}

onBeforeUnmount(() => resizeObserver?.disconnect());

function cancelOrUndo() {
  if (isDirty.value) {
    populateForm();
  } else {
    isEditing.value = false;
    stopEditTracking();
    emit('edit-end');
  }
}

async function handleSave() {
  if (isSaving.value) return;
  isSaving.value = true;
  try {
    const updated = await updateEntity(props.entity._id, {
      title:    form.title.trim(),
      category: form.category,
      summary:  form.summary.trim(),
      body:     form.body.trim(),
      tags:     form.tagsRaw.split(',').map(t => t.trim()).filter(Boolean),
    });
    isEditing.value = false;
    stopEditTracking();
    emit('saved', updated);
    emit('edit-end');
  } finally {
    isSaving.value = false;
  }
}

function handleDelete() {
  if (confirm(`Delete "${props.entity.title}"?`)) emit('delete');
}
</script>

<style scoped>
/* Ghost placeholder */
.card-outer {
  position: relative;
}
.card-ghost {
  border-radius: 10px;
  transition: height 0.25s ease;
  pointer-events: none;
}

/* Fixed card when editing */
.entity-card.editing {
  position: fixed;
  top: calc(var(--header-height, 0px) + 0.75rem);
  left: 50%;
  transform: translateX(-50%);
  width: min(760px, calc(100vw - 2rem));
  max-height: calc(100vh - var(--header-height, 0px) - 1.5rem);
  overflow-y: auto;
  z-index: 100;
  border-color: #555;
  box-shadow: 0 8px 48px rgba(0, 0, 0, 0.85);
}

/* Body animation — CSS grid trick */
.body-wrapper {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.25s ease;
}
.body-wrapper.open {
  grid-template-rows: 1fr;
}
.body-inner {
  overflow: hidden;
}
.body-content {
  padding-top: 12px;
  padding-bottom: 2px;
}

/* Edit/view mode cross-fade */
.mode-enter-active,
.mode-leave-active {
  transition: opacity 0.15s ease;
}
.mode-enter-from,
.mode-leave-to {
  opacity: 0;
}

/* Edit inputs */
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

.title-input  { font-size: 14px; font-weight: 500; }
.summary-input { margin-top: 6px; }
.tags-input    { margin-top: 8px; }

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

/* Spinner */
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
