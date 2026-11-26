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
        :questions-open="questionsOpen"
        :can-write="canWrite"
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
        @questions="toggleQuestions"
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
          <!-- `can-write` is this session's role in the workspace (KOL-150):
               false for a viewer, true for an editor or an owner, and true
               while the role is still unknown. -->
          <EntityDetail
            v-else-if="selectedEntity"
            :entity="selectedEntity"
            :loading="detailLoading"
            :breadcrumbs="breadcrumbs"
            :can-write="canWrite"
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
        ref="graphRef"
        @close="graphOpen = false"
        @open-entry="onGraphOpenEntry"
      />
    </Transition>

    <!-- The workspace's open questions (KOL-152). Over the graph, under settings; the Escape
         order below is this stacking order. It takes the entity list the layout already holds,
         because a `question:*` frame names its entities as bare ids. -->
    <Transition name="graph-fade">
      <OpenQuestionPanel
        v-if="questionsOpen"
        ref="questionsRef"
        :can-write="canWrite"
        :entities="entities"
        @close="questionsOpen = false"
        @open-entry="onQuestionOpenEntry"
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
          <!-- The switcher (KOL-090): which of this user's workspaces the session acts in. Shown
               for a single membership too since KOL-123 — it used to hide itself there, on the
               grounds that there was nothing to choose between, but a user can now create a
               second workspace in the form below and this is where it appears. -->
          <div v-if="workspaces.length" class="workspace-switcher">
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
          <!-- A second workspace (KOL-123). Beside the switcher because the two are one thought:
               this is where another workspace comes from, that is where you go to it. "Empty"
               is a real choice, not an omission — an import only writes into an empty workspace. -->
          <form class="workspace-create" @submit.prevent="createNewWorkspace">
            <label class="workspace-switcher-label" for="new-workspace-name">New workspace</label>
            <input
              id="new-workspace-name"
              v-model="newWorkspaceName"
              class="workspace-input"
              type="text"
              name="new-workspace-name"
              autocomplete="off"
              placeholder="Name"
              :maxlength="WORKSPACE_NAME_MAX"
              :disabled="workspaceCreating"
            />
            <label class="workspace-switcher-label" for="new-workspace-template">Start with</label>
            <select
              id="new-workspace-template"
              v-model="newWorkspaceTemplate"
              class="workspace-input"
              name="new-workspace-template"
              :disabled="workspaceCreating"
            >
              <option v-for="choice in templates" :key="choice.key" :value="choice.key">
                {{ choice.name }}
              </option>
              <option :value="EMPTY_TEMPLATE">Empty — nothing to start from</option>
            </select>
            <button type="submit" class="btn-sm" :disabled="workspaceCreating || !newWorkspaceReady">
              {{ workspaceCreating ? 'Creating…' : 'Create' }}
            </button>
            <p class="settings-note">
              Creates a workspace you own and switches this tab to it, which reloads the page.
              Nothing moves across — each workspace has its own entities, types and relationships.
            </p>
          </form>
          <!-- Deleting this workspace (KOL-133): the counterpart to the form above, and the one
               tenancy verb the product never had. Owner-only, because the server refuses anyone
               else (403 NOT_WORKSPACE_OWNER), and two presses rather than one: the delete is hard
               and there is no undo, so the first press is the only warning there is. -->
          <div v-if="workspace?.role === 'owner'" class="workspace-delete">
            <button
              v-if="!workspaceDeleteArmed"
              class="btn-sm danger"
              :disabled="workspaceDeleting"
              @click="armWorkspaceDelete"
            >
              Delete this workspace
            </button>
            <template v-else>
              <p class="settings-note">
                Deleting {{ workspace.name }} removes its entities, types, relationships, drafts,
                chats and pending invites — for every member, not just you. There is no undo.
              </p>
              <button class="btn-sm danger" :disabled="workspaceDeleting" @click="confirmWorkspaceDelete">
                {{ workspaceDeleting ? 'Deleting…' : 'Delete it permanently' }}
              </button>
              <button class="btn-sm" :disabled="workspaceDeleting" @click="workspaceDeleteArmed = false">
                Keep it
              </button>
            </template>
          </div>
          <p v-if="workspaceError" class="settings-error" role="alert">{{ workspaceError }}</p>
        </div>
        <!-- Invitations waiting for this account (KOL-124). Above the collaborator list because
             it is about a workspace you are not in yet — and because nothing delivers an invite,
             this is the only place one is ever seen. Hidden when there are none and there is
             nothing to say about them: a refusal from Accept or Decline is said here, next to the
             button that caused it (KOL-137), and both handlers re-read the list in `finally`, so
             the group stays mounted while it holds a message — otherwise a failed Accept on the
             last invitation would take its own explanation off the screen along with the row. -->
        <div v-if="myInvites.length || inviteError" class="settings-group">
          <div class="settings-group-title">Invitations for you</div>
          <div v-for="invite in myInvites" :key="invite._id" class="invite-row">
            <span class="invite-label">
              {{ invite.workspaceName ?? 'A workspace' }} — {{ invite.role }}
              <span class="invite-from">from {{ invite.invitedByEmail ?? 'someone here' }}</span>
            </span>
            <button class="btn-sm" :disabled="inviteBusy" @click="acceptMyInvite(invite)">Accept</button>
            <button class="btn-sm" :disabled="inviteBusy" @click="declineMyInvite(invite)">Decline</button>
          </div>
          <p v-if="myInvites.length" class="settings-note">
            Accepting adds the workspace to “Acting in” above; this tab stays where it is until you
            switch to it. Declining removes the invitation and does not tell whoever sent it.
          </p>
          <p v-if="inviteError" class="settings-error" role="alert">{{ inviteError }}</p>
        </div>
        <!-- Collaborators (KOL-124): who is in this workspace, and the owner's invite form. The
             list is shown to every member — working together means knowing who with — while every
             control on it is an owner's. -->
        <div class="settings-group">
          <div class="settings-group-title">Collaborators</div>
          <div v-for="member in members" :key="member.userId" class="member-row">
            <span class="member-email">{{ member.email ?? 'an account that no longer exists' }}</span>
            <template v-if="workspace?.role === 'owner'">
              <select
                class="workspace-input member-role"
                :aria-label="`Role of ${member.email ?? member.userId}`"
                :value="member.role"
                :disabled="memberBusy"
                @change="changeMemberRole(member, $event.target.value)"
              >
                <option v-for="role in ROLES" :key="role" :value="role">{{ role }}</option>
              </select>
              <button class="btn-sm" :disabled="memberBusy" @click="dropMember(member)">Remove</button>
            </template>
            <span v-else class="member-role-label">{{ member.role }}</span>
          </div>
          <form v-if="workspace?.role === 'owner'" class="invite-form" @submit.prevent="sendInvite">
            <label class="workspace-switcher-label" for="invite-email">Invite by email</label>
            <input
              id="invite-email"
              v-model="inviteEmail"
              class="workspace-input"
              type="email"
              name="invite-email"
              autocomplete="off"
              placeholder="name@example.com"
              :disabled="inviting"
            />
            <label class="workspace-switcher-label" for="invite-role">As</label>
            <select
              id="invite-role"
              v-model="inviteRole"
              class="workspace-input"
              name="invite-role"
              :disabled="inviting"
            >
              <option v-for="role in ROLES" :key="role" :value="role">{{ role }}</option>
            </select>
            <button type="submit" class="btn-sm" :disabled="inviting || !inviteReady">
              {{ inviting ? 'Inviting…' : 'Invite' }}
            </button>
            <p class="settings-note">
              No email is sent and no link is made — tell them yourself. They see the invitation in
              their own Settings once they sign in to an account with that address, and nothing here
              says whether that address has one yet. An editor may write; a viewer may only read.
            </p>
          </form>
          <div v-if="pendingInvites.length" class="pending-invites">
            <p class="settings-note">Invited, waiting to accept:</p>
            <div v-for="invite in pendingInvites" :key="invite._id" class="invite-row">
              <span class="invite-label">{{ invite.email }} — {{ invite.role }}</span>
              <button
                v-if="workspace?.role === 'owner'"
                class="btn-sm"
                :disabled="inviting"
                @click="withdraw(invite)"
              >Withdraw</button>
            </div>
          </div>
          <p v-if="collabError" class="settings-error" role="alert">{{ collabError }}</p>
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
import OpenQuestionPanel from './OpenQuestionPanel.vue';
import GeneratorOverlay from './generator/GeneratorOverlay.vue';
import ShortcutCheatsheet from './ShortcutCheatsheet.vue';
import AccountDeletion from './AccountDeletion.vue';
import PasskeySettings from './PasskeySettings.vue';
import RecentlyDeleted from './RecentlyDeleted.vue';
import TagSettings from './TagSettings.vue';
import {
  changePassword,
  changePasswordWithPasskey,
  getTemplates,
  PASSWORD_MIN_LENGTH,
  passwordTooShort,
  revokeOtherSessions,
  revokeOtherSessionsWithPasskey,
} from '../api/auth.js';
import { searchEntities } from '../api/entities.js';
import { downloadWorkspaceExport, importWorkspaceFile } from '../api/export.js';
import {
  acceptInvite, createWorkspace, declineInvite, deleteWorkspace, getWorkspace, inviteCollaborator, isRole, listMembers,
  listMyInvites, listWorkspaces, listWorkspaceInvites, removeMember, renameWorkspace, roleCanWrite,
  selectWorkspace, setMemberRole, withdrawInvite, WORKSPACE_NAME_MAX,
} from '../api/workspace.js';
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
const { loadEntityTypes, applyEntityTypeUpdate } = useEntityTypes();

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
/**
 * The graph, while it is open, so a relationship frame can tell it to redraw
 * (KOL-149). Null whenever it is closed, which is also the right answer: a view
 * nobody is looking at refetches nothing, and it loads on mount when it reopens.
 */
const graphRef = ref(null);
/**
 * The open-question panel (KOL-152), and the panel itself while it is open so a
 * `question:*` frame can be handed to it. Null whenever it is closed, which is
 * the right answer too: a list nobody is looking at has nothing to move, and it
 * loads its first page when it reopens.
 */
const questionsOpen = ref(false);
const questionsRef = ref(null);
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
 * The *name* is refetched on each Settings open — it is only ever shown there,
 * and another session may have renamed it since. The *role* is wanted before
 * anything is on screen, so `loadRole()` below reads the same route on mount
 * (KOL-150): `role` comes from the server's reading of this user's own
 * membership, so the rename field is hidden for an editor or a viewer; the
 * server refuses it for them anyway (403 NOT_WORKSPACE_OWNER), which is what
 * the error branch below says.
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

/**
 * ─── The write gate, client side (KOL-150) ───────────────────────────────────
 *
 * `requireWriteRole` on the server refuses every unsafe method from a `viewer`
 * with `403 NOT_WORKSPACE_EDITOR`, and until this item nothing in the client
 * read the role it already had: `canWrite` was a prop defaulting to `true` and
 * the only caller that ever passed it was the read-only snapshot panel. So a
 * viewer — possible in the shipped product since collaborator invites
 * (KOL-124) — was shown Edit, Delete, `+ New`, the block editor, the
 * open-question form and every relationship control, and found out what they
 * could do by clicking.
 *
 * Derived **once, here**, and passed down. The alternative — each component
 * reading the role for itself — is a second request per panel and a gate that
 * gets forgotten on the next control somebody adds.
 *
 * Hierarchical, so an editor and an owner both pass (`roleCanWrite`).
 *
 * **An unknown role is permissive.** Not yet read, a failed `GET /workspace`,
 * or a role string this client version does not know: all three leave the
 * controls on screen. A blank panel while a read is in flight is a worse
 * failure than a 403 — it is indistinguishable from a workspace you have been
 * locked out of, and it would be *every* user's first paint — and the server
 * is the gate either way. The refusal handling below is what makes that safe:
 * a write that should not have been offered is at least now said out loud.
 */
const canWrite = computed(() => {
  const role = workspace.value?.role;
  return !isRole(role) || roleCanWrite(role);
});

/**
 * Tiered debug logging for the gate and for refused entity writes: set
 * localStorage.ENTITY_WRITE_LOG_LEVEL to off | light | normal | verbose
 * (default light). The server logs its half of a refusal on
 * WORKSPACE_LOG_LEVEL (`refused PUT /entities/… role read as viewer`).
 *   light   — the role as read and what it did to the write controls, naming
 *             what asked for the read; and every refused write, naming which
 *             write it was, its status and what the server said. A refusal
 *             used to be an unhandled promise rejection and a panel that just
 *             sat there, so "which write, refused why" is the whole question
 *   normal  — light, plus every entity write that landed
 *   verbose — normal, plus the refusal body as the server sent it
 */
const WRITE_LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function writeLog(level, msg) {
  let configured = null;
  try { configured = localStorage.getItem('ENTITY_WRITE_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((WRITE_LEVELS[configured] ?? WRITE_LEVELS.light) >= WRITE_LEVELS[level]) {
    console.log(`[entityWrite:${level}] ${msg}`);
  }
}

/**
 * The role, read on mount so the first paint already knows it. Only `role` is
 * wanted here — the name is Settings' business — but it is the same route and
 * the same document, so `workspace` is filled in and Settings refetches it on
 * open anyway.
 *
 * A failure is deliberately *not* written to `workspaceError`: that message
 * belongs to a Settings panel nobody has opened, and the one visible effect of
 * not knowing the role is that the controls stay on screen.
 */
async function loadRole(source) {
  try {
    workspace.value = await getWorkspace({ source });
    workspaceDraft.value = workspace.value.name;
    writeLog('light', `role in "${workspace.value.name}" read as ${workspace.value.role} → write controls ${canWrite.value ? 'shown' : 'hidden'} (source: ${source})`);
  } catch (err) {
    writeLog('light', `could not read this session's role: ${err.status ?? 'no status'} ${err.message}; write controls stay shown because an unknown role is permissive (source: ${source})`);
  }
}

/**
 * What a refused entity write says, from the error api/entities.js throws —
 * which carries the status and the parsed body rather than just a message.
 *
 * The server's codes are not copy (`docs/api.md` → Roles), so the three a
 * person can actually act on get a sentence; everything else shows what the
 * server said verbatim, because a 400 from the block validator *is* the
 * explanation ("gallery block: data.images[0].url is not a URL") and no
 * paraphrase of it would be as useful.
 */
function writeRefusalReason(err) {
  if (err.message === 'NOT_WORKSPACE_EDITOR') return 'you have read-only access to this workspace';
  if (err.status === 401) return 'your session has ended — sign in again';
  if (err.status === 413) return 'it is too large for the server to accept';
  return err.message || `the server answered ${err.status ?? 'nothing'}`;
}

/**
 * Says that a write did not happen, in the one place that can: a toast.
 *
 * Before this the three handlers below awaited the API with no `catch`, so a
 * 403, a 400, a 409 or a 413 became an unhandled promise rejection — the
 * editor's `finally` cleared its spinner, the panel stayed open, and nothing on
 * screen said the save had been refused. `useToasts` is the same surface
 * `useFilters` reports a failed search on.
 *
 * The caller keeps its panel and its input: there is nothing to retype, and the
 * message says what to fix. For the inline editors inside the detail panel
 * that means the `false` `onEntityUpdated` returns below (KOL-156) — a toast
 * over a block that had already reverted to its stored content was the one
 * place this promise was not kept.
 */
function reportWriteRefused({ what, source }, err) {
  addToast({
    actorType: 'system',
    actorLabel: 'Not saved',
    message: `${what} — ${writeRefusalReason(err)}`,
  });
  writeLog('light', `refused with ${err.status ?? 'no status'} "${err.message}"; the role here is ${workspace.value?.role ?? 'unknown'} (source: ${source})`);
  writeLog('verbose', `refusal body: ${JSON.stringify(err.body ?? null)}`);
}

async function loadWorkspace() {
  workspaceError.value = '';
  // A fresh open starts with nothing to explain: the invitations group is kept mounted by its own
  // message (KOL-137), and a refusal from a previous open must not resurrect an empty group.
  inviteError.value = '';
  try {
    workspace.value = await getWorkspace({ source: 'Settings → Workspace' });
    workspaceDraft.value = workspace.value.name;
  } catch (err) {
    workspaceError.value = 'Could not load this workspace’s name.';
  }
  await loadWorkspaceList();
  loadTemplates();
  loadCollaborators();
  loadMyInvites();
}

/**
 * The memberships behind the switcher. Its own request and its own failure: a
 * list that did not answer leaves the switcher out rather than hiding the name
 * above it. Separate from loadWorkspace() because a create refreshes exactly
 * this — the new workspace is a membership, and the server's list is the one
 * that decides the order (oldest first).
 */
async function loadWorkspaceList() {
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

/**
 * Creating a second workspace (KOL-123).
 *
 * `POST /auth/register` was the only thing in the product that had ever created
 * a workspace, so the switcher above had nothing to switch between. The form is
 * beside it on purpose: this is where another workspace comes from.
 *
 * Two shapes the server distinguishes and so does this:
 *
 *   - **a template** seeds the new workspace with entity types, relationship
 *     types and a little starter content, as signing up does;
 *   - **Empty** (`template: null`) seeds nothing, which is the only kind of
 *     workspace `POST /import` will write into — it refuses one that already
 *     holds content, and before this item every workspace an account had was
 *     seeded at signup.
 *
 * The create does **not** select what it creates — the server leaves
 * `POST /workspaces/:id/select` as the only writer of which workspace a session
 * acts in — so this follows it with the switcher's own `switchWorkspace()`,
 * which selects and then reloads. Creating a workspace you then have to go and
 * find is not what anyone means by the button.
 */
const EMPTY_TEMPLATE = '';          // the "Empty" option's value; sent as template: null
const templates = ref([]);          // [{ key, name, description }] from GET /templates
const newWorkspaceName = ref('');
const newWorkspaceTemplate = ref(EMPTY_TEMPLATE);
const workspaceCreating = ref(false);

const newWorkspaceReady = computed(() => !!newWorkspaceName.value.trim());

/**
 * The template list, fetched once per page load on the first Settings open (it
 * is code-defined and public — `GET /templates`). A failure is not fatal and is
 * not an error in Settings: with no list the picker offers Empty alone, which
 * is still a workspace, and the signup form takes the same view.
 */
async function loadTemplates() {
  if (templates.value.length) return;
  try {
    const list = await getTemplates();
    templates.value = Array.isArray(list) ? list : [];
    // Default to a seeded workspace when there is a template to seed from —
    // the same default signing up offers — and to Empty when there is not.
    if (templates.value.length && newWorkspaceTemplate.value === EMPTY_TEMPLATE) {
      newWorkspaceTemplate.value = templates.value[0].key;
    }
  } catch (err) {
    console.warn('[WikiLayout] GET /templates failed; the New workspace picker offers Empty only:', err.message);
  }
}

async function createNewWorkspace() {
  if (workspaceCreating.value || !newWorkspaceReady.value) return;
  const name = newWorkspaceName.value.trim();
  const template = newWorkspaceTemplate.value === EMPTY_TEMPLATE ? null : newWorkspaceTemplate.value;
  workspaceCreating.value = true;
  workspaceError.value = '';
  try {
    const created = await createWorkspace(name, { template, source: 'Settings → Workspace → New workspace' });
    newWorkspaceName.value = '';
    addToast({
      message: `Created ${created.name}`,
      actorType: 'system',
      actorLabel: 'Workspace',
    });
    // The switcher's list, so the new workspace is in it whether or not the
    // switch below gets as far as reloading the page.
    await loadWorkspaceList();
    // Deliberately a second request, through the one route that writes the
    // session's workspace. It reloads the page on success, so nothing after
    // this runs in the ordinary case.
    await switchWorkspace(created._id);
  } catch (err) {
    workspaceError.value = err.status === 409
      ? `You can own up to ${err.limit ?? 'a limited number of'} workspaces. Delete one, or ask for more.`
      : err.status === 400 && err.message === 'INVALID_WORKSPACE_NAME'
      ? `A workspace name has to be 1–${WORKSPACE_NAME_MAX} characters.`
      : err.status === 400
      ? 'That is not a template this server offers. Reload and try again.'
      : 'Could not create this workspace.';
  } finally {
    // Reset even on success, unlike the switcher: switchWorkspace() handles
    // its own refusal rather than throwing, so a select that failed would
    // otherwise leave this form disabled for good.
    workspaceCreating.value = false;
  }
}

/**
 * Deleting this workspace (KOL-133).
 *
 * The counterpart to the form above: until this existed, a workspace created
 * from the wrong template or by a mis-click was permanent — it kept counting
 * against the cap the create is refused on, and nothing could clear what was
 * inside it short of deleting the whole account.
 *
 * It deletes the workspace this session is **acting in**, which is the one this
 * group is about — its name is at the top of it and the switcher beside it is
 * how you get to another. Two presses: arming says what goes, because the
 * server's delete is hard (there is no soft-delete store to undo from) and it
 * takes every member's content with it, not only this user's.
 *
 * Then the page reloads, for the reason a switch does: everything on screen —
 * the entity list, the type registry, the filters and the `/events` stream —
 * belongs to the workspace that no longer exists. The server leaves the
 * session's selection alone and falls back to another membership on the next
 * request, so the reload lands in a workspace that is really there, and the
 * stream the server just closed reconnects into it.
 */
const workspaceDeleteArmed = ref(false);
const workspaceDeleting = ref(false);

function armWorkspaceDelete() {
  workspaceDeleteArmed.value = true;
  workspaceError.value = '';
}

async function confirmWorkspaceDelete() {
  if (workspaceDeleting.value || !workspace.value) return;
  const { _id: id, name } = workspace.value;
  workspaceDeleting.value = true;
  workspaceError.value = '';
  try {
    await deleteWorkspace(id, { name, source: 'Settings → Workspace → Delete this workspace' });
    reloadAfterSwitch();
    // Deliberately still deleting, as the switcher is: the page is on its way
    // out, and a button re-enabled for the half-second before it goes is a
    // second delete of a workspace that is already gone.
  } catch (err) {
    // 409 is the floor that keeps an account able to resolve a workspace at
    // all; 404 means it went somewhere else first — another tab, or a co-owner.
    workspaceError.value = err.status === 409
      ? 'This is your only workspace, so it cannot be deleted. Create another one first.'
      : err.status === 403
      ? 'Only an owner can delete this workspace.'
      : err.status === 404
      ? 'That workspace is already gone.'
      : 'Could not delete this workspace.';
    workspaceDeleteArmed.value = false;
    workspaceDeleting.value = false;
  }
}

/**
 * Collaborators (KOL-124): who is in this workspace, who has been asked, and
 * the invitations waiting for this account.
 *
 * Roles have been enforced on every content write since KOL-103 and said out
 * loud in this very group ("Your role here is …") since KOL-071, while nothing
 * in the product could produce a member who was not the owner. This is where
 * one comes from.
 *
 * **An invite names an email address and delivers nothing.** No mail is sent
 * and no link is minted, so the form says so: the inviter passes the word on
 * themselves, and the invitee finds the invitation here. The note also stays
 * silent about whether the address has an account, because the server
 * deliberately does not say — an invite form must not be a way to ask who has
 * registered.
 *
 * Each list is its own request with its own failure, like the switcher above: a
 * member list that did not answer leaves that part out rather than taking the
 * workspace name with it. The owner's controls are hidden for a non-owner
 * rather than decided here — the server refuses them either way with
 * `403 NOT_WORKSPACE_OWNER`.
 *
 * Accepting does not move this tab: the server leaves which workspace a session
 * acts in to `POST /workspaces/:id/select`, so a new membership appears in the
 * switcher and going there stays one deliberate choice.
 */
const ROLES = ['owner', 'editor', 'viewer'];

const members = ref([]);            // [{ userId, email, role, isOwner }] from GET /workspace/members
const pendingInvites = ref([]);     // the addresses waiting on this workspace
const myInvites = ref([]);          // the invitations waiting for this account
const inviteEmail = ref('');
const inviteRole = ref('editor');
const inviting = ref(false);
const memberBusy = ref(false);
const inviteBusy = ref(false);
const collabError = ref('');
// Said inside the Collaborators group, which is where every control that writes it lives.
// Accept and Decline live in "Invitations for you", one group up, so their refusals go in their
// own message instead of being printed somewhere the row they were about cannot be seen (KOL-137).
const inviteError = ref('');

const inviteReady = computed(() => !!inviteEmail.value.trim());

/** The member list and the pending invites, both open to every member. */
async function loadCollaborators() {
  try {
    members.value = await listMembers({ source: 'Settings → Collaborators' });
  } catch (err) {
    members.value = [];
  }
  try {
    pendingInvites.value = await listWorkspaceInvites({ source: 'Settings → Collaborators' });
  } catch (err) {
    pendingInvites.value = [];
  }
}

/** This account's own invitations — about workspaces it is not a member of yet. */
async function loadMyInvites() {
  try {
    myInvites.value = await listMyInvites({ source: 'Settings → Invitations for you' });
  } catch (err) {
    myInvites.value = [];
  }
}

/** What a refusal from one of these routes says to the person who caused it. */
function collaboratorMessage(err, fallback) {
  if (err.message === 'ALREADY_A_MEMBER') return 'That address is already a member of this workspace.';
  if (err.message === 'LAST_OWNER') return 'A workspace has to keep at least one owner.';
  if (err.message === 'INVALID_EMAIL') return 'That is not an email address.';
  if (err.message === 'INVALID_ROLE') return 'Pick owner, editor or viewer.';
  if (err.status === 403) return 'Only an owner can manage collaborators here.';
  if (err.status === 404) return 'That is no longer there — reopening Settings will refresh it.';
  return fallback;
}

async function sendInvite() {
  if (inviting.value || !inviteReady.value) return;
  const email = inviteEmail.value.trim();
  inviting.value = true;
  collabError.value = '';
  try {
    const invite = await inviteCollaborator(email, { role: inviteRole.value, source: 'Settings → Collaborators → Invite' });
    inviteEmail.value = '';
    addToast({
      message: `${invite.email} is invited as ${invite.role}. Tell them — no email is sent.`,
      actorLabel: 'Workspace',
    });
    await loadCollaborators();
  } catch (err) {
    collabError.value = collaboratorMessage(err, 'Could not send that invitation.');
  } finally {
    inviting.value = false;
  }
}

async function withdraw(invite) {
  if (inviting.value) return;
  inviting.value = true;
  collabError.value = '';
  try {
    await withdrawInvite(invite._id, { email: invite.email, source: 'Settings → Collaborators → Withdraw' });
    await loadCollaborators();
  } catch (err) {
    collabError.value = collaboratorMessage(err, 'Could not withdraw that invitation.');
  } finally {
    inviting.value = false;
  }
}

async function changeMemberRole(member, role) {
  if (memberBusy.value || !role || role === member.role) return;
  memberBusy.value = true;
  collabError.value = '';
  try {
    await setMemberRole(member.userId, role, {
      from: member.role,
      email: member.email,
      source: 'Settings → Collaborators → role',
    });
    addToast({ message: `${member.email ?? 'That member'} is now ${role}`, actorLabel: 'Workspace' });
  } catch (err) {
    collabError.value = collaboratorMessage(err, 'Could not change that role.');
  } finally {
    // Re-read either way: a refusal must leave the select showing the role the
    // server still holds, not the one that was clicked.
    await loadCollaborators();
    memberBusy.value = false;
  }
}


async function dropMember(member) {
  if (memberBusy.value) return;
  memberBusy.value = true;
  collabError.value = '';
  try {
    await removeMember(member.userId, {
      email: member.email,
      role: member.role,
      source: 'Settings → Collaborators → Remove',
    });
    addToast({
      message: `${member.email ?? 'That member'} no longer has access. Their content stays here.`,
      actorLabel: 'Workspace',
    });
  } catch (err) {
    collabError.value = collaboratorMessage(err, 'Could not remove that member.');
  } finally {
    await loadCollaborators();
    memberBusy.value = false;
  }
}

async function acceptMyInvite(invite) {
  if (inviteBusy.value) return;
  inviteBusy.value = true;
  inviteError.value = '';
  try {
    const joined = await acceptInvite(invite._id, { source: 'Settings → Invitations for you → Accept' });
    addToast({
      message: `Joined ${joined.name} as ${joined.role}. Switch to it in “Acting in” above.`,
      actorLabel: 'Workspace',
    });
    // The switcher's list, because the new membership belongs in it; this tab
    // stays where it is until the switcher is used.
    await loadWorkspaceList();
  } catch (err) {
    inviteError.value = collaboratorMessage(err, 'Could not accept that invitation.');
  } finally {
    await loadMyInvites();
    inviteBusy.value = false;
  }
}

async function declineMyInvite(invite) {
  if (inviteBusy.value) return;
  inviteBusy.value = true;
  inviteError.value = '';
  try {
    await declineInvite(invite._id, { workspaceName: invite.workspaceName, source: 'Settings → Invitations for you → Decline' });
  } catch (err) {
    inviteError.value = collaboratorMessage(err, 'Could not decline that invitation.');
  } finally {
    await loadMyInvites();
    inviteBusy.value = false;
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

/**
 * A question row's way in to the entity it is attached to. The panel closes
 * with the click, as the graph does: the panel it opens is underneath this
 * overlay, and a question is read in its entity's context.
 */
function onQuestionOpenEntry(id, title) {
  questionsOpen.value = false;
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
  // The role, which decides whether a write control is on screen at all
  // (KOL-150). Not awaited: the layout renders while it is in flight, and an
  // unread role is permissive on purpose — see `canWrite`.
  loadRole('WikiLayout mount');
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
  // The sidebar and the empty state hide `+ New` for a viewer, and the `n` key
  // is the one way in that cannot be hidden — the cheatsheet renders the
  // binding map, so a key removed from it for one role would have to be
  // removed from the list too. Refused here instead, rather than opening an
  // editor whose Save is a 403 (KOL-150).
  if (!canWrite.value) {
    writeLog('light', `refused to open the editor: the role here is ${workspace.value?.role ?? 'unknown'} (source: the "n" shortcut or a caller that is not the sidebar)`);
    return;
  }
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

/**
 * The three entity writes the detail panel and the editor ask for (KOL-150).
 *
 * Each one catches, because each one is a request that can be refused — and a
 * refusal here used to be silent. The catch does three things and no more: it
 * raises the toast, it leaves the panel exactly as it was (the editor keeps the
 * fields the user typed; a failed delete does not close the entity it failed to
 * delete), and it does not rethrow — there is nobody above to handle it, and a
 * rejection is what this was.
 *
 * Leaving the panel alone is enough only for the panels *this* function owns.
 * The detail panel's inline editors — a block's, the header's — close
 * themselves, so `onEntityUpdated` also hands back whether the write landed
 * (KOL-156); it is the one of the three with a caller that needs an answer.
 */
async function onEntitySaved(data) {
  let entity;
  try {
    entity = await addEntity(data);
  } catch (err) {
    reportWriteRefused({ what: 'Your new entity was not created', source: 'the editor’s Save → POST /entities' }, err);
    return;
  }
  writeLog('normal', `created ${entity._id} "${entity.title}" (source: the editor’s Save)`);
  closePanel(EDITOR_ID);
  openEntry(entity._id, entity.title);
}

/**
 * Every entity update the detail panel asks for — the header's form, a block
 * editor, a deleted or added block.
 *
 * It **reports whether the write landed** (KOL-156), because the panel's two
 * inline editors close themselves: they are not panels this function can leave
 * open, as `onEntitySaved` does for the editor above, so the only thing that
 * can keep a refused save's typed text on screen is this answer travelling
 * back down. `true` only after `editEntity` returned; `false` on every
 * refusal, alongside the toast. See lib/inlineEdit.js for the chain.
 */
async function onEntityUpdated(id, data) {
  try {
    await editEntity(id, data);
  } catch (err) {
    reportWriteRefused({ what: 'Your change was not saved', source: `an edit of ${id} → PUT /entities/:id` }, err);
    return false;
  }
  writeLog('normal', `updated ${id} (source: an edit in the detail panel)`);
  return true;
}

async function onEntityDeleted(id) {
  try {
    await removeEntity(id);
  } catch (err) {
    reportWriteRefused({ what: 'That entity was not deleted', source: `a delete of ${id} → DELETE /entities/:id` }, err);
    return;
  }
  writeLog('normal', `deleted ${id} (source: Delete entity in the detail panel)`);
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
  if (questionsOpen.value)   { questionsOpen.value = false; return; }
  if (graphOpen.value)       { graphOpen.value = false; return; }
  if (chatOpen.value)        { onChatClose(); return; }
  if (activePanelId.value)   { closePanel(activePanelId.value); return; }
}

function openNewEntity() {
  openEditor();
}

// Also the sidebar's Questions button. A toggle, like the graph and the chat:
// the key that opened the panel is the obvious way back out of it, and Escape
// closes it either way.
function toggleQuestions() {
  questionsOpen.value = !questionsOpen.value;
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
  q: { handler: toggleQuestions, label: 'Open the workspace’s open questions' },
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

// ─── Open-question frames (KOL-116) ───────────────────────────────────────────

/**
 * Whether a `question:*` frame changes what the open detail panel is showing.
 *
 * Two ways it can: the question is linked to that entity *now* (the frame's
 * `entry_ids`, which is why the payload carries them), or it was a moment ago
 * and no longer is — a question moved off this entity, or deleted from it, is a
 * change to this panel too, and the only record of the old link is the list the
 * panel is already holding.
 */
function questionTouchesPanel({ question, questionId, entry_ids }) {
  const shown = selectedEntity.value;
  if (!shown) return false;
  if ((entry_ids ?? []).some(id => String(id) === String(shown._id))) return true;
  const id = String(questionId ?? question?._id);
  return (shown.open_questions ?? []).some(q => String(q._id) === id);
}

/**
 * Refetches the entity on screen so its open-question section re-seeds from the
 * server, and says who. A refetch rather than a patch: the section renders what
 * the server last said about the entity (the populate on `GET /entities/:id`),
 * and the server is the one that decides what a write actually did.
 *
 * A frame for an entity nobody is looking at is dropped on purpose — the
 * sidebar does not show questions, so there would be nothing to update and a
 * toast about an entity off screen is noise. The workspace-wide question panel
 * is the one view that *does* care about every frame, and it is handed them
 * directly (KOL-152), not through here.
 */
function refreshQuestions(payload, message) {
  if (!questionTouchesPanel(payload)) return;
  const shown = selectedEntity.value;
  selectEntity(shown._id);
  addToast({
    actorLabel:  'Open questions',
    actorType:   'system',
    message,
    entityId:    shown._id,
    entityTitle: shown.title,
    changeType:  'updated',
  });
}

// ─── Relationship-group frames (KOL-149) ──────────────────────────────────────

/**
 * Whether a `group:*` frame changes what the open detail panel is showing.
 *
 * Two ways it can, the same two a `question:*` frame has: the frame's
 * `entityIds` names the entity on screen — the flattened member set, nested
 * subgroups included, which is why the payload carries it — or the panel is
 * showing the group that just changed, which is the case a removal makes
 * (`entityIds` carries the member that left, but a group the panel renders
 * through a *parent* of it would not be named at all).
 */
function groupTouchesPanel({ group, groupId, entityIds }) {
  const shown = selectedEntity.value;
  if (!shown) return false;
  if ((entityIds ?? []).some(id => String(id) === String(shown._id))) return true;
  const id = String(groupId ?? group?._id);
  return (shown.relationships ?? []).some(g => String(g._id) === id);
}

/**
 * The layout's answer to a relationship write in another tab.
 *
 * Two listeners, and they are not the same shape. **The graph redraws on every
 * frame**, because relationships are the whole of what it draws and it read the
 * group list once on mount — a group created, relabelled, reordered or deleted
 * elsewhere left it drawing edges that no longer exist, with nothing on screen
 * to say so. It reloads itself rather than being remounted, so the viewer keeps
 * their zoom, pan and layout. **The panel refetches only when the frame touches
 * it**: `RelationshipsSection` renders the groups the server resolved for that
 * one entity (`GET /entities/:id`), so the refresh is a refetch of the entity
 * on screen, and a frame about entities nobody is looking at has nothing to
 * update — the sidebar shows no relationships.
 */
function refreshRelationships(payload, frame, message) {
  graphRef.value?.reload?.(`a ${frame} frame`);

  if (!groupTouchesPanel(payload)) return;
  const shown = selectedEntity.value;
  selectEntity(shown._id);
  addToast({
    actorLabel:  'Relationships',
    actorType:   'system',
    message,
    entityId:    shown._id,
    entityTitle: shown.title,
    changeType:  'updated',
  });
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

  // ── Open questions (KOL-116) ──
  // Their own collection on their own route, so none of this rides along with
  // an entity frame. Two listeners per frame, and they are not the same shape.
  // **The detail panel refetches**, and only when the frame touches the entity
  // it is showing (the payload's `entry_ids` is there to say): that section
  // renders questions from the populated `entity.open_questions` it was handed
  // (components/EntityHeader.vue), so the server is what re-seeds it. **The
  // question panel patches its own list** from the frame, with no request at
  // all (KOL-152) — the payload carries the row and its links, which is enough
  // to move, drop or insert a row — and it takes *every* frame, because it
  // lists the whole workspace rather than one entity's questions.

  onQuestionCreated(payload) {
    questionsRef.value?.applyFrame?.('question:created', payload);
    refreshQuestions(payload, 'added a question to');
  },

  onQuestionUpdated(payload) {
    questionsRef.value?.applyFrame?.('question:updated', payload);
    refreshQuestions(payload, 'changed a question on');
  },

  onQuestionDeleted(payload) {
    questionsRef.value?.applyFrame?.('question:deleted', payload);
    refreshQuestions(payload, 'removed a question from');
  },

  // ── Relationship groups (KOL-149) ──
  // One `group:updated` stands for every write that changes a group's own row
  // (server/src/lib/relationshipEvents.js says why), so none of these can be
  // patched from the payload: the graph reloads and the open panel refetches.

  onGroupCreated(payload) {
    refreshRelationships(payload, 'group:created', 'added a relationship to');
  },

  onGroupUpdated(payload) {
    refreshRelationships(payload, 'group:updated', 'changed a relationship on');
  },

  onGroupDeleted(payload) {
    refreshRelationships(payload, 'group:deleted', 'removed a relationship from');
  },

  // ── Entity types (KOL-151) ──
  // A type rename is the largest write the product makes to a workspace's
  // entities, and the per-entity `entity:updated` frames it also sends cannot
  // say where the *name* went. Two things have to follow here, and only one of
  // them is a repaint: the shared registry is patched from the frame (the pills,
  // the pickers and every category colour read that one list), and a category
  // filter set to the old name is moved to the new one — otherwise the pill the
  // user is standing on matches nothing and the sidebar silently empties, which
  // is indistinguishable from a workspace that lost its entities.

  onEntityTypeUpdated({ entityType, from, to, relabelled, actor }) {
    applyEntityTypeUpdate(entityType, 'an entity-type:updated frame');
    if (from && to && activeCat.value === from) setCat(to);

    const moved = relabelled?.entities ?? 0;
    addToast({
      actorLabel: actor?.label ?? 'Entity types',
      actorType:  actor?.type ?? 'system',
      message:    `renamed the "${from}" type to "${to}"${moved ? `, moving ${moved} entit${moved === 1 ? 'y' : 'ies'}` : ''}`,
      changeType: 'updated',
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

/* Collaborators (KOL-124): one row per member or invite — the address on the left, its
   controls on the right, wrapping on a phone rather than overflowing. */
.member-row,
.invite-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0;
  font-size: 0.85rem;
}
.member-email,
.invite-label {
  flex: 1 1 10rem;
  min-width: 0;
  overflow-wrap: anywhere;
  color: #ddd;
}
.invite-from { color: #888; }
.member-role-label { color: #888; text-transform: capitalize; }
.member-role { flex: 0 0 auto; width: auto; padding: 0.25rem 0.4rem; }
.invite-form {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-top: 0.6rem;
}
.pending-invites { margin-top: 0.6rem; }

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

/* The New workspace form: stacked, so the name, the picker and the button each
   get the full width the switcher above them has. */
.workspace-create {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid #2a2a2a;
}

.workspace-create .workspace-switcher-label {
  margin-bottom: 0;
}

.workspace-create .workspace-input {
  width: 100%;
}

.workspace-create .btn-sm {
  margin-top: 6px;
  align-self: flex-start;
}

/* The delete, below the create and separated from it the same way: the two are
   opposite verbs on the same thing, and this one is irreversible. */
.workspace-delete {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid #2a2a2a;
}

.workspace-delete .settings-note { margin: 0; }

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
