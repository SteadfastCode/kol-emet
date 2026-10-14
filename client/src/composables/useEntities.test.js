/**
 * The paged load's own rules (KOL-067) — the ones that are about the composable
 * rather than about what the sidebar ends up showing (which
 * components/WikiLayout.test.js pins, over the real layout).
 *
 *   `sidebarLoading` is cleared after the *first* page, not after the walk. The
 *   whole reason for paging is that a workspace of a few thousand entities
 *   should not hold the sidebar blank, so the flag is load-bearing rather than
 *   cosmetic and the boundary it is cleared on is the thing to pin.
 *
 *   The newest load owns the list. A load is several requests now, and the
 *   layout starts one from a handful of places — mount, a draft apply, a tag
 *   change, a restore, a create — so two can be in flight at once. Without the
 *   token the slower run's later pages would append onto the faster run's list
 *   and the sidebar would show rows twice.
 *
 *   A failing page leaves what is already on screen alone, rather than
 *   resetting the list to nothing — and records that it failed (KOL-083).
 *   `sidebarLoading` is already false by page 2, so a walk that stops partway
 *   through otherwise leaves a truncated workspace that looks exactly like a
 *   whole one; `loadError` carries how much of how much is there, for the
 *   sidebar to say so. It is recorded rather than thrown: no call site catches
 *   this (the layout starts most loads without awaiting them) and the one that
 *   awaits is `addEntity`, which would have reported a create that worked as a
 *   failure.
 *
 * Falsification: clear `sidebarLoading` after the loop and the first case
 * fails; drop the `token !== loadToken` guard and the overlap case shows five
 * rows; wrap the walk in a `catch` that empties the list and the failure case
 * fails; leave `loadError` unset, or set it from a superseded run, and the
 * last three do.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const { getEntityPage } = vi.hoisted(() => ({ getEntityPage: vi.fn() }));
vi.mock('../api/entities.js', () => ({
  ENTITY_PAGE_SIZE: 200,
  getEntityPage,
  getEntity: vi.fn(), createEntity: vi.fn(), updateEntity: vi.fn(), deleteEntity: vi.fn(),
}));

const { useEntities } = await import('./useEntities.js');

const row = (id, title) => ({ _id: id, title, category: 'Worlds', summary: `${title}.`, tags: [] });
const PAGE_1 = [row('p1', 'Aqueduct'), row('p2', 'Brakeman')];
const PAGE_2 = [row('p3', 'Coupling')];
const CURSOR = { title: 'Brakeman', _id: 'p2' };

/** A promise plus the handle to settle it, so a page can be left in flight. */
function pending() {
  let settle;
  const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  return { promise, ...settle };
}

describe('useEntities paged load', () => {
  beforeEach(() => {
    getEntityPage.mockReset();
    localStorage.setItem('ENTITY_LOAD_LOG_LEVEL', 'off');
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('asks for pages at ENTITY_PAGE_SIZE and hands back the cursor it was given', async () => {
    getEntityPage
      .mockResolvedValueOnce({ items: PAGE_1, nextAfter: CURSOR, total: 3 })
      .mockResolvedValueOnce({ items: PAGE_2, nextAfter: null, total: 3 });

    const { entities, loadEntities } = useEntities();
    await loadEntities();

    expect(entities.value.map((e) => e.title)).toEqual(['Aqueduct', 'Brakeman', 'Coupling']);
    expect(getEntityPage.mock.calls.map((c) => c[0])).toEqual([
      { limit: 200, after: null },
      { limit: 200, after: CURSOR },
    ]);
  });

  it('clears sidebarLoading after the first page, not after the last', async () => {
    const second = pending();
    getEntityPage
      .mockResolvedValueOnce({ items: PAGE_1, nextAfter: CURSOR, total: 3 })
      .mockReturnValueOnce(second.promise);

    const { entities, sidebarLoading, loadEntities } = useEntities();
    const walk = loadEntities();
    expect(sidebarLoading.value).toBe(true);

    // Let page 1 land. Page 2 is still in flight.
    await Promise.resolve();
    await Promise.resolve();
    expect(sidebarLoading.value).toBe(false);
    expect(entities.value.map((e) => e.title)).toEqual(['Aqueduct', 'Brakeman']);

    second.resolve({ items: PAGE_2, nextAfter: null, total: 3 });
    await walk;
    expect(sidebarLoading.value).toBe(false);
    expect(entities.value).toHaveLength(3);
  });

  it('the newest load owns the list — an overlapping slow one stops writing to it', async () => {
    const slowSecondPage = pending();
    getEntityPage
      .mockResolvedValueOnce({ items: PAGE_1, nextAfter: CURSOR, total: 3 })
      .mockReturnValueOnce(slowSecondPage.promise)
      .mockResolvedValueOnce({ items: [...PAGE_1, ...PAGE_2], nextAfter: null, total: 3 });

    const { entities, loadEntities } = useEntities();
    const slow = loadEntities();
    await Promise.resolve();
    await Promise.resolve();

    // A second load, started while the first is waiting on its page 2.
    const fresh = loadEntities();
    await fresh;
    expect(entities.value.map((e) => e.title)).toEqual(['Aqueduct', 'Brakeman', 'Coupling']);

    // The superseded run's page finally arrives and must change nothing.
    slowSecondPage.resolve({ items: PAGE_2, nextAfter: null, total: 3 });
    await slow;
    expect(entities.value.map((e) => e.title)).toEqual(['Aqueduct', 'Brakeman', 'Coupling']);
  });

  it('a failing page keeps the pages already loaded and records what is missing', async () => {
    getEntityPage
      .mockResolvedValueOnce({ items: PAGE_1, nextAfter: CURSOR, total: 3 })
      .mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }));

    const { entities, sidebarLoading, loadError, loadEntities } = useEntities();
    // Resolves: a rejection here reached no catch anywhere in the client.
    await loadEntities('test');

    expect(entities.value.map((e) => e.title)).toEqual(['Aqueduct', 'Brakeman']);
    expect(sidebarLoading.value).toBe(false);
    // Two of the three rows are on screen, and the record says exactly that —
    // the sidebar has no other way to tell this list from a complete one.
    expect(loadError.value).toMatchObject({ status: 401, loaded: 2, total: 3, source: 'test' });
    expect(loadError.value.message).toMatch(/session has expired/i);
  });

  it('a first page that fails leaves an empty list that knows it is not an empty workspace', async () => {
    getEntityPage.mockRejectedValueOnce(Object.assign(new Error('500 Internal Server Error'), { status: 500 }));

    const { entities, sidebarLoading, loadError, loadEntities } = useEntities();
    await loadEntities('mount');

    expect(entities.value).toEqual([]);
    expect(sidebarLoading.value).toBe(false);
    // No page landed, so there is no workspace total to report against.
    expect(loadError.value).toMatchObject({ status: 500, loaded: 0, total: null, source: 'mount' });
    expect(loadError.value.message).toMatch(/could not be loaded/i);
  });

  it('a retry that completes clears the record', async () => {
    getEntityPage
      .mockResolvedValueOnce({ items: PAGE_1, nextAfter: CURSOR, total: 3 })
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ items: PAGE_1, nextAfter: CURSOR, total: 3 })
      .mockResolvedValueOnce({ items: PAGE_2, nextAfter: null, total: 3 });

    const { entities, loadError, loadEntities } = useEntities();
    await loadEntities('mount');
    expect(loadError.value).not.toBeNull();

    await loadEntities('retry');
    expect(loadError.value).toBeNull();
    expect(entities.value.map((e) => e.title)).toEqual(['Aqueduct', 'Brakeman', 'Coupling']);
  });

  it("a superseded load's failure does not put a banner over the newer load's list", async () => {
    const slowSecondPage = pending();
    getEntityPage
      .mockResolvedValueOnce({ items: PAGE_1, nextAfter: CURSOR, total: 3 })
      .mockReturnValueOnce(slowSecondPage.promise)
      .mockResolvedValueOnce({ items: [...PAGE_1, ...PAGE_2], nextAfter: null, total: 3 });

    const { entities, loadError, loadEntities } = useEntities();
    const slow = loadEntities('mount');
    await Promise.resolve();
    await Promise.resolve();

    const fresh = loadEntities('tag change');
    await fresh;

    slowSecondPage.reject(Object.assign(new Error('503 Service Unavailable'), { status: 503 }));
    await slow;

    // The newer load walked the whole workspace; the older one's failure is
    // about a list that is no longer on screen.
    expect(loadError.value).toBeNull();
    expect(entities.value.map((e) => e.title)).toEqual(['Aqueduct', 'Brakeman', 'Coupling']);
  });
});
