/**
 * The Tags group in Settings (KOL-053), over the real client API module. fetch is stubbed rather
 * than api/tags.js mocked, so what is pinned here is the routes the group calls — method, path and
 * body — and what it does with their answers. Where its list comes from matters too: the counts
 * are derived from the entity list the layout already holds, so there is no request on mount, and
 * a group that quietly added one would fail the "unexpected request" throw below.
 *
 * The server's own rules — merging, the changelog trail, the 200-entity bound — are in
 * server/tests/http/tags.test.js. Where the group sits in Settings is in WikiLayout.test.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import TagSettings from './TagSettings.vue';

/** Three entities, so `train` is on two of them and `steam` on one. */
const ENTITIES = [
  { _id: 'a', title: 'The Engine',   tags: ['train', 'steam'] },
  { _id: 'b', title: 'The Caboose',  tags: ['train'] },
  { _id: 'c', title: 'The Conductor', tags: [] },
];

/** `{ 'METHOD /path': (init) => [status, body] }`, answered by the stubbed fetch. */
let routes;
/** Every request made, as `{ key, body }` with key `'METHOD /path'`. */
let calls;

beforeEach(() => {
  localStorage.setItem('TAG_LOG_LEVEL', 'off');
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

/** The item whose tag name is `name`. */
const itemFor = (wrapper, name) => {
  const found = wrapper.findAll('.tag-item').find((li) => li.find('.tag-name').exists() && li.get('.tag-name').text() === name);
  if (!found) throw new Error(`no row for tag "${name}"`);
  return found;
};

describe('TagSettings', () => {
  it('lists every tag in the workspace with the number of entities carrying it, and asks for nothing', () => {
    const wrapper = mount(TagSettings, { props: { entities: ENTITIES } });

    const rows = wrapper.findAll('.tag-item').map((li) => [li.get('.tag-name').text(), li.get('.tag-count').text()]);
    expect(rows).toEqual([['steam', '1 entity'], ['train', '2 entities']]);
    expect(calls).toEqual([]);
  });

  it('renames through PUT /tags/:tag with the new name, then tells the parent to refetch', async () => {
    routes['PUT /tags/train'] = () => [200, { renamed: 2, from: 'train', to: 'rail' }];
    const wrapper = mount(TagSettings, { props: { entities: ENTITIES } });

    await button(wrapper, 'Rename', itemFor(wrapper, 'train')).trigger('click');
    await wrapper.get('.tag-rename input').setValue('rail');
    await wrapper.get('.tag-rename').trigger('submit');
    await flushPromises();

    expect(calls).toEqual([{ key: 'PUT /tags/train', body: JSON.stringify({ to: 'rail' }) }]);
    expect(wrapper.emitted('changed')).toHaveLength(1);
    // The field closes; the row comes back only when the parent's refetch changes the prop.
    expect(wrapper.find('.tag-rename').exists()).toBe(false);
  });

  it('removes through DELETE /tags/:tag, but only after the action is confirmed', async () => {
    routes['DELETE /tags/steam'] = () => [200, { removed: 1, tag: 'steam' }];
    const wrapper = mount(TagSettings, { props: { entities: ENTITIES } });

    await button(wrapper, 'Remove', itemFor(wrapper, 'steam')).trigger('click');
    expect(calls).toEqual([]);           // arming it is not the removal

    await button(wrapper, 'Remove', itemFor(wrapper, 'steam')).trigger('click');
    await flushPromises();

    expect(calls.map((c) => c.key)).toEqual(['DELETE /tags/steam']);
    expect(wrapper.emitted('changed')).toHaveLength(1);
  });

  it('shows the server\'s own sentence when a bulk operation is refused, and does not claim a change', async () => {
    routes['DELETE /tags/train'] = () => [413, { error: '"train" is on 201 entities; one tag operation may change at most 200.' }];
    const wrapper = mount(TagSettings, { props: { entities: ENTITIES } });

    await button(wrapper, 'Remove', itemFor(wrapper, 'train')).trigger('click');
    await button(wrapper, 'Remove', itemFor(wrapper, 'train')).trigger('click');
    await flushPromises();

    expect(wrapper.get('.tag-error').text()).toBe('"train" is on 201 entities; one tag operation may change at most 200.');
    expect(wrapper.emitted('changed')).toBeUndefined();
  });

  it('a rename to the same name asks for nothing', async () => {
    const wrapper = mount(TagSettings, { props: { entities: ENTITIES } });

    await button(wrapper, 'Rename', itemFor(wrapper, 'train')).trigger('click');
    await wrapper.get('.tag-rename').trigger('submit');
    await flushPromises();

    expect(calls).toEqual([]);
    expect(wrapper.emitted('changed')).toBeUndefined();
  });

  it('a tag holding a slash addresses its own route, not another one', async () => {
    routes['DELETE /tags/rolling%2Fstock'] = () => [200, { removed: 1, tag: 'rolling/stock' }];
    const wrapper = mount(TagSettings, { props: { entities: [{ _id: 'd', title: 'Yard', tags: ['rolling/stock'] }] } });

    await button(wrapper, 'Remove', itemFor(wrapper, 'rolling/stock')).trigger('click');
    await button(wrapper, 'Remove', itemFor(wrapper, 'rolling/stock')).trigger('click');
    await flushPromises();

    expect(calls.map((c) => c.key)).toEqual(['DELETE /tags/rolling%2Fstock']);
  });
});
