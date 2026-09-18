<template>
  <div class="entity-editor">
    <div class="editor-header">
      <h2 class="editor-title">New Entity</h2>
      <button class="icon-btn" title="Cancel" @click="$emit('cancel')">✕</button>
    </div>

    <!-- Core fields -->
    <div class="editor-fields">
      <input
        v-model="form.title"
        class="input title-input"
        placeholder="Entity title"
        @blur="applyDefaultBlocks"
      />

      <select v-model="form.category" class="input" @change="applyDefaultBlocks">
        <option value="" disabled>Select category</option>
        <option v-for="cat in categoryNames" :key="cat" :value="cat">{{ cat }}</option>
      </select>

      <input
        v-model="form.summary"
        class="input"
        placeholder="One-line summary (optional)"
      />

      <!--
        Tags stay a plain comma-separated text field; the suggestion list only
        offers what the workspace already uses, so a typo becomes a reused tag
        instead of a new one-off. ARIA combobox pattern: the input owns the
        list, the list owns the options.
      -->
      <div class="tag-field">
        <input
          v-model="tagsInput"
          class="input"
          placeholder="Tags, comma-separated (optional)"
          role="combobox"
          autocomplete="off"
          aria-autocomplete="list"
          :aria-controls="tagListId"
          :aria-expanded="suggestOpen ? 'true' : 'false'"
          :aria-activedescendant="activeOptionId"
          @input="onTagsInput"
          @focus="tagsFocused = true"
          @blur="tagsFocused = false"
          @keydown.down="onTagsArrow($event, 1)"
          @keydown.up="onTagsArrow($event, -1)"
          @keydown.enter="onTagsEnter"
          @keydown.esc="onTagsEscape"
        />
        <ul v-if="suggestOpen" :id="tagListId" class="tag-suggest" role="listbox">
          <li
            v-for="(tag, i) in tagSuggestions"
            :id="tagOptionId(i)"
            :key="tag"
            class="tag-suggest-option"
            :class="{ active: i === activeSuggestion }"
            role="option"
            :aria-selected="i === activeSuggestion"
            @mousedown.prevent="chooseTag(tag, 'click')"
          >{{ tag }}</li>
        </ul>
      </div>
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
        <span v-if="isSaving" class="spinner" /><span v-else>Create entity</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, useId } from 'vue';
import draggable from 'vuedraggable';
import { useEntityTypes } from '../composables/useEntityTypes.js';
import { getTags } from '../api/tags.js';
import { getDefaultBlocks } from '../config/defaultBlocks.js';

const BLOCK_TYPES = ['text', 'timeline_event', 'attribute', 'quote', 'gallery'];
const BLOCK_TYPE_LABELS = {
  text: 'Text',
  timeline_event: 'Timeline Event',
  attribute: 'Attribute',
  quote: 'Quote',
  gallery: 'Gallery',
};
const BLOCK_DEFAULTS = {
  text: { markdown: '' },
  timeline_event: { date: '', sortKey: 0, era: '', description: '', linkedEntryId: null },
  attribute: { label: '', value: '' },
  quote: { text: '', attribution: '' },
  gallery: { images: [] },
};

const emit = defineEmits(['saved', 'cancel']);

const { names: categoryNames } = useEntityTypes();

/**
 * `initial` hydrates the editor from an existing payload — used by the draft
 * review screen, where editing a proposed entity should open the real editor
 * rather than a stripped-down form. Reusing this component is what makes an
 * edited draft item come back in exactly the shape `proposed` uses, which is
 * what the server revalidates against.
 */
const props = defineProps({
  initial: { type: Object, default: null },
});

const form = reactive({ title: '', category: '', summary: '' });
const tagsInput = ref('');
const blocks = ref([]);
const showAddMenu = ref(false);
const isSaving = ref(false);
let keyCounter = 0;

function makeKey() { return ++keyCounter; }

// Hydrate before anything else runs, so applyDefaultBlocks does not overwrite
// imported blocks with category defaults.
if (props.initial) {
  form.title    = props.initial.title ?? '';
  form.category = props.initial.normalizedCategory ?? props.initial.category ?? '';
  form.summary  = props.initial.summary ?? '';
  tagsInput.value = (props.initial.tags ?? []).join(', ');
  blocks.value = (props.initial.blocks ?? []).map(b => ({
    type: b.type,
    order: b.order,
    data: { ...b.data },
    _key: makeKey(),
  }));
}

/* ── Tag suggestions ──────────────────────────────────────────────────────
 * The workspace's tags (GET /tags), offered against the token after the last
 * comma. Prefix matches first, then substring, tags already in the field
 * dropped, at most MAX_TAG_SUGGESTIONS shown. The fetch is best-effort: if it
 * fails there is simply no list, and the field still saves whatever was typed.
 *
 * Tiered debug logging: set localStorage.TAG_SUGGEST_LOG_LEVEL to
 * off | light | normal | verbose (default light).
 *   light   — a failed load, and every change the list makes to the field,
 *             naming what made it (click or keyboard) and the old value
 *   normal  — light, plus the load itself and the list opening and closing
 *   verbose — normal, plus the matches computed for each token
 */

const MAX_TAG_SUGGESTIONS = 8;
const TAG_LOG_LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function tagLog(level, msg) {
  let setting = null;
  try { setting = localStorage.getItem('TAG_SUGGEST_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((TAG_LOG_LEVELS[setting] ?? TAG_LOG_LEVELS.light) >= TAG_LOG_LEVELS[level]) {
    console.log(`[tagSuggest:${level}] ${msg}`);
  }
}

const workspaceTags = ref([]);
const tagsFocused = ref(false);
const suggestDismissed = ref(false);
const activeSuggestion = ref(-1);

// Unique per editor: two editors can be open at once (the wiki panel and a
// draft being reviewed), and aria-controls needs to point at the right list.
const tagListId = useId();
const tagOptionId = (i) => `${tagListId}-option-${i}`;

onMounted(async () => {
  try {
    const fetched = await getTags();
    workspaceTags.value = Array.isArray(fetched) ? fetched : [];
    tagLog('normal', `loaded ${workspaceTags.value.length} workspace tag(s) for suggestions`);
    tagLog('verbose', `workspace tags: ${workspaceTags.value.join(', ')}`);
  } catch (err) {
    tagLog('light', `GET /tags failed, so this editor offers no suggestions (typed tags still save): ${err.message}`);
  }
});

/** Everything before the last comma as finished tags, plus the token being typed. */
function splitTagsInput(value) {
  const parts = value.split(',');
  const token = parts.pop() ?? '';
  return { entered: parts.map(t => t.trim()).filter(Boolean), token: token.trim() };
}

const tagSuggestions = computed(() => {
  const { entered, token } = splitTagsInput(tagsInput.value);
  const taken = new Set(entered.map(t => t.toLowerCase()));
  const query = token.toLowerCase();
  const prefix = [];
  const substring = [];
  for (const tag of workspaceTags.value) {
    if (typeof tag !== 'string' || !tag.trim()) continue;
    const at = tag.toLowerCase().indexOf(query);
    if (at < 0 || taken.has(tag.toLowerCase())) continue;
    (at === 0 ? prefix : substring).push(tag);
  }
  return [...prefix, ...substring].slice(0, MAX_TAG_SUGGESTIONS);
});

const suggestOpen = computed(() =>
  tagsFocused.value && !suggestDismissed.value && tagSuggestions.value.length > 0);

const activeOptionId = computed(() =>
  (suggestOpen.value && activeSuggestion.value >= 0) ? tagOptionId(activeSuggestion.value) : null);

function onTagsInput() {
  suggestDismissed.value = false;
  activeSuggestion.value = -1;
  tagLog('verbose', `token "${splitTagsInput(tagsInput.value).token}" matches: ${tagSuggestions.value.join(', ') || '(none)'}`);
}

function onTagsArrow(event, delta) {
  const count = tagSuggestions.value.length;
  if (!count) return;
  event.preventDefault();
  // An arrow key re-opens a list Escape closed, the way a native combobox does.
  if (suggestDismissed.value) {
    suggestDismissed.value = false;
    tagLog('normal', 'suggestion list re-opened by an arrow key');
  }
  activeSuggestion.value = activeSuggestion.value < 0
    ? (delta > 0 ? 0 : count - 1)
    : (activeSuggestion.value + delta + count) % count;
}

function onTagsEnter(event) {
  if (!suggestOpen.value || activeSuggestion.value < 0) return;
  event.preventDefault();
  chooseTag(tagSuggestions.value[activeSuggestion.value], 'keyboard');
}

// Escape closes the list only. The editor stays open — the panel's own close
// button is the way out — so the key never does two things at once.
function onTagsEscape(event) {
  if (!suggestOpen.value) return;
  event.preventDefault();
  event.stopPropagation();
  suggestDismissed.value = true;
  activeSuggestion.value = -1;
  tagLog('normal', 'suggestion list closed by Escape; the editor stays open');
}

/** Replaces the token being typed with `tag` and opens the next one. */
function chooseTag(tag, source) {
  const previous = tagsInput.value;
  const { entered } = splitTagsInput(previous);
  tagsInput.value = `${[...entered, tag].join(', ')}, `;
  activeSuggestion.value = -1;
  suggestDismissed.value = false;
  tagLog('light', `tags set by a ${source} suggestion "${tag}": "${previous}" -> "${tagsInput.value}"`);
}

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
  });
  showAddMenu.value = false;
}

function removeBlock(index) {
  blocks.value.splice(index, 1);
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
      const { _key, ...rest } = b;
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
.entity-editor {
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

.tag-field { position: relative; }
.tag-field .input { width: 100%; }

.tag-suggest {
  position: absolute;
  z-index: 5;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  margin: 0;
  padding: 4px;
  list-style: none;
  max-height: 200px;
  overflow-y: auto;
  background: #161616;
  border: 1px solid #333;
  border-radius: 7px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.45);
}
.tag-suggest-option {
  font-size: 12px;
  color: #888;
  padding: 5px 8px;
  border-radius: 5px;
  cursor: pointer;
}
.tag-suggest-option:hover,
.tag-suggest-option.active { background: #222; color: #e0e0e0; }

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
