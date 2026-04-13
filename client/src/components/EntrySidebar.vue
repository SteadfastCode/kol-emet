<template>
  <div class="entry-list">
    <!-- Header -->
    <div class="list-header">
      <div class="header-top">
        <span class="site-title">Kol Emet</span>
        <div class="header-actions">
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
          v-for="cat in ['All', ...CATEGORIES]"
          :key="cat"
          class="pill"
          :class="{ active: (activeCat === cat || (cat === 'All' && !activeCat)) && !activeTag }"
          @click="$emit('set-cat', cat)"
        >{{ cat }}</span>
        <span v-if="activeTag" class="pill active" @click="$emit('clear-tag')">#{{ activeTag }} ✕</span>
      </div>

      <div class="entry-count">{{ entries.length }} entries</div>
    </div>

    <!-- Entry list -->
    <div v-if="loading" class="list-empty">Loading…</div>
    <VirtualList v-else-if="entries.length" :items="entries">
      <template #default="{ item }">
        <SidebarCard
          :entry="item"
          :selected="item._id === selectedId"
          @select="$emit('select', $event, item.title)"
        />
      </template>
    </VirtualList>
    <div v-else class="list-empty">No entries found.</div>
  </div>
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
.entry-list {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #0f0f0f;
  overflow: hidden;
}

.list-header {
  flex-shrink: 0;
  padding: 14px 20px 10px;
  border-bottom: 1px solid #1e1e1e;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.header-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.site-title {
  font-size: 15px;
  font-weight: 700;
  color: #e0e0e0;
  letter-spacing: 0.01em;
}

.header-actions {
  display: flex;
  gap: 6px;
}

.search-input {
  width: 100%;
  padding: 8px 12px;
  font-size: 13px;
  border-radius: 8px;
  border: 1px solid #2a2a2a;
  background: #161616;
  color: #e0e0e0;
  font-family: inherit;
  box-sizing: border-box;
}
.search-input:focus { outline: none; border-color: #444; }
.search-input::placeholder { color: #444; }

.cat-pills {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}

.entry-count {
  font-size: 11px;
  color: #3a3a3a;
}

/* Entry list scroll area */
.list-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.list-empty {
  padding: 40px 20px;
  color: #444;
  font-size: 13px;
  text-align: center;
}
</style>
