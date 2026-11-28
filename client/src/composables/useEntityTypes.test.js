/**
 * The shared entity-type registry, and what an `entity-type:updated` frame does
 * to it (KOL-151).
 *
 * The list is module-level — the pills, the category pickers and every category
 * colour read this one copy — and until that frame existed nothing but
 * `WikiLayout`'s mount ever filled it. So a type renamed in another tab left
 * this one rendering a pill no entity carried any more: it matched nothing, and
 * filtering on it silently emptied the sidebar.
 *
 * What is pinned here is that the frame is enough on its own: the payload
 * carries the whole row, so the list is **patched, not refetched**, and it is
 * left in the order `GET /entity-types` would have given it (`order`, then
 * name) — the pills are rendered straight off this array.
 *
 * `applyEntityTypeCreated` and `applyEntityTypeDeleted` (KOL-158) are the same
 * half of the registry's other two frames, which exist for the same reason one
 * step later: the registry now has a screen
 * (`components/EntityTypeSettings.vue`), so a type added or removed is an
 * ordinary browser write — and a tab that heard neither frame would offer a
 * category picker missing the option another tab just added and render a pill
 * for a type that is gone. Both are also what the *writing* tab applies to its
 * own response, since it is excluded from its own frames, which is why the
 * create is idempotent on `_id`: applying the response and then the frame for
 * the same row must not leave two.
 *
 * Falsification: drop the sort and the ordering cases fail; replace by name
 * instead of `_id` and the rename case leaves two rows; refetch instead of
 * patching and the "no second request" assertions fail; append without the
 * `_id` check and the idempotence case leaves two rows; filter on `_id` by
 * identity rather than by string and the delete case keeps its row.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

const getEntityTypes = vi.fn();
vi.mock('../api/entityTypes.js', () => ({ getEntityTypes }));

const { useEntityTypes } = await import('./useEntityTypes.js');

const CHARACTERS = { _id: 't1', name: 'Characters', icon: null, color: { bg: '#B5D4F4', text: '#0C447C' }, order: 0 };
const WORLDS     = { _id: 't2', name: 'Worlds',     icon: null, color: { bg: '#C9E8D2', text: '#15543A' }, order: 1 };

/** The module's list, loaded from a stubbed `GET /entity-types`. */
async function loaded(rows = [CHARACTERS, WORLDS]) {
  const api = useEntityTypes();
  getEntityTypes.mockResolvedValueOnce(rows);
  await api.loadEntityTypes('a test');
  getEntityTypes.mockClear();
  return api;
}

beforeEach(() => {
  getEntityTypes.mockReset();
});

describe('applyEntityTypeUpdate', () => {
  it('replaces the renamed row in place, with no second request', async () => {
    const { names, applyEntityTypeUpdate } = await loaded();

    const changed = applyEntityTypeUpdate({ ...CHARACTERS, name: 'People' }, 'a frame');

    expect(changed).toBe(true);
    expect(names.value).toEqual(['People', 'Worlds']);
    expect(getEntityTypes).not.toHaveBeenCalled();
  });

  it('matches on _id, not on name — the name is the thing that just changed', async () => {
    const { types, applyEntityTypeUpdate } = await loaded();

    applyEntityTypeUpdate({ ...CHARACTERS, name: 'CHARACTERS' }, 'a case-only rename');

    expect(types.value).toHaveLength(2);
    expect(types.value.map(t => t._id)).toEqual(['t1', 't2']);
  });

  it('carries the colours through, so the pills repaint from the frame alone', async () => {
    const { styleFor, applyEntityTypeUpdate } = await loaded();

    applyEntityTypeUpdate({ ...CHARACTERS, name: 'People', color: { bg: '#111', text: '#eee' } }, 'a frame');

    expect(styleFor('People')).toEqual({ bg: '#111', color: '#eee' });
    // And the old name is gone, so an entity still showing it falls back.
    expect(styleFor('Characters')).toEqual({ bg: '#333', color: '#aaa' });
  });

  it('appends a type this tab has never seen, in the order the server would have', async () => {
    // Created in another tab while this one was open, then renamed: the frame is
    // the first this tab hears of it, and the row is complete.
    const { names, applyEntityTypeUpdate } = await loaded();

    applyEntityTypeUpdate({ _id: 't3', name: 'Rolling Stock', color: {}, order: 0 }, 'a frame');

    expect(names.value).toEqual(['Characters', 'Rolling Stock', 'Worlds']);
  });

  it('ignores a payload with no _id rather than corrupting the list', async () => {
    const { names, applyEntityTypeUpdate } = await loaded();

    expect(applyEntityTypeUpdate(undefined, 'a malformed frame')).toBe(false);
    expect(applyEntityTypeUpdate({ name: 'Nameless' }, 'a malformed frame')).toBe(false);
    expect(names.value).toEqual(['Characters', 'Worlds']);
  });
});

describe('applyEntityTypeCreated', () => {
  it('adds the new row in the order the server would have, with no second request', async () => {
    const { names, applyEntityTypeCreated } = await loaded();

    const added = applyEntityTypeCreated(
      { _id: 't3', name: 'Airships', icon: null, color: { bg: '#111', text: '#eee' }, order: 0 },
      'an entity-type:created frame',
    );

    expect(added).toBe(true);
    // order 0 ties with Characters, so the name breaks it — as `GET /entity-types` does.
    expect(names.value).toEqual(['Airships', 'Characters', 'Worlds']);
    expect(getEntityTypes).not.toHaveBeenCalled();
  });

  it('carries the colours through, so a new pill is painted from the frame alone', async () => {
    const { styleFor, applyEntityTypeCreated } = await loaded();

    applyEntityTypeCreated({ _id: 't3', name: 'Airships', color: { bg: '#111', text: '#eee' }, order: 2 }, 'a frame');

    expect(styleFor('Airships')).toEqual({ bg: '#111', color: '#eee' });
  });

  it('is idempotent on _id: the writing tab\'s own response and a frame for it leave one row', async () => {
    // The tab that wrote applies the row it was answered with, because it is
    // excluded from its own frame — but a second tab's frame for the same row
    // can still reach a list that already has it (a reconnect, a re-delivery).
    const { types, applyEntityTypeCreated } = await loaded();
    const row = { _id: 't3', name: 'Airships', color: {}, order: 2 };

    applyEntityTypeCreated(row, 'this tab\'s own POST /entity-types');
    applyEntityTypeCreated({ ...row, name: 'Airships' }, 'an entity-type:created frame');

    expect(types.value.filter(t => String(t._id) === 't3')).toHaveLength(1);
    expect(types.value).toHaveLength(3);
  });

  it('ignores a payload with no _id', async () => {
    const { names, applyEntityTypeCreated } = await loaded();

    expect(applyEntityTypeCreated(undefined, 'a malformed frame')).toBe(false);
    expect(applyEntityTypeCreated({ name: 'Nameless' }, 'a malformed frame')).toBe(false);
    expect(names.value).toEqual(['Characters', 'Worlds']);
  });
});

describe('applyEntityTypeDeleted', () => {
  it('drops the row by id, with no second request', async () => {
    const { names, applyEntityTypeDeleted } = await loaded();

    const dropped = applyEntityTypeDeleted('t1', 'an entity-type:deleted frame');

    expect(dropped).toBe(true);
    expect(names.value).toEqual(['Worlds']);
    expect(getEntityTypes).not.toHaveBeenCalled();
  });

  it('reports a row this tab never had rather than treating it as a change', async () => {
    // A type created and deleted again while this tab was open.
    const { names, applyEntityTypeDeleted } = await loaded();

    expect(applyEntityTypeDeleted('t9', 'an entity-type:deleted frame')).toBe(false);
    expect(applyEntityTypeDeleted(undefined, 'a malformed frame')).toBe(false);
    expect(names.value).toEqual(['Characters', 'Worlds']);
  });
});
