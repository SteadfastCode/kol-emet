<template>
  <div
    class="sidebar-card"
    :class="{ selected }"
    @click="$emit('select', entity._id, entity.title)"
  >
    <div class="card-top">
      <span class="card-title">{{ entity.title }}</span>
      <span class="entity-cat" :style="catStyle">{{ entity.category }}</span>
    </div>
    <div class="card-summary">{{ entity.summary }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useEntityTypes } from '../composables/useEntityTypes.js';

const props = defineProps({
  entity: Object,
  selected: Boolean,
});

defineEmits(['select']);

const { styleFor } = useEntityTypes();

const catStyle = computed(() => {
  const c = styleFor(props.entity.category);
  return { background: c.bg, color: c.color };
});
</script>

<style scoped>
.sidebar-card {
  height: 64px;
  padding: 0 20px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  cursor: pointer;
  border-bottom: 1px solid #1a1a1a;
  transition: background 0.1s;
  user-select: none;
}

.sidebar-card:hover { background: #141414; }
.sidebar-card.selected { background: #1a1a1a; border-left: 2px solid #e0e0e0; padding-left: 18px; }

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

.entity-cat {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 999px;
  white-space: nowrap;
  flex-shrink: 0;
  opacity: 0.85;
}

.card-summary {
  font-size: 11px;
  color: #555;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
