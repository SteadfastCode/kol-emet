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
 */
import { describe, it, expect, vi } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import WikiLayout from './WikiLayout.vue';
import PasskeySettings from './PasskeySettings.vue';
import RecentlyDeleted from './RecentlyDeleted.vue';
import TagSettings from './TagSettings.vue';
import EntitySidebar from './EntitySidebar.vue';

const { entities, loadEntities } = vi.hoisted(() => ({ entities: [], loadEntities: vi.fn() }));
vi.mock('../composables/useEntities.js', async () => {
  const { ref } = await import('vue');
  return {
    useEntities: () => ({
      entities: ref(entities), selectedEntity: ref(null), sidebarLoading: ref(false), detailLoading: ref(false),
      loadEntities, selectEntity: vi.fn(), addEntity: vi.fn(), editEntity: vi.fn(), removeEntity: vi.fn(),
    }),
  };
});
vi.mock('../composables/useFilters.js', async () => {
  const { ref } = await import('vue');
  return {
    useFilters: () => ({
      searchQuery: ref(''), activeCat: ref(null), activeTag: ref(null), filtered: ref([]),
      setCat: vi.fn(), setTag: vi.fn(), clearTag: vi.fn(), resetFilters: vi.fn(),
    }),
  };
});
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
