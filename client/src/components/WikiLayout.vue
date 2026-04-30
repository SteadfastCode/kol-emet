<template>
  <div :class="['wiki-root', { 'panel-open': !!activePanelId, 'chat-open': chatOpen }, `tab-${mobileTab}`]">
    <!-- Full-width list -->
    <div class="list-view">
      <EntitySidebar
        :entities="filtered"
        :active-cat="activeCat"
        :active-tag="activeTag"
        :search-query="searchQuery"
        :selected-id="activePanelId"
        :loading="sidebarLoading"
        :graph-open="graphOpen"
        @search="searchQuery = $event"
        @set-cat="setCat"
        @set-tag="setTag"
        @clear-tag="clearTag"
        @select="openEntry"
        @new-entry="openEditor"
        @logout="$emit('logout')"
        @chat="chatOpen = !chatOpen"
        @graph="graphOpen = !graphOpen"
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
          <EntityEditor
            v-if="activePanel?.mode === 'editor'"
            @saved="onEntitySaved"
            @cancel="closePanel(activePanelId)"
          />
          <template v-else-if="activePanel?.mode === 'snapshot'">
            <div class="deleted-badge">DELETED — {{ activePanel.deletedAt }}</div>
            <EntityDetail
              :entity="activePanel.snapshotEntry"
              :loading="false"
              :breadcrumbs="[]"
            />
          </template>
          <EntityDetail
            v-else-if="selectedEntity"
            :entity="selectedEntity"
            :loading="detailLoading"
            :breadcrumbs="breadcrumbs"
            @crumb-click="onCrumbClick"
            @follow-link="followLink"
            @set-tag="setTag"
            @saved="onEntityUpdated"
            @deleted="onEntityDeleted"
            @refresh="selectEntity(activePanelId)"
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

    <!-- Graph overlay -->
    <Transition name="graph-fade">
      <GraphView
        v-if="graphOpen"
        @close="graphOpen = false"
        @open-entry="onGraphOpenEntry"
      />
    </Transition>

    <ToastNotification />

    <!-- Chat panel -->
    <ChatPanel :open="chatOpen" @close="onChatClose" />

    <!-- Settings panel (mobile only) -->
    <div class="mobile-settings-panel">
      <div class="settings-group">
        <div class="settings-group-title">Account</div>
        <button class="settings-row danger" @click="$emit('logout')">Log Out</button>
      </div>
    </div>

    <!-- Bottom tab bar (mobile portrait only) -->
    <nav class="mobile-tab-bar">
      <button class="tab-btn" :class="{ active: mobileTab === 'list' }" @click="setMobileTab('list')">
        <svg class="tab-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <line x1="3" y1="5"  x2="17" y2="5"/>
          <line x1="3" y1="10" x2="17" y2="10"/>
          <line x1="3" y1="15" x2="17" y2="15"/>
        </svg>
        <span>List</span>
      </button>
      <button
        class="tab-btn"
        :class="{ active: mobileTab === 'detail', dimmed: !activePanelId }"
        @click="setMobileTab('detail')"
      >
        <svg class="tab-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <rect x="4" y="2" width="12" height="16" rx="1.5"/>
          <line x1="7" y1="7"  x2="13" y2="7"/>
          <line x1="7" y1="10" x2="13" y2="10"/>
          <line x1="7" y1="13" x2="10" y2="13"/>
        </svg>
        <span>Detail</span>
      </button>
      <button class="tab-btn" :class="{ active: mobileTab === 'chat' }" @click="setMobileTab('chat')">
        <svg class="tab-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 4h14a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7.5L3 17V5a1 1 0 0 1 1-1z"/>
        </svg>
        <span>AI Chat</span>
      </button>
      <button class="tab-btn" :class="{ active: graphOpen }" @click="graphOpen = !graphOpen">
        <svg class="tab-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="4"  cy="10" r="2"/>
          <circle cx="16" cy="4"  r="2"/>
          <circle cx="16" cy="16" r="2"/>
          <circle cx="10" cy="10" r="2"/>
          <line x1="6"  y1="10" x2="8"  y2="10"/>
          <line x1="12" y1="10" x2="14" y2="5"/>
          <line x1="12" y1="10" x2="14" y2="15"/>
        </svg>
        <span>Graph</span>
      </button>
      <button class="tab-btn" :class="{ active: mobileTab === 'settings' }" @click="setMobileTab('settings')">
        <svg class="tab-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <circle cx="10" cy="10" r="2.5"/>
          <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.1 4.1l1.4 1.4M14.5 14.5l1.4 1.4M4.1 15.9l1.4-1.4M14.5 5.5l1.4-1.4"/>
        </svg>
        <span>Settings</span>
      </button>
    </nav>
  </div>
</template>

<script setup>
import { ref, computed, provide, onMounted } from 'vue';
import EntitySidebar from './EntitySidebar.vue';
import EntityDetail from './EntityDetail.vue';
import EntityEditor from './EntityEditor.vue';
import ToastNotification from './ToastNotification.vue';
import ChatPanel from './ChatPanel.vue';
import GraphView from './GraphView.vue';
import { useEntities } from '../composables/useEntities.js';
import { useFilters } from '../composables/useFilters.js';
import { useNavigation } from '../composables/useNavigation.js';
import { useEvents } from '../composables/useEvents.js';
import { useToasts } from '../composables/useToasts.js';

const EDITOR_ID = '__new_entity__';

const emit = defineEmits(['logout']);

const {
  entities, selectedEntity, sidebarLoading, detailLoading,
  loadEntities, selectEntity, addEntity, editEntity, removeEntity,
} = useEntities();

const { searchQuery, activeCat, activeTag, filtered, setCat, setTag, clearTag } = useFilters(entities);
const { breadcrumbs, startNavigation, pushCrumb, navigateToIndex } = useNavigation();
const { addToast } = useToasts();

// Panel state: array of { id, title, mode: 'entry' | 'editor' | 'snapshot', snapshotEntry?, deletedAt? }
const panels = ref([]);
const activePanelId = ref(null);
const chatOpen = ref(false);
const graphOpen = ref(false);
const mobileTab = ref('list'); // 'list' | 'detail' | 'chat' | 'settings'

function setMobileTab(tab) {
  if (tab === 'detail' && !activePanelId.value) return;
  mobileTab.value = tab;
  chatOpen.value = (tab === 'chat');
}

function onChatClose() {
  chatOpen.value = false;
  if (mobileTab.value === 'chat') mobileTab.value = activePanelId.value ? 'detail' : 'list';
}

function onGraphOpenEntry(id, title) {
  graphOpen.value = false;
  openEntry(id, title);
}

const activePanel = computed(() =>
  panels.value.find(p => p.id === activePanelId.value) ?? null
);

const minimizedPanels = computed(() =>
  panels.value.filter(p => p.id !== activePanelId.value)
);

onMounted(() => loadEntities());

function openEntry(id, title) {
  const existing = panels.value.find(p => p.id === id);
  if (!existing) {
    panels.value.push({ id, title, mode: 'entity' });
  } else {
    existing.title = title; // keep title fresh
  }
  activePanelId.value = id;
  mobileTab.value = 'detail';
  startNavigation(id, title);
  selectEntity(id);
}

function openSnapshot(snapshot) {
  const id = `__snapshot_${snapshot._id}__`;
  const deletedAt = new Date().toLocaleString();
  const existing = panels.value.find(p => p.id === id);
  if (!existing) {
    panels.value.push({ id, title: `${snapshot.title} [DELETED]`, mode: 'snapshot', snapshotEntry: snapshot, deletedAt });
  }
  activePanelId.value = id;
  mobileTab.value = 'detail';
}

function openEditor() {
  const existing = panels.value.find(p => p.id === EDITOR_ID);
  if (!existing) {
    panels.value.push({ id: EDITOR_ID, title: 'New Entity', mode: 'editor' });
  }
  activePanelId.value = EDITOR_ID;
  mobileTab.value = 'detail';
}

function minimizePanel() {
  activePanelId.value = null;
}

function closePanel(id) {
  panels.value = panels.value.filter(p => p.id !== id);
  if (activePanelId.value === id) {
    activePanelId.value = panels.value.at(-1)?.id ?? null;
    if (activePanelId.value && activePanel.value?.mode === 'entity') {
      selectEntity(activePanelId.value);
    } else if (!activePanelId.value) {
      mobileTab.value = 'list';
    }
  }
}

function restorePanel(id) {
  activePanelId.value = id;
  const panel = panels.value.find(p => p.id === id);
  if (panel?.mode === 'entity') selectEntity(id);
}

function followLink(id, title) {
  pushCrumb(id, title);
  const panel = panels.value.find(p => p.id === activePanelId.value);
  if (panel) panel.title = title;
  selectEntity(id);
}

function onCrumbClick(index) {
  const crumb = navigateToIndex(index);
  const panel = panels.value.find(p => p.id === activePanelId.value);
  if (panel) panel.title = crumb.title;
  selectEntity(crumb.id);
}

async function onEntitySaved(data) {
  const entity = await addEntity(data);
  closePanel(EDITOR_ID);
  openEntry(entity._id, entity.title);
}

async function onEntityUpdated(id, data) {
  await editEntity(id, data);
}

async function onEntityDeleted(id) {
  await removeEntity(id);
  closePanel(id);
}

// ─── SSE change summary helpers ───────────────────────────────────────────────

function buildChangeMessage(changes) {
  const parts = [];
  if (changes.fieldsChanged?.length) {
    parts.push(changes.fieldsChanged.join(', '));
  }
  const blockParts = [];
  if (changes.blocksAdded?.length)   blockParts.push(`${changes.blocksAdded.length} block${changes.blocksAdded.length > 1 ? 's' : ''} added`);
  if (changes.blocksUpdated?.length) blockParts.push(`${changes.blocksUpdated.length} block${changes.blocksUpdated.length > 1 ? 's' : ''} changed`);
  if (changes.blocksDeleted?.length) blockParts.push(`${changes.blocksDeleted.length} block${changes.blocksDeleted.length > 1 ? 's' : ''} removed`);
  if (blockParts.length) parts.push(blockParts.join(', '));
  return parts.length ? `updated — ${parts.join('; ')}` : 'updated';
}

// ─── SSE event handlers ───────────────────────────────────────────────────────

useEvents({
  onEntityCreated({ entity, actor }) {
    // Insert into sidebar (sorted by title)
    const idx = entities.value.findIndex(e => e.title.localeCompare(entity.title) > 0);
    if (idx === -1) entities.value.push(entity);
    else entities.value.splice(idx, 0, entity);

    addToast({
      actorLabel:  actor.label,
      actorType:   actor.type,
      message:     'added',
      entityId:    entity._id,
      entityTitle: entity.title,
      changeType:  'created',
    });
  },

  onEntityUpdated({ entity, actor, changes }) {
    const idx = entities.value.findIndex(e => e._id === entity._id);
    if (idx !== -1) entities.value[idx] = entity;
    if (selectedEntity.value?._id === entity._id) selectedEntity.value = entity;

    addToast({
      actorLabel:  actor.label,
      actorType:   actor.type,
      message:     buildChangeMessage(changes),
      entityId:    entity._id,
      entityTitle: entity.title,
      changeType:  'updated',
    });
  },

  onEntityDeleted({ entityId, entityTitle, actor, snapshot }) {
    entities.value = entities.value.filter(e => e._id !== entityId);
    if (selectedEntity.value?._id === entityId) {
      selectedEntity.value = null;
      closePanel(entityId);
    }

    addToast({
      actorLabel:  actor.label,
      actorType:   actor.type,
      message:     'deleted',
      entityId,
      entityTitle,
      snapshot,
      changeType:  'deleted',
    });
  },
});

provide('entities', entities);
provide('followLink', followLink);
provide('openEntry', openEntry);
provide('openSnapshot', openSnapshot);
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

/* When chat panel is open, keep main layout from being hidden under it */
.wiki-root.chat-open .detail-panel {
  margin-right: 380px;
  transition: margin-right 0.25s ease;
}

/* ─── Mobile settings panel ───────────────────────────────────────── */
.mobile-settings-panel {
  display: none; /* shown by tab CSS below */
  flex: 1;
  overflow-y: auto;
  background: #0a0a0a;
  padding: 32px 20px 24px;
}

.settings-group { margin-bottom: 32px; }

.settings-group-title {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #444;
  margin-bottom: 8px;
}

.settings-row {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 12px 16px;
  background: #111;
  border: 1px solid #1e1e1e;
  border-radius: 8px;
  color: #ccc;
  font-size: 14px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}
.settings-row:hover { background: #1a1a1a; }
.settings-row.danger { color: #e07070; }
.settings-row.danger:hover { background: #1a0a0a; }

/* ─── Mobile bottom tab bar ───────────────────────────────────────── */
.mobile-tab-bar {
  display: none; /* shown only on mobile portrait */
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: calc(56px + env(safe-area-inset-bottom, 0px));
  padding-bottom: env(safe-area-inset-bottom, 0px);
  background: #0a0a0a;
  border-top: 1px solid #1e1e1e;
  z-index: 400;
  align-items: stretch;
  justify-content: space-around;
}

.tab-btn {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  background: none;
  border: none;
  color: #444;
  cursor: pointer;
  font-size: 10px;
  font-family: inherit;
  padding: 6px 4px;
  transition: color 0.1s;
  -webkit-tap-highlight-color: transparent;
}
.tab-btn:hover  { color: #888; }
.tab-btn.active { color: #7ab4f5; }
.tab-btn.dimmed { opacity: 0.3; cursor: default; }

.tab-icon {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
}

/* ─── Mobile portrait layout ──────────────────────────────────────── */
@media (orientation: portrait) and (max-width: 768px) {
  .mobile-tab-bar { display: flex; }

  /* Make room for the fixed tab bar */
  .wiki-root { padding-bottom: calc(56px + env(safe-area-inset-bottom, 0px)); }

  /* Disable right taskbar and desktop chat margin */
  .right-taskbar { display: none; }
  .wiki-root.chat-open .detail-panel { margin-right: 0; }

  /* ── Tab: list ── */
  .wiki-root.tab-list .list-view    { display: flex !important; flex: 1 !important; }
  .wiki-root.tab-list .detail-panel { display: none !important; }

  /* ── Tab: detail ── */
  .wiki-root.tab-detail .list-view    { display: none !important; }
  .wiki-root.tab-detail .detail-panel { display: flex !important; flex: 1 !important; }

  /* ── Tab: chat ── */
  .wiki-root.tab-chat .list-view    { display: none !important; }
  .wiki-root.tab-chat .detail-panel { display: none !important; }

  /* ── Tab: settings ── */
  .wiki-root.tab-settings .list-view           { display: none !important; }
  .wiki-root.tab-settings .detail-panel        { display: none !important; }
  .wiki-root.tab-settings .mobile-settings-panel { display: block; }

  /* Override old panel-open flex rules — tabs own the layout */
  .wiki-root.panel-open .list-view    { flex: 1 !important; }
  .wiki-root.panel-open .detail-panel { flex: 1 !important; }
}

/* Graph overlay fade */
.graph-fade-enter-active,
.graph-fade-leave-active { transition: opacity 0.2s ease; }
.graph-fade-enter-from,
.graph-fade-leave-to { opacity: 0; }

/* Deleted entry snapshot badge */
.deleted-badge {
  background: #7f1d1d;
  color: #fca5a5;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-align: center;
  padding: 6px 12px;
  border-bottom: 1px solid #991b1b;
  flex-shrink: 0;
}
</style>
