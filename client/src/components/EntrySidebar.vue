<template>
  <aside class="sidebar">
    <!-- Header -->
    <div class="sidebar-header">
      <div class="sidebar-top">
        <span class="sidebar-title">Kol Emet</span>
        <div class="sidebar-actions">
          <button class="btn-sm primary" @click="$emit('new-entry')">+ New</button>
          <button class="btn-sm" @click="$emit('logout')">Sign out</button>
        </div>
      </div>

      <input
        :value="searchQuery"
        class="search-input"
        placeholder="Search entries…"
        @input="$emit('search', $event.target.value)"
      />

      <div class="cat-pills">
        <span
          v-for="cat in ['All', ...CATEGORIES]" :key="cat"
          class="pill" :class="{ active: activeCat === cat && !activeTag }"
          @click="$emit('set-cat', cat)"
        >{{ cat }}</span>
        <span v-if="activeTag" class="pill active" @click="$emit('clear-tag')">#{{ activeTag }} ✕</span>
      </div>

      <div class="entry-count">{{ entries.length }} entries</div>
    </div>

    <!-- Virtualized list -->
    <VirtualList v-if="!loading && entries.length" :items="entries">
      <template #default="{ item }">
        <SidebarCard
          :entry="item"
          :selected="item._id === selectedId"
          @select="$emit('select', $event, item.title)"
        />
      </template>
    </VirtualList>

    <div v-else-if="loading" class="sidebar-empty">Loading…</div>
    <div v-else class="sidebar-empty">No entries found.</div>
  </aside>
</template>

<script setup>
import VirtualList from './VirtualList.vue';
import SidebarCard from './SidebarCard.vue';
import { CATEGORIES } from '../config/categories.js';

defineProps({
  entries: Array,
  activeCat: String,
  activeTag: String,
  searchQuery: String,
  selectedId: String,
  loading: Boolean,
});

defineEmits(['search', 'set-cat', 'set-tag', 'clear-tag', 'select', 'new-entry', 'logout']);
</script>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  height: 100vh;
  border-right: 1px solid #1e1e1e;
  background: #0f0f0f;
  overflow: hidden;
}

.sidebar-header {
  flex-shrink: 0;
  padding: 12px;
  border-bottom: 1px solid #1e1e1e;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sidebar-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.sidebar-title {
  font-size: 14px;
  font-weight: 600;
  color: #e0e0e0;
}

.sidebar-actions {
  display: flex;
  gap: 6px;
}

.search-input {
  width: 100%;
  padding: 6px 10px;
  font-size: 13px;
  border-radius: 7px;
  border: 1px solid #2a2a2a;
  background: #161616;
  color: #e0e0e0;
  font-family: inherit;
}
.search-input:focus { outline: none; border-color: #444; }

.cat-pills {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}

.entry-count {
  font-size: 11px;
  color: #444;
}

.sidebar-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: #444;
}
</style>
