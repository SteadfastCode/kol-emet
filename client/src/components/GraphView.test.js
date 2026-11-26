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
 *   It redraws **in place** when a relationship frame says the groups moved
 *   (KOL-149). The graph read the group list once on mount, so a group created,
 *   relabelled, reordered or deleted in another tab left it drawing edges that
 *   no longer exist — the one view whose entire content is relationships was the
 *   one view that never updated. The layout calls `reload` on every `group:*`
 *   frame (components/WikiLayout.vue), and it has to rebuild without remounting:
 *   a remount would throw away the zoom, the pan and the force layout the viewer
 *   is reading.
 *
 *   And **in place means the viewer's place** (KOL-157), which not remounting
 *   was only half of. `initGraph` wipes the `<svg>` and builds a fresh `<g>`,
 *   so three things have to be carried across it by hand: the zoom transform,
 *   which d3-zoom keeps on the `<svg>` itself and hands straight back to the new
 *   behaviour — leaving the drawing at identity under a behaviour that believes
 *   otherwise, so the next wheel jumps by the stale delta; the node positions,
 *   which a fresh copy of `nodeData` does not carry; and a warm alpha, because
 *   a simulation that resumes at d3's default 1 re-runs the whole layout and the
 *   carried positions would only decide where the rearrangement starts.
 *
 * Falsification: stop walking after the first page and the first case's edge
 * count drops; drop the `loadWarning` strip and the partial cases fail; roll the
 * partial groups back to nothing on a failed page and the "keeps what arrived"
 * assertions fail; leave the "No relationships yet" overlay unconditional and
 * the first-page-failure case shows it; drop `defineExpose({ reload })` or leave
 * the load inside `onMounted` and the reload group fails. Drop any one of the
 * three carries in `initGraph` — the `<g>`'s transform, the x/y seeded onto the
 * node copies, or the lowered alpha — and one of the last four cases fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import * as d3 from 'd3';
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
/** The rows `/entities` answers with, so a test can add one mid-run. */
let entityRows;

/** Answers `/entities` with the fixture and `/relationship-groups` from the queue. */
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const { pathname, searchParams } = new URL(url, 'http://localhost');
    if (pathname === '/entities') {
      return { ok: true, status: 200, statusText: 'OK', json: async () => entityRows };
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
  entityRows = [...ENTITIES];
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

/** The `<g>` the whole drawing hangs off — the element the zoom transform rides. */
const drawing = (wrapper) => wrapper.find('g.graph-g').element;

/**
 * Where the drawing currently has each node, by entity id, read off the data
 * d3 bound to the node elements — which is the same object the force simulation
 * integrates every tick, so it is where a tick or a drag writes to.
 */
function positions(wrapper) {
  const at = {};
  for (const el of wrapper.findAll('g.node')) {
    const d = el.element.__data__;
    at[d.id] = [d.x, d.y];
  }
  return at;
}

/**
 * Puts the nodes somewhere a settled layout or a few drags would have — away
 * from d3's opening phyllotaxis spiral, so a redraw that quietly restarted the
 * layout is not mistaken for one that kept it.
 */
function placeNodes(wrapper, where) {
  for (const el of wrapper.findAll('g.node')) {
    const d = el.element.__data__;
    const [x, y] = where[d.id];
    d.x = x; d.y = y; d.vx = 0; d.vy = 0;
  }
}

/**
 * The state a wheel or drag gesture leaves behind: d3-zoom keeps the gesture on
 * a `__zoom` property of the element it was called on — the `<svg>` — and the
 * component's own `zoom` handler writes the same transform onto the `<g>`.
 */
function zoomedTo(wrapper, transform) {
  wrapper.find('svg').element.__zoom = transform;
  drawing(wrapper).setAttribute('transform', transform.toString());
}

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

  it('reloads in place on demand, redrawing from the groups that arrive', async () => {
    groupPages.push({ body: PAGE_1 });
    const wrapper = await mountGraph();
    expect(stats(wrapper)).toContain('4 nodes · 1 edges');
    const svgBefore = wrapper.find('svg').element;
    const requestsBefore = requestedGroupQueries.length;

    // What a `group:created` frame in another tab means: there is a second
    // group now, and this graph has never heard of it.
    groupPages.push({
      body: {
        items: [group('g1', 'Runs through', ['e1', 'e2']), group('g2', 'Feeds', ['e3', 'e4'])],
        nextAfter: null,
      },
    });
    await wrapper.vm.reload('a group:created frame');
    await flushPromises();

    expect(stats(wrapper)).toContain('4 nodes · 2 edges');
    expect(requestedGroupQueries.length).toBeGreaterThan(requestsBefore);
    // The same element, so the component was not remounted: the viewer's zoom,
    // pan and layout survive the redraw.
    expect(wrapper.find('svg').element).toBe(svgBefore);
  });

  it('a reload that succeeds clears the warning a failed page left', async () => {
    groupPages.push({ status: 500, body: { error: 'INTERNAL' } });
    const wrapper = await mountGraph();
    expect(warning(wrapper).exists()).toBe(true);

    groupPages.push({ body: PAGE_2 });
    await wrapper.vm.reload('a group:updated frame');
    await flushPromises();

    expect(warning(wrapper).exists()).toBe(false);
    expect(stats(wrapper)).toContain('4 nodes · 1 edges');
  });

  it('a reload that finds nothing left draws no edges', async () => {
    // What a `group:deleted` frame means when it was the only group: the edge
    // has to go, which is the whole point of listening for one.
    groupPages.push({ body: PAGE_1 });
    const wrapper = await mountGraph();
    expect(stats(wrapper)).toContain('1 edges');

    groupPages.push({ body: { items: [], nextAfter: null } });
    await wrapper.vm.reload('a group:deleted frame');
    await flushPromises();

    expect(stats(wrapper)).toContain('0 edges');
    expect(wrapper.find('.graph-overlay.muted').exists()).toBe(true);
  });

  it('carries the zoom and the pan across a redraw, and leaves d3-zoom agreeing with the drawing', async () => {
    groupPages.push({ body: PAGE_1 });
    const wrapper = await mountGraph();
    const svg = wrapper.find('svg').element;
    const gBefore = drawing(wrapper);

    const gesture = d3.zoomIdentity.translate(-120, 64).scale(2.5);
    zoomedTo(wrapper, gesture);

    groupPages.push({ body: { items: [group('g1', 'Runs through', ['e1', 'e2'])], nextAfter: null } });
    await wrapper.vm.reload('a group:updated frame');

    // The redraw rebuilds the <svg>'s children, so this is a different element…
    expect(drawing(wrapper)).not.toBe(gBefore);
    // …and the viewer's transform has to come back with it. Without that the
    // drawing snaps to identity on every `group:*` frame.
    expect(drawing(wrapper).getAttribute('transform')).toBe('translate(-120,64) scale(2.5)');
    // d3-zoom's own state survives the rebuild (it lives on the <svg>, which is
    // not wiped), so the two have to still agree: a <g> at identity under a
    // behaviour that believes it is at 2.5× makes the next wheel or drag jump
    // by the whole stale delta.
    const held = d3.zoomTransform(svg);
    expect([held.k, held.x, held.y]).toEqual([2.5, -120, 64]);
    expect(drawing(wrapper).getAttribute('transform')).toBe(held.toString());
  });

  it('carries the force layout across a redraw instead of restarting it', async () => {
    groupPages.push({ body: PAGE_1 });
    const wrapper = await mountGraph();

    // Where the viewer's layout had got to — nowhere near d3's opening spiral,
    // which is all of ~19px from the origin for four nodes.
    const settled = { e1: [-400, 120], e2: [260, -310], e3: [40, 520], e4: [-75, -640] };
    placeNodes(wrapper, settled);

    groupPages.push({ body: { items: [group('g1', 'Runs through', ['e1', 'e2']), group('g2', 'Feeds', ['e3', 'e4'])], nextAfter: null } });
    // Awaited, not flushed: everything the reload waits on is a microtask, so
    // the simulation cannot tick in between and these positions are the ones
    // the redraw was handed.
    await wrapper.vm.reload('a group:created frame');

    expect(stats(wrapper)).toContain('2 edges');
    expect(positions(wrapper)).toEqual(settled);
  });

  it('places a node the redraw is seeing for the first time', async () => {
    groupPages.push({ body: PAGE_1 });
    const wrapper = await mountGraph();
    placeNodes(wrapper, { e1: [-400, 120], e2: [260, -310], e3: [40, 520], e4: [-75, -640] });

    // An entity created in another tab: there is no previous position to carry,
    // so the force layout has to place it rather than leave it at NaN.
    entityRows.push(entity('e5', 'Engine Shed'));
    groupPages.push({ body: { items: [group('g1', 'Runs through', ['e1', 'e5'])], nextAfter: null } });
    await wrapper.vm.reload('a group:updated frame');

    const at = positions(wrapper);
    expect(at.e1).toEqual([-400, 120]);
    expect(at.e5.every(Number.isFinite)).toBe(true);
  });

  it('says what each redraw carried, and what asked for it', async () => {
    localStorage.setItem('GRAPH_LOAD_LOG_LEVEL', 'light');
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    groupPages.push({ body: PAGE_1 });
    const wrapper = await mountGraph();
    zoomedTo(wrapper, d3.zoomIdentity.translate(-120, 64).scale(2.5));
    logged.mockClear();

    groupPages.push({ body: PAGE_1 });
    await wrapper.vm.reload('a group:updated frame');

    // A redraw that kept the viewer's place and one that silently reset it are
    // the same picture from the outside, so the light tier has to name both
    // what asked and what survived.
    const lines = logged.mock.calls.map(([line]) => line);
    const redraw = lines.find((line) => line.includes('redrew in place'));
    expect(redraw).toMatch(/source: a group:updated frame/);
    expect(redraw).toMatch(/kept zoom k=2\.500 x=-120 y=64/);
    expect(redraw).toMatch(/4 of 4 node position\(s\)/);
    // The alpha the simulation is actually at, not the figure it was meant to
    // be given: a redraw that resumed hot at d3's default 1 re-runs the whole
    // layout, and carrying the positions would only decide where it starts.
    expect(redraw).toMatch(/alpha 0\.3$/);
    logged.mockRestore();
  });

  it('a failed entity list is still a failed graph', async () => {
    // The nodes are the graph; without them there is nothing to be partial
    // about, and the overlay is the right answer.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) })));

    const wrapper = await mountGraph();

    expect(wrapper.find('.graph-overlay.error').exists()).toBe(true);
  });
});
