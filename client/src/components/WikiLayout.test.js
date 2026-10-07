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
 * The last group is the exception — it mounts the list for real (sidebar, cards and all) over
 * entities that carry no `blocks`, which is the shape `GET /entities` now sends (KOL-061). Nothing
 * on this path reads block content, and the group fails if something starts to. `useFilters` is
 * therefore the real composable throughout this file rather than a stub: it reaches no network, and
 * what it reads off an entity is part of what is pinned here.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { mount, shallowMount } from '@vue/test-utils';
import WikiLayout from './WikiLayout.vue';
import PasskeySettings from './PasskeySettings.vue';
import RecentlyDeleted from './RecentlyDeleted.vue';
import TagSettings from './TagSettings.vue';
import EntitySidebar from './EntitySidebar.vue';

const { entities, loadEntities, selectEntity } = vi.hoisted(() => ({
  entities: [], loadEntities: vi.fn(), selectEntity: vi.fn(),
}));
vi.mock('../composables/useEntities.js', async () => {
  const { ref } = await import('vue');
  return {
    useEntities: () => ({
      entities: ref(entities), selectedEntity: ref(null), sidebarLoading: ref(false), detailLoading: ref(false),
      loadEntities, selectEntity, addEntity: vi.fn(), editEntity: vi.fn(), removeEntity: vi.fn(),
    }),
  };
});
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

const mountList = () => mount(WikiLayout, {
  global: {
    stubs: {
      VirtualList: VirtualListStub,
      EntityDetail: true, EntityEditor: true, ChatPanel: true, GraphView: true,
      GeneratorOverlay: true, ToastNotification: true, AccountDeletion: true,
      PasskeySettings: true, RecentlyDeleted: true, TagSettings: true,
    },
  },
});

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
