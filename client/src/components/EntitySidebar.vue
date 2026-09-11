<template>
  <div class="entity-list">
    <!-- Header -->
    <div class="list-header">
      <div class="header-top">
        <span class="site-title">Kol Emet</span>
        <div class="header-actions">
          <button class="btn-sm primary" @click="$emit('new-entry')">+ New</button>
          <button
            class="btn-sm btn-icon"
            :class="{ active: graphOpen }"
            title="Relationship Graph"
            @click="$emit('graph')"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
              <circle cx="4"  cy="10" r="2"/>
              <circle cx="16" cy="4"  r="2"/>
              <circle cx="16" cy="16" r="2"/>
              <circle cx="10" cy="10" r="2"/>
              <line x1="6"  y1="10" x2="8"  y2="10"/>
              <line x1="12" y1="10" x2="14" y2="5"/>
              <line x1="12" y1="10" x2="14" y2="15"/>
            </svg>
          </button>
          <button class="btn-sm" title="Generate a draft from notes" @click="$emit('generate')">Draft</button>
          <button class="btn-sm" title="AI Chat" @click="$emit('chat')">AI</button>
          <button class="btn-sm" @click="$emit('settings')">Settings</button>
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

      <div class="entity-count">{{ entities.length }} entities</div>
    </div>

    <!-- Entity list -->
    <div v-if="loading" class="list-empty">Loading…</div>
    <VirtualList v-else-if="entities.length" :items="entities">
      <template #default="{ item }">
        <SidebarCard
          :entity="item"
          :selected="item._id === selectedId"
          @select="$emit('select', $event, item.title)"
        />
      </template>
    </VirtualList>
    <!-- A filtered-to-nothing view and a genuinely empty workspace need
         different responses: one wants the filter cleared, the other wants a
         way to start. -->
    <div v-else-if="isFiltered" class="list-empty">
      <p class="empty-title">No matches</p>
      <p class="empty-body">Nothing here matches your current search or filters.</p>
      <button class="btn-sm" @click="$emit('reset-filters')">Clear filters</button>
    </div>
    <div v-else class="list-empty">
      <p class="empty-title">Your wiki is empty</p>
      <p class="empty-body">
        Entities are the nodes of your graph — characters, worlds, organizations.
        Create one, then link them together to build the map.
      </p>
      <div class="empty-actions">
        <button class="btn-sm primary" @click="$emit('new-entry')">Create your first entity</button>
        <button class="btn-sm" @click="$emit('generate')">Or paste in some notes</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import VirtualList from './VirtualList.vue';
import SidebarCard from './SidebarCard.vue';
import { CATEGORIES } from '../config/categories.js';

const props = defineProps({
  entities: Array,
  activeCat: String,
  activeTag: String,
  searchQuery: String,
  selectedId: String,
  loading: Boolean,
  graphOpen: Boolean,
});

// `entities` is already filtered, so an empty list alone can't distinguish
// "no content" from "no matches" — the active filters are what separates them.
const isFiltered = computed(() =>
  Boolean(props.searchQuery?.trim()) ||
  Boolean(props.activeTag) ||
  (props.activeCat && props.activeCat !== 'All')
);

defineEmits(['search', 'set-cat', 'set-tag', 'clear-tag', 'select', 'new-entry', 'logout', 'settings', 'chat', 'graph', 'reset-filters', 'generate']);
</script>

<style scoped>
.entity-list {
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

.entity-count {
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

.empty-title {
  margin: 0 0 6px;
  color: #888;
  font-size: 14px;
  font-weight: 600;
}

.empty-actions { display: flex; flex-direction: column; gap: 6px; align-items: center; }

.empty-body {
  margin: 0 auto 14px;
  max-width: 260px;
  color: #555;
  line-height: 1.5;
}
</style>
