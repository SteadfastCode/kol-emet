/**
 * What the graph's loader does with a group list that now arrives in pages
 * (KOL-092), over the real component and the real `getAllGroups` walk — only
 * `fetch` is stubbed.
 *
 *   It pages to the end. The graph asked for every group in the workspace in
 *   one unbounded request, which is the read the item removed; the edges it
 *   draws have to come from *all* the pages, so a walk that stopped at the
 *   first one would be a graph missing edges and saying nothing.
 *
 *   A page that fails leaves a visible "stopped partway" state rather than a
 *   silently short list — KOL-083's rule, for the graph instead of the sidebar.
 *   This matters more here than in a list: every node is still drawn, so an
 *   incomplete graph is *indistinguishable* from a complete one — the missing
 *   edges simply look like relationships that do not exist. The groups that did
 *   arrive are still drawn, because an empty graph is a worse answer than an
 *   incomplete one, and "No relationships yet" is withheld, because the server
 *   never said that.
 *
 * Falsification: stop walking after the first page and the first case's edge
 * count drops; drop the `loadWarning` strip and the partial cases fail; roll the
 * partial groups back to nothing on a failed page and the "keeps what arrived"
 * assertions fail; leave the "No relationships yet" overlay unconditional and
 * the first-page-failure case shows it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import GraphView from './GraphView.vue';

// The force simulation holds a timer and the resize observer a listener, so a
// wrapper left mounted keeps running for the rest of the file.
enableAutoUnmount(afterEach);

const entity = (id, title) => ({ _id: id, title, category: 'Worlds' });
const group = (id, label, memberIds) => ({
  _id: id,
  label,
  members: memberIds.map((refId) => ({ refId, refModel: 'Entity', label: null, notes: null })),
});

const ENTITIES = [entity('e1', 'Alder Street'), entity('e2', 'Boiler Room'), entity('e3', 'Coupling Yard'), entity('e4', 'Depot')];
/** One group per page, so each page contributes exactly one edge. */
const PAGE_1 = { items: [group('g1', 'Runs through', ['e1', 'e2'])], nextAfter: 'g1' };
const PAGE_2 = { items: [group('g2', 'Feeds', ['e3', 'e4'])], nextAfter: null };

/** Group-page responses, in order; each is `{ status?, body }`. */
let groupPages;
let requestedGroupQueries;

/** Answers `/entities` with the fixture and `/relationship-groups` from the queue. */
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const { pathname, searchParams } = new URL(url, 'http://localhost');
    if (pathname === '/entities') {
      return { ok: true, status: 200, statusText: 'OK', json: async () => ENTITIES };
    }
    if (pathname === '/relationship-groups') {
      requestedGroupQueries.push(searchParams.toString());
      const next = groupPages.shift() ?? { body: { items: [], nextAfter: null } };
      const status = next.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 401 ? 'Unauthorized' : 'Internal Server Error',
        json: async () => next.body,
      };
    }
    throw new Error(`unexpected request: ${url}`);
  }));
}

beforeEach(() => {
  groupPages = [];
  requestedGroupQueries = [];
  stubFetch();
  // jsdom has no ResizeObserver, and the graph observes its container.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  localStorage.setItem('GRAPH_LOAD_LOG_LEVEL', 'off');
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Mounts the graph and lets the load settle. */
async function mountGraph() {
  const wrapper = mount(GraphView, { attachTo: document.body });
  await flushPromises();
  await flushPromises();
  return wrapper;
}

const stats = (wrapper) => wrapper.find('.graph-stats').text();
const warning = (wrapper) => wrapper.find('.graph-warning');

describe('GraphView group loading', () => {
  it('pages to the end and draws the edges from every page', async () => {
    groupPages.push({ body: PAGE_1 }, { body: PAGE_2 });

    const wrapper = await mountGraph();

    // Two pages walked, the second with the first's cursor.
    expect(requestedGroupQueries).toEqual(['limit=200', 'limit=200&after=g1']);
    // One edge from each page — a walk that stopped at page one would say 1.
    expect(stats(wrapper)).toContain('4 nodes · 2 edges');
    expect(warning(wrapper).exists()).toBe(false);
  });

  it('a failed second page keeps the first page on screen and says the graph is incomplete', async () => {
    groupPages.push({ body: PAGE_1 }, { status: 500, body: { error: 'INTERNAL' } });

    const wrapper = await mountGraph();

    expect(warning(wrapper).exists()).toBe(true);
    expect(warning(wrapper).text()).toMatch(/incomplete/i);
    // The edge from the page that did arrive is still drawn: an empty graph
    // would be a worse answer than an incomplete one.
    expect(stats(wrapper)).toContain('4 nodes · 1 edges');
    // And it is not reported as a failed load — the graph is on screen.
    expect(wrapper.find('.graph-overlay.error').exists()).toBe(false);
  });

  it('a 401 on a page says the session expired, not that something went wrong', async () => {
    groupPages.push({ body: PAGE_1 }, { status: 401, body: {} });

    const wrapper = await mountGraph();

    expect(warning(wrapper).text()).toMatch(/session has expired/i);
  });

  it('a first page that fails does not claim there are no relationships', async () => {
    groupPages.push({ status: 500, body: { error: 'INTERNAL' } });

    const wrapper = await mountGraph();

    expect(warning(wrapper).exists()).toBe(true);
    expect(stats(wrapper)).toContain('0 edges');
    // "No relationships yet — add relationship groups" is an answer the server
    // never gave.
    expect(wrapper.find('.graph-overlay.muted').exists()).toBe(false);
  });

  it('an empty workspace still gets the empty state, not a warning', async () => {
    groupPages.push({ body: { items: [], nextAfter: null } });

    const wrapper = await mountGraph();

    expect(warning(wrapper).exists()).toBe(false);
    expect(wrapper.find('.graph-overlay.muted').exists()).toBe(true);
  });

  it('a failed entity list is still a failed graph', async () => {
    // The nodes are the graph; without them there is nothing to be partial
    // about, and the overlay is the right answer.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) })));

    const wrapper = await mountGraph();

    expect(wrapper.find('.graph-overlay.error').exists()).toBe(true);
  });
});
