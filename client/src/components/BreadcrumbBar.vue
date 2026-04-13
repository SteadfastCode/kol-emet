<template>
  <nav v-if="breadcrumbs.length > 1" class="breadcrumbs">
    <span
      v-for="(crumb, i) in breadcrumbs"
      :key="crumb.id + i"
      class="crumb-wrap"
    >
      <span
        class="crumb"
        :class="{ current: i === breadcrumbs.length - 1 }"
        @click="i < breadcrumbs.length - 1 && $emit('crumb-click', i)"
      >{{ crumb.title }}</span>
      <span v-if="i < breadcrumbs.length - 1" class="sep">›</span>
    </span>
  </nav>
</template>

<script setup>
defineProps({ breadcrumbs: Array });
defineEmits(['crumb-click']);
</script>

<style scoped>
.breadcrumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  padding: 10px 24px;
  border-bottom: 1px solid #1e1e1e;
  background: #0f0f0f;
  flex-shrink: 0;
}

.crumb-wrap { display: flex; align-items: center; gap: 4px; }

.crumb {
  font-size: 12px;
  color: #555;
  cursor: pointer;
  transition: color 0.1s;
}
.crumb:hover { color: #aaa; }
.crumb.current { color: #888; cursor: default; }

.sep { font-size: 12px; color: #333; }
</style>
