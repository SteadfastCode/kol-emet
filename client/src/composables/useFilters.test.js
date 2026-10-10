/**
 * The search box asks the server; the pills stay in the browser (KOL-068).
 *
 * `useFilters` used to search the loaded list over `title`, `summary` and
 * `tags`, which left block markdown — the field a wiki keeps its content in,
 * and one the list route does not even send — unsearchable from the UI. The
 * keyword now goes to `GET /entities?q=`, which matches block markdown too, and
 * the result set is what the category and tag pills narrow.
 *
 * That makes the sidebar's contents depend on a debounced, raced, failable
 * request, and none of those steps is visible on screen: a row that should be
 * listed and is not looks identical whichever of them dropped it. So each one
 * is pinned here, over an injected request this file controls.
 *
 * Falsification: drop the `setTimeout` and the debounce case sees one request
 * per keystroke; drop the `seq !== latest` guard and the overtaken case ends on
 * the stale rows; assign `searchResults` in the `catch` and the failure case
 * empties the sidebar; filter `entries` instead of `searched` and the pill case
 * loses the rows the server found.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { SEARCH_DEBOUNCE_MS, useFilters } from './useFilters.js';
import { useToasts } from './useToasts.js';

const row = (id, title, { category = 'Worlds', summary = `${title}.`, tags = [] } = {}) =>
  ({ _id: id, title, category, summary, tags });

/** The loaded list: what the paged load has put in the browser. */
const LOADED = [
  row('e1', 'Boiler Room', { summary: 'Where the pressure comes from.', tags: ['engine'] }),
  row('e2', 'Alder Street', { category: 'Characters', summary: 'A stop on the northern line.', tags: ['stations'] }),
];

/**
 * A server answer. `Coupling Rod` is the point of the feature: the term is in
 * neither its title nor its summary, so the server matched it inside a block
 * and the browser can only know that by elimination.
 */
const SERVER_ROWS = [
  row('e1', 'Boiler Room', { summary: 'Where the pressure comes from.', tags: ['engine'] }),
  row('e3', 'Coupling Rod', { category: 'Characters', summary: 'Holds the wheels in step.', tags: [] }),
];

const titles = (list) => list.map((e) => e.title);

/** A promise plus the handle to settle it, so a request can be left in flight. */
function pending() {
  let settle;
  const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  return { promise, ...settle };
}

let entries;
let search;

beforeEach(() => {
  localStorage.setItem('SEARCH_LOG_LEVEL', 'off');
  vi.useFakeTimers();
  entries = ref(LOADED.map((e) => ({ ...e })));
  search = vi.fn();
  // Module-level state, shared with every other suite in the run.
  useToasts().toasts.value = [];
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

const build = () => useFilters(entries, { search });

/** Types `term` and lets the debounce fire and its request settle. */
async function type(filters, term) {
  filters.searchQuery.value = term;
  await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
}

describe('useFilters with an empty box', () => {
  it('filters the loaded list in the browser and asks the server nothing', async () => {
    const { filtered, setCat } = build();

    expect(titles(filtered.value)).toEqual(['Boiler Room', 'Alder Street']);

    setCat('Characters');
    expect(titles(filtered.value)).toEqual(['Alder Street']);

    await vi.advanceTimersByTimeAsync(10 * SEARCH_DEBOUNCE_MS);
    expect(search).not.toHaveBeenCalled();
  });

  it('narrows the loaded list by tag, case-insensitively', () => {
    const { filtered, setTag, clearTag } = build();

    setTag('ENGINE');
    expect(titles(filtered.value)).toEqual(['Boiler Room']);

    clearTag();
    expect(titles(filtered.value)).toEqual(['Boiler Room', 'Alder Street']);
  });
});

describe('useFilters search request', () => {
  it('coalesces a typed word into one request, after the debounce', async () => {
    search.mockResolvedValue(SERVER_ROWS);
    const filters = build();

    for (const term of ['c', 'co', 'cou', 'coup']) filters.searchQuery.value = term;
    expect(search).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    expect(search).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('coup');
  });

  it('shows the server result set rather than the loaded list', async () => {
    search.mockResolvedValue(SERVER_ROWS);
    const filters = build();

    await type(filters, 'coupling');

    // `Coupling Rod` is not in the loaded list at all; `Alder Street` is, and
    // the server did not return it.
    expect(titles(filters.filtered.value)).toEqual(['Boiler Room', 'Coupling Rod']);
  });

  it('marks the row whose only hit was inside a block, and only that row', async () => {
    search.mockResolvedValue(SERVER_ROWS);
    const filters = build();

    await type(filters, 'Boiler');

    const marked = filters.filtered.value.filter((e) => e.matchedInText).map((e) => e.title);
    expect(marked).toEqual(['Coupling Rod']);
  });

  it('is searching while the request is out, and done when it lands', async () => {
    const inFlight = pending();
    search.mockReturnValueOnce(inFlight.promise);
    const filters = build();

    filters.searchQuery.value = 'coupling';
    expect(filters.searching.value).toBe(false);

    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(filters.searching.value).toBe(true);

    inFlight.resolve(SERVER_ROWS);
    await vi.advanceTimersByTimeAsync(0);
    expect(filters.searching.value).toBe(false);
  });

  it('discards an overtaken response rather than letting it replace a newer one', async () => {
    const slow = pending();
    search.mockReturnValueOnce(slow.promise).mockResolvedValueOnce([row('e9', 'Signal Box')]);
    const filters = build();

    // The first query goes out and stays out.
    filters.searchQuery.value = 'coupling';
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    // A second one overtakes it and lands.
    await type(filters, 'signal');
    expect(titles(filters.filtered.value)).toEqual(['Signal Box']);

    // The first finally answers, and must change nothing.
    slow.resolve(SERVER_ROWS);
    await vi.advanceTimersByTimeAsync(0);
    expect(titles(filters.filtered.value)).toEqual(['Signal Box']);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous results and raises a toast when a request fails', async () => {
    search
      .mockResolvedValueOnce(SERVER_ROWS)
      .mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const filters = build();

    await type(filters, 'coupling');
    expect(titles(filters.filtered.value)).toEqual(['Boiler Room', 'Coupling Rod']);

    await type(filters, 'couplings');

    // Emptying the sidebar would read as "no matches" — an answer the server
    // never gave.
    expect(titles(filters.filtered.value)).toEqual(['Boiler Room', 'Coupling Rod']);
    expect(filters.searching.value).toBe(false);
    const messages = useToasts().toasts.value.map((t) => t.message);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('503 Service Unavailable');
  });

  it('lets a category pill narrow a server result set', async () => {
    search.mockResolvedValue(SERVER_ROWS);
    const filters = build();

    await type(filters, 'coupling');
    filters.setCat('Characters');

    // The pill filtered the two rows the server returned — not the loaded list,
    // which has no Coupling Rod in it.
    expect(titles(filters.filtered.value)).toEqual(['Coupling Rod']);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('lets a tag pill narrow a server result set, with no second request', async () => {
    search.mockResolvedValue(SERVER_ROWS);
    const filters = build();

    await type(filters, 'coupling');
    filters.setTag('engine');

    expect(titles(filters.filtered.value)).toEqual(['Boiler Room']);
    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe('useFilters clearing the box', () => {
  it('falls back to the loaded list', async () => {
    search.mockResolvedValue(SERVER_ROWS);
    const filters = build();

    await type(filters, 'coupling');
    expect(titles(filters.filtered.value)).toEqual(['Boiler Room', 'Coupling Rod']);

    await type(filters, '');
    expect(titles(filters.filtered.value)).toEqual(['Boiler Room', 'Alder Street']);
    // Clearing is not a query.
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('cancels a debounce that has not fired', async () => {
    search.mockResolvedValue(SERVER_ROWS);
    const filters = build();

    filters.searchQuery.value = 'coup';
    filters.searchQuery.value = '';

    await vi.advanceTimersByTimeAsync(10 * SEARCH_DEBOUNCE_MS);
    expect(search).not.toHaveBeenCalled();
  });

  it('disowns a response that is already in flight', async () => {
    const slow = pending();
    search.mockReturnValueOnce(slow.promise);
    const filters = build();

    filters.searchQuery.value = 'coupling';
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    filters.searchQuery.value = '';

    slow.resolve(SERVER_ROWS);
    await vi.advanceTimersByTimeAsync(0);

    // The box is empty, so the loaded list is what belongs on screen.
    expect(titles(filters.filtered.value)).toEqual(['Boiler Room', 'Alder Street']);
    expect(filters.searching.value).toBe(false);
  });

  it('resetFilters drops the search and both pills at once', async () => {
    search.mockResolvedValue(SERVER_ROWS);
    const filters = build();

    await type(filters, 'coupling');
    filters.setCat('Characters');
    expect(titles(filters.filtered.value)).toEqual(['Coupling Rod']);

    filters.resetFilters();

    expect(filters.searchQuery.value).toBe('');
    expect(filters.activeCat.value).toBe('All');
    expect(filters.activeTag.value).toBe(null);
    expect(titles(filters.filtered.value)).toEqual(['Boiler Room', 'Alder Street']);
  });
});

describe('useFilters without a search function', () => {
  it('leaves the loaded list alone rather than emptying the sidebar', async () => {
    const filters = useFilters(entries);

    filters.searchQuery.value = 'coupling';
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    expect(titles(filters.filtered.value)).toEqual(['Boiler Room', 'Alder Street']);
  });
});
