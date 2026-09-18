/**
 * Tag suggestions in the entity editor. fetch is stubbed rather than
 * api/tags.js mocked, so what is pinned here is that the list comes from
 * GET /tags, fetched once when the editor mounts.
 *
 * The field stays a plain comma-separated text input: the suggestions only act
 * on the token after the last comma, and a failed fetch costs the suggestions,
 * never the typing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import EntityEditor from './EntityEditor.vue';

// Server order for GET /tags: sorted, and deliberately mixed-case so a
// case-sensitive match would fail.
const TAGS = ['alpha', 'cache', 'Carriage', 'castle', 'scar'];

let respond;
let calls;

beforeEach(() => {
  localStorage.setItem('TAG_SUGGEST_LOG_LEVEL', 'off');
  calls = [];
  respond = () => new Response(JSON.stringify(TAGS), { status: 200, headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push(`${init.method ?? 'GET'} ${new URL(url, 'http://localhost').pathname}`);
    return respond();
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function openEditor() {
  const wrapper = mount(EntityEditor);
  await flushPromises();
  return wrapper;
}

const tagsInputOf = (wrapper) => wrapper.get('input[role="combobox"]');

/** Types into the tags field the way a user would: focus, then a value. */
async function typeTags(wrapper, value) {
  const input = tagsInputOf(wrapper);
  await input.trigger('focus');
  await input.setValue(value);
  return input;
}

const optionsOf = (wrapper) => wrapper.findAll('[role="option"]').map((o) => o.text());

describe('EntityEditor tag suggestions', () => {
  it('fetches the workspace tags once from GET /tags when the editor mounts', async () => {
    await openEditor();
    expect(calls).toEqual(['GET /tags']);
  });

  it('matches the token after the last comma, prefix matches before substring ones', async () => {
    const wrapper = await openEditor();
    await typeTags(wrapper, 'alpha, ca');

    // cache/Carriage/castle start with "ca"; scar only contains it; alpha is
    // already in the field.
    expect(optionsOf(wrapper)).toEqual(['cache', 'Carriage', 'castle', 'scar']);
    expect(optionsOf(wrapper)).not.toContain('alpha');
  });

  it('leaves out a matching tag that is already in the field', async () => {
    const wrapper = await openEditor();
    await typeTags(wrapper, 'castle, ca');

    expect(optionsOf(wrapper)).toEqual(['cache', 'Carriage', 'scar']);
  });

  it('shows at most 8 tags', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `tag${i}`);
    respond = () => new Response(JSON.stringify(many), { status: 200 });
    const wrapper = await openEditor();
    await typeTags(wrapper, 'tag');

    expect(optionsOf(wrapper)).toHaveLength(8);
  });

  it('replaces the typed token and opens the next one when a suggestion is clicked', async () => {
    const wrapper = await openEditor();
    const input = await typeTags(wrapper, 'alpha, ca');

    const castle = wrapper.findAll('[role="option"]').find((o) => o.text() === 'castle');
    await castle.trigger('mousedown');

    expect(input.element.value).toBe('alpha, castle, ');
    // The finished tags are what the editor saves.
    await wrapper.get('.title-input').setValue('Ravenhold');
    await wrapper.get('.editor-footer .primary').trigger('click');
    expect(wrapper.emitted('saved')[0][0].tags).toEqual(['alpha', 'castle']);
  });

  it('chooses with the arrow keys and Enter, tracking the active option in ARIA', async () => {
    const wrapper = await openEditor();
    const input = await typeTags(wrapper, 'alpha, ca');

    expect(input.attributes('aria-activedescendant')).toBeUndefined();

    await input.trigger('keydown', { key: 'ArrowDown' });   // cache
    await input.trigger('keydown', { key: 'ArrowDown' });   // Carriage
    await input.trigger('keydown', { key: 'ArrowUp' });     // cache

    const active = wrapper.get('[role="option"][aria-selected="true"]');
    expect(active.text()).toBe('cache');
    expect(input.attributes('aria-activedescendant')).toBe(active.attributes('id'));

    await input.trigger('keydown', { key: 'Enter' });
    expect(input.element.value).toBe('alpha, cache, ');
  });

  it('wires the input to the list with the ARIA combobox attributes', async () => {
    const wrapper = await openEditor();
    const input = tagsInputOf(wrapper);

    expect(input.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);

    await typeTags(wrapper, 'ca');

    const list = wrapper.get('[role="listbox"]');
    expect(input.attributes('aria-expanded')).toBe('true');
    expect(input.attributes('aria-controls')).toBe(list.attributes('id'));
  });

  it('closes the list on Escape without closing the editor, and reopens on an arrow key', async () => {
    const onEscape = vi.fn();
    const Host = {
      components: { EntityEditor },
      setup: () => ({ onEscape }),
      template: '<div @keydown.esc="onEscape"><EntityEditor /></div>',
    };
    const host = mount(Host);
    await flushPromises();

    const input = await typeTags(host, 'alpha, ca');
    expect(host.find('[role="listbox"]').exists()).toBe(true);

    await input.trigger('keydown', { key: 'Escape' });

    expect(host.find('[role="listbox"]').exists()).toBe(false);
    expect(input.attributes('aria-expanded')).toBe('false');
    // The editor is still there, and the key never reached anything that would
    // have closed it.
    expect(host.findComponent(EntityEditor).exists()).toBe(true);
    expect(host.findComponent(EntityEditor).emitted('cancel')).toBeUndefined();
    expect(onEscape).not.toHaveBeenCalled();

    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(host.find('[role="listbox"]').exists()).toBe(true);
  });

  it('offers no suggestions when GET /tags fails, and still saves what was typed', async () => {
    respond = () => new Response('nope', { status: 500 });
    const wrapper = await openEditor();

    await typeTags(wrapper, 'alpha, ca');
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    expect(tagsInputOf(wrapper).attributes('aria-expanded')).toBe('false');

    await wrapper.get('.title-input').setValue('Ravenhold');
    await wrapper.get('.editor-footer .primary').trigger('click');
    expect(wrapper.emitted('saved')[0][0].tags).toEqual(['alpha', 'ca']);
  });
});
