/**
 * The open-questions section of an entity's header (KOL-104/KOL-115), and what a
 * concurrent write to the same entity is allowed to take away from the reader
 * (KOL-117) — the component's first test.
 *
 * The section re-seeds its rows from `entity.open_questions` whenever a fresh
 * array arrives, and that now happens often: WikiLayout replaces
 * `selectedEntity` wholesale and refetches the entity on every open-question
 * frame (KOL-116), so another tab, the chat relay or an MCP client re-seeds the
 * list underneath whoever is typing in it. What is pinned here is therefore the
 * split — the rows are the server's, the half-finished state is the reader's —
 * and the one case where even that goes: a *different* entity arriving in the
 * panel, which reaches this component as the same watcher fire because the
 * panel is not keyed and nothing is remounted.
 *
 * fetch is stubbed rather than api/openQuestions.js mocked, as in
 * RecentlyDeleted.test.js, so what is pinned is the routes the section calls and
 * what it does with their answers. A route here may answer a promise, which is
 * how a write is held in flight while the list is re-seeded under it. The
 * server's own rules for `/open-questions` live in server/tests/http.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import EntityHeader from './EntityHeader.vue';

const question = (id, text, status = 'open') => ({ _id: id, question: text, status });

const WHO = question('oq-who', 'Who built the first engine?');
const WHERE = question('oq-where', 'Where does the line end?');
const ANSWERED = question('oq-fuel', 'What does it burn?', 'resolved');

/** A fresh entity object with a fresh `open_questions` array — one re-seed. */
const entityWith = (rows, id = 'ent-brakeman') => ({
  _id: id,
  title: id === 'ent-brakeman' ? 'The Brakeman' : 'The Caboose',
  category: 'Characters',
  summary: 'fixture',
  tags: [],
  blocks: [],
  relationships: [],
  open_questions: rows.map((r) => ({ ...r })),
});

/** `{ 'METHOD /path': (init) => [status, body] | Promise<[status, body]> }`. */
let routes;
/** Every request made, as `{ key, body }` with key `'METHOD /path'`. */
let calls;

beforeEach(() => {
  localStorage.setItem('OPEN_QUESTION_LOG_LEVEL', 'off');
  calls = [];
  routes = {};
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${new URL(url, 'http://localhost').pathname}`;
    calls.push({ key, body: init.body });
    if (!routes[key]) throw new Error(`unexpected request: ${key}`);
    const [status, body] = await routes[key](init);
    return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A promise this test resolves by hand, so a write can sit in flight. */
function deferred() {
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  return { promise, settle };
}

const button = (within, text) => {
  const found = within.findAll('button').find((b) => b.text() === text);
  if (!found) throw new Error(`no "${text}" button`);
  return found;
};

const rows = (wrapper) => wrapper.findAll('.oq-item');

const rowFor = (wrapper, text) => {
  const found = rows(wrapper).find((r) => r.find('.oq-text').exists() && r.get('.oq-text').text() === text);
  if (!found) throw new Error(`no row reading "${text}"`);
  return found;
};

const addField = (wrapper) => wrapper.get('.oq-new');
const addButton = (wrapper) => wrapper.get('.oq-add button');

const mountHeader = (rowsIn = [], props = {}) =>
  mount(EntityHeader, { props: { entity: entityWith(rowsIn), ...props } });

/** Opens the inline editor on a row and types `text` into it. */
async function typeInEditor(wrapper, rowText, text) {
  await rowFor(wrapper, rowText).get('button[title="Edit question"]').trigger('click');
  await wrapper.get('.oq-edit').setValue(text);
}

describe('EntityHeader open questions — seeding', () => {
  it('seeds the rows the entity arrived with and counts only the unanswered', async () => {
    const wrapper = mountHeader([WHO, ANSWERED]);
    await flushPromises();

    expect(rows(wrapper).map((r) => r.get('.oq-text').text()))
      .toEqual([WHO.question, ANSWERED.question]);
    expect(wrapper.get('.oq-count').text()).toBe('1');
    expect(addField(wrapper).element.value).toBe('');
    expect(calls).toEqual([]);                 // the rows arrive populated; nothing is fetched
  });

  it('re-seeds the rows from the incoming entity', async () => {
    const wrapper = mountHeader([WHO]);
    await wrapper.setProps({ entity: entityWith([WHO, WHERE]) });

    expect(rows(wrapper).map((r) => r.get('.oq-text').text()))
      .toEqual([WHO.question, WHERE.question]);
  });
});

describe('EntityHeader open questions — a re-seed under the reader (KOL-117)', () => {
  /**
   * Falsification: put `newQuestion.value = ''` back in the watcher and the
   * typed question is gone by the time the reader presses Add.
   */
  it('keeps the text typed into "Add a question"', async () => {
    const wrapper = mountHeader([WHO]);
    await addField(wrapper).setValue('Who signs the orders?');

    await wrapper.setProps({ entity: entityWith([WHO, WHERE]) });

    expect(addField(wrapper).element.value).toBe('Who signs the orders?');
    expect(addButton(wrapper).element.disabled).toBe(false);
    expect(rows(wrapper)).toHaveLength(2);
  });

  /**
   * Falsification: put `editingId.value = null` back and the editor closes
   * mid-sentence, dropping the rewrite.
   */
  it('keeps an open editor and its typed text while that row is still on the list', async () => {
    const wrapper = mountHeader([WHO, WHERE]);
    await typeInEditor(wrapper, WHO.question, 'Who built the very first engine?');

    await wrapper.setProps({ entity: entityWith([WHO, WHERE, ANSWERED]) });

    expect(wrapper.get('.oq-edit').element.value).toBe('Who built the very first engine?');
    expect(rows(wrapper)).toHaveLength(3);
  });

  it('closes the editor when the re-seeded list no longer holds that row', async () => {
    const wrapper = mountHeader([WHO, WHERE]);
    await typeInEditor(wrapper, WHO.question, 'Who built the very first engine?');

    // Somebody else deleted the question being edited; there is nothing left to
    // save the typed text to.
    await wrapper.setProps({ entity: entityWith([WHERE]) });

    expect(wrapper.find('.oq-edit').exists()).toBe(false);
    expect(rows(wrapper).map((r) => r.get('.oq-text').text())).toEqual([WHERE.question]);
  });

  it('drops a delete confirmation: the row it asked about has just changed', async () => {
    const wrapper = mountHeader([WHO]);
    await rowFor(wrapper, WHO.question).get('button[title="Delete question"]').trigger('click');
    expect(wrapper.find('.oq-confirm').exists()).toBe(true);

    await wrapper.setProps({ entity: entityWith([WHO]) });

    expect(wrapper.find('.oq-confirm').exists()).toBe(false);
    expect(rowFor(wrapper, WHO.question).find('button[title="Delete question"]').exists()).toBe(true);
  });

  /**
   * Falsification: put `pendingId.value = null` back and the re-enabled Save
   * lets a second `PUT` go out while the first is still unanswered.
   */
  it('leaves a row disabled while its own write is in flight, and settles on the answer', async () => {
    const put = deferred();
    routes['PUT /open-questions/oq-who'] = () => put.promise;

    const wrapper = mountHeader([WHO]);
    await typeInEditor(wrapper, WHO.question, 'Who built the very first engine?');
    await button(wrapper, 'Save').trigger('click');
    expect(button(wrapper, 'Save').element.disabled).toBe(true);

    await wrapper.setProps({ entity: entityWith([WHO, WHERE]) });

    expect(button(wrapper, 'Save').element.disabled).toBe(true);
    expect(wrapper.get('.oq-badge-btn').element.disabled).toBe(true);
    expect(calls.filter((c) => c.key === 'PUT /open-questions/oq-who')).toHaveLength(1);

    put.settle([200, { ...WHO, question: 'Who built the very first engine?' }]);
    await flushPromises();

    expect(wrapper.find('.oq-edit').exists()).toBe(false);
    expect(rows(wrapper).map((r) => r.get('.oq-text').text()))
      .toEqual(['Who built the very first engine?', WHERE.question]);
    expect(wrapper.get('.oq-badge-btn').element.disabled).toBe(false);
  });

  /**
   * The re-seed that answers an open-question frame can already carry the
   * question this POST is still waiting for, because the panel refetches the
   * entity from the server. The answer must not list it a second time.
   */
  it('leaves an in-flight add pending, and does not list its answer twice', async () => {
    const post = deferred();
    routes['POST /open-questions'] = () => post.promise;

    const wrapper = mountHeader([WHO]);
    await addField(wrapper).setValue(WHERE.question);
    await wrapper.get('form.oq-add').trigger('submit');
    expect(addButton(wrapper).element.disabled).toBe(true);
    expect(addButton(wrapper).text()).toBe('Adding…');

    await wrapper.setProps({ entity: entityWith([WHO, WHERE]) });
    // `Adding…` and not merely a disabled button: an empty field disables it
    // too, so the label is what says the add itself is still unanswered.
    expect(addButton(wrapper).text()).toBe('Adding…');
    expect(addButton(wrapper).element.disabled).toBe(true);

    post.settle([201, { ...WHERE }]);
    await flushPromises();

    expect(rows(wrapper).map((r) => r.get('.oq-text').text()))
      .toEqual([WHO.question, WHERE.question]);
    expect(addField(wrapper).element.value).toBe('');
    expect(addButton(wrapper).element.disabled).toBe(true);   // the field is empty again
  });
});

describe('EntityHeader open questions — another entity in the panel', () => {
  it('keeps nothing: the typed text and the editor were for the section that left', async () => {
    const wrapper = mountHeader([WHO, WHERE]);
    await typeInEditor(wrapper, WHO.question, 'Who built the very first engine?');
    await addField(wrapper).setValue('Who signs the orders?');

    await wrapper.setProps({ entity: entityWith([ANSWERED], 'ent-caboose') });

    expect(wrapper.find('.oq-edit').exists()).toBe(false);
    expect(addField(wrapper).element.value).toBe('');
    expect(rows(wrapper).map((r) => r.get('.oq-text').text())).toEqual([ANSWERED.question]);
  });

  it('does not list a created question on the entity the panel moved on to', async () => {
    const post = deferred();
    routes['POST /open-questions'] = () => post.promise;

    const wrapper = mountHeader([WHO]);
    await addField(wrapper).setValue(WHERE.question);
    await wrapper.get('form.oq-add').trigger('submit');
    expect(JSON.parse(calls.at(-1).body).entry_ids).toEqual(['ent-brakeman']);

    await wrapper.setProps({ entity: entityWith([ANSWERED], 'ent-caboose') });
    post.settle([201, { ...WHERE }]);
    await flushPromises();

    // Written against the brakeman, so it belongs to the brakeman's list.
    expect(rows(wrapper).map((r) => r.get('.oq-text').text())).toEqual([ANSWERED.question]);
    expect(addButton(wrapper).element.disabled).toBe(true);
  });
});

describe('EntityHeader open questions — logging', () => {
  it('says what the re-seed kept and what it dropped, at light tier', async () => {
    localStorage.setItem('OPEN_QUESTION_LOG_LEVEL', 'light');
    const logged = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));

    const wrapper = mountHeader([WHO, WHERE]);
    await typeInEditor(wrapper, WHO.question, 'Who built the very first engine?');
    await addField(wrapper).setValue('Who signs the orders?');
    await rowFor(wrapper, WHERE.question).get('button[title="Delete question"]').trigger('click');
    logged.length = 0;

    await wrapper.setProps({ entity: entityWith([WHO]) });

    const line = logged.find((l) => l.includes('re-seeded'));
    expect(line).toBeTruthy();
    expect(line).toContain('[openQuestions:light]');
    expect(line).toContain('re-seeded 1 question(s) for ent-brakeman');
    expect(line).toContain('(source: entity.open_questions)');
    expect(line).toContain('kept the "Add a question" text');
    expect(line).toContain(`dropped the delete confirmation on ${WHERE._id}`);
  });
});

/**
 * The header's own Edit, under the role gate (KOL-150).
 *
 * `canWrite` already hid every open-question control; the pencil beside the entity type was gated on
 * nothing, so a `viewer` — whose `PUT /entities/:id` the server refuses with
 * `403 NOT_WORKSPACE_EDITOR` — was offered the form that saves the title, the type, the summary and
 * the tags, and found out by pressing Save. The flag now covers both.
 *
 * Falsification: drop the `v-if` on the pencil and the read-only case fails on the editor it opens.
 */
describe('EntityHeader write controls', () => {
  const pencil = (wrapper) => wrapper.find('button[title="Edit header"]');

  it('offers Edit when the entity can be written', async () => {
    const wrapper = mountHeader([WHO]);
    await flushPromises();

    expect(pencil(wrapper).exists()).toBe(true);

    await pencil(wrapper).trigger('click');
    expect(wrapper.get('input.edit-title').element.value).toBe('The Brakeman');
  });

  it('offers no Edit when it cannot, and still shows what the form would have edited', async () => {
    const wrapper = mountHeader([WHO], { canWrite: false });
    await flushPromises();

    expect(pencil(wrapper).exists()).toBe(false);
    expect(wrapper.find('input.edit-title').exists()).toBe(false);
    // The header is a read either way: title, type, summary and the question itself.
    expect(wrapper.get('.entity-title').text()).toBe('The Brakeman');
    expect(wrapper.get('.entity-cat').text()).toBe('Characters');
    expect(wrapper.get('.entity-summary').text()).toBe('fixture');
    expect(rows(wrapper).map((r) => r.get('.oq-text').text())).toEqual([WHO.question]);
    expect(calls).toEqual([]);
  });
});

/**
 * The header's own form, against a save the server refused (KOL-156).
 *
 * `await emit('save', …)` awaited `undefined` — Vue's `emit` returns no handler
 * result — so the form closed in the same tick the request was sent. A refusal
 * (a role that answered `viewer` after the first paint, a 409 on the title, a
 * 400 from the block validator over the blocks sent with it) then arrived as a
 * toast over a header that had already reverted to the stored title, type,
 * summary and tags. The page's save is a function prop now, it reports whether
 * the entity was written, and nothing less than `true` closes the form.
 *
 * The open-question writes above are a different path — their own routes, and
 * they already kept a refused row's text where it was typed (KOL-104).
 *
 * Falsification: close the form unconditionally after the await and the refused
 * case fails on the title it no longer holds.
 */
describe('EntityHeader editor against a refused save', () => {
  const pencil = (wrapper) => wrapper.get('button[title="Edit header"]');
  const saveButton = (wrapper) => wrapper.get('.edit-actions .primary');
  const editing = (wrapper) => wrapper.find('.header-edit').exists();

  /** Opens the form and rewrites every field in it. */
  async function rewrite(onSave) {
    localStorage.setItem('INLINE_EDIT_LOG_LEVEL', 'off');
    const wrapper = mount(EntityHeader, { props: { entity: entityWith([WHO]), onSave } });
    await flushPromises();
    await pencil(wrapper).trigger('click');
    await wrapper.get('input.edit-title').setValue('The Brakewoman');
    await wrapper.get('input[placeholder="Summary"]').setValue('Rewritten, and not yet saved.');
    await wrapper.get('input[placeholder="Tags (comma separated)"]').setValue('crew, brakes');
    return wrapper;
  }

  it('sends the whole header and keeps the form, and what was typed in it, when the write is refused', async () => {
    const onSave = vi.fn(async () => false);
    const wrapper = await rewrite(onSave);

    await saveButton(wrapper).trigger('click');
    await flushPromises();

    expect(onSave).toHaveBeenCalledWith({
      title: 'The Brakewoman',
      category: 'Characters',
      summary: 'Rewritten, and not yet saved.',
      tags: ['crew', 'brakes'],
    });

    expect(editing(wrapper)).toBe(true);
    expect(wrapper.get('input.edit-title').element.value).toBe('The Brakewoman');
    expect(wrapper.get('input[placeholder="Summary"]').element.value).toBe('Rewritten, and not yet saved.');
    expect(wrapper.get('input[placeholder="Tags (comma separated)"]').element.value).toBe('crew, brakes');
    // Nothing of the stored header is on screen to be mistaken for a save.
    expect(wrapper.find('.entity-title').exists()).toBe(false);
    // And Save works again rather than spinning on a finished request.
    expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();
    expect(calls).toEqual([]);                 // the header's save is not an open-question route
  });

  it('closes the form when the write lands', async () => {
    const wrapper = await rewrite(vi.fn(async () => true));

    await saveButton(wrapper).trigger('click');
    await flushPromises();

    expect(editing(wrapper)).toBe(false);
    // The read is back — of the entity as it stands, which the page replaces
    // with the server's answer to the write just made.
    expect(wrapper.get('.entity-title').text()).toBe('The Brakeman');
  });

  it('holds the form open while the write is in flight', async () => {
    const { promise, settle } = deferred();
    const wrapper = await rewrite(() => promise);

    await saveButton(wrapper).trigger('click');
    await flushPromises();

    expect(editing(wrapper)).toBe(true);
    expect(saveButton(wrapper).attributes('disabled')).toBeDefined();
    expect(wrapper.find('.edit-actions .spinner').exists()).toBe(true);

    settle(true);
    await flushPromises();
    expect(editing(wrapper)).toBe(false);
  });

  it('keeps what was typed when nothing is listening for the save', async () => {
    const wrapper = await rewrite(undefined);

    await saveButton(wrapper).trigger('click');
    await flushPromises();

    expect(editing(wrapper)).toBe(true);
    expect(wrapper.get('input.edit-title').element.value).toBe('The Brakewoman');
  });
});
