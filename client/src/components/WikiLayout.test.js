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

const { entities, loadEntities, selectEntity, realEntities } = vi.hoisted(() => ({
  entities: [], loadEntities: vi.fn(), selectEntity: vi.fn(),
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
    useEntities: () => (realEntities.value ? actual.useEntities() : {
      entities: ref(entities), selectedEntity: ref(null), sidebarLoading: ref(false), detailLoading: ref(false),
      loadError: ref(null),
      loadEntities, selectEntity, addEntity: vi.fn(), editEntity: vi.fn(), removeEntity: vi.fn(),
    }),
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
const { downloadWorkspaceExport } = vi.hoisted(() => ({ downloadWorkspaceExport: vi.fn() }));
vi.mock('../api/export.js', () => ({
  downloadWorkspaceExport,
  default: downloadWorkspaceExport,
  filenameFromDisposition: vi.fn(),
  FALLBACK_FILENAME: 'workspace-export.json',
}));
// The Password group posts through these (KOL-074); nothing in a test should fetch, and nothing
// should prompt an authenticator. The two policy exports are the real thing rather than stubs —
// the rule is not network, and a stub returning undefined would let the form send a password the
// server would refuse. What api/auth.js itself does with a response is its own concern.
const { changePassword, changePasswordWithPasskey } = vi.hoisted(() => ({
  changePassword: vi.fn(async () => ({ ok: true })),
  changePasswordWithPasskey: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../api/auth.js', () => ({
  changePassword, changePasswordWithPasskey,
  PASSWORD_MIN_LENGTH: 12,
  passwordTooShort: (value) => [...(value ?? '')].length < 12,
  login: vi.fn(), register: vi.fn(), logout: vi.fn(), getSession: vi.fn(), getTemplates: vi.fn(),
  registerPasskey: vi.fn(), loginWithPasskey: vi.fn(), passkeysSupported: () => false,
  deleteAccount: vi.fn(), deleteAccountWithPasskey: vi.fn(),
  listPasskeys: vi.fn(async () => ({ passkeys: [], hasPassword: true, userHandle: null, rpId: 'localhost' })),
  removePasskey: vi.fn(),
}));
// The Workspace group reads GET /workspace on each Settings open and PATCHes a rename;
// nothing in a test should fetch. What the module itself does is its own concern
// (api/workspace.js).
const { getWorkspace, renameWorkspace } = vi.hoisted(() => ({
  getWorkspace: vi.fn(async () => ({ _id: 'w1', name: 'Alice’s Bible', role: 'owner', createdAt: '2026-10-10T00:00:00.000Z' })),
  renameWorkspace: vi.fn(async (name) => ({ _id: 'w1', name, role: 'owner', createdAt: '2026-10-10T00:00:00.000Z' })),
}));
vi.mock('../api/workspace.js', () => ({
  getWorkspace, renameWorkspace, WORKSPACE_NAME_MAX: 80, default: getWorkspace,
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
vi.mock('../composables/useEvents.js', () => ({ useEvents: vi.fn() }));
vi.mock('../composables/useToasts.js', () => ({ useToasts: () => ({ addToast: vi.fn() }) }));
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
  it('opens with Workspace, then Account, then Password beside Passkeys, and Delete account last', () => {
    const wrapper = shallowMount(WikiLayout);

    const titles = wrapper.findAll('.mobile-settings-panel .settings-group-title').map((t) => t.text());
    expect(titles).toEqual([
      'Workspace', 'Account', 'Password', 'Passkeys', 'Recently deleted', 'Export workspace', 'Tags',
      'Delete account',
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

  beforeEach(() => {
    getWorkspace.mockReset();
    renameWorkspace.mockReset();
    getWorkspace.mockResolvedValue({ ...OWNED });
    renameWorkspace.mockImplementation(async (name) => ({ ...OWNED, name }));
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
