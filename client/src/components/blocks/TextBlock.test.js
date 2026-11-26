/**
 * What an inline block editor does with a save the server refused (KOL-156).
 *
 * All four block editors are here rather than in a file each: they are the same
 * component four times over — a pencil, a draft seeded from `block.data`, a
 * Save — and the thing under test is the one line they share. The text block is
 * driven in full (it is where the bug was found, TextBlock.vue:78) and the other
 * three are driven through the table at the bottom.
 *
 * The bug: `await emit('save', …)` awaited `undefined`, because Vue's `emit`
 * returns no handler result. So `isEditing.value = false` ran in the same tick
 * the request was sent, and a refusal — 403 for a viewer, a 400 from the block
 * validator, a 409 — arrived as a toast over a block that had already closed
 * its editor and reverted to the stored content. The page's save is now a
 * function prop (`onSave`) that reports whether the entity was written, and
 * nothing less than `true` closes an editor.
 *
 * `onSave` is passed as a prop here; `@save="…"` on the component is what fills
 * it in from the page. That the whole chain — block editor → BlockList →
 * EntityDetail → WikiLayout — carries the answer back is pinned end to end in
 * WikiLayout.test.js, over a refused `editEntity`.
 *
 * Falsification: close the editor unconditionally again (`isEditing.value =
 * false` after the await) and every "refused" case below fails on the draft it
 * no longer has; report success for a refusal (`!== false` instead of `===
 * true`) and the "reported nothing" case fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import TextBlock from './TextBlock.vue';
import AttributeBlock from './AttributeBlock.vue';
import QuoteBlock from './QuoteBlock.vue';
import TimelineEventBlock from './TimelineEventBlock.vue';

const textBlock = () => ({ _id: 'b1', type: 'text', order: 0, data: { markdown: 'The stored paragraph.' } });

beforeEach(() => {
  localStorage.setItem('INLINE_EDIT_LOG_LEVEL', 'off');
});

/** A promise this test settles by hand, so a save can sit in flight. */
function deferred() {
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  return { promise, settle };
}

/** Mounts the block, opens its editor with the pencil and types `markdown`. */
async function typeInto(onSave, markdown, block = textBlock()) {
  const wrapper = mount(TextBlock, { props: { block, canEdit: true, onSave } });
  await wrapper.get('.block-toolbar .icon-btn').trigger('click');
  await wrapper.get('textarea').setValue(markdown);
  return wrapper;
}

const saveButton = (wrapper) => wrapper.get('.block-edit-actions .primary');
const editing = (wrapper) => wrapper.find('.block-edit').exists();

describe('TextBlock inline editor', () => {
  it('keeps the editor open and the typed markdown when the write is refused', async () => {
    const onSave = vi.fn(async () => false);
    const wrapper = await typeInto(onSave, 'Half a thought, not yet retypeable.');

    await saveButton(wrapper).trigger('click');
    await flushPromises();

    expect(onSave).toHaveBeenCalledWith({ markdown: 'Half a thought, not yet retypeable.' });
    // Open, with what was typed — not the stored paragraph, and not nothing.
    expect(editing(wrapper)).toBe(true);
    expect(wrapper.get('textarea').element.value).toBe('Half a thought, not yet retypeable.');
    expect(wrapper.find('.markdown-body').exists()).toBe(false);
    // And the editor is usable again: Save is not left spinning on a request
    // that has already come back.
    expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();
    expect(saveButton(wrapper).text()).toBe('Save');
  });

  it('closes the editor when the write lands', async () => {
    const onSave = vi.fn(async () => true);
    const wrapper = await typeInto(onSave, 'A finished paragraph.');

    await saveButton(wrapper).trigger('click');
    await flushPromises();

    expect(editing(wrapper)).toBe(false);
    // The rendered view is the block's own data, which is the page's to replace
    // once the write it just made comes back.
    expect(wrapper.get('.markdown-body').text()).toContain('The stored paragraph.');
  });

  it('holds the editor open while the write is in flight, rather than closing on the request', async () => {
    const { promise, settle } = deferred();
    const wrapper = await typeInto(() => promise, 'In flight.');

    await saveButton(wrapper).trigger('click');
    await flushPromises();

    // The old code had closed by now: the await was over before the request was.
    expect(editing(wrapper)).toBe(true);
    expect(saveButton(wrapper).attributes('disabled')).toBeDefined();
    expect(wrapper.find('.block-edit-actions .spinner').exists()).toBe(true);

    settle(true);
    await flushPromises();
    expect(editing(wrapper)).toBe(false);
  });

  it('keeps the draft when the page reported nothing at all, or threw', async () => {
    for (const onSave of [async () => undefined, async () => { throw Object.assign(new Error('NOT_WORKSPACE_EDITOR'), { status: 403 }); }]) {
      const wrapper = await typeInto(onSave, 'Still mine.');

      await saveButton(wrapper).trigger('click');
      await flushPromises();

      expect(editing(wrapper)).toBe(true);
      expect(wrapper.get('textarea').element.value).toBe('Still mine.');
      wrapper.unmount();
    }
  });

  it('keeps the draft when nothing is listening for the save', async () => {
    const wrapper = await typeInto(undefined, 'Nobody is listening.');

    await saveButton(wrapper).trigger('click');
    await flushPromises();

    expect(editing(wrapper)).toBe(true);
    expect(wrapper.get('textarea').element.value).toBe('Nobody is listening.');
  });

  it('says at the light tier which editor stayed open and that the text is still there', async () => {
    localStorage.setItem('INLINE_EDIT_LOG_LEVEL', 'light');
    const said = vi.spyOn(console, 'log').mockImplementation(() => {});
    const wrapper = await typeInto(async () => false, 'Refused.');

    await saveButton(wrapper).trigger('click');
    await flushPromises();

    const lines = said.mock.calls.map(([line]) => line).filter((l) => l.startsWith('[inlineEdit:'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('text block b1');
    expect(lines[0]).toContain('not saved');
    expect(lines[0]).toContain('still holding what was typed');
    // A log line at this tier names where the change came from, not just what
    // changed: which side reported the refusal is the whole question here.
    expect(lines[0]).toContain('source:');
    said.mockRestore();
  });
});

/**
 * The other three editors, on the one behaviour they share with the text block.
 * Each entry drives its own primary field, because that is the only thing about
 * them that differs.
 */
const EDITORS = [
  {
    name: 'AttributeBlock',
    component: AttributeBlock,
    block: { _id: 'b2', type: 'attribute', order: 0, data: { label: 'Gauge', value: '1435 mm' } },
    field: '.block-edit input',
    typed: '1000 mm',
    expectSent: { label: 'Gauge', value: '1000 mm' },
    fieldIndex: 1,
  },
  {
    name: 'QuoteBlock',
    component: QuoteBlock,
    block: { _id: 'b3', type: 'quote', order: 0, data: { text: 'All aboard.', attribution: 'The Conductor' } },
    field: '.block-edit textarea',
    typed: 'Mind the gap.',
    expectSent: { text: 'Mind the gap.', attribution: 'The Conductor' },
    fieldIndex: 0,
  },
  {
    name: 'TimelineEventBlock',
    component: TimelineEventBlock,
    block: { _id: 'b4', type: 'timeline_event', order: 0, data: { date: 'Year 42', sortKey: 42, era: 'Steam', description: 'The first run.', linkedEntryId: null } },
    field: '.block-edit textarea',
    typed: 'The first run, rewritten.',
    expectSent: { date: 'Year 42', sortKey: 42, era: 'Steam', description: 'The first run, rewritten.', linkedEntryId: null },
    fieldIndex: 0,
  },
];

describe.each(EDITORS)('$name inline editor', ({ component, block, field, typed, expectSent, fieldIndex }) => {
  const open = async (onSave) => {
    const wrapper = mount(component, { props: { block, canEdit: true, onSave } });
    await wrapper.get('.block-toolbar .icon-btn').trigger('click');
    await wrapper.findAll(field)[fieldIndex].setValue(typed);
    return wrapper;
  };

  it('keeps the editor open and the typed value when the write is refused', async () => {
    const onSave = vi.fn(async () => false);
    const wrapper = await open(onSave);

    await saveButton(wrapper).trigger('click');
    await flushPromises();

    expect(onSave).toHaveBeenCalledWith(expectSent);
    expect(editing(wrapper)).toBe(true);
    expect(wrapper.findAll(field)[fieldIndex].element.value).toBe(typed);
  });

  it('closes the editor when the write lands', async () => {
    const wrapper = await open(vi.fn(async () => true));

    await saveButton(wrapper).trigger('click');
    await flushPromises();

    expect(editing(wrapper)).toBe(false);
  });
});
