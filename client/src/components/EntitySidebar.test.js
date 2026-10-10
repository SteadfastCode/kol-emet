/**
 * The category pills and card colours in the sidebar, over the real useEntityTypes composable and
 * client API module. fetch is stubbed rather than api/entityTypes.js mocked, so what is pinned here
 * is that the list comes from GET /entity-types, in the order the server sends it, and that a
 * category the registry lacks still gets a colour. VirtualList is stubbed to render every item:
 * jsdom has no layout, so the real one would window the list down to nothing.
 *
 * The second group is the search result's "matched in text" line (KOL-068). The search box asks the
 * server, which matches block markdown as well as title and summary, so a result can be on screen
 * for a reason that appears nowhere on its card — and a result with no visible reason is the thing
 * this line exists to prevent. `useFilters` decides which rows get it (see its own tests); what is
 * pinned here is that the sidebar renders it, on those rows only, without swallowing the click that
 * opens the entity.
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

const mountSidebar = (props = {}) => mount(EntitySidebar, {
  props: { entities: ENTITIES, activeCat: 'All', activeTag: null, searchQuery: '', loading: false, ...props },
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

/**
 * A search result set as `useFilters` hands it over: `matchedInText` on the row whose term was in
 * neither its title nor its summary, absent on the one it could be read off.
 */
const RESULTS = [
  { _id: 'r1', title: 'Boiler Room', category: 'Worlds', summary: 'Holds the boiler.', tags: [] },
  { _id: 'r2', title: 'Coupling Rod', category: 'Worlds', summary: 'Holds the wheels in step.', tags: [], matchedInText: true },
];

const cardFor = (wrapper, title) =>
  wrapper.findAll('.result-row').find((r) => r.find('.card-title').text() === title);

describe('EntitySidebar search results', () => {
  it("gives the row that matched only in a block the 'matched in text' line, and no other row", async () => {
    const wrapper = mountSidebar({ entities: RESULTS, searchQuery: 'boiler' });
    await flushPromises();

    expect(cardFor(wrapper, 'Coupling Rod').get('.matched-in-text').text()).toBe('matched in text');
    expect(cardFor(wrapper, 'Boiler Room').find('.matched-in-text').exists()).toBe(false);
  });

  it('leaves the line off every row when nothing is searched', async () => {
    const wrapper = mountSidebar();
    await flushPromises();

    expect(wrapper.find('.matched-in-text').exists()).toBe(false);
  });

  it('still opens the entity when the marked row is clicked', async () => {
    const wrapper = mountSidebar({ entities: RESULTS, searchQuery: 'boiler' });
    await flushPromises();

    await cardFor(wrapper, 'Coupling Rod').get('.sidebar-card').trigger('click');

    expect(wrapper.emitted('select')).toEqual([['r2', 'Coupling Rod']]);
  });

  it('says a query is out while one is, on the count line', async () => {
    const wrapper = mountSidebar({ entities: RESULTS, searchQuery: 'boiler', searching: true });
    await flushPromises();

    expect(wrapper.get('.entity-count').text()).toBe('2 entities \u00b7 searching\u2026');

    await wrapper.setProps({ searching: false });
    expect(wrapper.get('.entity-count').text()).toBe('2 entities');
  });
});
