/**
 * The history list on an entity's page, and the entity-type picker a version
 * saved under a since-renamed type needs (KOL-059).
 *
 * fetch is stubbed rather than api/entities.js mocked, as in TagSettings.test.js,
 * so what is pinned here is the routes the section calls — method, path and
 * body — and what it does with their answers. The point of the picker is that
 * the choice is made before the click: `GET /entities/:id/history` marks the
 * entries that need one, and the row for one of those sends
 * `{ category }` to `POST /entities/:id/rollback/:logId`.
 *
 * The server's own rules — the 409, what it names, and what it refuses to
 * write — are in server/tests/http/rollback.test.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import EntityDetail from './EntityDetail.vue';

const ENTITY = {
  _id: 'e1',
  title: 'The Engine',
  category: 'People',
  summary: 'fixture',
  tags: [],
  blocks: [],
  relationships: [],
  open_questions: [],
};

/** Two entries: the older one was saved under a type the workspace lost. */
const STALE = {
  _id: 'log-stale',
  changeType: 'updated',
  actorLabel: 'daniel@example.test',
  createdAt: '2026-10-01T10:00:00.000Z',
  changes: { fieldsChanged: ['title'], blocksAdded: [], blocksUpdated: [], blocksDeleted: [] },
  snapshot: { title: 'Older', category: 'Characters' },
  snapshotCategoryMissing: true,
};
const FINE = {
  _id: 'log-fine',
  changeType: 'updated',
  actorLabel: 'daniel@example.test',
  createdAt: '2026-10-02T10:00:00.000Z',
  changes: { fieldsChanged: ['summary'], blocksAdded: [], blocksUpdated: [], blocksDeleted: [] },
  snapshot: { title: 'Newer', category: 'People' },
};

/** The workspace's types, as `GET /entity-types` answers them. */
const TYPES = [
  { _id: 't1', name: 'People', order: 0, color: { bg: '#111', text: '#eee' } },
  { _id: 't2', name: 'Worlds', order: 1, color: { bg: '#222', text: '#eee' } },
];

/** `{ 'METHOD /path': (init) => [status, body] }`, answered by the stubbed fetch. */
let routes;
/** Every request made, as `{ key, body }` with key `'METHOD /path'`. */
let calls;

beforeEach(() => {
  localStorage.setItem('HISTORY_LOG_LEVEL', 'off');
  localStorage.setItem('ENTITY_TYPE_LOG_LEVEL', 'off');
  calls = [];
  routes = {
    'GET /entity-types': () => [200, TYPES],
    'GET /entities/e1/history': () => [200, [FINE, { ...STALE }]],
  };
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${new URL(url, 'http://localhost').pathname}`;
    calls.push({ key, body: init.body });
    if (!routes[key]) throw new Error(`unexpected request: ${key}`);
    const [status, body] = routes[key](init);
    return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const button = (within, text) => {
  const found = within.findAll('button').find((b) => b.text() === text);
  if (!found) throw new Error(`no "${text}" button`);
  return found;
};

/** Mounts the page, loads the workspace's types, and opens the history section. */
async function openHistory(props = {}) {
  const { loadEntityTypes } = await import('../composables/useEntityTypes.js').then((m) => m.useEntityTypes());
  await loadEntityTypes('EntityDetail.test.js');

  const wrapper = mount(EntityDetail, {
    props: { entity: ENTITY, loading: false, breadcrumbs: [], ...props },
    global: { stubs: { BreadcrumbBar: true, EntityHeader: true, BlockList: true, RelationshipsSection: true } },
  });
  await flushPromises();
  await button(wrapper, 'History').trigger('click');
  await flushPromises();
  return wrapper;
}

/**
 * The history row whose summary line reads `what` — the two fixtures changed
 * different fields, so that is what tells them apart on screen. Found by
 * rendered text rather than by log id: the ids are not in the DOM, and a test
 * that reached into the component's state would pass with nothing rendered.
 */
const rowFor = (wrapper, what) => {
  const found = wrapper.findAll('.history-item').find((li) => li.get('.history-what').text() === what);
  if (!found) throw new Error(`no history row reading "${what}"`);
  return found;
};

describe('EntityDetail history', () => {
  it('asks for nothing until the history section is opened', async () => {
    mount(EntityDetail, {
      props: { entity: ENTITY, loading: false, breadcrumbs: [] },
      global: { stubs: { BreadcrumbBar: true, EntityHeader: true, BlockList: true, RelationshipsSection: true } },
    });
    await flushPromises();
    expect(calls.filter((c) => c.key.includes('/history'))).toHaveLength(0);
  });

  it('renders an entity-type picker, from the workspace\'s types, on a row whose snapshot type is gone', async () => {
    const wrapper = await openHistory();

    expect(calls.map((c) => c.key)).toContain('GET /entities/e1/history');

    const stale = rowFor(wrapper, 'title');
    const picker = stale.get('select.history-category');
    expect(picker.findAll('option').map((o) => o.text())).toEqual(['Choose a type…', 'People', 'Worlds']);
    expect(stale.text()).toContain('Characters');

    // And only that row: an entry whose type is still there restores directly.
    expect(rowFor(wrapper, 'summary').find('select.history-category').exists()).toBe(false);
  });

  it('will not restore a stale row until a type is chosen, then sends the choice', async () => {
    const wrapper = await openHistory();
    const stale = rowFor(wrapper, 'title');

    expect(button(stale, 'Restore').attributes('disabled')).toBeDefined();

    routes['POST /entities/e1/rollback/log-stale'] = () => [200, { ...ENTITY, title: 'Older' }];
    await stale.get('select.history-category').setValue('Worlds');
    await button(stale, 'Restore').trigger('click');
    await flushPromises();

    const sent = calls.find((c) => c.key === 'POST /entities/e1/rollback/log-stale');
    expect(JSON.parse(sent.body)).toEqual({ category: 'Worlds' });
    expect(wrapper.emitted('refresh')).toHaveLength(1);
  });

  it('restores a row that needs no choice without naming a category', async () => {
    const wrapper = await openHistory();
    routes['POST /entities/e1/rollback/log-fine'] = () => [200, { ...ENTITY, title: 'Newer' }];

    await button(rowFor(wrapper, 'summary'), 'Restore').trigger('click');
    await flushPromises();

    const sent = calls.find((c) => c.key === 'POST /entities/e1/rollback/log-fine');
    expect(JSON.parse(sent.body)).toEqual({});
    expect(wrapper.emitted('refresh')).toHaveLength(1);
  });

  it('grows a picker from a 409 for a type that went while the list was on screen', async () => {
    // The server did not flag it, so the row offered a plain Restore.
    routes['GET /entities/e1/history'] = () => [200, [{ ...FINE }]];
    const wrapper = await openHistory();
    expect(rowFor(wrapper, 'summary').find('select.history-category').exists()).toBe(false);

    routes['POST /entities/e1/rollback/log-fine'] = () => [409, {
      error: 'This version was saved under "People", which is no longer an entity type in this workspace.',
      snapshotCategory: 'People',
      availableCategories: ['Folk'],
    }];
    await button(rowFor(wrapper, 'summary'), 'Restore').trigger('click');
    await flushPromises();

    const row = rowFor(wrapper, 'summary');
    expect(row.get('select.history-category').findAll('option').map((o) => o.text()))
      .toEqual(['Choose a type…', 'Folk']);
    expect(wrapper.get('.history-error').text()).toContain('no longer an entity type');
    expect(wrapper.emitted('refresh')).toBeUndefined();
  });
});
