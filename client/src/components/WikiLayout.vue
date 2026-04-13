<template>
  <div class="wiki-root" :class="{ 'panel-open': !!activePanelId }">
    <!-- Full-width list -->
    <div class="list-view">
      <EntrySidebar
        :entries="filtered"
        :active-cat="activeCat"
        :active-tag="activeTag"
        :search-query="searchQuery"
        :selected-id="activePanelId"
        :loading="sidebarLoading"
        @search="searchQuery = $event"
        @set-cat="setCat"
        @set-tag="setTag"
        @clear-tag="clearTag"
        @select="openEntry"
        @new-entry="openEditor"
        @logout="$emit('logout')"
      />
    </div>

    <!-- Detail panel -->
    <Transition name="panel">
      <div v-if="activePanelId" class="detail-panel">
        <div class="panel-chrome">
          <span class="panel-title">{{ activePanel?.title }}</span>
          <div class="panel-chrome-actions">
            <button class="chrome-btn" title="Minimize" @click="minimizePanel">─</button>
            <button class="chrome-btn" title="Close" @click="closePanel(activePanelId)">✕</button>
          </div>
        </div>
        <div class="panel-body">
          <EntryEditor
            v-if="activePanel?.mode === 'editor'"
            @saved="onEntrySaved"
            @cancel="closePanel(activePanelId)"
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
          <div v-else class="panel-loading">Loading…</div>
        </div>
      </div>
    </Transition>

    <!-- Right taskbar — minimized panels -->
    <Transition name="taskbar-fade">
      <div v-if="minimizedPanels.length" class="right-taskbar">
        <div class="taskbar-inner">
          <div
            v-for="panel in minimizedPanels"
            :key="panel.id"
            class="taskbar-item"
            :title="panel.title"
            @click="restorePanel(panel.id)"
          >
            <span class="taskbar-label">{{ panel.title }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, computed, provide, onMounted } from 'vue';
import EntrySidebar from './EntrySidebar.vue';
import EntryDetail from './EntryDetail.vue';
import EntryEditor from './EntryEditor.vue';
import { useEntries } from '../composables/useEntries.js';
import { useFilters } from '../composables/useFilters.js';
import { useNavigation } from '../composables/useNavigation.js';

const EDITOR_ID = '__new_entry__';

const emit = defineEmits(['logout']);

const {
  entries, selectedEntry, sidebarLoading, detailLoading,
  loadEntries, selectEntry, addEntry, editEntry, removeEntry,
} = useEntries();

const { searchQuery, activeCat, activeTag, filtered, setCat, setTag, clearTag } = useFilters(entries);
const { breadcrumbs, startNavigation, pushCrumb, navigateToIndex } = useNavigation();

// Panel state: array of { id, title, mode: 'entry' | 'editor' }
const panels = ref([]);
const activePanelId = ref(null);

const activePanel = computed(() =>
  panels.value.find(p => p.id === activePanelId.value) ?? null
);

const minimizedPanels = computed(() =>
  panels.value.filter(p => p.id !== activePanelId.value)
);

onMounted(() => loadEntries());

function openEntry(id, title) {
  const existing = panels.value.find(p => p.id === id);
  if (!existing) {
    panels.value.push({ id, title, mode: 'entry' });
  } else {
    existing.title = title; // keep title fresh
  }
  activePanelId.value = id;
  startNavigation(id, title);
  selectEntry(id);
}

function openEditor() {
  const existing = panels.value.find(p => p.id === EDITOR_ID);
  if (!existing) {
    panels.value.push({ id: EDITOR_ID, title: 'New Entry', mode: 'editor' });
  }
  activePanelId.value = EDITOR_ID;
}

function minimizePanel() {
  // Remove from active; panel stays in array → visible in taskbar
  activePanelId.value = null;
}

function closePanel(id) {
  panels.value = panels.value.filter(p => p.id !== id);
  if (activePanelId.value === id) {
    activePanelId.value = panels.value.at(-1)?.id ?? null;
    if (activePanelId.value && activePanel.value?.mode === 'entry') {
      selectEntry(activePanelId.value);
    }
  }
}

function restorePanel(id) {
  activePanelId.value = id;
  const panel = panels.value.find(p => p.id === id);
  if (panel?.mode === 'entry') selectEntry(id);
}

function followLink(id, title) {
  pushCrumb(id, title);
  // Update the active panel title + entry
  const panel = panels.value.find(p => p.id === activePanelId.value);
  if (panel) panel.title = title;
  selectEntry(id);
}

function onCrumbClick(index) {
  const crumb = navigateToIndex(index);
  const panel = panels.value.find(p => p.id === activePanelId.value);
  if (panel) panel.title = crumb.title;
  selectEntry(crumb.id);
}

async function onEntrySaved(data) {
  const entry = await addEntry(data);
  closePanel(EDITOR_ID);
  openEntry(entry._id, entry.title);
}

async function onEntryUpdated(id, data) {
  await editEntry(id, data);
}

async function onEntryDeleted(id) {
  await removeEntry(id);
  closePanel(id);
}

provide('entries', entries);
provide('followLink', followLink);
</script>

<style scoped>
.wiki-root {
  display: flex;
  height: 100vh;
  overflow: hidden;
  position: relative;
}

/* List view — full width by default, shrinks when panel is open */
.list-view {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  transition: flex 0.3s ease;
}
.wiki-root.panel-open .list-view {
  flex: 0 0 320px;
}

/* Detail panel */
.detail-panel {
  display: flex;
  flex-direction: column;
  flex: 0 0 0;
  overflow: hidden;
  background: #121212;
  border-left: 1px solid #1e1e1e;
  transition: flex-basis 0.3s ease;
}
.wiki-root.panel-open .detail-panel {
  flex: 1;
}

.panel-chrome {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid #1e1e1e;
  background: #0f0f0f;
  gap: 12px;
}

.panel-title {
  font-size: 13px;
  font-weight: 500;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.panel-chrome-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.chrome-btn {
  background: none;
  border: none;
  color: #444;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 4px;
  transition: color 0.1s, background 0.1s;
}
.chrome-btn:hover { color: #ccc; background: #222; }

.panel-body {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.panel-loading {
  padding: 32px;
  color: #444;
  font-size: 13px;
}

/* Panel slide transition */
.panel-enter-active,
.panel-leave-active {
  transition: flex-basis 0.3s ease, opacity 0.2s ease;
}
.panel-enter-from,
.panel-leave-to {
  flex-basis: 0 !important;
  opacity: 0;
}

/* Right taskbar — minimized panels */
.right-taskbar {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  width: 6px;
  z-index: 200;
  overflow: hidden;
  transition: width 0.25s ease;
  background: #0f0f0f;
  border-left: 1px solid #1e1e1e;
}
.right-taskbar:hover {
  width: 200px;
}

.taskbar-inner {
  width: 200px;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 8px 0;
  gap: 2px;
  overflow-y: auto;
  overflow-x: hidden;
}

.taskbar-item {
  display: flex;
  align-items: center;
  height: 36px;
  padding: 0 12px;
  cursor: pointer;
  color: #666;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-radius: 6px;
  margin: 0 4px;
  transition: background 0.1s, color 0.1s;
  flex-shrink: 0;
}
.taskbar-item:hover { background: #1a1a1a; color: #ccc; }

.taskbar-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Taskbar fade-in when first minimized entry appears */
.taskbar-fade-enter-active,
.taskbar-fade-leave-active { transition: opacity 0.2s; }
.taskbar-fade-enter-from,
.taskbar-fade-leave-to { opacity: 0; }
</style>
