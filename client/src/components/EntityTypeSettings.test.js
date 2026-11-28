/**
 * The Entity types group in Settings (KOL-158), over the real client API module and the real
 * shared registry. `fetch` is stubbed rather than `api/entityTypes.js` mocked, so what is pinned
 * here is the routes the group calls — method, path and body — and what it does with their
 * answers.
 *
 * Why this screen exists: Phase 6 dropped the hardcoded category enum so a workspace could have a
 * vocabulary of its own, and `client/src/api/entityTypes.js` then exported exactly one of the
 * route's four verbs. A user could neither add a type, rename one, recolour a pill, reorder them
 * nor remove one nothing uses — the only client that could was an MCP connector.
 *
 * Four properties, each of which was the hole:
 *
 *   **It asks for nothing when it opens.** The list is the module-level registry `useEntityTypes`
 *   holds — the same copy the pills, the pickers and every category colour read — and the three
 *   `entity-type:*` frames keep it honest, so a group that quietly added a fetch on mount would
 *   fail the "unexpected request" throw below.
 *
 *   **Every refusal is shown where it happened** (KOL-150's rule), in the server's own words: a
 *   refused rename leaves the *stored* name on the row with the sentence beside it, and a delete
 *   refused while the type is in use names the count. A screen that swallowed either would look
 *   exactly like a write that landed.
 *
 *   **The near-duplicate `warning` is a warning.** `POST /entity-types` creates the type *and*
 *   says a similar name exists; rendering that as an error would claim nothing happened.
 *
 *   **A frame patches the list with no refetch.** The writing tab is excluded from its own frames,
 *   so the other tab's create and delete arrive as `applyEntityTypeCreated` /
 *   `applyEntityTypeDeleted` — a row appears and disappears with no second `GET /entity-types`.
 *
 * The server's own rules — the 409s, the audited rename cascade, the 413 bound, the frames — are in
 * server/tests/http/entityTypes.test.js. Where the group sits in Settings is in WikiLayout.test.js.
 *
 * Falsification: drop the sort in `rows` and the ordering case fails; post `newName` untrimmed and
 * the add case fails; close the editor on a refusal and the refused-rename case loses its input;
 * render the `warning` in `.type-error` and that case fails; call `loadEntityTypes` on mount and
 * every case fails on an unexpected request; drop the `canWrite` gate and the viewer case fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

import EntityTypeSettings from './EntityTypeSettings.vue';
import { useEntityTypes } from '../composables/useEntityTypes.js';

/** Three types whose stored order is NOT the order they are listed in. */
const WORLDS     = { _id: 't2', name: 'Worlds',     icon: null, color: { bg: '#C9E8D2', text: '#15543A' }, order: 1 };
const CHARACTERS = { _id: 't1', name: 'Characters', icon: '🧍', color: { bg: '#B5D4F4', text: '#0C447C' }, order: 0 };
/** Same `order` as Worlds, so the name is what separates them. */
const AIRSHIPS   = { _id: 't3', name: 'Airships',   icon: null, color: { bg: null, text: null }, order: 1 };

/** `{ 'METHOD /path': (init) => [status, body] }`, answered by the stubbed fetch. */
let routes;
/** Every request made, as `{ key, body }` with key `'METHOD /path'`. */
let calls;

const { loadEntityTypes, applyEntityTypeCreated, applyEntityTypeDeleted } = useEntityTypes();

beforeEach(async () => {
  localStorage.setItem('ENTITY_TYPE_LOG_LEVEL', 'off');
  calls = [];
  routes = {};
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${new URL(url, 'http://localhost').pathname}`;
    calls.push({ key, body: init.body });
    if (!routes[key]) throw new Error(`unexpected request: ${key}`);
    const [status, body] = routes[key](init);
    return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body };
  }));

  // The shared registry is module-level, so each case starts from a known list —
  // loaded the one way the product loads it, through the real API module.
  routes['GET /entity-types'] = () => [200, [WORLDS, CHARACTERS, AIRSHIPS]];
  await loadEntityTypes('a test');
  delete routes['GET /entity-types'];
  calls = [];
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

/** The row whose stored name is `name`. */
const itemFor = (wrapper, name) => {
  const found = wrapper.findAll('.type-item')
    .find((li) => li.find('.type-pill').exists() && li.get('.type-pill').text().includes(name));
  if (!found) throw new Error(`no row for entity type "${name}"`);
  return found;
};

const names = (wrapper) => wrapper.findAll('.type-item .type-name').map((n) => n.text());

describe('EntityTypeSettings', () => {
  it('lists the workspace\'s types in order then name, and asks for nothing', () => {
    const wrapper = mount(EntityTypeSettings);

    // Airships and Worlds share order 1; the name breaks the tie, as on the server.
    expect(names(wrapper)).toEqual(['Characters', 'Airships', 'Worlds']);
    expect(calls).toEqual([]);
  });

  it('paints each row with its own colours, and the fallback where it has none', () => {
    const wrapper = mount(EntityTypeSettings);

    const pill = itemFor(wrapper, 'Characters').get('.type-pill');
    expect(pill.attributes('style')).toContain('rgb(181, 212, 244)');   // #B5D4F4
    expect(pill.text()).toBe('🧍 Characters');
    expect(itemFor(wrapper, 'Airships').get('.type-pill').attributes('style')).toContain('rgb(51, 51, 51)');
  });

  it('adds a type through POST /entity-types with the trimmed name, and appends the row', async () => {
    routes['POST /entity-types'] = () => [201, { _id: 't4', name: 'Rolling Stock', icon: null, color: { bg: null, text: null }, order: 3 }];
    const wrapper = mount(EntityTypeSettings);

    await wrapper.get('.type-add input').setValue('  Rolling Stock  ');
    await wrapper.get('.type-add').trigger('submit');
    await flushPromises();

    expect(calls).toEqual([{ key: 'POST /entity-types', body: JSON.stringify({ name: 'Rolling Stock' }) }]);
    // Appended from the response, not from a refetch: the writing tab is
    // excluded from its own entity-type:created frame.
    expect(names(wrapper)).toEqual(['Characters', 'Airships', 'Worlds', 'Rolling Stock']);
    expect(wrapper.get('.type-add input').element.value).toBe('');
    expect(wrapper.find('.type-error').exists()).toBe(false);
  });

  it('renders the near-duplicate warning as a warning beside the row that WAS created', async () => {
    routes['POST /entity-types'] = () => [201, {
      _id: 't5', name: 'Worldz', icon: null, color: { bg: null, text: null }, order: 4,
      warning: 'Similar types exist: Worlds',
    }];
    const wrapper = mount(EntityTypeSettings);

    await wrapper.get('.type-add input').setValue('Worldz');
    await wrapper.get('.type-add').trigger('submit');
    await flushPromises();

    expect(names(wrapper)).toContain('Worldz');
    const row = itemFor(wrapper, 'Worldz');
    expect(row.get('.type-warning').text()).toBe('Similar types exist: Worlds');
    expect(wrapper.find('.type-error').exists()).toBe(false);
  });

  it('a duplicate name is 409 and says so without adding a row', async () => {
    routes['POST /entity-types'] = () => [409, { error: 'Entity type already exists', existing: WORLDS }];
    const wrapper = mount(EntityTypeSettings);

    await wrapper.get('.type-add input').setValue('worlds');
    await wrapper.get('.type-add').trigger('submit');
    await flushPromises();

    expect(wrapper.get('.type-error').text()).toBe('Entity type already exists');
    expect(names(wrapper)).toEqual(['Characters', 'Airships', 'Worlds']);
  });

  it('renames through PUT /entity-types/:id and tells the parent, with both names', async () => {
    routes['PUT /entity-types/t1'] = () => [200, {
      ...CHARACTERS, name: 'People', relabelled: { entities: 3, sourceCategories: 0, targetCategories: 0 },
    }];
    const wrapper = mount(EntityTypeSettings);

    await button(wrapper, 'Edit', itemFor(wrapper, 'Characters')).trigger('click');
    await itemFor(wrapper, 'Characters').get('.type-edit input[type="text"]').setValue('People');
    await itemFor(wrapper, 'Characters').get('.type-edit').trigger('submit');
    await flushPromises();

    // Only the field that changed: the icon, the colours and the order are untouched.
    expect(calls).toEqual([{ key: 'PUT /entity-types/t1', body: JSON.stringify({ name: 'People' }) }]);
    // The cascade moved entities, so the layout refetches and moves a filter standing on the old name.
    expect(wrapper.emitted('changed')).toEqual([[{ from: 'Characters', to: 'People' }]]);
    expect(names(wrapper)).toContain('People');
    expect(names(wrapper)).not.toContain('Characters');
  });

  it('a rename refused 409 leaves the old name on screen, with the server\'s sentence beside it', async () => {
    routes['PUT /entity-types/t1'] = () => [409, { error: 'Entity type already exists', existing: WORLDS }];
    const wrapper = mount(EntityTypeSettings);

    await button(wrapper, 'Edit', itemFor(wrapper, 'Characters')).trigger('click');
    await itemFor(wrapper, 'Characters').get('.type-edit input[type="text"]').setValue('Worlds');
    await itemFor(wrapper, 'Characters').get('.type-edit').trigger('submit');
    await flushPromises();

    const row = itemFor(wrapper, 'Characters');
    expect(row.get('.type-pill').text()).toBe('🧍 Characters');
    expect(row.get('.type-error').text()).toBe('Entity type already exists');
    // The editor stays open with what was typed (KOL-156), and the registry is untouched.
    expect(row.get('.type-edit input[type="text"]').element.value).toBe('Worlds');
    expect(wrapper.emitted('changed')).toBeUndefined();
  });

  it('sends an icon, both colour halves and an order, each only when it changed', async () => {
    routes['PUT /entity-types/t3'] = (init) => [200, { ...AIRSHIPS, ...JSON.parse(init.body) }];
    const wrapper = mount(EntityTypeSettings);

    await button(wrapper, 'Edit', itemFor(wrapper, 'Airships')).trigger('click');
    const row = () => itemFor(wrapper, 'Airships');
    await row().get('.type-input-icon').setValue('🎈');
    await row().get('.type-swatch-input').setValue('#111111');
    await row().get('.type-input-order').setValue('7');
    await row().get('.type-edit').trigger('submit');
    await flushPromises();

    expect(JSON.parse(calls[0].body)).toEqual({ icon: '🎈', color: { bg: '#111111' }, order: 7 });
    // No name in the patch, so no cascade and nothing for the parent to refetch.
    expect(wrapper.emitted('changed')).toBeUndefined();
  });

  it('a save with nothing changed asks for nothing', async () => {
    const wrapper = mount(EntityTypeSettings);

    await button(wrapper, 'Edit', itemFor(wrapper, 'Worlds')).trigger('click');
    await itemFor(wrapper, 'Worlds').get('.type-edit').trigger('submit');
    await flushPromises();

    expect(calls).toEqual([]);
    expect(wrapper.emitted('changed')).toBeUndefined();
  });

  it('removes through DELETE /entity-types/:id, but only after the action is confirmed', async () => {
    routes['DELETE /entity-types/t3'] = () => [204, null];
    const wrapper = mount(EntityTypeSettings);

    await button(wrapper, 'Remove', itemFor(wrapper, 'Airships')).trigger('click');
    expect(calls).toEqual([]);           // arming it is not the removal

    await button(wrapper, 'Remove', itemFor(wrapper, 'Airships')).trigger('click');
    await flushPromises();

    expect(calls.map((c) => c.key)).toEqual(['DELETE /entity-types/t3']);
    expect(names(wrapper)).toEqual(['Characters', 'Worlds']);
  });

  it('a delete refused while the type is in use names the count, and keeps the row', async () => {
    routes['DELETE /entity-types/t1'] = () => [409, {
      error: 'Cannot delete: 3 entities and 1 relationship type use "Characters"',
      inUse: 4, entities: 3, relationshipTypes: 1,
    }];
    const wrapper = mount(EntityTypeSettings);

    await button(wrapper, 'Remove', itemFor(wrapper, 'Characters')).trigger('click');
    await button(wrapper, 'Remove', itemFor(wrapper, 'Characters')).trigger('click');
    await flushPromises();

    const row = itemFor(wrapper, 'Characters');
    expect(row.get('.type-error').text())
      .toBe('Cannot delete: 3 entities and 1 relationship type use "Characters"');
    expect(names(wrapper)).toContain('Characters');
  });

  it('the last-type refusal says why, in the server\'s words', async () => {
    routes['DELETE /entity-types/t2'] = () => [409, {
      error: 'Cannot delete "Worlds": a workspace keeps at least one entity type',
    }];
    const wrapper = mount(EntityTypeSettings);

    await button(wrapper, 'Remove', itemFor(wrapper, 'Worlds')).trigger('click');
    await button(wrapper, 'Remove', itemFor(wrapper, 'Worlds')).trigger('click');
    await flushPromises();

    expect(itemFor(wrapper, 'Worlds').get('.type-error').text())
      .toBe('Cannot delete "Worlds": a workspace keeps at least one entity type');
  });

  it('the two frames add and remove a row with no refetch', async () => {
    const wrapper = mount(EntityTypeSettings);

    // What another tab's create and delete arrive as: the writing tab is excluded
    // from its own frames, so these are the only account this tab gets.
    applyEntityTypeCreated({ _id: 't9', name: 'Signals', icon: null, color: {}, order: 2 }, 'an entity-type:created frame');
    await wrapper.vm.$nextTick();
    expect(names(wrapper)).toEqual(['Characters', 'Airships', 'Worlds', 'Signals']);

    applyEntityTypeDeleted('t2', 'an entity-type:deleted frame');
    await wrapper.vm.$nextTick();
    expect(names(wrapper)).toEqual(['Characters', 'Airships', 'Signals']);

    expect(calls).toEqual([]);
  });

  it('gives a viewer the list and no write control at all', () => {
    const wrapper = mount(EntityTypeSettings, { props: { canWrite: false } });

    expect(names(wrapper)).toEqual(['Characters', 'Airships', 'Worlds']);
    expect(wrapper.find('.type-add').exists()).toBe(false);
    expect(wrapper.findAll('button')).toHaveLength(0);
    expect(calls).toEqual([]);
  });
});
