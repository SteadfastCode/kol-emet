/**
 * The workspace-wide open-question panel (KOL-152).
 *
 * `GET /open-questions` has answered the whole workspace's questions newest-first, with `?status=`
 * and a bare-id cursor, since KOL-092, and `getOpenQuestionPage` has wrapped it since KOL-104 with
 * no caller at all — questions were reachable one entity at a time. What is pinned here is the
 * four properties that view has to have and that no server test can see:
 *
 *   The pages **add up**. A list built by concatenation can paint only the first page, repeat a
 *   row across the boundary or drop one, and every symptom reads as "that question is not in the
 *   workspace".
 *
 *   The status pills **re-query the route**. The route filters by status; a filter applied to the
 *   rows already here would answer "the open questions among the pages this tab happens to hold",
 *   which is a different sentence — and wrong as soon as the walk is still running.
 *
 *   A `question:*` frame **moves the list without a request**. KOL-116's payload carries the row
 *   and its links precisely so a listener does not have to refetch, and a refetch here would be a
 *   walk of the whole collection per frame.
 *
 *   A **viewer** gets no resolve control: `PUT /open-questions/:id` is refused for them with
 *   403 NOT_WORKSPACE_EDITOR (KOL-150).
 *
 * Falsification: return only the last page from the walk and the first case fails; filter `rows`
 * in the template instead of reloading and the pill cases fail (the second asserts the request,
 * the third that no row was filtered out of a page the server already narrowed); call `load` from
 * `applyFrame` and the frame cases fail on the request they did not need.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import OpenQuestionPanel from './OpenQuestionPanel.vue';

const { getOpenQuestionPage, setOpenQuestionStatus } = vi.hoisted(() => ({
  getOpenQuestionPage: vi.fn(),
  setOpenQuestionStatus: vi.fn(),
}));
vi.mock('../api/openQuestions.js', () => ({
  QUESTION_PAGE_SIZE: 200,
  getOpenQuestionPage,
  setOpenQuestionStatus,
  getOpenQuestion: vi.fn(),
  createOpenQuestion: vi.fn(),
  renameOpenQuestion: vi.fn(),
  setOpenQuestionEntries: vi.fn(),
  deleteOpenQuestion: vi.fn(),
}));

/**
 * What the route answers: `entry_ids` populated with `title` and `category`
 * (`lib/scopedPopulate.js`), and `_id` descending — newest first.
 */
const question = (id, text, status = 'open', entities = [{ _id: 'e1', title: 'Boiler Room', category: 'Worlds' }]) => ({
  _id: id, question: text, status, entry_ids: entities,
  createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z',
});

const PAGE_1 = [
  question('q1', 'Who stokes the boiler?'),
  question('q2', 'How fast does the train run?', 'open', [{ _id: 'e2', title: 'Alder Street', category: 'Worlds' }]),
];
const PAGE_2 = [question('q3', 'Where does the northern line end?')];

const ENTITIES = [
  { _id: 'e1', title: 'Boiler Room', category: 'Worlds' },
  { _id: 'e2', title: 'Alder Street', category: 'Worlds' },
  { _id: 'e9', title: 'Coupling Rod', category: 'Lore & Mechanics' },
];

const open = (props = {}) => mount(OpenQuestionPanel, { props: { entities: ENTITIES, ...props } });

const texts = (wrapper) => wrapper.findAll('.oq-question').map((q) => q.text());
const statuses = (wrapper) => wrapper.findAll('.oq-status').map((s) => s.text());
const pill = (wrapper, label) => wrapper.findAll('.oq-pill').find((p) => p.text() === label);

beforeEach(() => {
  // The panel logs every frame and every write at the light tier by default. Off here: these
  // cases assert the list, not the console.
  localStorage.setItem('OPEN_QUESTION_PANEL_LOG_LEVEL', 'off');
  getOpenQuestionPage.mockReset();
  setOpenQuestionStatus.mockReset();
});

describe('OpenQuestionPanel paging', () => {
  it('ends a two-page walk with every question listed once, in the order the route sent them', async () => {
    getOpenQuestionPage
      .mockResolvedValueOnce({ items: PAGE_1, nextAfter: 'q2' })
      .mockResolvedValueOnce({ items: PAGE_2, nextAfter: null });

    const wrapper = open();
    await flushPromises();

    expect(texts(wrapper)).toEqual([
      'Who stokes the boiler?',
      'How fast does the train run?',
      'Where does the northern line end?',
    ]);
    expect(getOpenQuestionPage).toHaveBeenCalledTimes(2);
    // The first request asks for no status at all, and the second sends the first page's cursor
    // back verbatim — a bare id, which is this route's whole sort key.
    expect(getOpenQuestionPage.mock.calls[0][0]).toEqual({ status: null, limit: 200, after: null });
    expect(getOpenQuestionPage.mock.calls[1][0]).toEqual({ status: null, limit: 200, after: 'q2' });
  });

  it('paints the first page while the rest is still arriving, and appends the second at the end', async () => {
    let releasePage2;
    getOpenQuestionPage
      .mockResolvedValueOnce({ items: PAGE_1, nextAfter: 'q2' })
      .mockReturnValueOnce(new Promise((resolve) => { releasePage2 = resolve; }));

    const wrapper = open();
    await flushPromises();

    // Page 2 has not resolved: this is the panel mid-walk — rows, not "Loading…".
    expect(texts(wrapper)).toEqual(['Who stokes the boiler?', 'How fast does the train run?']);
    expect(wrapper.find('.oq-empty').exists()).toBe(false);

    releasePage2({ items: PAGE_2, nextAfter: null });
    await flushPromises();

    expect(texts(wrapper)).toEqual([
      'Who stokes the boiler?',
      'How fast does the train run?',
      'Where does the northern line end?',
    ]);
    // Nothing repeated and nothing dropped across the boundary.
    expect(wrapper.findAll('.oq-row')).toHaveLength(3);
  });

  it('keeps the questions that arrived when a page fails, says so, and finishes on the retry', async () => {
    getOpenQuestionPage
      .mockResolvedValueOnce({ items: PAGE_1, nextAfter: 'q2' })
      .mockRejectedValueOnce(Object.assign(new Error('500 Internal Server Error'), { status: 500 }));

    const wrapper = open();
    await flushPromises();

    expect(texts(wrapper)).toEqual(['Who stokes the boiler?', 'How fast does the train run?']);
    const notice = wrapper.get('.oq-load-failed').text();
    expect(notice).toContain('could not be loaded');
    expect(notice).toContain('Showing 2 questions');

    getOpenQuestionPage
      .mockResolvedValueOnce({ items: PAGE_1, nextAfter: 'q2' })
      .mockResolvedValueOnce({ items: PAGE_2, nextAfter: null });

    await wrapper.get('.oq-load-failed button').trigger('click');
    await flushPromises();

    expect(texts(wrapper)).toHaveLength(3);
    expect(wrapper.find('.oq-load-failed').exists()).toBe(false);
  });

  it('takes the bare array an API from before the page cap answers with', async () => {
    // The client and the API deploy independently, so this build can be talking to an older one.
    getOpenQuestionPage.mockResolvedValueOnce([...PAGE_1, ...PAGE_2]);

    const wrapper = open();
    await flushPromises();

    expect(texts(wrapper)).toHaveLength(3);
    expect(getOpenQuestionPage).toHaveBeenCalledTimes(1);
  });
});

describe('OpenQuestionPanel status filter', () => {
  it('asks the route again instead of narrowing the page already in the browser', async () => {
    getOpenQuestionPage.mockResolvedValueOnce({ items: PAGE_1, nextAfter: null });
    const wrapper = open();
    await flushPromises();
    expect(texts(wrapper)).toHaveLength(2);

    // The server's answer to `?status=resolved` — a question that was never in the list above.
    getOpenQuestionPage.mockResolvedValueOnce({
      items: [question('q7', 'Does the line reach the coast?', 'resolved')],
      nextAfter: null,
    });

    await pill(wrapper, 'Resolved').trigger('click');
    await flushPromises();

    // A second request, carrying the filter — not a filter applied to what was already here.
    expect(getOpenQuestionPage).toHaveBeenCalledTimes(2);
    expect(getOpenQuestionPage.mock.calls[1][0]).toEqual({ status: 'resolved', limit: 200, after: null });
    // And the rows are the server's answer, which a browser-side filter over the first two could
    // never have produced.
    expect(texts(wrapper)).toEqual(['Does the line reach the coast?']);
  });

  it('shows every row the route sent for a filter, without re-checking their status itself', async () => {
    // A filter re-applied here would be a second copy of the route's rule, free to disagree with
    // it. So a page answered for `?status=open` is listed as it arrived.
    getOpenQuestionPage.mockResolvedValueOnce({ items: PAGE_1, nextAfter: null });
    const wrapper = open();
    await flushPromises();

    getOpenQuestionPage.mockResolvedValueOnce({
      items: [question('q1', 'Who stokes the boiler?'), question('q8', 'Who drives it?', 'resolved')],
      nextAfter: null,
    });
    await pill(wrapper, 'Open').trigger('click');
    await flushPromises();

    expect(texts(wrapper)).toEqual(['Who stokes the boiler?', 'Who drives it?']);
  });

  it('does not re-query when the pill that is already down is pressed again', async () => {
    getOpenQuestionPage.mockResolvedValue({ items: PAGE_1, nextAfter: null });
    const wrapper = open();
    await flushPromises();

    await pill(wrapper, 'All').trigger('click');
    await flushPromises();

    expect(getOpenQuestionPage).toHaveBeenCalledTimes(1);
  });

  it('offers to clear a filter that matched nothing, rather than reading as an empty workspace', async () => {
    getOpenQuestionPage.mockResolvedValueOnce({ items: PAGE_1, nextAfter: null });
    const wrapper = open();
    await flushPromises();

    getOpenQuestionPage.mockResolvedValueOnce({ items: [], nextAfter: null });
    await pill(wrapper, 'Resolved').trigger('click');
    await flushPromises();

    expect(wrapper.get('.oq-empty-title').text()).toBe('No resolved questions');

    getOpenQuestionPage.mockResolvedValueOnce({ items: PAGE_1, nextAfter: null });
    await wrapper.get('.oq-empty button').trigger('click');
    await flushPromises();

    expect(getOpenQuestionPage.mock.calls.at(-1)[0]).toEqual({ status: null, limit: 200, after: null });
    expect(texts(wrapper)).toHaveLength(2);
  });
});

describe('OpenQuestionPanel empty workspace', () => {
  it('reads as an empty state, not an empty list', async () => {
    getOpenQuestionPage.mockResolvedValueOnce({ items: [], nextAfter: null });

    const wrapper = open();
    await flushPromises();

    expect(wrapper.findAll('.oq-row')).toHaveLength(0);
    expect(wrapper.get('.oq-empty-title').text()).toBe('Nothing unanswered here');
    // It says what would put a question here — from an entity, or from an AI client.
    expect(wrapper.get('.oq-empty-body').text()).toMatch(/entity/i);
    // And it is not the filtered nothing: there is no filter to clear.
    expect(wrapper.find('.oq-empty button').exists()).toBe(false);
  });
});

describe('OpenQuestionPanel rows', () => {
  it('opens the entity a question is attached to', async () => {
    getOpenQuestionPage.mockResolvedValueOnce({ items: PAGE_1, nextAfter: null });
    const wrapper = open();
    await flushPromises();

    await wrapper.findAll('.oq-question')[1].trigger('click');

    expect(wrapper.emitted('open-entry')).toEqual([['e2', 'Alder Street']]);
  });

  it('names every entity a question is attached to, each its own way in', async () => {
    getOpenQuestionPage.mockResolvedValueOnce({
      items: [question('q4', 'Which of them owns the shed?', 'open', [
        { _id: 'e1', title: 'Boiler Room', category: 'Worlds' },
        { _id: 'e9', title: 'Coupling Rod', category: 'Lore & Mechanics' },
      ])],
      nextAfter: null,
    });
    const wrapper = open();
    await flushPromises();

    const chips = wrapper.findAll('.oq-entity');
    expect(chips.map((c) => c.text())).toEqual(['Boiler Room', 'Coupling Rod']);

    await chips[1].trigger('click');
    expect(wrapper.emitted('open-entry')).toEqual([['e9', 'Coupling Rod']]);
  });

  it('says so when a question is attached to no entity at all', async () => {
    // `POST /open-questions` takes an empty `entry_ids`, and the server drops ids outside the
    // workspace — so this row exists, and this panel is the only place it is visible.
    getOpenQuestionPage.mockResolvedValueOnce({
      items: [question('q5', 'Whose idea was the second engine?', 'open', [])],
      nextAfter: null,
    });
    const wrapper = open();
    await flushPromises();

    expect(wrapper.get('.oq-unattached').text()).toMatch(/not attached/i);
    expect(wrapper.find('.oq-entity').exists()).toBe(false);
    // Nothing to open, so the question is text rather than a button.
    await wrapper.get('.oq-question').trigger('click');
    expect(wrapper.emitted('open-entry')).toBeUndefined();
  });
});

describe('OpenQuestionPanel resolve and reopen', () => {
  it('writes status alone and shows what came back', async () => {
    getOpenQuestionPage.mockResolvedValueOnce({ items: PAGE_1, nextAfter: null });
    setOpenQuestionStatus.mockResolvedValueOnce(question('q1', 'Who stokes the boiler?', 'resolved'));
    const wrapper = open();
    await flushPromises();

    await wrapper.findAll('.oq-status-btn')[0].trigger('click');
    await flushPromises();

    expect(setOpenQuestionStatus).toHaveBeenCalledWith('q1', 'resolved');
    expect(statuses(wrapper)).toEqual(['resolved', 'open']);
    // In place: the other row is untouched and nothing was refetched.
    expect(texts(wrapper)).toHaveLength(2);
    expect(getOpenQuestionPage).toHaveBeenCalledTimes(1);
  });

  it('reopens a resolved question', async () => {
    getOpenQuestionPage.mockResolvedValueOnce({
      items: [question('q7', 'Does the line reach the coast?', 'resolved')], nextAfter: null,
    });
    setOpenQuestionStatus.mockResolvedValueOnce(question('q7', 'Does the line reach the coast?', 'open'));
    const wrapper = open();
    await flushPromises();

    await wrapper.get('.oq-status-btn').trigger('click');
    await flushPromises();

    expect(setOpenQuestionStatus).toHaveBeenCalledWith('q7', 'open');
    expect(statuses(wrapper)).toEqual(['open']);
  });

  it('drops a row that the filter on screen no longer matches', async () => {
    getOpenQuestionPage.mockResolvedValueOnce({ items: PAGE_1, nextAfter: null });
    const wrapper = open();
    await flushPromises();
    getOpenQuestionPage.mockResolvedValueOnce({ items: PAGE_1, nextAfter: null });
    await pill(wrapper, 'Open').trigger('click');
    await flushPromises();

    setOpenQuestionStatus.mockResolvedValueOnce(question('q1', 'Who stokes the boiler?', 'resolved'));
    await wrapper.findAll('.oq-status-btn')[0].trigger('click');
    await flushPromises();

    // An "Open" list is the answer to `?status=open`, and this question is no longer part of it.
    expect(texts(wrapper)).toEqual(['How fast does the train run?']);
    expect(getOpenQuestionPage).toHaveBeenCalledTimes(2);
  });

  it('keeps the rows on screen when a write is refused, and says what the server said', async () => {
    getOpenQuestionPage.mockResolvedValueOnce({ items: PAGE_1, nextAfter: null });
    setOpenQuestionStatus.mockRejectedValueOnce(
      Object.assign(new Error('NOT_WORKSPACE_EDITOR'), { status: 403 }),
    );
    const wrapper = open();
    await flushPromises();

    await wrapper.findAll('.oq-status-btn')[0].trigger('click');
    await flushPromises();

    expect(wrapper.get('.oq-error').text()).toContain('NOT_WORKSPACE_EDITOR');
    // Above the list, not instead of it: the row is where the retry is.
    expect(texts(wrapper)).toHaveLength(2);
    expect(statuses(wrapper)).toEqual(['open', 'open']);
  });

  it('gives a viewer no resolve control at all', async () => {
    getOpenQuestionPage.mockResolvedValueOnce({ items: PAGE_1, nextAfter: null });
    const wrapper = open({ canWrite: false });
    await flushPromises();

    // The status is still readable — that is the point of the list — but there is nothing to
    // press: `PUT /open-questions/:id` is refused for a viewer with 403 NOT_WORKSPACE_EDITOR.
    expect(statuses(wrapper)).toEqual(['open', 'open']);
    expect(wrapper.find('.oq-status-btn').exists()).toBe(false);
    // And the rows still open their entities: nothing that reads is gated.
    await wrapper.findAll('.oq-question')[0].trigger('click');
    expect(wrapper.emitted('open-entry')).toEqual([['e1', 'Boiler Room']]);
  });
});

/**
 * The three `question:*` frames (KOL-116), handed in by the layout. The payload carries the row
 * *and* the bare ids it links to, which is exactly enough to move the list without a request —
 * and a refetch here would be a walk of the whole collection per frame.
 */
describe('OpenQuestionPanel live frames', () => {
  const panel = async (items = PAGE_1, props = {}) => {
    getOpenQuestionPage.mockResolvedValueOnce({ items, nextAfter: null });
    const wrapper = open(props);
    await flushPromises();
    getOpenQuestionPage.mockClear();
    return wrapper;
  };

  it('moves a row on question:updated, with no refetch', async () => {
    const wrapper = await panel();

    wrapper.vm.applyFrame('question:updated', {
      question: { _id: 'q1', question: 'Who stokes the boiler, exactly?', status: 'resolved' },
      entry_ids: ['e1'],
    });
    await wrapper.vm.$nextTick();

    expect(texts(wrapper)).toEqual(['Who stokes the boiler, exactly?', 'How fast does the train run?']);
    expect(statuses(wrapper)).toEqual(['resolved', 'open']);
    // The frame's `entry_ids` are bare ids; the entity is named from the list the layout holds.
    expect(wrapper.findAll('.oq-entity')[0].text()).toBe('Boiler Room');
    expect(getOpenQuestionPage).not.toHaveBeenCalled();
  });

  it('removes a row on question:deleted, with no refetch', async () => {
    const wrapper = await panel();

    wrapper.vm.applyFrame('question:deleted', {
      questionId: 'q2',
      question: { _id: 'q2', question: 'How fast does the train run?', status: 'open' },
      entry_ids: [],
    });
    await wrapper.vm.$nextTick();

    expect(texts(wrapper)).toEqual(['Who stokes the boiler?']);
    expect(getOpenQuestionPage).not.toHaveBeenCalled();
  });

  it('puts a question created elsewhere at the top, where the route would have it', async () => {
    const wrapper = await panel();

    wrapper.vm.applyFrame('question:created', {
      question: { _id: 'q9', question: 'And who signs for the coal?', status: 'open' },
      entry_ids: ['e9'],
    });
    await wrapper.vm.$nextTick();

    // Newest first: `_id` descending is this route's sort, and a new `_id` is the largest.
    expect(texts(wrapper)[0]).toBe('And who signs for the coal?');
    expect(wrapper.findAll('.oq-row')).toHaveLength(3);
    expect(getOpenQuestionPage).not.toHaveBeenCalled();
  });

  it('applies a frame against the filter on screen: a resolve leaves an Open list', async () => {
    const wrapper = await panel();
    getOpenQuestionPage.mockResolvedValueOnce({ items: PAGE_1, nextAfter: null });
    await pill(wrapper, 'Open').trigger('click');
    await flushPromises();
    getOpenQuestionPage.mockClear();

    wrapper.vm.applyFrame('question:updated', {
      question: { _id: 'q1', question: 'Who stokes the boiler?', status: 'resolved' },
      entry_ids: ['e1'],
    });
    await wrapper.vm.$nextTick();

    expect(texts(wrapper)).toEqual(['How fast does the train run?']);
    expect(getOpenQuestionPage).not.toHaveBeenCalled();
  });

  it('and a reopen elsewhere joins it', async () => {
    const wrapper = await panel([question('q2', 'How fast does the train run?')]);
    getOpenQuestionPage.mockResolvedValueOnce({ items: [question('q2', 'How fast does the train run?')], nextAfter: null });
    await pill(wrapper, 'Open').trigger('click');
    await flushPromises();
    getOpenQuestionPage.mockClear();

    wrapper.vm.applyFrame('question:updated', {
      question: { _id: 'q7', question: 'Does the line reach the coast?', status: 'open' },
      entry_ids: ['e1'],
    });
    await wrapper.vm.$nextTick();

    expect(texts(wrapper)).toEqual(['Does the line reach the coast?', 'How fast does the train run?']);
    expect(getOpenQuestionPage).not.toHaveBeenCalled();
  });

  it('ignores a frame about a question outside the filter it does not hold', async () => {
    const wrapper = await panel();
    getOpenQuestionPage.mockResolvedValueOnce({ items: PAGE_1, nextAfter: null });
    await pill(wrapper, 'Open').trigger('click');
    await flushPromises();

    wrapper.vm.applyFrame('question:updated', {
      question: { _id: 'q7', question: 'Does the line reach the coast?', status: 'resolved' },
      entry_ids: ['e1'],
    });
    wrapper.vm.applyFrame('question:deleted', { questionId: 'q7', entry_ids: [] });
    await wrapper.vm.$nextTick();

    expect(texts(wrapper)).toEqual(['Who stokes the boiler?', 'How fast does the train run?']);
  });

  it('names an entity the sidebar has not loaded rather than dropping the way in to it', async () => {
    const wrapper = await panel(PAGE_1, { entities: [] });

    wrapper.vm.applyFrame('question:created', {
      question: { _id: 'q9', question: 'And who signs for the coal?', status: 'open' },
      entry_ids: ['e-unknown'],
    });
    await wrapper.vm.$nextTick();

    const chip = wrapper.findAll('.oq-entity')[0];
    expect(chip.text()).toBe('An entity');
    await chip.trigger('click');
    expect(wrapper.emitted('open-entry')).toEqual([['e-unknown', 'An entity']]);
  });
});
