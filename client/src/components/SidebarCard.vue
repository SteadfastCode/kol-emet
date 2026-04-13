<template>
  <div
    class="sidebar-card"
    :class="{ selected }"
    @click="$emit('select', entry._id, entry.title)"
  >
    <div class="card-top">
      <span class="card-title">{{ entry.title }}</span>
      <span class="entry-cat" :style="catStyle">{{ entry.category }}</span>
    </div>
    <div class="card-summary">{{ entry.summary }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { CAT_COLORS } from '../config/categories.js';

const props = defineProps({
  entry: Object,
  selected: Boolean,
});

defineEmits(['select']);

const catStyle = computed(() => CAT_COLORS[props.entry.category] ?? { bg: '#333', color: '#aaa' });
</script>

<style scoped>
.sidebar-card {
  height: 64px;
  padding: 0 12px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  cursor: pointer;
  border-bottom: 1px solid #1e1e1e;
  transition: background 0.1s;
  user-select: none;
}

.sidebar-card:hover { background: #1a1a1a; }
.sidebar-card.selected { background: #1e1e1e; border-left: 2px solid #e0e0e0; }

.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.card-title {
  font-size: 13px;
  font-weight: 500;
  color: #e0e0e0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.card-summary {
  font-size: 11px;
  color: #555;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
