/**
 * Where the Passkeys, Recently deleted and Tags groups sit: in Settings, between Account and Delete
 * account, and mounted only while Settings shows, so their lists are fetched fresh on each open and
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
 * therefore the real composable throughout this file rather than a stub: it reaches no network, and
 * what it reads off an entity is part of what is pinned here.
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
      loadEntities, selectEntity, addEntity: vi.fn(), editEntity: vi.fn(), removeEntity: vi.fn(),
    }),
  };
});
// Mocked for the paged-load group, which is the only one that reaches it: the
// real composable calls getEntityPage, and nothing in a test should fetch.
const { getEntityPage } = vi.hoisted(() => ({ getEntityPage: vi.fn() }));
vi.mock('../api/entities.js', () => ({
  ENTITY_PAGE_SIZE: 200,
  getEntityPage,
  getEntities: vi.fn(), getEntity: vi.fn(), createEntity: vi.fn(),
  updateEntity: vi.fn(), deleteEntity: vi.fn(),
  getEntityHistory: vi.fn(), rollbackEntity: vi.fn(),
  getDeletedEntities: vi.fn(), restoreEntity: vi.fn(),
}));
// useFilters is deliberately NOT mocked: it reaches nothing, and the fields it reads off a listed
// entity are the point of the list group below.
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
  it('has Passkeys, Recently deleted and Tags groups between Account and Delete account', () => {
    const wrapper = shallowMount(WikiLayout);

    const titles = wrapper.findAll('.mobile-settings-panel .settings-group-title').map((t) => t.text());
    expect(titles).toEqual(['Account', 'Passkeys', 'Recently deleted', 'Tags', 'Delete account']);
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

  it('searches the list on summary text, with no block content to read', async () => {
    const wrapper = mountList();

    await wrapper.get('.search-input').setValue('northern');

    expect(cards(wrapper)).toEqual(['Alder Street']);
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
 * Falsification: assign only the last page in `loadEntities` and the first assertion fails; clear
 * `sidebarLoading` after the loop instead of after the first page and the mid-load one does.
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
});
