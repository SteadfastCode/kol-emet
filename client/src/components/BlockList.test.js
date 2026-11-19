/**
 * The add-block menu on the entity detail page. The block it emits is handed
 * straight to the save, so its data has to be the new block's own: a shallow
 * spread of the gallery default shared `BLOCK_DEFAULTS.gallery.images` between
 * every block it created (KOL-148).
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import BlockList from './BlockList.vue';

const mountList = () =>
  mount(BlockList, {
    props: { blocks: [], canEdit: true },
    global: { stubs: { TextBlock: true, TimelineEventBlock: true, TimelineView: true, AttributeBlock: true, QuoteBlock: true, GalleryBlock: true } },
  });

/** Opens the add menu and picks a block type, the way a user would. */
async function addBlock(wrapper, label) {
  await wrapper.get('.add-block-trigger').trigger('click');
  await wrapper.findAll('.block-type-btn').find((b) => b.text() === label).trigger('click');
  return wrapper.emitted('add-block').at(-1)[0];
}

describe('BlockList add-block', () => {
  it('gives each new gallery block its own images array', async () => {
    const wrapper = mountList();

    const first = await addBlock(wrapper, 'Gallery');
    const second = await addBlock(wrapper, 'Gallery');

    expect(first.data.images).toEqual([]);
    expect(second.data.images).toEqual([]);
    expect(first.data.images).not.toBe(second.data.images);

    // A row written into one block stays in that block — and never reaches
    // the next gallery added from the same menu.
    first.data.images.push({ url: 'https://images.example.test/a.jpg', caption: '' });
    expect(second.data.images).toEqual([]);
    expect((await addBlock(wrapper, 'Gallery')).data.images).toEqual([]);
  });

  it('emits the other block types with their own default data', async () => {
    const wrapper = mountList();

    expect(await addBlock(wrapper, 'Text')).toMatchObject({ type: 'text', order: 0, data: { markdown: '' } });
    expect(await addBlock(wrapper, 'Attribute')).toMatchObject({ type: 'attribute', data: { label: '', value: '' } });
    expect(await addBlock(wrapper, 'Quote')).toMatchObject({ type: 'quote', data: { text: '', attribution: '' } });
  });
});
