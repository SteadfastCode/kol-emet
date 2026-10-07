/**
 * The "Recently deleted" group in Settings (KOL-060), over the real client API module. fetch is
 * stubbed rather than api/entities.js mocked, so what is pinned here is the routes the group calls
 * — method, path and body — and what it does with their answers. The server's own rules (the
 * recreate at the original id, the 409s, the tenancy) are in server/tests/http/restore.test.js;
 * where the group sits in Settings is in WikiLayout.test.js.
 *
 * `useEntityTypes` is mocked for its names alone: the real one is a module-level cache that only
 * WikiLayout fills, so a picker test would otherwise have no types to offer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import RecentlyDeleted from './RecentlyDeleted.vue';

vi.mock('../composables/useEntityTypes.js', async () => {
  const { ref } = await import('vue');
  return { useEntityTypes: () => ({ names: ref(['Characters', 'People']), types: ref([]), styleFor: () => ({}), loadEntityTypes: vi.fn() }) };
});

const BRAKEMAN = {
  _id: 'log-brakeman', entityId: 'ent-brakeman', entityTitle: 'The Brakeman',
  category: 'Characters', actorLabel: 'rider@example.test', actorType: 'user',
  createdAt: '2026-10-05T09:30:00.000Z',
};
const CABOOSE = {
  _id: 'log-caboose', entityId: 'ent-caboose', entityTitle: 'The Caboose',
  category: 'Worlds', actorLabel: 'rider@example.test via AI', actorType: 'mcp',
  createdAt: '2026-10-06T11:00:00.000Z',
};

const when = (iso) => new Date(iso).toLocaleString();

/** `{ 'METHOD /path': (init) => [status, body] }`, answered by the stubbed fetch. */
let routes;
/** Every request made, as `{ key, body }` with key `'METHOD /path'`. */
let calls;

beforeEach(() => {
  localStorage.setItem('DELETED_LOG_LEVEL', 'off');
  calls = [];
  routes = {};
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

const button = (wrapper, text, within = wrapper) => {
  const found = within.findAll('button').find((b) => b.text() === text);
  if (!found) throw new Error(`no "${text}" button`);
  return found;
};

const rowFor = (wrapper, title) => {
  const found = wrapper.findAll('.deleted-item').find((li) => li.get('.deleted-title').text() === title);
  if (!found) throw new Error(`no row for "${title}"`);
  return found;
};

async function mountListing(...pages) {
  // A copy per answer: a refused restore marks the row it came from, and the
  // rows above are shared between tests.
  routes['GET /deleted'] = () => [200, (pages.length > 1 ? pages.shift() : pages[0]).map((e) => ({ ...e }))];
  const wrapper = mount(RecentlyDeleted);
  await flushPromises();
  return wrapper;
}

describe('RecentlyDeleted', () => {
  it('lists what GET /deleted offers, with when it went and who did it', async () => {
    const wrapper = await mountListing([CABOOSE, BRAKEMAN]);

    expect(calls.map((c) => c.key)).toEqual(['GET /deleted']);
    const rows = wrapper.findAll('.deleted-item');
    expect(rows.map((r) => r.get('.deleted-title').text())).toEqual(['The Caboose', 'The Brakeman']);
    expect(rows[1].text()).toContain(`Deleted ${when(BRAKEMAN.createdAt)} by rider@example.test`);
    expect(rows[1].text()).toContain('Characters');
    // The restore brings the entity back, not the edges the delete pruned.
    expect(wrapper.text()).toContain('links to other entities are not rebuilt');
  });

  it('says so when nothing was deleted, and asks for nothing else', async () => {
    const wrapper = await mountListing([]);

    expect(wrapper.text()).toContain('Nothing deleted in the last 30 days.');
    expect(wrapper.findAll('.deleted-item')).toHaveLength(0);
    expect(calls.map((c) => c.key)).toEqual(['GET /deleted']);
  });

  it('restores a row through the rollback route, drops it from the list and says so upwards', async () => {
    routes['POST /entities/ent-brakeman/rollback/log-brakeman'] = () => [201, { _id: 'ent-brakeman', title: 'The Brakeman' }];
    const wrapper = await mountListing([CABOOSE, BRAKEMAN]);

    await button(wrapper, 'Restore', rowFor(wrapper, 'The Brakeman')).trigger('click');
    await flushPromises();

    expect(calls.map((c) => c.key)).toEqual(['GET /deleted', 'POST /entities/ent-brakeman/rollback/log-brakeman']);
    expect(JSON.parse(calls[1].body)).toEqual({}); // no category: the snapshot's own type is still there
    expect(wrapper.findAll('.deleted-item').map((r) => r.get('.deleted-title').text())).toEqual(['The Caboose']);
    expect(wrapper.emitted('restored')).toEqual([['ent-brakeman']]);
    expect(wrapper.find('.deleted-error').exists()).toBe(false);
  });

  it('asks which type to restore a stale row under, and sends the choice', async () => {
    const stale = { ...BRAKEMAN, snapshotCategoryMissing: true };
    routes['POST /entities/ent-brakeman/rollback/log-brakeman'] = () => [201, { _id: 'ent-brakeman' }];
    const wrapper = await mountListing([stale]);

    const row = rowFor(wrapper, 'The Brakeman');
    expect(row.text()).toContain('no longer an entity type here');
    // Nothing chosen yet, so there is nothing to send.
    expect(button(wrapper, 'Restore', row).element.disabled).toBe(true);
    expect(row.get('select').findAll('option').map((o) => o.text())).toEqual(['Choose a type…', 'Characters', 'People']);

    await row.get('select').setValue('People');
    await button(wrapper, 'Restore', row).trigger('click');
    await flushPromises();

    expect(JSON.parse(calls[1].body)).toEqual({ category: 'People' });
    expect(wrapper.emitted('restored')).toEqual([['ent-brakeman']]);
  });

  it('a 409 for a type that went while the list was open turns that row into the picker', async () => {
    routes['POST /entities/ent-brakeman/rollback/log-brakeman'] = () => [409, {
      error: 'This version was saved under "Characters", which is no longer an entity type in this workspace.',
      snapshotCategory: 'Characters',
      availableCategories: ['Vehicles'],
    }];
    const wrapper = await mountListing([BRAKEMAN]);

    await button(wrapper, 'Restore', rowFor(wrapper, 'The Brakeman')).trigger('click');
    await flushPromises();

    // The row stays on screen: it is where the choice that fixes it is made.
    const row = rowFor(wrapper, 'The Brakeman');
    expect(wrapper.get('.deleted-error').text()).toContain('no longer an entity type');
    // Offered from what the refusal named, not from the workspace list.
    expect(row.get('select').findAll('option').map((o) => o.text())).toEqual(['Choose a type…', 'Vehicles']);
    expect(wrapper.emitted('restored')).toBeUndefined();
  });

  it('a 409 for an id that is live again shows the refusal and reloads the list', async () => {
    routes['POST /entities/ent-brakeman/rollback/log-brakeman'] = () => [409, {
      error: 'This entity exists again, so restoring the deleted version would overwrite it.',
      entityId: 'ent-brakeman',
    }];
    const wrapper = await mountListing([BRAKEMAN], [CABOOSE]);

    await button(wrapper, 'Restore', rowFor(wrapper, 'The Brakeman')).trigger('click');
    await flushPromises();

    expect(wrapper.get('.deleted-error').text()).toContain('would overwrite it');
    expect(calls.map((c) => c.key)).toEqual([
      'GET /deleted',
      'POST /entities/ent-brakeman/rollback/log-brakeman',
      'GET /deleted',
    ]);
    expect(wrapper.findAll('.deleted-item').map((r) => r.get('.deleted-title').text())).toEqual(['The Caboose']);
    expect(wrapper.emitted('restored')).toBeUndefined();
  });

  it('says so when the list cannot be loaded, without pretending nothing was deleted', async () => {
    routes['GET /deleted'] = () => [500, { error: 'boom' }];
    const wrapper = mount(RecentlyDeleted);
    await flushPromises();

    expect(wrapper.get('.deleted-error').text()).toBe('Could not load what was recently deleted.');
    expect(wrapper.text()).not.toContain('Nothing deleted in the last 30 days.');
  });
});
