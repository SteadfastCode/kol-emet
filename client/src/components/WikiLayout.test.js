/**
 * Where the Passkeys group sits: in Settings, between Account and Delete account, and mounted only
 * while Settings shows, so its list is fetched fresh on each open and never on page load. What the
 * group itself does is pinned in PasskeySettings.test.js. Shallow: every child is a stub, and the
 * composables that would reach the network or open an EventSource are replaced.
 */
import { describe, it, expect, vi } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import WikiLayout from './WikiLayout.vue';
import PasskeySettings from './PasskeySettings.vue';
import EntitySidebar from './EntitySidebar.vue';

vi.mock('../composables/useEntities.js', async () => {
  const { ref } = await import('vue');
  return {
    useEntities: () => ({
      entities: ref([]), selectedEntity: ref(null), sidebarLoading: ref(false), detailLoading: ref(false),
      loadEntities: vi.fn(), selectEntity: vi.fn(), addEntity: vi.fn(), editEntity: vi.fn(), removeEntity: vi.fn(),
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

const settingsTab = (wrapper) => wrapper.findAll('.tab-btn').find((b) => b.text() === 'Settings');

describe('WikiLayout settings', () => {
  it('has a Passkeys group between Account and Delete account', () => {
    const wrapper = shallowMount(WikiLayout);

    const titles = wrapper.findAll('.mobile-settings-panel .settings-group-title').map((t) => t.text());
    expect(titles).toEqual(['Account', 'Passkeys', 'Delete account']);
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
});
