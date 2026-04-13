<template>
  <div class="wiki-layout">
    <EntrySidebar
      :entries="filtered"
      :active-cat="activeCat"
      :active-tag="activeTag"
      :search-query="searchQuery"
      :selected-id="selectedEntry?._id"
      :loading="sidebarLoading"
      @search="searchQuery = $event"
      @set-cat="setCat"
      @set-tag="setTag"
      @clear-tag="clearTag"
      @select="openEntry"
      @new-entry="showEditor = true"
      @logout="$emit('logout')"
    />

    <main class="main-panel">
      <EntryEditor
        v-if="showEditor"
        @saved="onEntrySaved"
        @cancel="showEditor = false"
      />
      <EntryDetail
        v-else-if="selectedEntry"
        :entry="selectedEntry"
        :loading="detailLoading"
        :breadcrumbs="breadcrumbs"
        @crumb-click="onCrumbClick"
        @follow-link="followLink"
        @set-tag="setTag"
        @saved="onEntryUpdated"
        @deleted="onEntryDeleted"
      />
      <div v-else class="empty-state">
        <p>Select an entry to view it, or create a new one.</p>
      </div>
    </main>
  </div>
</template>

<script setup>
import { provide, onMounted } from 'vue';
import EntrySidebar from './EntrySidebar.vue';
import EntryDetail from './EntryDetail.vue';
import EntryEditor from './EntryEditor.vue';
import { useEntries } from '../composables/useEntries.js';
import { useFilters } from '../composables/useFilters.js';
import { useNavigation } from '../composables/useNavigation.js';
import { ref } from 'vue';

const emit = defineEmits(['logout']);

const {
  entries, selectedEntry, sidebarLoading, detailLoading,
  loadEntries, selectEntry, addEntry, editEntry, removeEntry,
} = useEntries();

const { searchQuery, activeCat, activeTag, filtered, setCat, setTag, clearTag } = useFilters(entries);
const { breadcrumbs, startNavigation, pushCrumb, navigateToIndex } = useNavigation();

const showEditor = ref(false);

onMounted(() => loadEntries());

function openEntry(id, title) {
  showEditor.value = false;
  startNavigation(id, title);
  selectEntry(id);
}

function followLink(id, title) {
  pushCrumb(id, title);
  selectEntry(id);
}

function onCrumbClick(index) {
  const crumb = navigateToIndex(index);
  selectEntry(crumb.id);
}

async function onEntrySaved(data) {
  const entry = await addEntry(data);
  showEditor.value = false;
  openEntry(entry._id, entry.title);
}

async function onEntryUpdated(id, data) {
  await editEntry(id, data);
}

async function onEntryDeleted(id) {
  await removeEntry(id);
}

// Provide for deep components (TextBlock [[links]], RelationshipBlock navigation)
provide('entries', entries);
provide('followLink', followLink);
</script>

<style scoped>
.wiki-layout {
  display: grid;
  grid-template-columns: var(--sidebar-width, 300px) 1fr;
  height: 100vh;
  overflow: hidden;
}

.main-panel {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow-y: auto;
  background: #121212;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #444;
  font-size: 14px;
}
</style>
