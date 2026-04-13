<template>
  <div class="entry-editor">
    <div class="editor-header">
      <h2 class="editor-title">New Entry</h2>
      <button class="icon-btn" title="Cancel" @click="$emit('cancel')">✕</button>
    </div>

    <!-- Core fields -->
    <div class="editor-fields">
      <input
        v-model="form.title"
        class="input title-input"
        placeholder="Entry title"
        @blur="applyDefaultBlocks"
      />

      <select v-model="form.category" class="input" @change="applyDefaultBlocks">
        <option value="" disabled>Select category</option>
        <option v-for="cat in CATEGORIES" :key="cat" :value="cat">{{ cat }}</option>
      </select>

      <input
        v-model="form.summary"
        class="input"
        placeholder="One-line summary (optional)"
      />

      <input
        v-model="tagsInput"
        class="input"
        placeholder="Tags, comma-separated (optional)"
      />
    </div>

    <!-- Blocks -->
    <div class="blocks-section">
      <div class="blocks-label">Blocks</div>

      <draggable
        v-model="blocks"
        item-key="_key"
        handle=".drag-handle"
        ghost-class="drag-ghost"
        animation="150"
      >
        <template #item="{ element: block, index }">
          <div class="editor-block">
            <div class="editor-block-toolbar">
              <span class="drag-handle" title="Drag to reorder">⠿</span>
              <span class="block-type-label">{{ BLOCK_TYPE_LABELS[block.type] }}</span>
              <button class="icon-btn small danger" title="Remove block" @click="removeBlock(index)">✕</button>
            </div>

            <!-- Text block -->
            <textarea
              v-if="block.type === 'text'"
              v-model="block.data.markdown"
              class="block-textarea"
              placeholder="Markdown text…"
              rows="4"
            />

            <!-- Attribute block -->
            <div v-else-if="block.type === 'attribute'" class="attr-row">
              <input v-model="block.data.label" class="input" placeholder="Label" style="flex:1" />
              <input v-model="block.data.value" class="input" placeholder="Value" style="flex:2" />
            </div>

            <!-- Timeline event block -->
            <div v-else-if="block.type === 'timeline_event'" class="tl-fields">
              <div class="date-row">
                <input v-model="block.data.date" class="input" placeholder="Date" style="flex:2" />
                <input v-model.number="block.data.sortKey" class="input" type="number" placeholder="Sort #" style="flex:1" />
              </div>
              <input v-model="block.data.era" class="input" placeholder="Era (optional)" style="margin-top:6px" />
              <textarea v-model="block.data.description" class="block-textarea" placeholder="Description" rows="2" style="margin-top:6px" />
            </div>

            <!-- Relationship block -->
            <div v-else-if="block.type === 'relationship'" class="rel-fields">
              <RelationshipTypeInput v-model="block.data.relationshipType" />
              <div class="target-search" style="margin-top:8px">
                <input
                  v-model="block._targetSearch"
                  class="input"
                  placeholder="Target entry (search…)"
                  @input="filterTargets(block)"
                />
                <div v-if="block._targetResults?.length" class="target-dropdown">
                  <div
                    v-for="e in block._targetResults"
                    :key="e._id"
                    class="target-option"
                    @click="selectTarget(block, e)"
                  >{{ e.title }}</div>
                </div>
                <div v-if="block.data.targetId" class="selected-target">
                  ✓ {{ block.data.targetTitle }}
                  <button class="icon-btn small" @click="clearTarget(block)">✕</button>
                </div>
              </div>
              <textarea v-model="block.data.notes" class="block-textarea" placeholder="Notes (optional)" rows="2" style="margin-top:8px" />
            </div>

            <!-- Quote block -->
            <div v-else-if="block.type === 'quote'" class="quote-fields">
              <textarea v-model="block.data.text" class="block-textarea" placeholder="Quote text" rows="3" />
              <input v-model="block.data.attribution" class="input" placeholder="Attribution" style="margin-top:6px" />
            </div>

            <!-- Gallery block -->
            <div v-else-if="block.type === 'gallery'" class="gallery-placeholder">
              Image hosting coming soon.
            </div>
          </div>
        </template>
      </draggable>

      <!-- Add block -->
      <div class="add-block-section">
        <div v-if="!showAddMenu" class="add-block-trigger" @click="showAddMenu = true">
          + Add block
        </div>
        <div v-else class="add-block-menu">
          <button
            v-for="type in BLOCK_TYPES"
            :key="type"
            class="block-type-btn"
            @click="addBlock(type)"
          >{{ BLOCK_TYPE_LABELS[type] }}</button>
          <button class="btn-sm" @click="showAddMenu = false">Cancel</button>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="editor-footer">
      <button class="btn-sm" @click="$emit('cancel')">Cancel</button>
      <button class="btn-sm primary" :disabled="isSaving || !form.title.trim()" @click="save">
        <span v-if="isSaving" class="spinner" /><span v-else>Create entry</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, inject } from 'vue';
import draggable from 'vuedraggable';
import RelationshipTypeInput from './RelationshipTypeInput.vue';
import { CATEGORIES } from '../config/categories.js';
import { getDefaultBlocks } from '../config/defaultBlocks.js';

const BLOCK_TYPES = ['text', 'relationship', 'timeline_event', 'attribute', 'quote', 'gallery'];
const BLOCK_TYPE_LABELS = {
  text: 'Text',
  relationship: 'Relationship',
  timeline_event: 'Timeline Event',
  attribute: 'Attribute',
  quote: 'Quote',
  gallery: 'Gallery',
};
const BLOCK_DEFAULTS = {
  text: { markdown: '' },
  relationship: { relationshipType: '', targetId: null, targetTitle: '', notes: '' },
  timeline_event: { date: '', sortKey: 0, era: '', description: '', linkedEntryId: null },
  attribute: { label: '', value: '' },
  quote: { text: '', attribution: '' },
  gallery: { images: [] },
};

const emit = defineEmits(['saved', 'cancel']);
const entries = inject('entries', ref([]));

const form = reactive({ title: '', category: '', summary: '' });
const tagsInput = ref('');
const blocks = ref([]);
const showAddMenu = ref(false);
const isSaving = ref(false);
let keyCounter = 0;

function makeKey() { return ++keyCounter; }

function applyDefaultBlocks() {
  if (blocks.value.length === 0 && form.category) {
    const defaults = getDefaultBlocks(form.category);
    blocks.value = defaults.map(b => ({ ...b, _key: makeKey() }));
  }
}

function addBlock(type) {
  blocks.value.push({
    type,
    order: blocks.value.length,
    data: { ...BLOCK_DEFAULTS[type] },
    _key: makeKey(),
    _targetSearch: '',
    _targetResults: [],
  });
  showAddMenu.value = false;
}

function removeBlock(index) {
  blocks.value.splice(index, 1);
}

// Relationship target search
function filterTargets(block) {
  const q = (block._targetSearch ?? '').toLowerCase();
  if (!q) { block._targetResults = []; return; }
  block._targetResults = (entries.value ?? [])
    .filter(e => e.title.toLowerCase().includes(q))
    .slice(0, 8);
}

function selectTarget(block, entry) {
  block.data.targetId = entry._id;
  block.data.targetTitle = entry.title;
  block._targetSearch = entry.title;
  block._targetResults = [];
}

function clearTarget(block) {
  block.data.targetId = null;
  block.data.targetTitle = '';
  block._targetSearch = '';
  block._targetResults = [];
}

async function save() {
  if (!form.title.trim()) return;
  isSaving.value = true;
  try {
    const tags = tagsInput.value
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    const cleanBlocks = blocks.value.map((b, i) => {
      const { _key, _targetSearch, _targetResults, ...rest } = b;
      return { ...rest, order: i };
    });

    emit('saved', {
      title: form.title.trim(),
      category: form.category,
      summary: form.summary.trim(),
      tags,
      blocks: cleanBlocks,
    });
  } finally {
    isSaving.value = false;
  }
}
</script>

<style scoped>
.entry-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  padding: 24px;
  gap: 20px;
}

.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.editor-title {
  font-size: 18px;
  font-weight: 600;
  color: #e0e0e0;
  margin: 0;
}

.editor-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.title-input {
  font-size: 16px;
  padding: 10px 12px;
}

.blocks-section {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.blocks-label {
  font-size: 11px;
  color: #555;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 8px;
}

.editor-block {
  border: 1px solid #222;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  background: #161616;
}

.editor-block-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.drag-handle {
  color: #444;
  cursor: grab;
  font-size: 14px;
  line-height: 1;
  user-select: none;
}
.drag-handle:active { cursor: grabbing; }

.drag-ghost { opacity: 0.4; }

.icon-btn.small { font-size: 11px; padding: 2px 4px; }
.icon-btn.danger { color: #555; }
.icon-btn.danger:hover { color: #e07070; }

.attr-row { display: flex; gap: 8px; }
.date-row { display: flex; gap: 8px; }

.block-textarea {
  width: 100%; background: #0e0e0e; border: 1px solid #333; border-radius: 7px;
  color: #e0e0e0; font-family: inherit; font-size: 13px; padding: 8px 10px; resize: vertical;
}
.block-textarea:focus { outline: none; border-color: #555; }

.rel-fields { display: flex; flex-direction: column; }

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

.gallery-placeholder {
  font-size: 12px;
  color: #555;
  font-style: italic;
  padding: 8px 0;
}

.add-block-section {
  padding: 8px 0 0;
}
.add-block-trigger {
  font-size: 12px; color: #333; cursor: pointer; padding: 6px 0;
  transition: color 0.1s;
}
.add-block-trigger:hover { color: #777; }
.add-block-menu {
  display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 0;
}
.block-type-btn {
  font-size: 11px; padding: 4px 10px; border-radius: 999px;
  border: 1px solid #333; background: #1a1a1a; color: #888;
  cursor: pointer; transition: all 0.1s;
}
.block-type-btn:hover { color: #e0e0e0; border-color: #555; }

.editor-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid #1e1e1e;
  margin-top: auto;
}
</style>
