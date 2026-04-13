<template>
  <div class="rel-type-input">
    <label class="input-label">Relationship type</label>
    <div class="input-wrap">
      <input
        ref="inputEl"
        v-model="query"
        class="input"
        placeholder="e.g. mentor, sibling, created by…"
        autocomplete="off"
        @input="onInput"
        @keydown.down.prevent="moveDown"
        @keydown.up.prevent="moveUp"
        @keydown.enter.prevent="confirmSelection"
        @keydown.escape="close"
        @blur="onBlur"
        @focus="onFocus"
      />
    </div>

    <div v-if="showDropdown" class="type-dropdown">
      <div
        v-for="(item, i) in suggestions"
        :key="item._id ?? item.name"
        class="type-option"
        :class="{ highlighted: i === highlightIndex }"
        @mousedown.prevent="selectItem(item)"
      >
        <span class="type-name">{{ item.name }}</span>
        <span v-if="item.isNew" class="type-badge new">new</span>
      </div>
      <div v-if="suggestions.length === 0 && query.trim()" class="type-empty">
        Press Enter to create "{{ query.trim() }}"
      </div>
    </div>

    <div v-if="warning" class="type-warning">
      Similar type exists: "{{ warning }}" — did you mean that?
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import Fuse from 'fuse.js';
import { getRelationshipTypes, createRelationshipType } from '../api/relationshipTypes.js';

const props = defineProps({
  modelValue: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);

const query = ref(props.modelValue);
const allTypes = ref([]);
const highlightIndex = ref(-1);
const isOpen = ref(false);
const warning = ref('');

watch(() => props.modelValue, v => { if (v !== query.value) query.value = v; });
watch(query, v => emit('update:modelValue', v));

async function loadTypes() {
  try {
    const data = await getRelationshipTypes();
    allTypes.value = data ?? [];
  } catch {}
}
loadTypes();

const fuse = computed(() =>
  new Fuse(allTypes.value, { keys: ['name'], threshold: 0.4, includeScore: true })
);

const suggestions = computed(() => {
  const q = query.value.trim();
  if (!q) return allTypes.value.slice(0, 8).map(t => ({ ...t, isNew: false }));
  const results = fuse.value.search(q).map(r => ({ ...r.item, isNew: false }));
  const exact = allTypes.value.some(t => t.name.toLowerCase() === q.toLowerCase());
  if (!exact) results.push({ name: q, _id: null, isNew: true });
  return results.slice(0, 8);
});

const showDropdown = computed(() => isOpen.value && (suggestions.value.length > 0 || query.value.trim()));

function onInput() {
  warning.value = '';
  isOpen.value = true;
  highlightIndex.value = -1;
}

function onFocus() { isOpen.value = true; }
function onBlur() { setTimeout(() => { isOpen.value = false; }, 150); }
function close() { isOpen.value = false; }

function moveDown() {
  if (highlightIndex.value < suggestions.value.length - 1) highlightIndex.value++;
}
function moveUp() {
  if (highlightIndex.value > 0) highlightIndex.value--;
}

function confirmSelection() {
  if (highlightIndex.value >= 0 && suggestions.value[highlightIndex.value]) {
    selectItem(suggestions.value[highlightIndex.value]);
  } else if (query.value.trim()) {
    selectByName(query.value.trim());
  }
}

async function selectItem(item) {
  if (item.isNew) {
    await selectByName(item.name);
  } else {
    query.value = item.name;
    isOpen.value = false;
  }
}

async function selectByName(name) {
  const existing = allTypes.value.find(t => t.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    query.value = existing.name;
    isOpen.value = false;
    return;
  }
  try {
    const result = await createRelationshipType({ name });
    if (result.warning) warning.value = result.warning;
    allTypes.value.push(result.type ?? result);
    query.value = name;
  } catch {}
  isOpen.value = false;
}
</script>

<style scoped>
.rel-type-input { position: relative; }

.input-label {
  display: block;
  font-size: 11px;
  color: #555;
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.type-dropdown {
  position: absolute;
  left: 0; right: 0; top: calc(100% + 2px);
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 7px;
  z-index: 10;
  max-height: 200px;
  overflow-y: auto;
}

.type-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 13px;
  cursor: pointer;
  color: #ccc;
}
.type-option:hover,
.type-option.highlighted { background: #252525; }

.type-name { flex: 1; }

.type-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
}
.type-badge.new {
  background: #1e2a3a;
  color: #7ab4f5;
  border: 1px solid #2a4a6a;
}

.type-empty {
  padding: 7px 10px;
  font-size: 12px;
  color: #555;
  font-style: italic;
}

.type-warning {
  margin-top: 4px;
  font-size: 11px;
  color: #f5a07a;
}
</style>
