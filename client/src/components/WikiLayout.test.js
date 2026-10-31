/**
 * Where the Passkeys, Recently deleted, Export workspace and Tags groups sit: in Settings, between
 * Account and Delete account, and — bar the Export row, which fetches nothing until it is pressed —
 * mounted only while Settings shows, so their lists are fetched fresh on each open and
 * never on page load. What each group itself does is pinned in PasskeySettings.test.js,
 * RecentlyDeleted.test.js and TagSettings.test.js; what is asserted here is that Tags is handed the
 * entity list the layout already holds (its counts come from there, not from a route) and that a
 * change refetches it, and that a restore refetches it too — the restoring tab is excluded from its
 * own entity:created broadcast, so nothing else would put the entity back in its sidebar. Also that
 * the entity-type registry is loaded once on mount; what the sidebar does with it is pinned in
 * EntitySidebar.test.js. Shallow: every child is a stub, and the composables that would reach the
 * network or open an EventSource are replaced.
 *
 * The last two groups are the exception — they mount the list for real (sidebar, cards and all) over
 * entities that carry no `blocks`, which is the shape `GET /entities` now sends (KOL-061). Nothing
 * on this path reads block content, and the group fails if something starts to. `useFilters` is
 * therefore the real composable throughout this file rather than a stub: it reaches no network of
 * its own — the layout hands it the keyword request (KOL-068), which is mocked above — and what it
 * reads off an entity is part of what is pinned here.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount, shallowMount } from '@vue/test-utils';
import WikiLayout from './WikiLayout.vue';
import PasskeySettings from './PasskeySettings.vue';
import RecentlyDeleted from './RecentlyDeleted.vue';
import TagSettings from './TagSettings.vue';
import EntitySidebar from './EntitySidebar.vue';
import EntityEditor from './EntityEditor.vue';
import ChatPanel from './ChatPanel.vue';
import GraphView from './GraphView.vue';
import ShortcutCheatsheet from './ShortcutCheatsheet.vue';
import { SEARCH_DEBOUNCE_MS } from '../composables/useFilters.js';
import { useKeyboardShortcuts } from '../composables/useKeyboardShortcuts.js';

// The layout now holds a window-level keydown listener (KOL-063), so a wrapper
// left mounted keeps answering keys for the rest of the file. Unmount them all.
enableAutoUnmount(afterEach);

const { entities, loadEntities, selectEntity, realEntities, stubbedEntities } = vi.hoisted(() => ({
  entities: [], loadEntities: vi.fn(), selectEntity: vi.fn(),
  // The last stubbed composable the layout took, so the live-sync group can put
  // an entity on screen — the open-question frames only act on the panel that
  // is open. A holder rather than a shared ref: every other group here expects
  // its own mount to start with nothing selected.
  stubbedEntities: {},
  // The paged-load group at the bottom needs the *real* composable — the thing
  // it asserts is that two pages end up as one list of cards — while every
  // other group here needs the stub. A flag, rather than a second test file
  // mounting its own copy of this layout.
  realEntities: { value: false },
}));
vi.mock('../composables/useEntities.js', async (importOriginal) => {
  const { ref } = await import('vue');
  const actual = await importOriginal();
  return {
    useEntities: () => {
      if (realEntities.value) return actual.useEntities();
      const stub = {
        entities: ref(entities), selectedEntity: ref(null), sidebarLoading: ref(false), detailLoading: ref(false),
        loadError: ref(null),
        loadEntities, selectEntity, addEntity: vi.fn(), editEntity: vi.fn(), removeEntity: vi.fn(),
      };
      stubbedEntities.last = stub;
      return stub;
    },
  };
});
// Mocked for the paged-load group, which is the only one that reaches it: the
// real composable calls getEntityPage, and nothing in a test should fetch.
const { getEntityPage, searchEntities } = vi.hoisted(() => ({ getEntityPage: vi.fn(), searchEntities: vi.fn() }));
vi.mock('../api/entities.js', () => ({
  ENTITY_PAGE_SIZE: 200,
  getEntityPage, searchEntities,
  getEntities: vi.fn(), getEntity: vi.fn(), createEntity: vi.fn(),
  updateEntity: vi.fn(), deleteEntity: vi.fn(),
  getEntityHistory: vi.fn(), rollbackEntity: vi.fn(),
  getDeletedEntities: vi.fn(), restoreEntity: vi.fn(),
}));
// The Export workspace row calls this; nothing in a test should fetch, and nothing should try to
// save a file. What the real module does with the response is its own concern (api/export.js).
// The Import workspace row posts through importWorkspaceFile (KOL-077), on the same terms.
const { downloadWorkspaceExport, importWorkspaceFile } = vi.hoisted(() => ({
  downloadWorkspaceExport: vi.fn(), importWorkspaceFile: vi.fn(),
}));
vi.mock('../api/export.js', () => ({
  downloadWorkspaceExport,
  default: downloadWorkspaceExport,
  importWorkspaceFile,
  filenameFromDisposition: vi.fn(),
  FALLBACK_FILENAME: 'workspace-export.json',
  IMPORT_MESSAGES: {},
}));
// The Password group posts through these (KOL-074); nothing in a test should fetch, and nothing
// should prompt an authenticator. The two policy exports are the real thing rather than stubs —
// the rule is not network, and a stub returning undefined would let the form send a password the
// server would refuse. What api/auth.js itself does with a response is its own concern.
// The Sign out everywhere row posts through the two below (KOL-076), on the same terms.
// The New workspace picker is built from GET /templates (KOL-123), which the layout asks for on
// the first Settings open — public, code-defined, and the same list the signup form offers.
const { changePassword, changePasswordWithPasskey, getTemplates, revokeOtherSessions, revokeOtherSessionsWithPasskey } = vi.hoisted(() => ({
  getTemplates: vi.fn(async () => [
    { key: 'worldbuilding', name: 'Worldbuilding', description: 'Characters, worlds and so on.' },
    { key: 'software-architecture', name: 'Software Architecture', description: 'Services and data stores.' },
  ]),
  changePassword: vi.fn(async () => ({ ok: true })),
  changePasswordWithPasskey: vi.fn(async () => ({ ok: true })),
  revokeOtherSessions: vi.fn(async () => ({ ok: true, revokedAt: '2026-10-15T12:00:00.000Z' })),
  revokeOtherSessionsWithPasskey: vi.fn(async () => ({ ok: true, revokedAt: '2026-10-15T12:00:00.000Z' })),
}));
vi.mock('../api/auth.js', () => ({
  changePassword, changePasswordWithPasskey,
  revokeOtherSessions, revokeOtherSessionsWithPasskey,
  PASSWORD_MIN_LENGTH: 12,
  passwordTooShort: (value) => [...(value ?? '')].length < 12,
  login: vi.fn(), register: vi.fn(), logout: vi.fn(), getSession: vi.fn(), getTemplates,
  registerPasskey: vi.fn(), loginWithPasskey: vi.fn(), passkeysSupported: () => false,
  deleteAccount: vi.fn(), deleteAccountWithPasskey: vi.fn(),
  listPasskeys: vi.fn(async () => ({ passkeys: [], hasPassword: true, userHandle: null, rpId: 'localhost' })),
  removePasskey: vi.fn(),
}));
// The Workspace group reads GET /workspace on each Settings open and PATCHes a rename;
// nothing in a test should fetch. What the module itself does is its own concern
// (api/workspace.js).
// The switcher (KOL-090) reads GET /workspaces on the same open and POSTs the choice.
// `POST /workspaces` creates a second one (KOL-123); the form sends it and then goes through
// selectWorkspace, since the server leaves the selection to that one route.
// Collaborators (KOL-124): the member list, the pending invites and this account's own
// invitations are three more reads on each Settings open, and the invite form writes.
const {
  acceptInvite, declineInvite, inviteCollaborator, listMembers, listMyInvites,
  listWorkspaceInvites, removeMember, setMemberRole, withdrawInvite,
} = vi.hoisted(() => ({
  acceptInvite: vi.fn(async () => ({ _id: 'w2', name: 'The Shared Compendium', role: 'editor', createdAt: '2026-10-09T00:00:00.000Z' })),
  declineInvite: vi.fn(async () => undefined),
  inviteCollaborator: vi.fn(async (email, { role } = {}) => ({ _id: 'i9', email, role: role ?? 'editor', invitedBy: 'u1', createdAt: '2026-10-30T00:00:00.000Z' })),
  listMembers: vi.fn(async () => [
    { userId: 'u1', email: 'alice@example.test', role: 'owner', isOwner: true },
    { userId: 'u2', email: 'bob@example.test', role: 'editor', isOwner: false },
  ]),
  listMyInvites: vi.fn(async () => []),
  listWorkspaceInvites: vi.fn(async () => []),
  removeMember: vi.fn(async () => undefined),
  setMemberRole: vi.fn(async (userId, role) => ({ userId, role })),
  withdrawInvite: vi.fn(async () => undefined),
}));
const { createWorkspace, getWorkspace, listWorkspaces, renameWorkspace, selectWorkspace } = vi.hoisted(() => ({
  createWorkspace: vi.fn(async (name) => ({ _id: 'w9', name, role: 'owner', createdAt: '2026-10-20T00:00:00.000Z' })),
  getWorkspace: vi.fn(async () => ({ _id: 'w1', name: 'Alice’s Bible', role: 'owner', createdAt: '2026-10-10T00:00:00.000Z' })),
  listWorkspaces: vi.fn(async () => [{ _id: 'w1', name: 'Alice’s Bible', role: 'owner', createdAt: '2026-10-10T00:00:00.000Z' }]),
  renameWorkspace: vi.fn(async (name) => ({ _id: 'w1', name, role: 'owner', createdAt: '2026-10-10T00:00:00.000Z' })),
  selectWorkspace: vi.fn(async (id) => ({ _id: id, name: 'The Shared Compendium', role: 'editor', createdAt: '2026-10-09T00:00:00.000Z' })),
}));
vi.mock('../api/workspace.js', () => ({
  createWorkspace, getWorkspace, listWorkspaces, renameWorkspace, selectWorkspace,
  acceptInvite, declineInvite, inviteCollaborator, listMembers, listMyInvites,
  listWorkspaceInvites, removeMember, setMemberRole, withdrawInvite,
  WORKSPACE_NAME_MAX: 80, default: getWorkspace,
}));
// One Escape case below mounts the generator overlay for real (KOL-084), and the overlay asks for
// the AI allowance as it opens; nothing in a test should fetch. The rest of the module is mocked
// with it because the overlay's subtree imports it too (the braindump input's producers, the
// review's decide/apply calls) — none of it is called here.
const { getAllowance } = vi.hoisted(() => ({
  getAllowance: vi.fn(async () => ({
    grantedMicros: 3_500_000, spentMicros: 0, remainingMicros: 3_500_000,
    exhausted: false, granted: '$3.50', spent: '$0.00', remaining: '$3.50',
  })),
}));
vi.mock('../api/drafts.js', () => ({
  getAllowance, streamDraft: vi.fn(), listDrafts: vi.fn(), getDraft: vi.fn(), discardDraft: vi.fn(),
  decideItem: vi.fn(), retargetItem: vi.fn(), acceptClean: vi.fn(), applyDraft: vi.fn(),
  createComposeDraft: vi.fn(), createOpenApiDraft: vi.fn(), createKubernetesDraft: vi.fn(), createSqlDraft: vi.fn(),
}));
// One Escape case below mounts the chat panel for real (KOL-085), and the panel asks for the
// providers and the conversation list as it mounts; nothing in a test should fetch. The rename the
// case drives goes through `renameConversation`, which is what proves a cancelled rename saved
// nothing.
const { getProviders, listConversations, renameConversation } = vi.hoisted(() => ({
  getProviders: vi.fn(async () => ([
    { id: 'anthropic', name: 'Anthropic', models: ['claude-opus-5'], defaultModel: 'claude-opus-5' },
  ])),
  listConversations: vi.fn(async () => ([
    { _id: 'c1', title: 'Boiler notes', provider: 'anthropic', model: 'claude-opus-5' },
  ])),
  renameConversation: vi.fn(async () => ({})),
}));
vi.mock('../api/chat.js', () => ({ getProviders, streamChat: vi.fn() }));
vi.mock('../api/conversations.js', () => ({
  listConversations, renameConversation,
  createConversation: vi.fn(), getConversation: vi.fn(),
  deleteConversation: vi.fn(), generateTitle: vi.fn(),
}));
// useFilters is deliberately NOT mocked: it reaches nothing by itself — the layout hands it the
// keyword request, which is the mocked `searchEntities` above — and the fields it reads off a
// listed entity are the point of the list group below.
vi.mock('../composables/useNavigation.js', async () => {
  const { ref } = await import('vue');
  return {
    useNavigation: () => ({ breadcrumbs: ref([]), startNavigation: vi.fn(), pushCrumb: vi.fn(), navigateToIndex: vi.fn() }),
  };
});
// Mocked, and held onto: the live-sync group at the bottom reads the handlers the layout
// registered and delivers a frame to them, which is how a bulk write from another tab is
// driven without a socket (KOL-102). What the composable itself does with a frame is pinned in
// composables/useEvents.test.js.
const { useEvents, addToast } = vi.hoisted(() => ({ useEvents: vi.fn(), addToast: vi.fn() }));
vi.mock('../composables/useEvents.js', () => ({ useEvents }));
vi.mock('../composables/useToasts.js', () => ({ useToasts: () => ({ addToast }) }));
const { loadEntityTypes } = vi.hoisted(() => ({ loadEntityTypes: vi.fn() }));
vi.mock('../composables/useEntityTypes.js', async () => {
  const { ref } = await import('vue');
  return {
    useEntityTypes: () => ({
      types: ref([]), names: ref([]), styleFor: () => ({ bg: '#333', color: '#aaa' }), loadEntityTypes,
    }),
  };
});

const settingsTab = (wrapper) => wrapper.findAll('.tab-btn').find((b) => b.text() === 'Settings');
const listTab = (wrapper) => wrapper.findAll('.tab-btn').find((b) => b.text() === 'List');

describe('WikiLayout entity types', () => {
  it('loads the entity-type registry once when it mounts', () => {
    loadEntityTypes.mockClear();
    shallowMount(WikiLayout);
    expect(loadEntityTypes).toHaveBeenCalledTimes(1);
  });
});

describe('WikiLayout settings', () => {
  it('opens with Workspace, then Collaborators, then Account, then Password beside Passkeys, and Delete account last', () => {
    const wrapper = shallowMount(WikiLayout);

    const titles = wrapper.findAll('.mobile-settings-panel .settings-group-title').map((t) => t.text());
    // Import sits directly under Export: they are the two halves of one file format (KOL-077).
    // Collaborators follows Workspace, because it is about the same workspace (KOL-124).
    // "Invitations for you" would sit between them, and is absent here: this account has none.
    expect(titles).toEqual([
      'Workspace', 'Collaborators', 'Account', 'Password', 'Passkeys', 'Recently deleted',
      'Export workspace', 'Import workspace', 'Tags', 'Delete account',
    ]);
  });

  it('mounts the group only while Settings shows: the mobile tab, or the overlay from the sidebar', async () => {
    const wrapper = shallowMount(WikiLayout);
    expect(wrapper.findComponent(PasskeySettings).exists()).toBe(false);

    await settingsTab(wrapper).trigger('click');
    expect(wrapper.findComponent(PasskeySettings).exists()).toBe(true);

    await wrapper.get('.settings-close').trigger('click');
    expect(wrapper.findComponent(PasskeySettings).exists()).toBe(false);

    wrapper.findComponent(EntitySidebar).vm.$emit('settings');
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(PasskeySettings).exists()).toBe(true);
  });

  it('leaving Settings through the tab bar disarms the overlay, not just the tab', async () => {
    const wrapper = shallowMount(WikiLayout);

    wrapper.findComponent(EntitySidebar).vm.$emit('settings');
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(PasskeySettings).exists()).toBe(true);

    await listTab(wrapper).trigger('click');
    expect(wrapper.findComponent(PasskeySettings).exists()).toBe(false);
  });

  it('hands the Tags group the entity list it already holds, and refetches when it changes', async () => {
    entities.length = 0;
    entities.push({ _id: 'a', title: 'Engine', tags: ['train'] });
    loadEntities.mockClear();

    const wrapper = shallowMount(WikiLayout);
    expect(wrapper.findComponent(TagSettings).exists()).toBe(false);

    await settingsTab(wrapper).trigger('click');
    const group = wrapper.findComponent(TagSettings);
    expect(group.exists()).toBe(true);
    expect(group.props('entities')).toEqual(entities);

    // One call is the mount's own load; the group's `changed` has to add another.
    const beforeChange = loadEntities.mock.calls.length;
    group.vm.$emit('changed');
    await wrapper.vm.$nextTick();
    expect(loadEntities.mock.calls.length).toBe(beforeChange + 1);
  });

  it('refetches the entity list when the Recently deleted group restores one', async () => {
    loadEntities.mockClear();
    const wrapper = shallowMount(WikiLayout);
    expect(wrapper.findComponent(RecentlyDeleted).exists()).toBe(false);

    await settingsTab(wrapper).trigger('click');
    const group = wrapper.findComponent(RecentlyDeleted);
    expect(group.exists()).toBe(true);

    // One call is the mount's own load; the restore has to add another.
    const beforeRestore = loadEntities.mock.calls.length;
    group.vm.$emit('restored', 'ent-brakeman');
    await wrapper.vm.$nextTick();
    expect(loadEntities.mock.calls.length).toBe(beforeRestore + 1);
  });

  // The way out of the product (KOL-070). The row is the only thing in Settings that is NOT gated
  // on `settingsVisible`: it fetches nothing until it is pressed, so there is no stale list to keep
  // fresh. What the request and the saved file look like is pinned on the server
  // (server/tests/http/export.test.js) and in api/export.js; what matters here is that the row
  // reaches the API at all, and that a refusal stays in Settings.
  const exportRow = (wrapper) =>
    wrapper.findAll('.mobile-settings-panel .settings-row').find((b) => b.text().startsWith('Download workspace'));

  it('the Export workspace row asks the API for the download', async () => {
    downloadWorkspaceExport.mockClear();
    downloadWorkspaceExport.mockResolvedValue({ filename: 'my-workspace-2026-10-10.json', bytes: 2048 });
    const wrapper = shallowMount(WikiLayout);

    await settingsTab(wrapper).trigger('click');
    expect(downloadWorkspaceExport).not.toHaveBeenCalled();

    await exportRow(wrapper).trigger('click');
    expect(downloadWorkspaceExport).toHaveBeenCalledTimes(1);
    // Every light-tier log line names what started the export, so the source is part of the call.
    expect(downloadWorkspaceExport.mock.calls[0][0]).toMatchObject({ source: expect.stringContaining('Settings') });

    await flushPromises();
    expect(wrapper.find('.settings-error').exists()).toBe(false);
  });

  it('a failed export says so in Settings rather than navigating away', async () => {
    downloadWorkspaceExport.mockClear();
    downloadWorkspaceExport.mockRejectedValue(new Error('No workspace for this user'));
    const wrapper = shallowMount(WikiLayout);

    await settingsTab(wrapper).trigger('click');
    await exportRow(wrapper).trigger('click');
    await flushPromises();

    expect(wrapper.get('.settings-error').text()).toBe('No workspace for this user');
    // And the row is usable again, so a transient failure is not a dead end.
    expect(exportRow(wrapper).attributes('disabled')).toBeUndefined();
  });

  // The way back in (KOL-077). The file is read and posted by api/export.js, whose own behaviour
  // is pinned on the server (server/tests/http/import.test.js); what matters here is that choosing
  // a file reaches the API, that the sidebar is reloaded afterwards — every entity in it was just
  // created — and that a refusal (409 WORKSPACE_NOT_EMPTY, most of the time) stays in Settings.
  const fileInput = (wrapper) => wrapper.find('.mobile-settings-panel input[type="file"]');
  const chooseFile = async (wrapper) => {
    const input = fileInput(wrapper);
    // A plain object, not a File: the api module is mocked, so nothing reads it.
    Object.defineProperty(input.element, 'files', { value: [{ name: 'my-workspace-2026-10-15.json' }], configurable: true });
    await input.trigger('change');
  };

  it('the Import workspace row sends the chosen file and reloads the entities', async () => {
    importWorkspaceFile.mockClear();
    importWorkspaceFile.mockResolvedValue({
      version: 'kol-emet/workspace-export@1',
      imported: { entityTypes: 0, relationshipTypes: 1, entities: 3, relationshipGroups: 2, openQuestions: 1 },
      skipped: { entityTypes: 6, relationshipTypes: 4 },
      dropped: { members: 0, questionEntries: 0 },
    });
    const wrapper = shallowMount(WikiLayout);

    await settingsTab(wrapper).trigger('click');
    expect(importWorkspaceFile).not.toHaveBeenCalled();

    const beforeReload = loadEntities.mock.calls.length;
    await chooseFile(wrapper);
    expect(importWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(importWorkspaceFile.mock.calls[0][0]).toMatchObject({ name: 'my-workspace-2026-10-15.json' });
    // Every light-tier log line names what started the import, so the source is part of the call.
    expect(importWorkspaceFile.mock.calls[0][1]).toMatchObject({ source: expect.stringContaining('Settings') });

    await flushPromises();
    expect(wrapper.find('.settings-error').exists()).toBe(false);
    expect(wrapper.text()).toContain('Imported 3 entities');
    expect(loadEntities.mock.calls.length).toBe(beforeReload + 1);
  });

  it('a refused import says why in Settings, and the entities are left alone', async () => {
    importWorkspaceFile.mockClear();
    importWorkspaceFile.mockRejectedValue(
      Object.assign(new Error('This workspace already has content.'), { status: 409, code: 'WORKSPACE_NOT_EMPTY' }),
    );
    const wrapper = shallowMount(WikiLayout);

    await settingsTab(wrapper).trigger('click');
    const beforeReload = loadEntities.mock.calls.length;
    await chooseFile(wrapper);
    await flushPromises();

    expect(wrapper.get('.settings-error').text()).toBe('This workspace already has content.');
    expect(loadEntities.mock.calls.length).toBe(beforeReload, 'a refused import must not refetch');
    // And the input is usable again: the same file is the one you retry with.
    expect(fileInput(wrapper).attributes('disabled')).toBeUndefined();
  });
});

/**
 * The Workspace group (KOL-071): the name of the workspace this session is in, and a rename for
 * its owner. The name is fetched when Settings opens, not on page load — it is shown nowhere else,
 * and another session may have renamed it since — and the rename goes through the api module, whose
 * own behaviour is its concern. `role` decides whether the field is there at all; the server
 * refuses a non-owner's rename anyway (403 NOT_WORKSPACE_OWNER), which is the error case below.
 *
 * Goes red if the group stops reading the name, if the rename stops reaching the API, or if the
 * field is rendered for a role that may not use it.
 */
describe('WikiLayout workspace group', () => {
  const OWNED = { _id: 'w1', name: 'Alice’s Bible', role: 'owner', createdAt: '2026-10-10T00:00:00.000Z' };

  const SHARED = { _id: 'w2', name: 'The Shared Compendium', role: 'editor', createdAt: '2026-10-09T00:00:00.000Z' };

  const CREATED = { _id: 'w9', name: 'A Second Bible', role: 'owner', createdAt: '2026-10-20T00:00:00.000Z' };

  beforeEach(() => {
    getWorkspace.mockReset();
    listWorkspaces.mockReset();
    renameWorkspace.mockReset();
    selectWorkspace.mockReset();
    createWorkspace.mockReset();
    getWorkspace.mockResolvedValue({ ...OWNED });
    // One membership: the ordinary case, and — since KOL-123 — one the switcher
    // is shown for anyway, because it is where a created workspace shows up.
    listWorkspaces.mockResolvedValue([{ ...OWNED }]);
    createWorkspace.mockImplementation(async (name) => ({ ...CREATED, name }));
    renameWorkspace.mockImplementation(async (name) => ({ ...OWNED, name }));
    selectWorkspace.mockImplementation(async (id) => (id === SHARED._id ? { ...SHARED } : { ...OWNED }));
  });

  const group = (wrapper) =>
    wrapper.findAll('.mobile-settings-panel .settings-group')
      .find((g) => g.get('.settings-group-title').text() === 'Workspace');

  async function openSettings() {
    const wrapper = shallowMount(WikiLayout);
    expect(getWorkspace).not.toHaveBeenCalled();   // nothing is fetched on page load
    await settingsTab(wrapper).trigger('click');
    await flushPromises();
    return wrapper;
  }

  it('shows the workspace name, fetched when Settings opens', async () => {
    const wrapper = await openSettings();

    expect(getWorkspace).toHaveBeenCalledTimes(1);
    // Every light-tier log line names what asked, so the source is part of the call.
    expect(getWorkspace.mock.calls[0][0]).toMatchObject({ source: expect.stringContaining('Settings') });
    expect(group(wrapper).get('.workspace-name').text()).toBe(OWNED.name);
  });

  it('an owner renames it: the typed name reaches the API and the group shows it', async () => {
    const wrapper = await openSettings();

    await group(wrapper).get('.workspace-input').setValue('The Signal Archive');
    await group(wrapper).get('form.workspace-rename').trigger('submit');
    await flushPromises();

    expect(renameWorkspace).toHaveBeenCalledTimes(1);
    expect(renameWorkspace.mock.calls[0][0]).toBe('The Signal Archive');
    // The light tier names the source and the name being replaced, not just the new value.
    expect(renameWorkspace.mock.calls[0][1]).toMatchObject({
      source: expect.stringContaining('Settings'),
      from: OWNED.name,
    });
    expect(group(wrapper).get('.workspace-name').text()).toBe('The Signal Archive');
    expect(group(wrapper).find('.settings-error').exists()).toBe(false);
  });

  it('trims the typed name, and does not send a rename to the name it already has', async () => {
    const wrapper = await openSettings();

    await group(wrapper).get('.workspace-input').setValue(`  ${OWNED.name}  `);
    await group(wrapper).get('form.workspace-rename').trigger('submit');
    await flushPromises();
    expect(renameWorkspace).not.toHaveBeenCalled();

    await group(wrapper).get('.workspace-input').setValue('  The Trimmed Archive  ');
    await group(wrapper).get('form.workspace-rename').trigger('submit');
    await flushPromises();
    expect(renameWorkspace.mock.calls[0][0]).toBe('The Trimmed Archive');
  });

  it('a member who is not the owner reads the name, with no rename field', async () => {
    getWorkspace.mockResolvedValue({ ...OWNED, role: 'editor' });
    const wrapper = await openSettings();

    expect(group(wrapper).get('.workspace-name').text()).toBe(OWNED.name);
    expect(group(wrapper).find('.workspace-rename').exists()).toBe(false);
    expect(group(wrapper).get('.settings-note').text()).toContain('Only an owner can rename');
  });

  /**
   * The switcher (KOL-090). Absent for a one-workspace user, which is every account until
   * invites land: there is nothing to choose between, and a select with one option is a control
   * that only looks like a choice. Present the moment there are two, and choosing one goes
   * through the API — the choice is server-side session state, so a switch the server did not
   * accept is not a switch.
   */
  describe('the switcher', () => {
    it('is there for a user with one workspace too, since they can create a second', async () => {
      const wrapper = await openSettings();

      expect(listWorkspaces).toHaveBeenCalledTimes(1);
      expect(listWorkspaces.mock.calls[0][0]).toMatchObject({ source: expect.stringContaining('Settings') });
      // It used to hide itself here (KOL-090), on the grounds that there was nothing to choose
      // between. KOL-123 made a second workspace something a user can have, and this is where
      // the one they just created appears.
      const select = group(wrapper).get('.workspace-switcher select');
      expect(select.findAll('option').map((o) => o.attributes('value'))).toEqual([OWNED._id]);
      expect(select.element.value).toBe(OWNED._id);
      expect(group(wrapper).get('.workspace-name').text()).toBe(OWNED.name);
    });

    it('is absent only when the list did not answer at all', async () => {
      listWorkspaces.mockRejectedValue(new Error('offline'));
      const wrapper = await openSettings();

      expect(group(wrapper).find('.workspace-switcher').exists()).toBe(false);
      // And the name above it is untouched: the two are separate requests.
      expect(group(wrapper).get('.workspace-name').text()).toBe(OWNED.name);
      expect(group(wrapper).find('.settings-error').exists()).toBe(false);
    });

    it('lists both for a user with two, with the current one selected', async () => {
      listWorkspaces.mockResolvedValue([{ ...SHARED }, { ...OWNED }]);
      const wrapper = await openSettings();

      const select = group(wrapper).get('.workspace-switcher select');
      expect(select.findAll('option').map((o) => o.attributes('value'))).toEqual([SHARED._id, OWNED._id]);
      // The order is the server's (oldest first), and the value is the resolved workspace —
      // never the first option, which is a different workspace here.
      expect(select.element.value).toBe(OWNED._id);
      expect(select.findAll('option').map((o) => o.text())).toEqual([
        `${SHARED.name} — ${SHARED.role}`,
        `${OWNED.name} — ${OWNED.role}`,
      ]);
    });

    it('choosing another one sends the selection, naming the workspace it leaves', async () => {
      listWorkspaces.mockResolvedValue([{ ...SHARED }, { ...OWNED }]);
      const wrapper = await openSettings();

      await group(wrapper).get('.workspace-switcher select').setValue(SHARED._id);
      await flushPromises();

      expect(selectWorkspace).toHaveBeenCalledTimes(1);
      expect(selectWorkspace.mock.calls[0][0]).toBe(SHARED._id);
      // Every light-tier line names the source and what is being replaced, not just the new value.
      expect(selectWorkspace.mock.calls[0][1]).toMatchObject({
        source: expect.stringContaining('Settings'),
        from: OWNED.name,
      });
    });

    it('does not re-select the workspace already resolved', async () => {
      listWorkspaces.mockResolvedValue([{ ...SHARED }, { ...OWNED }]);
      const wrapper = await openSettings();

      await group(wrapper).get('.workspace-switcher select').setValue(OWNED._id);
      await flushPromises();

      expect(selectWorkspace).not.toHaveBeenCalled();
    });

    it('a refused switch says so, and the group still shows where the session is', async () => {
      listWorkspaces.mockResolvedValue([{ ...SHARED }, { ...OWNED }]);
      selectWorkspace.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
      const wrapper = await openSettings();

      await group(wrapper).get('.workspace-switcher select').setValue(SHARED._id);
      await flushPromises();

      expect(group(wrapper).get('.settings-error').text()).toBe('You are no longer a member of that workspace.');
      expect(group(wrapper).get('.workspace-name').text()).toBe(OWNED.name);
    });
  });

  /**
   * The New workspace form (KOL-123). `POST /auth/register` was the only thing in the product
   * that had ever created a workspace, so the switcher above it had nothing to switch between.
   *
   * Three things are pinned here: the name and the chosen template reach the API, "Empty" sends
   * `template: null` (the only kind of workspace an import will write into), and the create is
   * followed by the *existing* select call — the server does not select what it creates, and the
   * client must not pretend otherwise by rendering the new workspace as the current one.
   */
  describe('the New workspace form', () => {
    const form = (wrapper) => group(wrapper).get('form.workspace-create');

    async function fillAndSubmit(wrapper, name, templateKey) {
      await form(wrapper).get('#new-workspace-name').setValue(name);
      if (templateKey !== undefined) await form(wrapper).get('#new-workspace-template').setValue(templateKey);
      await form(wrapper).trigger('submit');
      await flushPromises();
    }

    it('offers each template from GET /templates, plus Empty', async () => {
      const wrapper = await openSettings();

      expect(getTemplates).toHaveBeenCalled();
      const options = form(wrapper).get('#new-workspace-template').findAll('option');
      expect(options.map((o) => o.text())).toEqual([
        'Worldbuilding', 'Software Architecture', 'Empty — nothing to start from',
      ]);
      // A template is the default, as it is at signup; Empty is a choice, not what you get
      // by not choosing.
      expect(form(wrapper).get('#new-workspace-template').element.value).toBe('worldbuilding');
    });

    it('sends the trimmed name and the chosen template, then selects what it created', async () => {
      const wrapper = await openSettings();

      await fillAndSubmit(wrapper, '  A Second Bible  ', 'software-architecture');

      expect(createWorkspace).toHaveBeenCalledTimes(1);
      expect(createWorkspace.mock.calls[0][0]).toBe('A Second Bible');
      expect(createWorkspace.mock.calls[0][1]).toMatchObject({
        template: 'software-architecture',
        // Every light-tier line names what asked for the change, not just the new value.
        source: expect.stringContaining('Settings'),
      });
      // The switcher's list is refreshed, so the new workspace is in it either way.
      expect(listWorkspaces).toHaveBeenCalledTimes(2);
      // And the session moves through the one route that writes it.
      expect(selectWorkspace).toHaveBeenCalledTimes(1);
      expect(selectWorkspace.mock.calls[0][0]).toBe(CREATED._id);
      expect(group(wrapper).find('.settings-error').exists()).toBe(false);
      // The typed name is cleared, so a second create does not repeat the first by accident.
      expect(form(wrapper).get('#new-workspace-name').element.value).toBe('');
    });

    it('sends template: null for Empty — the only workspace an import can land in', async () => {
      const wrapper = await openSettings();

      await fillAndSubmit(wrapper, 'Somewhere To Land', '');

      expect(createWorkspace.mock.calls[0][0]).toBe('Somewhere To Land');
      expect(createWorkspace.mock.calls[0][1].template).toBe(null);
    });

    it('sends nothing without a name, and nothing twice', async () => {
      const wrapper = await openSettings();

      await fillAndSubmit(wrapper, '   ');
      expect(createWorkspace).not.toHaveBeenCalled();
      // The button says so too, rather than only the handler refusing on submit.
      expect(form(wrapper).get('button[type="submit"]').attributes('disabled')).toBeDefined();
    });

    it('says what the cap is when the server refuses one, and selects nothing', async () => {
      createWorkspace.mockRejectedValue(
        Object.assign(new Error('WORKSPACE_LIMIT_REACHED'), { status: 409, limit: 10 }),
      );
      const wrapper = await openSettings();

      await fillAndSubmit(wrapper, 'One Too Many');

      expect(group(wrapper).get('.settings-error').text()).toContain('up to 10 workspaces');
      expect(selectWorkspace).not.toHaveBeenCalled();
      // Still where the session was: a refused create changes nothing on screen.
      expect(group(wrapper).get('.workspace-name').text()).toBe(OWNED.name);
    });

    it('says a refused name is a refused name', async () => {
      createWorkspace.mockRejectedValue(
        Object.assign(new Error('INVALID_WORKSPACE_NAME'), { status: 400 }),
      );
      const wrapper = await openSettings();

      await fillAndSubmit(wrapper, 'Whatever The Server Hates');

      expect(group(wrapper).get('.settings-error').text()).toContain('1–80 characters');
      expect(selectWorkspace).not.toHaveBeenCalled();
    });
  });

  it('a refused rename says so in Settings', async () => {
    renameWorkspace.mockRejectedValue(Object.assign(new Error('NOT_WORKSPACE_OWNER'), { status: 403 }));
    const wrapper = await openSettings();

    await group(wrapper).get('.workspace-input').setValue('Editor Was Here');
    await group(wrapper).get('form.workspace-rename').trigger('submit');
    await flushPromises();

    expect(group(wrapper).get('.settings-error').text()).toBe('Only an owner can rename this workspace.');
    // The name on screen is still the stored one, not the refused edit.
    expect(group(wrapper).get('.workspace-name').text()).toBe(OWNED.name);
  });
});

/**
 * Collaborators (KOL-124): the first thing in the product that can produce a member who is not
 * the owner, and the one place an invitation is ever seen — nothing is delivered, so an invite
 * that the UI did not show would be an invite nobody could accept.
 *
 * What these pin: the member list and both invite lists are read when Settings opens; the owner's
 * controls are rendered for an owner and absent for anyone else (the server refuses them either
 * way, so this is about not offering what will be refused); the form's address and role reach the
 * API; a refusal is said in words next to the control that caused it, with the list re-read so the
 * screen shows the server's state and not the click; and Accept/Decline reach the API and refresh
 * the switcher's list, because a joined workspace belongs in it.
 *
 * Goes red if the group stops reading any of the three lists, if an owner-only control is rendered
 * for an editor, if the "no email is sent" note is dropped, or if a refusal is swallowed.
 */
describe('WikiLayout collaborators', () => {
  const OWNED = { _id: 'w1', name: 'Alice’s Bible', role: 'owner', createdAt: '2026-10-10T00:00:00.000Z' };
  const MEMBERS = [
    { userId: 'u1', email: 'alice@example.test', role: 'owner', isOwner: true },
    { userId: 'u2', email: 'bob@example.test', role: 'editor', isOwner: false },
  ];
  const INVITATION = {
    _id: 'i1',
    workspaceId: 'w2',
    workspaceName: 'The Shared Compendium',
    role: 'editor',
    invitedByEmail: 'carol@example.test',
    createdAt: '2026-10-30T00:00:00.000Z',
  };

  beforeEach(() => {
    for (const mock of [
      getWorkspace, listWorkspaces, listMembers, listWorkspaceInvites, listMyInvites,
      inviteCollaborator, withdrawInvite, setMemberRole, removeMember, acceptInvite, declineInvite,
    ]) mock.mockReset();
    getWorkspace.mockResolvedValue({ ...OWNED });
    listWorkspaces.mockResolvedValue([{ ...OWNED }]);
    listMembers.mockResolvedValue(MEMBERS.map((m) => ({ ...m })));
    listWorkspaceInvites.mockResolvedValue([]);
    listMyInvites.mockResolvedValue([]);
    inviteCollaborator.mockImplementation(async (email, { role } = {}) => ({ _id: 'i9', email, role: role ?? 'editor' }));
    setMemberRole.mockImplementation(async (userId, role) => ({ userId, role }));
    acceptInvite.mockResolvedValue({ _id: 'w2', name: INVITATION.workspaceName, role: 'editor', createdAt: INVITATION.createdAt });
  });

  const groupNamed = (wrapper, title) =>
    wrapper.findAll('.mobile-settings-panel .settings-group')
      .find((g) => g.get('.settings-group-title').text() === title);

  async function openSettings() {
    const wrapper = shallowMount(WikiLayout);
    expect(listMembers).not.toHaveBeenCalled();   // nothing is fetched on page load
    await settingsTab(wrapper).trigger('click');
    await flushPromises();
    return wrapper;
  }

  it('reads the members and both invite lists when Settings opens, and names what asked', async () => {
    const wrapper = await openSettings();

    for (const mock of [listMembers, listWorkspaceInvites, listMyInvites]) {
      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock.mock.calls[0][0]).toMatchObject({ source: expect.stringContaining('Settings') });
    }
    const rows = groupNamed(wrapper, 'Collaborators').findAll('.member-row');
    expect(rows.map((r) => r.get('.member-email').text())).toEqual(['alice@example.test', 'bob@example.test']);
  });

  it('an owner gets a role select and a Remove for each member, plus the invite form', async () => {
    const wrapper = await openSettings();
    const group = groupNamed(wrapper, 'Collaborators');

    const roles = group.findAll('.member-row select');
    expect(roles.length).toBe(2);
    expect(roles[1].element.value).toBe('editor');
    expect(group.findAll('.member-row button').map((b) => b.text())).toEqual(['Remove', 'Remove']);
    expect(group.find('form.invite-form').exists()).toBe(true);
    // The honest part: nothing is delivered, so the form has to say so.
    expect(group.get('form.invite-form .settings-note').text()).toContain('No email is sent');
  });

  it('a member who is not the owner reads the list and is offered no control on it', async () => {
    getWorkspace.mockResolvedValue({ ...OWNED, role: 'editor' });
    const wrapper = await openSettings();
    const group = groupNamed(wrapper, 'Collaborators');

    expect(group.findAll('.member-row select').length).toBe(0);
    expect(group.findAll('.member-row button').length).toBe(0);
    expect(group.find('form.invite-form').exists()).toBe(false);
    expect(group.findAll('.member-role-label').map((r) => r.text())).toEqual(['owner', 'editor']);
  });

  it('the invite form sends the typed address and the chosen role, then clears and re-reads', async () => {
    const wrapper = await openSettings();
    const group = groupNamed(wrapper, 'Collaborators');

    await group.get('#invite-email').setValue('  New.Person@Example.test  ');
    await group.get('#invite-role').setValue('viewer');
    await group.get('form.invite-form').trigger('submit');
    await flushPromises();

    expect(inviteCollaborator).toHaveBeenCalledTimes(1);
    expect(inviteCollaborator.mock.calls[0][0]).toBe('New.Person@Example.test');
    expect(inviteCollaborator.mock.calls[0][1]).toMatchObject({ role: 'viewer', source: expect.stringContaining('Settings') });
    expect(group.get('#invite-email').element.value).toBe('');
    expect(listWorkspaceInvites).toHaveBeenCalledTimes(2);   // the pending list, refreshed
    expect(group.find('.settings-error').exists()).toBe(false);
  });

  it('says what a refused invite or role change was refused for, and keeps the server\'s state on screen', async () => {
    inviteCollaborator.mockRejectedValue(Object.assign(new Error('ALREADY_A_MEMBER'), { status: 409 }));
    setMemberRole.mockRejectedValue(Object.assign(new Error('LAST_OWNER'), { status: 409 }));
    const wrapper = await openSettings();
    const group = groupNamed(wrapper, 'Collaborators');

    await group.get('#invite-email').setValue('bob@example.test');
    await group.get('form.invite-form').trigger('submit');
    await flushPromises();
    expect(group.get('.settings-error').text()).toContain('already a member');

    await group.findAll('.member-row select')[0].setValue('editor');
    await flushPromises();
    expect(group.get('.settings-error').text()).toBe('A workspace has to keep at least one owner.');
    // Re-read after the refusal, so the select shows the role the server still holds.
    expect(listMembers).toHaveBeenCalledTimes(2);
    expect(group.findAll('.member-row select')[0].element.value).toBe('owner');
  });

  it('withdraws a pending invite and removes a member through the API', async () => {
    listWorkspaceInvites.mockResolvedValue([{ _id: 'i7', email: 'waiting@example.test', role: 'editor' }]);
    const wrapper = await openSettings();
    const group = groupNamed(wrapper, 'Collaborators');

    expect(group.get('.pending-invites .invite-label').text()).toContain('waiting@example.test');
    await group.get('.pending-invites .invite-row button').trigger('click');
    await flushPromises();
    expect(withdrawInvite).toHaveBeenCalledWith('i7', expect.objectContaining({ email: 'waiting@example.test' }));

    await group.findAll('.member-row button')[1].trigger('click');
    await flushPromises();
    expect(removeMember).toHaveBeenCalledWith('u2', expect.objectContaining({ email: 'bob@example.test', role: 'editor' }));
  });

  describe('invitations for this account', () => {
    beforeEach(() => { listMyInvites.mockResolvedValue([{ ...INVITATION }]); });

    it('names the workspace, the role and who asked', async () => {
      const wrapper = await openSettings();
      const group = groupNamed(wrapper, 'Invitations for you');

      expect(group.get('.invite-label').text()).toContain('The Shared Compendium');
      expect(group.get('.invite-label').text()).toContain('editor');
      expect(group.get('.invite-from').text()).toContain('carol@example.test');
    });

    it('accepting reaches the API and refreshes the switcher, without moving this tab', async () => {
      const wrapper = await openSettings();
      const buttons = groupNamed(wrapper, 'Invitations for you').findAll('button');
      expect(buttons.map((b) => b.text())).toEqual(['Accept', 'Decline']);

      await buttons[0].trigger('click');
      await flushPromises();

      expect(acceptInvite).toHaveBeenCalledWith('i1', expect.objectContaining({ source: expect.stringContaining('Settings') }));
      expect(listWorkspaces).toHaveBeenCalledTimes(2);   // the new membership belongs in the switcher
      expect(selectWorkspace).not.toHaveBeenCalled();    // accepting is not selecting (KOL-090)
      expect(listMyInvites).toHaveBeenCalledTimes(2);
    });

    it('declining reaches the API and the invitation goes', async () => {
      const wrapper = await openSettings();
      await groupNamed(wrapper, 'Invitations for you').findAll('button')[1].trigger('click');
      listMyInvites.mockResolvedValue([]);
      await flushPromises();

      expect(declineInvite).toHaveBeenCalledWith('i1', expect.objectContaining({ workspaceName: 'The Shared Compendium' }));
    });

    it('is absent for an account with none', async () => {
      listMyInvites.mockResolvedValue([]);
      const wrapper = await openSettings();
      expect(groupNamed(wrapper, 'Invitations for you')).toBeUndefined();
    });
  });
});

/**
 * The Password group (KOL-074): the way an account changes its password without being deleted and
 * rebuilt. It sits beside Passkeys because the two are the ways into an account, and it reads
 * nothing when Settings opens — there is no list here to go stale, so unlike Passkeys it is not
 * mounted behind `settingsVisible`.
 *
 * What is pinned here is that the form posts: the typed current and new password reach
 * changePassword(), naming the source (every light-tier log line says what asked for a change,
 * not just that one happened), and the passkey button posts the same new password through the
 * assertion path instead. Plus the two refusals a user can act on — the server's own sentence for
 * a wrong current password, and the minimum held locally so an opaque 400 is not how the rule is
 * discovered. What the API module does with the response is its own concern (api/auth.js), and
 * what the server does with the request is tests/http/password.test.js.
 *
 * Goes red if the group is dropped, if either button stops posting, if the submit stops being held
 * while the new password is too short, or if a 403 stops showing the server's message.
 */
describe('WikiLayout password group', () => {
  beforeEach(() => {
    changePassword.mockReset();
    changePasswordWithPasskey.mockReset();
    changePassword.mockResolvedValue({ ok: true });
    changePasswordWithPasskey.mockResolvedValue({ ok: true });
  });

  const group = (wrapper) =>
    wrapper.findAll('.mobile-settings-panel .settings-group')
      .find((g) => g.get('.settings-group-title').text() === 'Password');

  async function openSettings() {
    const wrapper = shallowMount(WikiLayout);
    await settingsTab(wrapper).trigger('click');
    await flushPromises();
    expect(changePassword).not.toHaveBeenCalled();   // nothing is posted on open
    return wrapper;
  }

  const fill = async (wrapper, { current = 'correct-horse-battery-staple', next = 'a-different-horse-entirely' } = {}) => {
    await group(wrapper).get('input[autocomplete="current-password"]').setValue(current);
    await group(wrapper).get('input[autocomplete="new-password"]').setValue(next);
  };

  const buttons = (wrapper) => group(wrapper).findAll('button');

  it('posts the typed passwords, naming what asked, and says the change landed', async () => {
    const wrapper = await openSettings();
    await fill(wrapper);

    await group(wrapper).get('form.password-change').trigger('submit');
    await flushPromises();

    expect(changePassword).toHaveBeenCalledTimes(1);
    expect(changePassword.mock.calls[0][0]).toEqual({
      currentPassword: 'correct-horse-battery-staple',
      newPassword: 'a-different-horse-entirely',
    });
    // The light tier names the source of a change, not just that one happened.
    expect(changePassword.mock.calls[0][1]).toMatchObject({ source: expect.stringContaining('Settings') });

    expect(group(wrapper).get('.settings-done').text()).toContain('Password changed');
    expect(group(wrapper).find('.settings-error').exists()).toBe(false);
    // Neither password is left in the form afterwards.
    expect(group(wrapper).get('input[autocomplete="current-password"]').element.value).toBe('');
    expect(group(wrapper).get('input[autocomplete="new-password"]').element.value).toBe('');
  });

  it('the passkey button posts the same new password through the assertion path', async () => {
    const wrapper = await openSettings();
    await fill(wrapper, { current: '' });

    await buttons(wrapper).find((b) => b.text().includes('passkey')).trigger('click');
    await flushPromises();

    expect(changePassword).not.toHaveBeenCalled();
    expect(changePasswordWithPasskey).toHaveBeenCalledTimes(1);
    expect(changePasswordWithPasskey.mock.calls[0][0]).toBe('a-different-horse-entirely');
    expect(changePasswordWithPasskey.mock.calls[0][1]).toMatchObject({ source: expect.stringContaining('Settings') });
    expect(group(wrapper).get('.settings-done').exists()).toBe(true);
  });

  it('holds both buttons while the new password is under the minimum, and states it', async () => {
    const wrapper = await openSettings();
    expect(group(wrapper).get('.settings-note').text()).toContain('At least 12 characters');

    await fill(wrapper, { next: 'a'.repeat(11) });
    for (const button of buttons(wrapper)) expect(button.attributes('disabled')).toBeDefined();

    await group(wrapper).get('form.password-change').trigger('submit');
    await flushPromises();
    expect(changePassword).not.toHaveBeenCalled();

    await fill(wrapper, { next: 'a'.repeat(12) });
    for (const button of buttons(wrapper)) expect(button.attributes('disabled')).toBeUndefined();
  });

  it("a refused change shows the server's sentence and keeps the group open", async () => {
    // 403: the re-authentication failed, the session did not (docs/api.md#password).
    changePassword.mockRejectedValue(Object.assign(new Error('Incorrect password'), { status: 403 }));
    const wrapper = await openSettings();
    await fill(wrapper);

    await group(wrapper).get('form.password-change').trigger('submit');
    await flushPromises();

    expect(group(wrapper).get('.settings-error').text()).toBe('Incorrect password');
    expect(group(wrapper).find('.settings-done').exists()).toBe(false);
    // The typed current password stays, so the correction is one field away.
    expect(group(wrapper).get('input[autocomplete="current-password"]').element.value).toBe('correct-horse-battery-staple');
  });

  it('a dismissed passkey prompt is not an error', async () => {
    changePasswordWithPasskey.mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
    const wrapper = await openSettings();
    await fill(wrapper, { current: '' });

    await buttons(wrapper).find((b) => b.text().includes('passkey')).trigger('click');
    await flushPromises();

    expect(group(wrapper).find('.settings-error').exists()).toBe(false);
    expect(group(wrapper).find('.settings-done').exists()).toBe(false);
  });
});

/**
 * Sign out everywhere else (KOL-076): in the Account group beside Log Out, because the two ways out
 * of an account belong together. Two steps on purpose — the row sits under Log Out, and the cost of
 * a mis-tap is every other device having to sign in again — so what is pinned here is that nothing
 * is posted until the form is armed *and* confirmed, that the password typed is what goes out, and
 * that a refusal keeps the server's own sentence. What the route itself does is pinned in
 * server/tests/http/sessionRevocation.test.js.
 */
describe('WikiLayout sign out everywhere', () => {
  beforeEach(() => {
    revokeOtherSessions.mockReset();
    revokeOtherSessionsWithPasskey.mockReset();
    revokeOtherSessions.mockResolvedValue({ ok: true, revokedAt: '2026-10-15T12:00:00.000Z' });
    revokeOtherSessionsWithPasskey.mockResolvedValue({ ok: true, revokedAt: '2026-10-15T12:00:00.000Z' });
  });

  const group = (wrapper) =>
    wrapper.findAll('.mobile-settings-panel .settings-group')
      .find((g) => g.get('.settings-group-title').text() === 'Account');

  const row = (wrapper) =>
    group(wrapper).findAll('button').find((b) => b.text() === 'Sign out everywhere else');

  async function openSettings() {
    const wrapper = shallowMount(WikiLayout);
    await settingsTab(wrapper).trigger('click');
    await flushPromises();
    expect(revokeOtherSessions).not.toHaveBeenCalled();   // nothing is posted on open
    return wrapper;
  }

  /** Arms the confirmation and answers with its password input. */
  async function arm(wrapper) {
    expect(group(wrapper).find('form.revoke-all').exists()).toBe(false);
    await row(wrapper).trigger('click');
    const form = group(wrapper).get('form.revoke-all');
    // Arming alone posts nothing: that is what makes this two steps rather than one.
    expect(revokeOtherSessions).not.toHaveBeenCalled();
    return form;
  }

  it('asks for the password before it posts, then names what asked and says it landed', async () => {
    const wrapper = await openSettings();
    const form = await arm(wrapper);

    const input = form.get('input[autocomplete="current-password"]');
    expect(input.attributes('type')).toBe('password');
    // Held until something is typed: the server refuses an empty one anyway.
    expect(form.get('button[type="submit"]').attributes('disabled')).toBeDefined();

    await input.setValue('correct-horse-battery-staple');
    expect(form.get('button[type="submit"]').attributes('disabled')).toBeUndefined();
    await form.trigger('submit');
    await flushPromises();

    expect(revokeOtherSessions).toHaveBeenCalledTimes(1);
    expect(revokeOtherSessions.mock.calls[0][0]).toEqual({ password: 'correct-horse-battery-staple' });
    // The light tier names the source of a change, not just that one happened.
    expect(revokeOtherSessions.mock.calls[0][1]).toMatchObject({ source: expect.stringContaining('Settings') });

    expect(group(wrapper).get('.settings-done').text()).toContain('still signed in');
    expect(group(wrapper).find('.settings-error').exists()).toBe(false);
    // The form closes and keeps no password: the row is back to one tap from armed.
    expect(group(wrapper).find('form.revoke-all').exists()).toBe(false);
    expect(row(wrapper).exists()).toBe(true);
  });

  it('the passkey button confirms the same revocation without a password', async () => {
    const wrapper = await openSettings();
    const form = await arm(wrapper);

    await form.findAll('button').find((b) => b.text().includes('passkey')).trigger('click');
    await flushPromises();

    expect(revokeOtherSessions).not.toHaveBeenCalled();
    expect(revokeOtherSessionsWithPasskey).toHaveBeenCalledTimes(1);
    expect(revokeOtherSessionsWithPasskey.mock.calls[0][0]).toMatchObject({ source: expect.stringContaining('Settings') });
    expect(group(wrapper).get('.settings-done').exists()).toBe(true);
  });

  it('cancelling the confirmation posts nothing and leaves the row armed again', async () => {
    const wrapper = await openSettings();
    const form = await arm(wrapper);
    await form.get('input[autocomplete="current-password"]').setValue('correct-horse-battery-staple');

    await form.findAll('button').find((b) => b.text() === 'Cancel').trigger('click');

    expect(revokeOtherSessions).not.toHaveBeenCalled();
    expect(group(wrapper).find('form.revoke-all').exists()).toBe(false);
    expect(group(wrapper).find('.settings-done').exists()).toBe(false);

    // And the password typed before cancelling is not still sitting in the re-armed form.
    await row(wrapper).trigger('click');
    expect(group(wrapper).get('form.revoke-all').get('input[autocomplete="current-password"]').element.value).toBe('');
  });

  it("a refused revocation shows the server's sentence and keeps the form open", async () => {
    // 403: the re-authentication failed, the session did not (docs/api.md#sessions).
    revokeOtherSessions.mockRejectedValue(Object.assign(new Error('Incorrect password'), { status: 403 }));
    const wrapper = await openSettings();
    const form = await arm(wrapper);
    await form.get('input[autocomplete="current-password"]').setValue('wrong-horse-battery-staple');

    await form.trigger('submit');
    await flushPromises();

    expect(group(wrapper).get('.settings-error').text()).toBe('Incorrect password');
    expect(group(wrapper).find('.settings-done').exists()).toBe(false);
    // Still armed, with the typed password left in place: the correction is one field away.
    expect(group(wrapper).get('form.revoke-all').get('input[autocomplete="current-password"]').element.value)
      .toBe('wrong-horse-battery-staple');
  });

  it('a dismissed passkey prompt is not an error', async () => {
    revokeOtherSessionsWithPasskey.mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
    const wrapper = await openSettings();
    const form = await arm(wrapper);

    await form.findAll('button').find((b) => b.text().includes('passkey')).trigger('click');
    await flushPromises();

    expect(group(wrapper).find('.settings-error').exists()).toBe(false);
    expect(group(wrapper).find('.settings-done').exists()).toBe(false);
    expect(group(wrapper).find('form.revoke-all').exists()).toBe(true);
  });
});

/**
 * Live sync's other half (KOL-102): the layout's answer to the two frames that stand for a write
 * touching many rows at once — `draft:applied` and `workspace:imported`. Both are a single frame
 * for a whole bulk write, so neither can say which rows moved and both have to refetch; and the
 * server excludes the client that did the write, so a frame arriving here is always someone
 * else's. The handlers are read off the mocked composable rather than delivered over a socket.
 *
 * Falsification: drop either handler from the `useEvents` call in WikiLayout.vue and the matching
 * case fails on the refetch it never asked for.
 */
const sseHandlers = () => {
  expect(useEvents).toHaveBeenCalled();
  return useEvents.mock.calls[useEvents.mock.calls.length - 1][0];
};

describe('WikiLayout live sync', () => {
  beforeEach(() => {
    useEvents.mockClear();
    loadEntities.mockClear();
    selectEntity.mockClear();
    addToast.mockClear();
  });

  it('reloads the sidebar and says who when another client applies a draft', async () => {
    const wrapper = shallowMount(WikiLayout);
    const before = loadEntities.mock.calls.length;

    sseHandlers().onDraftApplied({
      draftId: 'd1', applied: 30, failed: 0, blocked: 0, skipped: 0,
      actor: { label: 'alice@example.test', type: 'generator' },
    });
    await wrapper.vm.$nextTick();

    expect(loadEntities.mock.calls.length).toBe(before + 1);
    // The reason names the source, as every other load here does.
    expect(loadEntities.mock.calls.at(-1)[0]).toMatch(/draft/i);
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0][0]).toMatchObject({ actorLabel: 'alice@example.test' });
    expect(addToast.mock.calls[0][0].message).toContain('30');
  });

  it('reloads the sidebar and says who when another client imports a workspace', async () => {
    const wrapper = shallowMount(WikiLayout);
    const before = loadEntities.mock.calls.length;

    sseHandlers().onWorkspaceImported({
      version: 'kol-emet/workspace-export@1',
      imported: { entities: 18, relationshipGroups: 7, openQuestions: 3 },
      actor: { label: 'alice@example.test', type: 'user' },
    });
    await wrapper.vm.$nextTick();

    expect(loadEntities.mock.calls.length).toBe(before + 1);
    expect(loadEntities.mock.calls.at(-1)[0]).toMatch(/import/i);
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0][0].message).toContain('18 entities');
  });

  /**
   * The open-question frames (KOL-116). The panel renders questions from the populated
   * `entity.open_questions` it was handed, so the layout's answer to a frame is a refetch of the
   * entity on screen — and only when the frame touches it, which is what the payload's `entry_ids`
   * are for. A frame about an entity nobody is looking at has nothing to update: the sidebar shows
   * no questions.
   *
   * Falsification: drop any one `onQuestion*` handler from the `useEvents` call and that case fails
   * on the refetch it never asked for; ignore `entry_ids` and refetch unconditionally and the
   * "another entity" case fails; look only at `entry_ids` and the delete case fails (a question
   * removed from this entity is not in them).
   */
  const onScreen = (entity) => {
    stubbedEntities.last.selectedEntity.value = entity;
  };
  const PANEL = { _id: 'e1', title: 'Boiler Room', open_questions: [{ _id: 'q1', question: 'Who stokes it?', status: 'open' }] };

  it('refetches the open entity and says so when another client adds a question to it', async () => {
    const wrapper = shallowMount(WikiLayout);
    onScreen({ ...PANEL });
    selectEntity.mockClear();

    sseHandlers().onQuestionCreated({
      question: { _id: 'q2', question: 'And how fast?', status: 'open' }, entry_ids: ['e1'],
    });
    await wrapper.vm.$nextTick();

    expect(selectEntity).toHaveBeenCalledWith('e1');
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0][0]).toMatchObject({ entityId: 'e1', entityTitle: 'Boiler Room' });
    expect(addToast.mock.calls[0][0].message).toMatch(/question/i);
  });

  it('refetches when a question is resolved or renamed on the open entity', async () => {
    const wrapper = shallowMount(WikiLayout);
    onScreen({ ...PANEL });
    selectEntity.mockClear();

    sseHandlers().onQuestionUpdated({
      question: { _id: 'q1', question: 'Who stokes it?', status: 'resolved' }, entry_ids: ['e1'],
    });
    await wrapper.vm.$nextTick();

    expect(selectEntity).toHaveBeenCalledWith('e1');
    expect(addToast).toHaveBeenCalledTimes(1);
  });

  it('refetches when a question the open entity is showing is deleted, though it names no entity', async () => {
    // A delete's `entry_ids` are the links that existed; a question moved *off* this entity names
    // somewhere else entirely. Either way the panel is holding a row the server no longer has.
    const wrapper = shallowMount(WikiLayout);
    onScreen({ ...PANEL });
    selectEntity.mockClear();

    sseHandlers().onQuestionDeleted({
      questionId: 'q1', question: { _id: 'q1', question: 'Who stokes it?', status: 'open' }, entry_ids: [],
    });
    await wrapper.vm.$nextTick();

    expect(selectEntity).toHaveBeenCalledWith('e1');
  });

  it('ignores a question frame for another entity, and one with no panel open', async () => {
    const wrapper = shallowMount(WikiLayout);
    onScreen({ ...PANEL });
    selectEntity.mockClear();

    sseHandlers().onQuestionCreated({
      question: { _id: 'q9', question: 'Whose shed?', status: 'open' }, entry_ids: ['e2'],
    });
    await wrapper.vm.$nextTick();

    expect(selectEntity).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();

    // And with nothing on screen there is nothing to refetch either.
    onScreen(null);
    sseHandlers().onQuestionCreated({
      question: { _id: 'q9', question: 'Whose shed?', status: 'open' }, entry_ids: ['e1'],
    });
    await wrapper.vm.$nextTick();

    expect(selectEntity).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });

  it('says so when the server ends the stream for good', () => {
    // Nothing will reconnect, so the sidebar is a snapshot from here on and the
    // only thing left to do is tell the user.
    shallowMount(WikiLayout);
    const before = loadEntities.mock.calls.length;

    sseHandlers().onStreamEnded({
      reason: 'session-ended',
      message: 'Live updates stopped: you were signed out in another window.',
      limit: null,
    });

    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0][0].message).toMatch(/signed out in another window/);
    // And it does not refetch: a stream that ended because the session did would
    // answer that request with a 401.
    expect(loadEntities.mock.calls.length).toBe(before);
  });
});

/**
 * The list over the shape `GET /entities` sends: no `blocks` key at all (KOL-061). Everything but
 * the list is stubbed, so what mounts for real is the sidebar, its cards and the real useFilters —
 * the three places that read a listed entity. VirtualList is stubbed to render every item, as in
 * EntitySidebar.test.js: jsdom has no layout, so the real one would window the list to nothing.
 */
const BLOCKLESS = [
  {
    _id: 'e1', title: 'Boiler Room', category: 'Worlds', summary: 'Where the pressure comes from.',
    tags: ['engine'], open_questions: [], relationships: [],
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
  },
  {
    _id: 'e2', title: 'Alder Street', category: 'Worlds', summary: 'A stop on the northern line.',
    tags: ['stations'], open_questions: [], relationships: [],
    createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z',
  },
];

/**
 * What `GET /entities?q=toolchain&limit=200` answers (KOL-068, capped by KOL-082): the envelope
 * `?limit=` opts into, around the same projected shape, and a row the loaded list above does not
 * contain. Neither row holds the term in its title or summary — that is what "matched in text"
 * means — so the server matched both inside a block. `nextAfter: null` is the server saying these
 * two were every match; `SERVER_ANSWER_CAPPED` below is the other case.
 */
const SERVER_ROWS = [
  {
    _id: 'e1', title: 'Boiler Room', category: 'Worlds', summary: 'Where the pressure comes from.',
    tags: ['engine'], open_questions: [], relationships: [],
  },
  {
    _id: 'e3', title: 'Coupling Rod', category: 'Worlds', summary: 'Holds the wheels in step.',
    tags: [], open_questions: [], relationships: [],
  },
];

const SERVER_ANSWER = { items: SERVER_ROWS, nextAfter: null, total: SERVER_ROWS.length };

/** The same two rows as the first page of a term that matched 1,284 entities. */
const SERVER_ANSWER_CAPPED = {
  items: SERVER_ROWS,
  nextAfter: { title: 'Coupling Rod', _id: 'e3' },
  total: 1284,
};

const VirtualListStub = {
  props: ['items'],
  template: '<div><div v-for="(item, index) in items" :key="index"><slot :item="item" :index="index" /></div></div>',
};

// Everything but the sidebar and its list. The keyboard group below mounts the
// same shell, for the same reason: the search input has to be the real one.
const SHELL_STUBS = {
  VirtualList: VirtualListStub,
  EntityDetail: true, EntityEditor: true, ChatPanel: true, GraphView: true,
  GeneratorOverlay: true, ToastNotification: true, AccountDeletion: true,
  PasskeySettings: true, RecentlyDeleted: true, TagSettings: true,
};

const mountList = () => mount(WikiLayout, { global: { stubs: SHELL_STUBS } });

const cards = (wrapper) => wrapper.findAll('.sidebar-card').map((c) => c.get('.card-title').text());

describe('WikiLayout list over entities that carry no blocks', () => {
  beforeEach(() => {
    entities.length = 0;
    entities.push(...BLOCKLESS.map((e) => ({ ...e })));
    selectEntity.mockClear();
    searchEntities.mockReset();
  });

  // The two search cases below run the debounce on fake timers; the rest of the
  // file does not, so they are handed back here rather than per case.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a card per entity, title, category and summary and all', () => {
    // Premise: the fixtures are the projected shape, not full documents.
    expect(BLOCKLESS.some((e) => 'blocks' in e)).toBe(false);

    const wrapper = mountList();

    expect(cards(wrapper)).toEqual(['Boiler Room', 'Alder Street']);
    const first = wrapper.findAll('.sidebar-card')[0];
    expect(first.get('.card-summary').text()).toBe('Where the pressure comes from.');
    expect(first.get('.entity-cat').text()).toBe('Worlds');
  });

  it('sends a typed term to the server rather than filtering the loaded list', async () => {
    vi.useFakeTimers();
    searchEntities.mockResolvedValue(SERVER_ANSWER);
    const wrapper = mountList();

    await wrapper.get('.search-input').setValue('toolchain');
    // Inside the debounce: no request yet, and nothing filtered out in the
    // meantime either — the box is not a local filter any more.
    expect(searchEntities).not.toHaveBeenCalled();
    expect(cards(wrapper)).toEqual(['Boiler Room', 'Alder Street']);

    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await flushPromises();

    expect(searchEntities).toHaveBeenCalledTimes(1);
    expect(searchEntities).toHaveBeenCalledWith('toolchain');
    // `Coupling Rod` is in no page the loaded list holds: this is the server's
    // answer on screen, which is the whole point — "toolchain" lives inside a
    // block, and the browser never had that text to search.
    expect(cards(wrapper)).toEqual(['Boiler Room', 'Coupling Rod']);
    // Neither row shows the term, so both carry the reason they are listed.
    expect(wrapper.findAll('.matched-in-text')).toHaveLength(2);
  });

  it('tells the reader when the server capped the result set', async () => {
    vi.useFakeTimers();
    searchEntities.mockResolvedValue(SERVER_ANSWER_CAPPED);
    const wrapper = mountList();

    await wrapper.get('.search-input').setValue('a');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await flushPromises();

    // The rows are the server's; the line is what stops them reading as all of them.
    expect(cards(wrapper)).toEqual(['Boiler Room', 'Coupling Rod']);
    expect(wrapper.get('.search-capped').text()).toContain('First 2 of 1284 matches');
  });

  it('puts the loaded list back when the box is cleared, without another request', async () => {
    vi.useFakeTimers();
    searchEntities.mockResolvedValue(SERVER_ANSWER);
    const wrapper = mountList();

    await wrapper.get('.search-input').setValue('toolchain');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await flushPromises();
    expect(cards(wrapper)).toEqual(['Boiler Room', 'Coupling Rod']);

    await wrapper.get('.search-input').setValue('');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await flushPromises();

    expect(cards(wrapper)).toEqual(['Boiler Room', 'Alder Street']);
    expect(searchEntities).toHaveBeenCalledTimes(1);
  });

  it('filters the list by tag', async () => {
    const wrapper = mountList();

    wrapper.findComponent(EntitySidebar).vm.$emit('set-tag', 'engine');
    await wrapper.vm.$nextTick();

    expect(cards(wrapper)).toEqual(['Boiler Room']);
  });

  it('opening a card asks for the entity by id rather than reading the list row', async () => {
    // Which is why the list needs no blocks: the detail panel re-reads through GET /entities/:id.
    const wrapper = mountList();

    await wrapper.findAll('.sidebar-card')[0].trigger('click');

    expect(selectEntity).toHaveBeenCalledWith('e1');
  });
});

/**
 * The global shortcuts (KOL-063). Mounted for real down to the search input, because what `/` has
 * to do is move focus into *that* element; the layers it closes are stubs, since what is pinned
 * here is which one a press closes, not what any of them renders.
 *
 * `attachTo` matters: jsdom only moves focus to an element that is in the document.
 *
 * The listener is on `window`, so every press below is dispatched from the element that would
 * really have focus — bubbling is how it gets there, and the element it came from is half of the
 * rule about whose key it is.
 */
const mountShell = () => mount(WikiLayout, { attachTo: document.body, global: { stubs: SHELL_STUBS } });

const press = (key, { from = document.body, ...modifiers } = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers });
  from.dispatchEvent(event);
  return event;
};

describe('WikiLayout keyboard shortcuts', () => {
  beforeEach(() => {
    entities.length = 0;
    entities.push(...BLOCKLESS.map((e) => ({ ...e })));
  });

  it('focuses the search input on `/`, and does not type the `/` into it', async () => {
    const wrapper = mountShell();
    const input = wrapper.get('.search-input').element;
    expect(document.activeElement).not.toBe(input);

    const event = press('/');
    await wrapper.vm.$nextTick();

    expect(document.activeElement).toBe(input);
    // The press is ours, so the character it would have typed is swallowed.
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves `/` alone once the search input has focus — it is a character there', async () => {
    const wrapper = mountShell();
    const input = wrapper.get('.search-input').element;
    input.focus();

    const event = press('/', { from: input });
    await wrapper.vm.$nextTick();

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('closes one layer per Escape, topmost first: graph, then chat, then the panel', async () => {
    const wrapper = mountShell();
    const sidebar = wrapper.findComponent(EntitySidebar);
    sidebar.vm.$emit('select', 'e1', 'Boiler Room');
    sidebar.vm.$emit('chat');
    sidebar.vm.$emit('graph');
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(GraphView).exists()).toBe(true);
    expect(wrapper.findComponent(ChatPanel).props('open')).toBe(true);
    expect(wrapper.find('.detail-panel').exists()).toBe(true);

    press('Escape');
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(GraphView).exists()).toBe(false);
    expect(wrapper.findComponent(ChatPanel).props('open')).toBe(true);
    expect(wrapper.find('.detail-panel').exists()).toBe(true);

    press('Escape');
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(ChatPanel).props('open')).toBe(false);
    expect(wrapper.find('.detail-panel').exists()).toBe(true);

    press('Escape');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.detail-panel').exists()).toBe(false);
  });

  it('reaches the Escape handler from inside a textarea — that is the way out of one', async () => {
    const wrapper = mountShell();
    wrapper.findComponent(EntitySidebar).vm.$emit('select', 'e1', 'Boiler Room');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.detail-panel').exists()).toBe(true);

    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    composer.focus();
    press('Escape', { from: composer });
    await wrapper.vm.$nextTick();
    composer.remove();

    expect(wrapper.find('.detail-panel').exists()).toBe(false);
  });

  // KOL-084. The overlay is mounted for real here — `GeneratorOverlay: false` — because what went
  // wrong was in its own template, and a stub of it cannot reproduce that: it bound
  // `@keydown.esc` on its root, so one press closed the overlay and then bubbled on to the
  // layout's listener, which found the generator already shut and closed the chat underneath it.
  it('closes only the generator on Escape from inside it — the chat and the panel stay open', async () => {
    const wrapper = mount(WikiLayout, {
      attachTo: document.body,
      global: { stubs: { ...SHELL_STUBS, GeneratorOverlay: false } },
    });
    const sidebar = wrapper.findComponent(EntitySidebar);
    sidebar.vm.$emit('select', 'e1', 'Boiler Room');
    sidebar.vm.$emit('chat');
    sidebar.vm.$emit('generate');
    await flushPromises();
    expect(wrapper.findComponent(ChatPanel).props('open')).toBe(true);
    expect(wrapper.find('.detail-panel').exists()).toBe(true);

    // The braindump textarea takes focus as the overlay opens, so that is where the press really
    // comes from — a text field, which keeps every key but this one.
    const composer = wrapper.get('.gen-overlay textarea').element;
    expect(document.activeElement).toBe(composer);

    press('Escape', { from: composer });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.gen-overlay').exists()).toBe(false);
    // One press, one layer: everything that was under the overlay is still open.
    expect(wrapper.findComponent(ChatPanel).props('open')).toBe(true);
    expect(wrapper.find('.detail-panel').exists()).toBe(true);
  });

  // KOL-085. The chat panel is mounted for real here — `ChatPanel: false` — because what went
  // wrong was in its own template, and a stub of it cannot reproduce that: the conversation-rename
  // input bound `@keydown.escape.prevent` without stopping the event, so one press cancelled the
  // rename and then bubbled on to the layout's listener, which found no rename in progress and
  // closed the whole panel the field was in.
  it('cancels only the conversation rename on Escape — the chat panel stays open', async () => {
    renameConversation.mockClear();
    const wrapper = mount(WikiLayout, {
      attachTo: document.body,
      global: { stubs: { ...SHELL_STUBS, ChatPanel: false } },
    });
    const sidebar = wrapper.findComponent(EntitySidebar);
    sidebar.vm.$emit('select', 'e1', 'Boiler Room');
    sidebar.vm.$emit('chat');
    await flushPromises();

    const panel = wrapper.findComponent(ChatPanel);
    expect(panel.props('open')).toBe(true);

    // A double-click on the title is how a rename starts; the field opens with the title in it.
    await panel.get('.convo-title').trigger('dblclick');
    await flushPromises();
    const input = panel.get('.convo-rename-input');
    expect(input.element.value).toBe('Boiler notes');

    // The field takes focus as it opens, so that is where the press really comes from — a text
    // field, which keeps every key but this one.
    expect(document.activeElement).toBe(input.element);
    press('Escape', { from: input.element });
    await flushPromises();

    // The rename is off, and nothing was saved.
    expect(panel.find('.convo-rename-input').exists()).toBe(false);
    expect(panel.get('.convo-title').text()).toBe('Boiler notes');
    expect(renameConversation).not.toHaveBeenCalled();
    // One press, one thing: the panel the field was in is still open, and so is the panel under it.
    expect(panel.props('open')).toBe(true);
    expect(wrapper.find('.detail-panel').exists()).toBe(true);
  });

  it('opens the new-entity editor on `n`', async () => {
    const wrapper = mountShell();
    expect(wrapper.findComponent(EntityEditor).exists()).toBe(false);

    press('n');
    await wrapper.vm.$nextTick();

    expect(wrapper.get('.panel-title').text()).toBe('New Entity');
    expect(wrapper.findComponent(EntityEditor).exists()).toBe(true);
  });

  it('declines a shortcut held with a modifier — those belong to the browser', async () => {
    const wrapper = mountShell();
    const input = wrapper.get('.search-input').element;

    const slash = press('/', { ctrlKey: true });
    press('n', { ctrlKey: true });
    await wrapper.vm.$nextTick();

    expect(slash.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(input);
    expect(wrapper.findComponent(EntityEditor).exists()).toBe(false);
  });

  it('stops answering keys once the layout unmounts', async () => {
    const wrapper = mountShell();
    const input = wrapper.get('.search-input').element;
    wrapper.unmount();

    // `focusSearch` swallows the character before it goes looking for the input, so a `/` that
    // comes back un-prevented is a `/` no handler saw.
    const event = press('/');

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(input);
  });
});

/**
 * The `?` cheatsheet (KOL-072). What is pinned here is that the sheet *is* the binding map: the
 * rows are asserted against the list the composable derived from it, not against a list written
 * out in this file — a binding added to the layout appears here with it, and one added without a
 * label never reaches this group at all, because registration throws (last case below). So the
 * sheet cannot drift out of date with the keys that actually work.
 *
 * `?` is also the one shortcut whose press arrives with a modifier flag set — it is shift and
 * another key on most layouts — which is the one case the "ctrl/meta/alt is never ours" rule must
 * not catch.
 */
const sheet = (wrapper) => wrapper.findComponent(ShortcutCheatsheet);

describe('WikiLayout shortcut cheatsheet', () => {
  beforeEach(() => {
    entities.length = 0;
    entities.push(...BLOCKLESS.map((e) => ({ ...e })));
  });

  it('opens on `?` and lists every registered binding, key and sentence', async () => {
    const wrapper = mountShell();
    expect(sheet(wrapper).exists()).toBe(false);

    press('?');
    await wrapper.vm.$nextTick();

    // The map, as the composable derived it — the sheet's only source of rows.
    const registered = sheet(wrapper).props('shortcuts');
    expect(registered.length).toBeGreaterThan(0);

    const rows = wrapper.findAll('.sheet-row').map((row) => ({
      key: row.get('.sheet-key').text(),
      label: row.get('.sheet-label').text(),
    }));
    expect(rows).toEqual(registered.map(({ key, label }) => ({ key, label })));
    // Every one of them says something; an empty sentence is a row nobody can read.
    expect(rows.every((r) => r.label.trim().length > 0)).toBe(true);
    // And the keys that work today are all on it.
    expect(rows.map((r) => r.key)).toEqual(expect.arrayContaining(['/', 'Escape', 'n', '?']));
  });

  it('treats `?` as its own key, not a modifier press, when it arrives with shift held', async () => {
    // On most layouts `?` *is* shift and another key, so the press really does carry shiftKey.
    const wrapper = mountShell();

    press('?', { shiftKey: true });
    await wrapper.vm.$nextTick();

    expect(sheet(wrapper).exists()).toBe(true);
  });

  it('closes on Escape before any other layer — the panel underneath stays open', async () => {
    const wrapper = mountShell();
    wrapper.findComponent(EntitySidebar).vm.$emit('select', 'e1', 'Boiler Room');
    press('?');
    await wrapper.vm.$nextTick();
    expect(sheet(wrapper).exists()).toBe(true);
    expect(wrapper.find('.detail-panel').exists()).toBe(true);

    press('Escape');
    await wrapper.vm.$nextTick();

    expect(sheet(wrapper).exists()).toBe(false);
    // One press, one layer: the detail panel is still where it was.
    expect(wrapper.find('.detail-panel').exists()).toBe(true);
  });

  it('closes on a click outside it, and not on a click within it', async () => {
    const wrapper = mountShell();
    press('?');
    await wrapper.vm.$nextTick();

    await sheet(wrapper).get('.sheet').trigger('click');
    expect(sheet(wrapper).exists()).toBe(true);

    await sheet(wrapper).get('.sheet-backdrop').trigger('click');
    expect(sheet(wrapper).exists()).toBe(false);
  });

  it('types a `?` into the search box instead of opening, once the box has focus', async () => {
    const wrapper = mountShell();
    const input = wrapper.get('.search-input').element;
    input.focus();

    const event = press('?', { from: input, shiftKey: true });
    await wrapper.vm.$nextTick();

    expect(event.defaultPrevented).toBe(false);
    expect(sheet(wrapper).exists()).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('opens from the sidebar hint button, for anyone who would not guess the key', async () => {
    const wrapper = mountShell();
    expect(sheet(wrapper).exists()).toBe(false);

    await wrapper.get('.shortcut-hint').trigger('click');

    expect(sheet(wrapper).exists()).toBe(true);
  });

  it('refuses a binding with no label — that is what keeps the sheet complete', () => {
    // The guarantee behind the first case: there is no way to register a key that the sheet
    // would not list, so this fails at startup rather than shipping an undiscoverable shortcut.
    expect(() => useKeyboardShortcuts({ z: { handler: function zap() {} } })).toThrow(/label/);
    expect(() => useKeyboardShortcuts({ z: { handler: function zap() {}, label: '  ' } })).toThrow(/label/);
    expect(() => useKeyboardShortcuts({ z: { label: 'Zap something' } })).toThrow(/handler/);
  });
});

/**
 * The paged load (KOL-067). `GET /entities` used to answer with every row in the workspace in one
 * response; `loadEntities` now walks pages and appends, so the list a person ends up looking at is
 * assembled from several requests rather than handed over whole. Two things can break in a way no
 * server test can see, and both are asserted here over the real composable and the real sidebar:
 *
 *   The pages have to *add up*. A list built by concatenation can drop a page or paint only the
 *   first one, and the symptom is an entity that is simply not in the sidebar.
 *
 *   The first page has to paint before the rest arrive — that is the reason for paging at all. So
 *   page 2 is left pending while the cards from page 1 are asserted: a load that waits for the
 *   whole workspace before clearing `sidebarLoading` shows "Loading…" at that moment instead.
 *
 *   A page that fails has to be visible as a failure (KOL-083). Mid-walk there is no spinner left
 *   to miss and the count line counts what arrived, so a workspace truncated by a 500 looks exactly
 *   like a whole one. The last case walks that end to end over the real composable and the real
 *   sidebar: the rows that arrived stay, the notice says how many of how many they are, and the
 *   retry it offers finishes the walk.
 *
 * Falsification: assign only the last page in `loadEntities` and the first assertion fails; clear
 * `sidebarLoading` after the loop instead of after the first page and the mid-load one does; throw
 * out of the walk instead of recording the failure and the last one gets no notice (and an
 * unhandled rejection).
 */
const PAGE_1 = [
  { _id: 'p1', title: 'Aqueduct', category: 'Worlds', summary: 'Water over the gorge.', tags: [], open_questions: [], relationships: [] },
  { _id: 'p2', title: 'Brakeman', category: 'Characters', summary: 'Rides the last car.', tags: [], open_questions: [], relationships: [] },
];
const PAGE_2 = [
  { _id: 'p3', title: 'Coupling', category: 'Lore & Mechanics', summary: 'What holds the train together.', tags: [], open_questions: [], relationships: [] },
];

describe('WikiLayout paged entity load', () => {
  beforeEach(() => {
    realEntities.value = true;
    getEntityPage.mockReset();
  });

  afterEach(() => {
    realEntities.value = false;
  });

  it('ends a two-page load with every entity listed, once each', async () => {
    getEntityPage
      .mockResolvedValueOnce({ items: PAGE_1, nextAfter: { title: 'Brakeman', _id: 'p2' }, total: 3 })
      .mockResolvedValueOnce({ items: PAGE_2, nextAfter: null, total: 3 });

    const wrapper = mountList();
    await flushPromises();

    expect(cards(wrapper)).toEqual(['Aqueduct', 'Brakeman', 'Coupling']);
    expect(getEntityPage).toHaveBeenCalledTimes(2);
    // The second request is the first page's cursor, sent back as it was handed over.
    expect(getEntityPage.mock.calls[0][0]).toEqual({ limit: 200, after: null });
    expect(getEntityPage.mock.calls[1][0]).toEqual({ limit: 200, after: { title: 'Brakeman', _id: 'p2' } });
  });

  it('paints the first page while the rest of the workspace is still arriving', async () => {
    let releasePage2;
    getEntityPage
      .mockResolvedValueOnce({ items: PAGE_1, nextAfter: { title: 'Brakeman', _id: 'p2' }, total: 3 })
      .mockReturnValueOnce(new Promise((resolve) => { releasePage2 = resolve; }));

    const wrapper = mountList();
    await flushPromises();

    // Page 2 has not resolved, so this is the sidebar mid-load: cards, not "Loading…".
    expect(cards(wrapper)).toEqual(['Aqueduct', 'Brakeman']);
    expect(wrapper.find('.list-empty').exists()).toBe(false);

    releasePage2({ items: PAGE_2, nextAfter: null, total: 3 });
    await flushPromises();

    expect(cards(wrapper)).toEqual(['Aqueduct', 'Brakeman', 'Coupling']);
  });

  it('shows a workspace truncated by a failed page as truncated, and the retry finishes it', async () => {
    getEntityPage
      .mockResolvedValueOnce({ items: PAGE_1, nextAfter: { title: 'Brakeman', _id: 'p2' }, total: 3 })
      .mockRejectedValueOnce(Object.assign(new Error('500 Internal Server Error'), { status: 500 }));

    const wrapper = mountList();
    await flushPromises();

    // The two rows that arrived are still listed — and are now labelled as two of three.
    expect(cards(wrapper)).toEqual(['Aqueduct', 'Brakeman']);
    const notice = wrapper.get('.load-failed').text();
    expect(notice).toContain('could not be loaded');
    expect(notice).toContain('Showing 2 of 3 entities');

    getEntityPage
      .mockResolvedValueOnce({ items: PAGE_1, nextAfter: { title: 'Brakeman', _id: 'p2' }, total: 3 })
      .mockResolvedValueOnce({ items: PAGE_2, nextAfter: null, total: 3 });

    await wrapper.get('.load-failed button').trigger('click');
    await flushPromises();

    expect(cards(wrapper)).toEqual(['Aqueduct', 'Brakeman', 'Coupling']);
    expect(wrapper.find('.load-failed').exists()).toBe(false);
  });
});
