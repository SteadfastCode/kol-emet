/**
 * The category pills and card colours in the sidebar, over the real useEntityTypes composable and
 * client API module. fetch is stubbed rather than api/entityTypes.js mocked, so what is pinned here
 * is that the list comes from GET /entity-types, in the order the server sends it, and that a
 * category the registry lacks still gets a colour. VirtualList is stubbed to render every item:
 * jsdom has no layout, so the real one would window the list down to nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import EntitySidebar from './EntitySidebar.vue';
import { useEntityTypes } from '../composables/useEntityTypes.js';

// Server order (`order`, then name) — deliberately not alphabetical, so a client that sorted would fail.
const TYPES = [
  { _id: 't1', name: 'Worlds',     icon: null, color: { bg: '#9FE1CB', text: '#085041' }, order: 0 },
  { _id: 't2', name: 'Characters', icon: null, color: { bg: '#B5D4F4', text: '#0C447C' }, order: 1 },
  { _id: 't3', name: 'Starships',  icon: null, color: { bg: null, text: null },           order: 2 },
];

const ENTITIES = [
  { _id: 'e1', title: 'Earth',   category: 'Worlds',  summary: '', tags: [] },
  { _id: 'e2', title: 'Old one', category: 'Retired', summary: '', tags: [] },
];

const VirtualListStub = {
  props: ['items'],
  template: '<div><div v-for="(item, index) in items" :key="index"><slot :item="item" :index="index" /></div></div>',
};

let calls;

beforeEach(async () => {
  localStorage.setItem('ENTITY_TYPE_LOG_LEVEL', 'off');
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push(`${init.method ?? 'GET'} ${new URL(url, 'http://localhost').pathname}`);
    return new Response(JSON.stringify(TYPES), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  await useEntityTypes().loadEntityTypes('test');
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const mountSidebar = () => mount(EntitySidebar, {
  props: { entities: ENTITIES, activeCat: 'All', activeTag: null, searchQuery: '', loading: false },
  global: { stubs: { VirtualList: VirtualListStub } },
});

const badgeFor = (wrapper, title) =>
  wrapper.findAll('.sidebar-card').find((c) => c.find('.card-title').text() === title).get('.entity-cat');

describe('EntitySidebar categories', () => {
  it('renders a pill per fetched entity type, in the order GET /entity-types returned them', async () => {
    const wrapper = mountSidebar();
    await flushPromises();

    expect(calls).toEqual(['GET /entity-types']);
    expect(wrapper.findAll('.cat-pills .pill').map((p) => p.text())).toEqual(['All', 'Worlds', 'Characters', 'Starships']);
  });

  it("paints a registered category with the registry's colours", async () => {
    const wrapper = mountSidebar();
    await flushPromises();

    const style = badgeFor(wrapper, 'Earth').element.style;
    expect(style.background).toBe('rgb(159, 225, 203)'); // #9FE1CB
    expect(style.color).toBe('rgb(8, 80, 65)');          // #085041
  });

  it('paints a category the registry lacks with the fallback colours', async () => {
    const wrapper = mountSidebar();
    await flushPromises();

    const badge = badgeFor(wrapper, 'Old one');
    expect(badge.text()).toBe('Retired');
    expect(badge.element.style.background).toBe('rgb(51, 51, 51)'); // #333
    expect(badge.element.style.color).toBe('rgb(170, 170, 170)');   // #aaa
  });

  it('falls back per colour for a registered type that has none', () => {
    const { styleFor } = useEntityTypes();
    expect(styleFor('Starships')).toEqual({ bg: '#333', color: '#aaa' });
    expect(styleFor('Characters')).toEqual({ bg: '#B5D4F4', color: '#0C447C' });
  });
});
