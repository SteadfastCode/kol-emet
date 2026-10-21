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

/**
 * The open-question section on an entity's page (KOL-104).
 *
 * `EntityHeader` is deliberately *not* stubbed here, unlike in the history
 * cases above: the section lives in the header, and what is worth pinning is
 * that the panel's own entity id reaches `entry_ids` — a header mounted on its
 * own could not show that. fetch is stubbed the same way, so these pin the
 * routes the section calls (method, path and body) and what it renders from
 * their answers.
 *
 * The server's own rules — which `entry_ids` it keeps, the back-links, the 404
 * for a foreign id — are in server/tests/http/openQuestions.test.js.
 */

const QUESTIONS = [
  { _id: 'q1', question: 'Who stokes it on the night run?', status: 'open' },
  { _id: 'q2', question: 'How long is the northern line?', status: 'resolved' },
];

/** Mounts the page with the real header, so the open-question section renders. */
async function openPanel(entity = { ...ENTITY, open_questions: QUESTIONS }) {
  const { loadEntityTypes } = await import('../composables/useEntityTypes.js').then((m) => m.useEntityTypes());
  await loadEntityTypes('EntityDetail.test.js');

  const wrapper = mount(EntityDetail, {
    props: { entity, loading: false, breadcrumbs: [] },
    global: { stubs: { BreadcrumbBar: true, BlockList: true, RelationshipsSection: true } },
  });
  await flushPromises();
  return wrapper;
}

/** The rendered question rows, as `{ status, text }` in order. */
const rows = (wrapper) => wrapper.findAll('.oq-item').map((li) => ({
  status: li.get('.oq-badge').text(),
  text: li.get('.oq-text').text(),
}));

/** The row whose text is `text`. Found by what is on screen, not by index. */
const questionRow = (wrapper, text) => {
  const found = wrapper.findAll('.oq-item')
    .find((li) => li.find('.oq-text').exists() && li.get('.oq-text').text() === text);
  if (!found) throw new Error(`no question row reading "${text}"`);
  return found;
};

/** The one row with its text open in the inline editor. */
const editingRow = (wrapper) => {
  const found = wrapper.findAll('.oq-item').find((li) => li.find('.oq-edit').exists());
  if (!found) throw new Error('no question row is being edited');
  return found;
};

const addField = (wrapper) => wrapper.get('input[aria-label="Add a question"]');

describe('EntityDetail open questions', () => {
  beforeEach(() => {
    localStorage.setItem('OPEN_QUESTION_LOG_LEVEL', 'off');
  });

  it('renders the questions it was given and counts only the open ones', async () => {
    const wrapper = await openPanel();

    expect(rows(wrapper)).toEqual([
      { status: 'open', text: 'Who stokes it on the night run?' },
      { status: 'resolved', text: 'How long is the northern line?' },
    ]);
    // Two questions, one answered: the badge is 1, not 2.
    expect(wrapper.get('.oq-count').text()).toBe('1');
    // Reading them asks for nothing — they arrive populated on the entity.
    expect(calls.filter((c) => c.key.includes('/open-questions'))).toHaveLength(0);
  });

  it('posts a new question once, with the open entity id, and renders what came back', async () => {
    const wrapper = await openPanel();
    routes['POST /open-questions'] = () => [201, {
      _id: 'q3',
      // The server's version of it, which is what has to appear on the list.
      question: 'Where does the coal come from?',
      status: 'open',
      entry_ids: ['e1'],
    }];

    await addField(wrapper).setValue('  Where does the coal come from?  ');
    await wrapper.get('form.oq-add').trigger('submit');
    await flushPromises();

    const posts = calls.filter((c) => c.key === 'POST /open-questions');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].body)).toEqual({
      question: 'Where does the coal come from?',
      entry_ids: ['e1'],
    });

    expect(rows(wrapper).map((r) => r.text)).toContain('Where does the coal come from?');
    expect(wrapper.get('.oq-count').text()).toBe('2');
    expect(addField(wrapper).element.value).toBe('');
  });

  it('resolving sends status and no other field', async () => {
    const wrapper = await openPanel();
    routes['PUT /open-questions/q1'] = () => [200, { ...QUESTIONS[0], status: 'resolved' }];

    await questionRow(wrapper, 'Who stokes it on the night run?').get('.oq-badge-btn').trigger('click');
    await flushPromises();

    const sent = calls.filter((c) => c.key === 'PUT /open-questions/q1');
    expect(sent).toHaveLength(1);
    // Not the text, not entry_ids: a resolve that carried the row it was
    // clicked from could overwrite a rename somebody else made.
    expect(JSON.parse(sent[0].body)).toEqual({ status: 'resolved' });

    expect(questionRow(wrapper, 'Who stokes it on the night run?').text()).toContain('resolved');
    expect(wrapper.find('.oq-count').exists()).toBe(false);
  });

  it('reopening a resolved question sends status open', async () => {
    const wrapper = await openPanel();
    routes['PUT /open-questions/q2'] = () => [200, { ...QUESTIONS[1], status: 'open' }];

    await questionRow(wrapper, 'How long is the northern line?').get('.oq-badge-btn').trigger('click');
    await flushPromises();

    expect(JSON.parse(calls.find((c) => c.key === 'PUT /open-questions/q2').body)).toEqual({ status: 'open' });
    expect(wrapper.get('.oq-count').text()).toBe('2');
  });

  it('an inline rename sends the text alone and renders the saved text', async () => {
    const wrapper = await openPanel();
    routes['PUT /open-questions/q1'] = (init) => [200, {
      ...QUESTIONS[0],
      question: JSON.parse(init.body).question,
    }];

    const row = questionRow(wrapper, 'Who stokes it on the night run?');
    await row.get('button[title="Edit question"]').trigger('click');
    await editingRow(wrapper).get('.oq-edit').setValue('Who stokes it?');
    await button(editingRow(wrapper), 'Save').trigger('click');
    await flushPromises();

    expect(JSON.parse(calls.find((c) => c.key === 'PUT /open-questions/q1').body)).toEqual({
      question: 'Who stokes it?',
    });
    expect(rows(wrapper).map((r) => r.text)).toEqual(['Who stokes it?', 'How long is the northern line?']);
    expect(wrapper.find('input[aria-label="Question text"]').exists()).toBe(false);
  });

  it('a refused create leaves the list as it was and says so', async () => {
    const wrapper = await openPanel();
    const before = rows(wrapper);
    routes['POST /open-questions'] = () => [400, { error: 'Question is required' }];

    await addField(wrapper).setValue('Something the server will refuse');
    await wrapper.get('form.oq-add').trigger('submit');
    await flushPromises();

    // Not on the list: what is rendered is what came back, and nothing did.
    expect(rows(wrapper)).toEqual(before);
    expect(wrapper.get('.oq-error').text()).toBe('Question is required');
    // The typed text stays put, so the retry is a click and not a retype.
    expect(addField(wrapper).element.value).toBe('Something the server will refuse');
  });

  it('a refused resolve leaves the status and the count alone and says so', async () => {
    const wrapper = await openPanel();
    routes['PUT /open-questions/q1'] = () => [403, { error: 'Read-only access' }];

    await questionRow(wrapper, 'Who stokes it on the night run?').get('.oq-badge-btn').trigger('click');
    await flushPromises();

    expect(rows(wrapper)).toEqual([
      { status: 'open', text: 'Who stokes it on the night run?' },
      { status: 'resolved', text: 'How long is the northern line?' },
    ]);
    expect(wrapper.get('.oq-count').text()).toBe('1');
    expect(wrapper.get('.oq-error').text()).toBe('Read-only access');
  });

  it('a delete answering 204 removes exactly one row', async () => {
    const wrapper = await openPanel();
    routes['DELETE /open-questions/q2'] = () => [204, null];

    await questionRow(wrapper, 'How long is the northern line?').get('button[title="Delete question"]').trigger('click');
    await flushPromises();

    expect(rows(wrapper)).toEqual([{ status: 'open', text: 'Who stokes it on the night run?' }]);
    expect(calls.filter((c) => c.key.startsWith('DELETE /open-questions'))).toHaveLength(1);
  });

  it('offers no controls on a snapshot, and still shows the questions', async () => {
    const wrapper = await openPanel();
    const live = wrapper.findAll('.oq-badge-btn').length;
    expect(live).toBe(2);

    const snapshot = mount(EntityDetail, {
      props: {
        entity: { ...ENTITY, open_questions: QUESTIONS },
        loading: false,
        breadcrumbs: [],
        canWrite: false,
      },
      global: { stubs: { BreadcrumbBar: true, BlockList: true, RelationshipsSection: true } },
    });
    await flushPromises();

    expect(rows(snapshot).map((r) => r.text)).toEqual(QUESTIONS.map((q) => q.question));
    expect(snapshot.findAll('.oq-badge-btn')).toHaveLength(0);
    expect(snapshot.find('form.oq-add').exists()).toBe(false);
  });
});
