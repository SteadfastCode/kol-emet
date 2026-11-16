/**
 * The gallery block's reader (KOL-142).
 *
 * Before this item `GalleryBlock.vue` was a dashed box reading "Image hosting
 * coming soon." for every gallery, filled or not — the one block type the
 * product accepted a write of and had no reader for at all. What is pinned
 * here is what a reader now gets, and the two attributes that are not
 * cosmetic:
 *
 *   - `referrerpolicy="no-referrer"` on every image. The hosts are
 *     third-party; a Referer would tell each one which wiki page, and so which
 *     workspace, is being read.
 *   - `loading="lazy"`, because a gallery is usually below the fold.
 *
 * Plus the failure case, which is the normal one over time: a URL someone
 * pasted dies, and the block has to say so and name the host rather than leave
 * a browser's broken-image glyph.
 *
 * The scheme check is asserted here as well as on the server (see
 * server/tests/http/galleryBlock.test.js): rows written before that validation
 * existed are still in workspaces, so the reader does not assume its data was
 * validated.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import GalleryBlock from './GalleryBlock.vue';

const IMAGES = [
  { url: 'https://images.example.test/engine.jpg', caption: 'The engine, from the coupling' },
  { url: 'http://pictures.example.test/carriage.png', caption: '' },
];

const block = (images) => ({ _id: 'b1', type: 'gallery', order: 0, data: { images } });

const mountBlock = (images) => mount(GalleryBlock, { props: { block: block(images), canEdit: false } });

beforeEach(() => { localStorage.setItem('GALLERY_LOG_LEVEL', 'off'); });
afterEach(() => { localStorage.clear(); });

describe('GalleryBlock', () => {
  it('renders each image with its caption, lazily and without a referrer', () => {
    const wrapper = mountBlock(IMAGES);
    const imgs = wrapper.findAll('img');

    expect(imgs.map((i) => i.attributes('src'))).toEqual([IMAGES[0].url, IMAGES[1].url]);
    for (const img of imgs) {
      expect(img.attributes('referrerpolicy')).toBe('no-referrer');
      expect(img.attributes('loading')).toBe('lazy');
    }

    // Caption-derived alt: the caption is the only description anyone wrote,
    // and with none the alt stays empty (decorative) rather than reading a URL.
    expect(imgs[0].attributes('alt')).toBe(IMAGES[0].caption);
    expect(imgs[1].attributes('alt')).toBe('');

    expect(wrapper.findAll('figcaption').map((c) => c.text())).toEqual([IMAGES[0].caption]);
    expect(wrapper.text()).not.toContain('coming soon');
  });

  it('shows a per-image message naming the host when a load fails, keeping the others', async () => {
    const wrapper = mountBlock(IMAGES);

    await wrapper.findAll('img')[0].trigger('error');

    const failed = wrapper.findAll('[data-test="gallery-failed"]');
    expect(failed).toHaveLength(1);
    expect(failed[0].text()).toContain('images.example.test');
    expect(failed[0].text()).toMatch(/did not load/i);

    // The second image is untouched, and the dead one's caption still reads.
    const imgs = wrapper.findAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].attributes('src')).toBe(IMAGES[1].url);
    expect(wrapper.findAll('figcaption').map((c) => c.text())).toEqual([IMAGES[0].caption]);
  });

  it('reads an empty gallery as an empty block, not as a promise of image hosting', () => {
    for (const images of [[], undefined, 'not an array']) {
      const wrapper = mountBlock(images);
      expect(wrapper.findAll('img')).toHaveLength(0);
      expect(wrapper.text()).toContain('No images yet');
      expect(wrapper.text()).not.toContain('coming soon');
    }
  });

  it('does not render a row whose url is not an http(s) URL', () => {
    const wrapper = mountBlock([
      { url: 'javascript:alert(1)', caption: 'Looks like a picture' },
      { url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', caption: '' },
      { url: '   ', caption: 'blank' },
      { url: 'not a url', caption: '' },
      IMAGES[0],
    ]);

    expect(wrapper.findAll('img').map((i) => i.attributes('src'))).toEqual([IMAGES[0].url]);
  });
});
