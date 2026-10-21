<template>
  <div :class="['wiki-root', { 'panel-open': !!activePanelId, 'chat-open': chatOpen, 'settings-open': settingsOpen }, `tab-${mobileTab}`]">
    <!-- Full-width list -->
    <div class="list-view">
      <EntitySidebar
        ref="sidebarRef"
        :entities="filtered"
        :active-cat="activeCat"
        :active-tag="activeTag"
        :search-query="searchQuery"
        :selected-id="activePanelId"
        :loading="sidebarLoading"
        :searching="searching"
        :search-truncation="searchTruncation"
        :load-error="loadError"
        :graph-open="graphOpen"
        @search="searchQuery = $event"
        @set-cat="setCat"
        @set-tag="setTag"
        @clear-tag="clearTag"
        @reset-filters="resetFilters"
        @retry-load="loadEntities('Sidebar → retry after a failed load')"
        @select="openEntry"
        @new-entry="openEditor"
        @logout="$emit('logout')"
        @settings="openSettings"
        @chat="chatOpen = !chatOpen"
        @graph="graphOpen = !graphOpen"
        @generate="generatorOpen = true"
        @shortcuts="showShortcuts"
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
            <!-- A snapshot of a deleted entity: readable, and no open-question
                 writes (the entity it would link to is gone). -->
            <EntityDetail
              :entity="activePanel.snapshotEntry"
              :loading="false"
              :breadcrumbs="[]"
              :can-write="false"
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
    <GeneratorOverlay
      v-if="generatorOpen"
      @close="generatorOpen = false"
      @generated="onDraftGenerated"
      @applied="onDraftApplied"
    />

    <ChatPanel :open="chatOpen" @close="onChatClose" />

    <!-- The `?` cheatsheet (KOL-072). Over every other layer, because it is the layer you open
         to find out how to get out of them; Escape closes it first for the same reason. -->
    <Transition name="sheet-fade">
      <ShortcutCheatsheet
        v-if="cheatsheetOpen"
        :shortcuts="shortcuts"
        @close="cheatsheetOpen = false"
      />
    </Transition>

    <!-- Settings: a tab on mobile portrait; elsewhere an overlay opened from the sidebar -->
    <div class="mobile-settings-panel">
      <div class="settings-inner">
        <button class="settings-close" title="Close" @click="closeSettings">✕</button>
        <!-- First on purpose: which workspace this is, before anything done inside it (KOL-071). -->
        <div class="settings-group">
          <div class="settings-group-title">Workspace</div>
          <p v-if="workspace" class="workspace-name">{{ workspace.name }}</p>
          <!-- The rename is an owner's; everyone else reads the name above and is told why. -->
          <form v-if="workspace?.role === 'owner'" class="workspace-rename" @submit.prevent="saveWorkspaceName">
            <input
              v-model="workspaceDraft"
              class="workspace-input"
              type="text"
              name="workspace-name"
              autocomplete="off"
              aria-label="Workspace name"
              :maxlength="WORKSPACE_NAME_MAX"
              :disabled="workspaceSaving"
            />
            <button type="submit" class="btn-sm" :disabled="workspaceSaving || !workspaceRenameReady">
              {{ workspaceSaving ? 'Saving…' : 'Rename' }}
            </button>
          </form>
          <p v-else-if="workspace" class="settings-note">
            Only an owner can rename this workspace. Your role here is {{ workspace.role }}.
          </p>
          <!-- The switcher (KOL-090): which of this user's workspaces the session acts in. Only
               when there is more than one — with a single membership there is nothing to choose
               between, which is every account until invites land. -->
          <div v-if="workspaces.length > 1" class="workspace-switcher">
            <label class="workspace-switcher-label" for="workspace-switcher">Acting in</label>
            <select
              id="workspace-switcher"
              class="workspace-input"
              name="workspace-switcher"
              :value="workspace?._id"
              :disabled="workspaceSwitching"
              @change="switchWorkspace($event.target.value)"
            >
              <option v-for="choice in workspaces" :key="choice._id" :value="choice._id">
                {{ choice.name }} — {{ choice.role }}
              </option>
            </select>
            <p class="settings-note">
              Everything in this tab — the sidebar, search, chat and the graph — comes from the
              workspace selected here. Switching reloads the page.
            </p>
          </div>
          <p v-if="workspaceError" class="settings-error" role="alert">{{ workspaceError }}</p>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">Account</div>
          <button class="settings-row danger" @click="$emit('logout')">Log Out</button>
          <!-- Beside Log Out on purpose (KOL-076): the two ways out of an account sit together —
               this browser, or every other one. Two steps, because it is not a thing to do by
               mis-tapping the row below Log Out: the button arms a form, and the form
               re-authenticates, which is what the server demands anyway. -->
          <button
            v-if="!revokeArmed"
            class="settings-row danger"
            @click="armRevoke"
          >Sign out everywhere else</button>
          <form v-else class="revoke-all" autocomplete="on" @submit.prevent="revokeSessions">
            <p class="settings-note">
              Ends every other signed-in browser and device on this account — a borrowed laptop, a
              lost phone. This browser stays signed in. Anything signed in elsewhere is signed out
              the next time it asks for anything.
            </p>
            <label class="password-label" for="settings-revoke-password">Your password</label>
            <input
              id="settings-revoke-password"
              v-model="revokePassword"
              class="workspace-input"
              type="password"
              name="password"
              autocomplete="current-password"
              :disabled="revokeSaving"
            />
            <button
              type="submit"
              class="settings-row danger"
              :disabled="revokeSaving || !revokePassword"
            >{{ revokeSaving ? 'Signing out…' : 'Sign out everywhere else' }}</button>
            <!-- For an account signed in with a passkey, which is the case where the password is
                 the thing its owner does not have to hand. -->
            <button
              type="button"
              class="settings-row"
              :disabled="revokeSaving"
              @click="revokeSessionsWithPasskey"
            >Confirm with a passkey instead</button>
            <button
              type="button"
              class="settings-row"
              :disabled="revokeSaving"
              @click="cancelRevoke"
            >Cancel</button>
          </form>
          <p v-if="revokeError" class="settings-error" role="alert">{{ revokeError }}</p>
          <p v-else-if="revokeDone" class="settings-done" role="status">
            Signed out everywhere else. This browser is still signed in.
          </p>
        </div>
        <!-- Beside the passkey settings on purpose (KOL-074): the two ways into an account sit
             together. A form of its own with the standard autocomplete attributes, so a credential
             manager offers the saved password and then offers to store the new one. The session is
             already signed in; the server re-authenticates the change anyway, which is why the
             current password is asked for here. -->
        <div class="settings-group">
          <div class="settings-group-title">Password</div>
          <form class="password-change" autocomplete="on" @submit.prevent="savePassword">
            <label class="password-label" for="settings-current-password">Current password</label>
            <input
              id="settings-current-password"
              v-model="currentPassword"
              class="workspace-input"
              type="password"
              name="current-password"
              autocomplete="current-password"
              :disabled="passwordSaving"
            />
            <label class="password-label" for="settings-new-password">New password</label>
            <input
              id="settings-new-password"
              v-model="newPassword"
              class="workspace-input"
              type="password"
              name="new-password"
              autocomplete="new-password"
              :minlength="PASSWORD_MIN_LENGTH"
              :disabled="passwordSaving"
            />
            <!-- Said before it is typed, not only after a refusal: the server enforces the same
                 minimum and answers its own sentence (lib/passwordPolicy.js). -->
            <p class="settings-note">At least {{ PASSWORD_MIN_LENGTH }} characters. Length is the
              only rule — a passphrase is a good password.</p>
            <button type="submit" class="settings-row" :disabled="passwordSaving || !currentPassword || !newPasswordLongEnough">
              {{ passwordSaving ? 'Changing…' : 'Change password' }}
            </button>
            <!-- For an account whose password is the thing being replaced because it is not
                 trusted — and the only way in for one that has no password yet. -->
            <button
              type="button"
              class="settings-row"
              :disabled="passwordSaving || !newPasswordLongEnough"
              @click="savePasswordWithPasskey"
            >Confirm with a passkey instead</button>
          </form>
          <p v-if="passwordError" class="settings-error" role="alert">{{ passwordError }}</p>
          <p v-else-if="passwordChanged" class="settings-done" role="status">
            Password changed. You are still signed in here; other browsers signed in to this account
            are not signed out.
          </p>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">Passkeys</div>
          <!-- Mounted only while settings shows: fetched fresh on each open, never on page load. -->
          <PasskeySettings v-if="settingsVisible" />
        </div>
        <div class="settings-group">
          <div class="settings-group-title">Recently deleted</div>
          <!-- The way back to a deleted entity once its toast is gone (KOL-060): mounted only
               while settings shows, so the list is fetched fresh on each open. The restored
               entity arrives in every OTHER tab over SSE; this one refetches the list. -->
          <RecentlyDeleted v-if="settingsVisible" @restored="onEntityRestored" />
        </div>
        <div class="settings-group">
          <div class="settings-group-title">Export workspace</div>
          <!-- The way out (KOL-070): the whole graph as one canonical JSON file. No `v-if` —
               nothing is fetched until the row is pressed, so there is no stale list to keep
               fresh. The server names the file; this only asks for it. -->
          <button class="settings-row" :disabled="exporting" @click="exportWorkspace">
            {{ exporting ? 'Preparing your export…' : 'Download workspace as JSON' }}
          </button>
          <p class="settings-note">
            Everything in this workspace — entities, relationships, open questions and your type
            vocabularies — in one file you can keep. Account details are never included.
          </p>
          <p v-if="exportError" class="settings-error" role="alert">{{ exportError }}</p>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">Import workspace</div>
          <!-- The way back in (KOL-077): one exported file into an empty workspace. The file is
               read here and posted as the request body; the server refuses anything but an empty
               workspace (409 WORKSPACE_NOT_EMPTY), which is the message below. -->
          <label class="settings-row" :class="{ busy: importing }">
            {{ importing ? 'Importing…' : 'Import workspace from JSON' }}
            <input
              type="file"
              class="settings-file-input"
              accept="application/json,.json"
              :disabled="importing"
              @change="importWorkspace"
            />
          </label>
          <p class="settings-note">
            Reads a file from Export workspace back into this one. It has to be empty first —
            no entities, relationships or open questions — so nothing can be overwritten. Only
            the workspace owner can import.
          </p>
          <p v-if="importSummary" class="settings-note">{{ importSummary }}</p>
          <p v-if="importError" class="settings-error" role="alert">{{ importError }}</p>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">Tags</div>
          <!-- Counts come from the entity list already loaded here, not a route of their own;
               a rename or removal touches many entities, so the list is refetched after one. -->
          <TagSettings v-if="settingsVisible" :entities="entities" @changed="loadEntities('Settings → Tags changed')" />
        </div>
        <!-- Last on purpose: the irreversible action sits at the bottom of settings. -->
        <div class="settings-group">
          <div class="settings-group-title">Delete account</div>
          <AccountDeletion @deleted="$emit('account-deleted')" />
        </div>
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
import { ref, computed, provide, onMounted, watch } from 'vue';
import EntitySidebar from './EntitySidebar.vue';
import EntityDetail from './EntityDetail.vue';
import EntityEditor from './EntityEditor.vue';
import ToastNotification from './ToastNotification.vue';
import ChatPanel from './ChatPanel.vue';
import GraphView from './GraphView.vue';
import GeneratorOverlay from './generator/GeneratorOverlay.vue';
import ShortcutCheatsheet from './ShortcutCheatsheet.vue';
import AccountDeletion from './AccountDeletion.vue';
import PasskeySettings from './PasskeySettings.vue';
import RecentlyDeleted from './RecentlyDeleted.vue';
import TagSettings from './TagSettings.vue';
import {
  changePassword,
  changePasswordWithPasskey,
  PASSWORD_MIN_LENGTH,
  passwordTooShort,
  revokeOtherSessions,
  revokeOtherSessionsWithPasskey,
} from '../api/auth.js';
import { searchEntities } from '../api/entities.js';
import { downloadWorkspaceExport, importWorkspaceFile } from '../api/export.js';
import { getWorkspace, listWorkspaces, renameWorkspace, selectWorkspace, WORKSPACE_NAME_MAX } from '../api/workspace.js';
import { useEntities } from '../composables/useEntities.js';
import { useFilters } from '../composables/useFilters.js';
import { useNavigation } from '../composables/useNavigation.js';
import { useEvents } from '../composables/useEvents.js';
import { useToasts } from '../composables/useToasts.js';
import { useEntityTypes } from '../composables/useEntityTypes.js';
import { useKeyboardShortcuts } from '../composables/useKeyboardShortcuts.js';

const EDITOR_ID = '__new_entity__';

const emit = defineEmits(['logout', 'account-deleted']);

const {
  entities, selectedEntity, sidebarLoading, detailLoading, loadError,
  loadEntities, selectEntity, addEntity, editEntity, removeEntity,
} = useEntities();

// The search box asks the server, because block markdown — the one field a
// wiki keeps its content in — is not in the list the browser holds (KOL-068).
// The request is handed in rather than imported by the composable, so the
// filters themselves still reach nothing. The pills stay in the browser.
const {
  searchQuery, activeCat, activeTag, filtered, searching, searchTruncation,
  setCat, setTag, clearTag, resetFilters,
} = useFilters(entities, { search: searchEntities });
const { breadcrumbs, startNavigation, pushCrumb, navigateToIndex } = useNavigation();
const { addToast } = useToasts();
const { loadEntityTypes } = useEntityTypes();

// Applying is the only point at which a draft reaches the graph, so this is
// where the entity list has to be refetched.
async function onDraftApplied(res) {
  await loadEntities('a generated draft was applied');
  const n = res?.applied ?? 0;
  addToast({
    message: `${n} item${n === 1 ? '' : 's'} added from your draft`,
    actorType: 'generator',
    actorLabel: 'Generator',
  });
}

// A generated draft has not touched the graph, so this deliberately does not
// refresh the entity list — nothing there has changed yet.
function onDraftGenerated({ counts }) {
  const n = counts?.proposed ?? 0;
  addToast({
    message: `Draft ready — ${n} item${n === 1 ? '' : 's'} to review`,
    actorType: 'generator',
    actorLabel: 'Generator',
  });
}

// Panel state: array of { id, title, mode: 'entry' | 'editor' | 'snapshot', snapshotEntry?, deletedAt? }
const panels = ref([]);
const activePanelId = ref(null);
const chatOpen = ref(false);
const graphOpen = ref(false);
const generatorOpen = ref(false);
const cheatsheetOpen = ref(false);
const mobileTab = ref('list'); // 'list' | 'detail' | 'chat' | 'settings'

// The settings overlay. On mobile portrait, settings is the 'settings' tab
// instead, and this class has no effect there (see the styles).
const settingsOpen = ref(false);
const settingsVisible = computed(() => settingsOpen.value || mobileTab.value === 'settings');

function setMobileTab(tab) {
  if (tab === 'detail' && !activePanelId.value) return;
  mobileTab.value = tab;
  chatOpen.value = (tab === 'chat');
  // Mobile portrait has no ✕ on settings, so the tab bar is the only way out:
  // disarm the overlay too, or it reappears as soon as the portrait query
  // stops matching (a rotation to landscape).
  if (tab !== 'settings') settingsOpen.value = false;
}

// From the sidebar's Settings button: the overlay on wide screens, the tab on
// mobile portrait.
function openSettings() {
  settingsOpen.value = true;
  mobileTab.value = 'settings';
}

function closeSettings() {
  settingsOpen.value = false;
  if (mobileTab.value === 'settings') mobileTab.value = activePanelId.value ? 'detail' : 'list';
}

/**
 * A restore recreated an entity at its original id. The restoring tab is
 * excluded from its own entity:created broadcast (X-SSE-Client-Id), so the
 * sidebar it is looking at is the one that has to be refetched here.
 */
function onEntityRestored() {
  loadEntities('Settings → Recently deleted restore');
}

/**
 * The Export workspace row (KOL-070). The request carries the session cookie
 * and the file is saved from a blob, so a refusal stays a message in Settings
 * instead of navigating the app away to show an error body.
 */
const exporting = ref(false);
const exportError = ref('');

async function exportWorkspace() {
  if (exporting.value) return;
  exporting.value = true;
  exportError.value = '';
  try {
    const { filename } = await downloadWorkspaceExport({ source: 'Settings → Export workspace' });
    addToast({ message: `Exported ${filename}`, actorType: 'system', actorLabel: 'Export' });
  } catch (err) {
    exportError.value = err.message || 'Export failed';
  } finally {
    exporting.value = false;
  }
}

/**
 * The Import workspace row (KOL-077): the file from the row above, read back
 * into this workspace. The server only writes into an empty one, so most of
 * what this has to do is say why it refused — api/export.js turns each code
 * into a sentence. On success the sidebar is reloaded, since every entity in
 * it was just created.
 */
const importing = ref(false);
const importError = ref('');
const importSummary = ref('');

async function importWorkspace(event) {
  const file = event?.target?.files?.[0];
  // Reset the input either way, so choosing the same file twice fires `change`
  // again — a failed import is usually retried with the same file.
  const clear = () => { if (event?.target) event.target.value = ''; };
  if (!file || importing.value) return clear();

  importing.value = true;
  importError.value = '';
  importSummary.value = '';
  try {
    const result = await importWorkspaceFile(file, { source: 'Settings → Import workspace' });
    const counts = result.imported ?? {};
    importSummary.value = `Imported ${counts.entities ?? 0} entities, ${counts.relationshipGroups ?? 0} relationships and ${counts.openQuestions ?? 0} open questions.`;
    addToast({ message: importSummary.value, actorType: 'system', actorLabel: 'Import' });
    loadEntities('Settings → Import workspace');
  } catch (err) {
    importError.value = err.message || 'Import failed';
  } finally {
    importing.value = false;
    clear();
  }
}

/**
 * The Workspace group (KOL-071): the name of the workspace this session is in,
 * and a rename for its owner.
 *
 * Fetched on each Settings open rather than on page load — the name is only
 * ever shown here, and another session may have renamed it since. `role` comes
 * from the server's reading of this user's own membership, so the rename field
 * is hidden for an editor or a viewer; the server refuses it for them anyway
 * (403 NOT_WORKSPACE_OWNER), which is what the error branch below says.
 */
const workspace = ref(null);        // { _id, name, role, createdAt } from GET /workspace
const workspaces = ref([]);         // every membership, from GET /workspaces (KOL-090)
const workspaceDraft = ref('');     // the owner's edit in progress
const workspaceSaving = ref(false);
const workspaceSwitching = ref(false);
const workspaceError = ref('');

const workspaceRenameReady = computed(() => {
  const next = workspaceDraft.value.trim();
  return !!next && next !== workspace.value?.name;
});

async function loadWorkspace() {
  workspaceError.value = '';
  try {
    workspace.value = await getWorkspace({ source: 'Settings → Workspace' });
    workspaceDraft.value = workspace.value.name;
  } catch (err) {
    workspaceError.value = 'Could not load this workspace’s name.';
  }
  // Its own request, and its own failure: a list that did not answer leaves the
  // switcher hidden (one choice is the ordinary case anyway) rather than hiding
  // the name above it.
  try {
    workspaces.value = await listWorkspaces({ source: 'Settings → Workspace' });
  } catch (err) {
    workspaces.value = [];
  }
}

watch(settingsVisible, (open) => { if (open) loadWorkspace(); });

async function saveWorkspaceName() {
  if (workspaceSaving.value || !workspaceRenameReady.value) return;
  const from = workspace.value?.name;
  workspaceSaving.value = true;
  workspaceError.value = '';
  try {
    workspace.value = await renameWorkspace(workspaceDraft.value.trim(), {
      source: 'Settings → Workspace',
      from,
    });
    workspaceDraft.value = workspace.value.name;
    addToast({
      message: `Workspace renamed to ${workspace.value.name}`,
      actorType: 'system',
      actorLabel: 'Workspace',
    });
  } catch (err) {
    workspaceError.value = err.status === 403
      ? 'Only an owner can rename this workspace.'
      : err.status === 400
      ? `A workspace name has to be 1–${WORKSPACE_NAME_MAX} characters.`
      : 'Could not rename this workspace.';
  } finally {
    workspaceSaving.value = false;
  }
}

/**
 * Switching workspace (KOL-090). The choice is *server-side session state* —
 * `POST /workspaces/:id/select` — because the client cannot scope its own
 * reads: a workspace picked in a ref here while the server resolved another is
 * precisely the read-A-write-B split this item removes.
 *
 * Then the page reloads. Everything on screen belongs to the workspace just
 * left — the entity list, the type registry, the filters, and the `/events`
 * stream, which is tagged with a workspace when it connects and not after — so
 * refetching them one by one would leave a tab reading one workspace and
 * streaming another, with the next forgotten fetch the next silent mismatch.
 * A reload is the one thing that cannot be half-done.
 */
async function switchWorkspace(id) {
  if (workspaceSwitching.value || !id || id === workspace.value?._id) return;
  const from = workspace.value?.name;
  workspaceSwitching.value = true;
  workspaceError.value = '';
  try {
    const next = await selectWorkspace(id, { source: 'Settings → Workspace switcher', from });
    workspace.value = next;
    workspaceDraft.value = next.name;
    reloadAfterSwitch();
    // Deliberately still switching: the page is on its way out, and a select
    // re-enabled for the half-second before it goes is a second switch nobody
    // asked for.
  } catch (err) {
    // 404 is the server refusing an id this user is not a member of — which,
    // since the list came from the server a moment ago, means the membership
    // was revoked in between.
    workspaceError.value = err.status === 404
      ? 'You are no longer a member of that workspace.'
      : 'Could not switch workspace.';
    workspaceSwitching.value = false;
  }
}

/** Wrapped so a test environment without navigation cannot fail the switch. */
function reloadAfterSwitch() {
  try {
    window.location.reload();
  } catch (err) {
    /* jsdom has no navigation; the switch itself is already committed server-side. */
  }
}

// ─── Settings → Password (KOL-074) ───────────────────────────────────────────
// The group reads nothing on open, so unlike Passkeys it is not mounted behind
// `settingsVisible`: there is no list here to go stale. Both buttons post the
// same change and differ only in what re-authenticates it; the server refuses a
// new password under the minimum with its own sentence, and this form keeps the
// submit out of reach until the typed one could be accepted, so an opaque 400
// is not how a user finds the rule out.
const currentPassword = ref('');
const newPassword     = ref('');
const passwordSaving  = ref(false);
const passwordError   = ref('');
const passwordChanged = ref(false);

const newPasswordLongEnough = computed(() => !passwordTooShort(newPassword.value));

/** What Settings says about a refusal. The server's own sentence, where it has one. */
function passwordMessageFor(err) {
  // 403 is a failed re-authentication, not a dead session: the wrong current
  // password, or a passkey that did not confirm. 401 is the dead session.
  if (err.status === 400 || err.status === 403) return err.message;
  if (err.status === 429) return err.message;   // the throttle says how long to wait
  if (err.status === 401) return 'Your session has expired. Sign in again to change your password.';
  return 'Could not change your password. Please try again.';
}

async function runPasswordChange(attempt) {
  if (passwordSaving.value || !newPasswordLongEnough.value) return;
  passwordError.value = '';
  passwordChanged.value = false;
  passwordSaving.value = true;
  try {
    await attempt();
    currentPassword.value = '';
    newPassword.value = '';
    passwordChanged.value = true;
    addToast({
      message: 'Password changed',
      actorType: 'system',
      actorLabel: 'Account',
    });
  } catch (err) {
    // The passkey prompt was dismissed: not a failure to report, as at sign-in.
    if (err.name === 'NotAllowedError') return;
    passwordError.value = passwordMessageFor(err);
  } finally {
    passwordSaving.value = false;
  }
}

const savePassword = () => runPasswordChange(() => changePassword(
  { currentPassword: currentPassword.value, newPassword: newPassword.value },
  { source: 'Settings → Password' },
));

const savePasswordWithPasskey = () => runPasswordChange(() => changePasswordWithPasskey(
  newPassword.value,
  { source: 'Settings → Password, confirmed with a passkey' },
));

// ─── Settings → Account → Sign out everywhere else (KOL-076) ─────────────────
// Armed by a button rather than shown outright: the row sits under Log Out, and
// the cost of a mis-tap is every other device having to sign in again. The
// server re-authenticates it either way, and re-stamps this session so this
// browser is the one that stays.
const revokeArmed    = ref(false);
const revokePassword = ref('');
const revokeSaving   = ref(false);
const revokeError    = ref('');
const revokeDone     = ref(false);

function armRevoke() {
  revokeArmed.value = true;
  revokeError.value = '';
  revokeDone.value = false;
}

function cancelRevoke() {
  revokeArmed.value = false;
  revokePassword.value = '';
  revokeError.value = '';
}

/** What Settings says about a refusal. The server's own sentence, where it has one. */
function revokeMessageFor(err) {
  // 403 is a failed re-authentication, not a dead session: the wrong password,
  // or a passkey that did not confirm. 401 is the dead session — and from this
  // route it means this browser's own session had already been revoked.
  if (err.status === 400 || err.status === 403) return err.message;
  if (err.status === 429) return err.message;   // the throttle says how long to wait
  if (err.status === 401) return 'Your session has expired. Sign in again to sign your other devices out.';
  return 'Could not sign your other devices out. Please try again.';
}

async function runRevoke(attempt) {
  if (revokeSaving.value) return;
  revokeError.value = '';
  revokeDone.value = false;
  revokeSaving.value = true;
  try {
    await attempt();
    revokePassword.value = '';
    revokeArmed.value = false;
    revokeDone.value = true;
    addToast({
      message: 'Signed out everywhere else',
      actorType: 'system',
      actorLabel: 'Account',
    });
  } catch (err) {
    // The passkey prompt was dismissed: not a failure to report, as at sign-in.
    if (err.name === 'NotAllowedError') return;
    revokeError.value = revokeMessageFor(err);
  } finally {
    revokeSaving.value = false;
  }
}

const revokeSessions = () => runRevoke(() => revokeOtherSessions(
  { password: revokePassword.value },
  { source: 'Settings → Account → Sign out everywhere else' },
));

const revokeSessionsWithPasskey = () => runRevoke(() => revokeOtherSessionsWithPasskey(
  { source: 'Settings → Account → Sign out everywhere else, confirmed with a passkey' },
));

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

onMounted(() => {
  loadEntities('WikiLayout mount');
  loadEntityTypes('WikiLayout mount');
});

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

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
// The whole set, in one place, each binding a named function. The composable
// owns the only global keydown listener in the client and decides whose key a
// press is (a focused text field keeps everything but Escape; ctrl/meta/alt is
// never ours) — see useKeyboardShortcuts.js.

const sidebarRef = ref(null);

function focusSearch(event) {
  // Without this the `/` lands in the field it just focused.
  event.preventDefault();
  sidebarRef.value?.focusSearch();
}

/**
 * Escape walks back out of the layers, one press per layer, topmost first.
 * The order below is the stacking order: the cheatsheet over all of it (it is
 * what you opened to find out how to close the rest), then settings and the
 * generator, the graph over the panels, the chat beside them, and the detail
 * panel is the floor. Nothing open and the press does nothing.
 *
 * The cheatsheet joins this list rather than taking an Escape listener of its
 * own — two listeners on one key is how one press closes two layers.
 */
function closeTopLayer() {
  if (cheatsheetOpen.value)  { cheatsheetOpen.value = false; return; }
  if (settingsVisible.value) { closeSettings(); return; }
  if (generatorOpen.value)   { generatorOpen.value = false; return; }
  if (graphOpen.value)       { graphOpen.value = false; return; }
  if (chatOpen.value)        { onChatClose(); return; }
  if (activePanelId.value)   { closePanel(activePanelId.value); return; }
}

function openNewEntity() {
  openEditor();
}

// Also the sidebar's `?` button, for anyone who would never guess the key.
function showShortcuts() {
  cheatsheetOpen.value = true;
}

// The labels are not decoration: `shortcuts` below is this map, and it is what
// the cheatsheet renders — a binding added here without one throws at
// registration instead of shipping as a key nobody can find (KOL-072).
const { shortcuts } = useKeyboardShortcuts({
  '/': { handler: focusSearch, label: 'Jump to the search box' },
  Escape: { handler: closeTopLayer, label: 'Close the topmost panel or overlay' },
  n: { handler: openNewEntity, label: 'Start a new entity' },
  '?': { handler: showShortcuts, label: 'Open this list of shortcuts' },
});

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

  // ── The two bulk writes (KOL-102) ──
  // A draft apply and an import each send ONE frame for a write that touched
  // many rows (server/src/lib/changeLogger.js says why), and the frame cannot
  // say which rows — so both reload the list rather than patching it. The
  // client that did the write is excluded from its own frame by
  // X-SSE-Client-Id, so reaching here always means another tab or the
  // connector, and the toast names who.

  onDraftApplied({ applied, failed, blocked, actor }) {
    loadEntities('another client applied a generated draft');

    const n = applied ?? 0;
    const unfinished = (failed ?? 0) + (blocked ?? 0);
    addToast({
      actorLabel: actor?.label ?? 'Generator',
      actorType:  actor?.type ?? 'generator',
      message:    `applied ${n} item${n === 1 ? '' : 's'} from a draft${unfinished ? `, ${unfinished} not applied` : ''}`,
      changeType: 'created',
    });
  },

  onWorkspaceImported({ imported, actor }) {
    loadEntities('another client imported a workspace');

    const counts = imported ?? {};
    addToast({
      actorLabel: actor?.label ?? 'Import',
      actorType:  actor?.type ?? 'system',
      message:    `imported ${counts.entities ?? 0} entities, ${counts.relationshipGroups ?? 0} relationships and ${counts.openQuestions ?? 0} open questions`,
      changeType: 'created',
    });
  },

  // The server ended this stream for good — a session signed out elsewhere, or
  // more tabs than EVENTS_MAX_STREAMS_PER_USER. Nothing will reconnect, so the
  // one thing left is to say so: the sidebar is now a snapshot, not live.
  onStreamEnded({ message }) {
    addToast({ message, actorType: 'system', actorLabel: 'Live updates' });
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

/* The label is the button (.settings-row); the input itself is never shown. */
.settings-file-input { display: none; }
.settings-row.busy { opacity: 0.6; cursor: default; }

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
.settings-row:disabled { color: #666; cursor: default; }

.settings-note {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: #666;
}
.workspace-name {
  margin: 0;
  font-size: 14px;
  color: #ccc;
}

.workspace-rename {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.workspace-input {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  font-size: 14px;
  border-radius: 8px;
  border: 1px solid #333;
  background: #121212;
  color: #e0e0e0;
  font-family: inherit;
}

.workspace-input:focus { outline: none; border-color: #555; }
.workspace-input:disabled { opacity: 0.5; }

.workspace-switcher {
  margin-top: 10px;
}

.workspace-switcher-label {
  display: block;
  margin-bottom: 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #777;
}

.workspace-switcher .workspace-input {
  width: 100%;
}

.settings-error {
  margin: 8px 0 0;
  font-size: 12px;
  color: #e07070;
}

.password-change,
.revoke-all {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.password-label { font-size: 12px; color: #888; }

.settings-done {
  margin: 8px 0 0;
  font-size: 12px;
  color: #7fb77f;
}

.settings-close { display: none; }

/* Everywhere but mobile portrait, the panel opens over the wiki from the sidebar's Settings button. */
@media not all and (orientation: portrait) and (max-width: 768px) {
  .wiki-root.settings-open .mobile-settings-panel {
    display: flex;
    align-items: flex-start;
    justify-content: center;
    position: fixed;
    inset: 0;
    z-index: 600; /* above the chat panel (500) */
    padding: 10vh 16px 16px;
    background: rgba(0, 0, 0, 0.7);
  }
  .wiki-root.settings-open .settings-inner {
    position: relative;
    width: 100%;
    max-width: 420px;
    max-height: 80vh;
    overflow-y: auto;
    padding: 36px 20px 4px;
    background: #0a0a0a;
    border: 1px solid #1e1e1e;
    border-radius: 12px;
  }
  .wiki-root.settings-open .settings-close {
    display: block;
    position: absolute;
    top: 10px;
    right: 12px;
    background: none;
    border: none;
    color: #666;
    font-size: 14px;
    cursor: pointer;
  }
  .wiki-root.settings-open .settings-close:hover { color: #ccc; }
}

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
.sheet-fade-enter-active,
.sheet-fade-leave-active { transition: opacity 0.15s ease; }
.sheet-fade-enter-from,
.sheet-fade-leave-to { opacity: 0; }

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
