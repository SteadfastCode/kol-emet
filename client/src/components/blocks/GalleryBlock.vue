<template>
  <div class="block gallery-block">
    <div class="block-toolbar">
      <span class="block-type-label">Gallery</span>
    </div>

    <div v-if="!images.length" class="gallery-empty">No images yet.</div>

    <div v-else class="gallery-grid">
      <figure v-for="image in images" :key="image.key" class="gallery-item">
        <img
          v-if="!failed.has(image.key)"
          class="gallery-img"
          :src="image.url"
          :alt="image.alt"
          loading="lazy"
          referrerpolicy="no-referrer"
          @error="onError(image)"
        />
        <!-- A URL someone pasted can die, and the host is the only actionable
             thing we know about it: "imgur.com did not serve this" tells the
             owner where to look, a broken-image glyph tells them nothing. -->
        <div v-else class="gallery-failed" data-test="gallery-failed">
          This image did not load from {{ image.host }}.
        </div>
        <figcaption v-if="image.caption" class="gallery-caption">{{ image.caption }}</figcaption>
      </figure>
    </div>
  </div>
</template>

<script setup>
/**
 * The reader half of the gallery block (KOL-142). A gallery holds images the
 * user hosts somewhere already — `data.images` is `[{ url, caption }]`, and
 * there is no upload path here.
 *
 * Three things are deliberate:
 *
 *   - `referrerpolicy="no-referrer"` on every image. These are third-party
 *     hosts, and a Referer header would tell each one which wiki page — and so
 *     which workspace — is being read. A wiki must not leak its own URLs to
 *     whoever hosts a picture in it.
 *   - `loading="lazy"`, because a gallery is below the fold of an entity far
 *     more often than not.
 *   - the scheme is checked here too, even though the server refuses anything
 *     but http/https on write (models/Entity.js, blockDataError). Rows written
 *     before that validation existed are still in people's workspaces, and the
 *     reader does not get to assume its data was validated.
 *
 * `img-src` is not constrained by any CSP this app ships; a gallery URL is
 * fetched by the browser from whatever host it names.
 *
 * ─── Tiered debug logging ───────────────────────────────────────────────────
 * localStorage.GALLERY_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — every image this block will not render and why it was dropped —
 *             a load that failed (naming the URL and host that failed it) and
 *             a row rejected before render (naming the row and its scheme).
 *             A gallery that silently shows four of five images leaves no
 *             other trace: nothing errors, the page just looks thin.
 *   normal  — light, plus what each render decided: how many rows the block
 *             carried and how many survived
 *   verbose — normal, plus every surviving URL in order
 */
import { computed, ref } from 'vue';

const props = defineProps({ block: Object, canEdit: Boolean });

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  let setting = null;
  try { setting = localStorage.getItem('GALLERY_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((LEVELS[setting] ?? LEVELS.light) >= LEVELS[level]) console.log(`[gallery:${level}] ${msg}`);
}

const failed = ref(new Set());

/** The host of a URL, for a message about an image that will not load. */
function hostOf(url) {
  try { return new URL(url).host || 'an unnamed host'; } catch { return 'an unreadable address'; }
}

const images = computed(() => {
  const rows = Array.isArray(props.block?.data?.images) ? props.block.data.images : [];
  const out = [];

  rows.forEach((row, i) => {
    const url = typeof row?.url === 'string' ? row.url.trim() : '';
    if (!url) {
      log('light', `dropped images[${i}]: no url (source: block ${props.block?._id ?? 'unsaved'})`);
      return;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      log('light', `dropped images[${i}]: ${url} is not a URL (source: block ${props.block?._id ?? 'unsaved'})`);
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      log('light', `dropped images[${i}]: scheme ${parsed.protocol} is not http/https (source: block ${props.block?._id ?? 'unsaved'})`);
      return;
    }

    const caption = typeof row.caption === 'string' ? row.caption.trim() : '';
    out.push({
      // Keyed by position AND url so replacing a dead URL in the editor clears
      // the failure recorded against the old one.
      key: `${i}:${url}`,
      url,
      caption,
      host: parsed.host,
      // Caption-derived: the caption is the only description of the picture
      // anyone wrote. With none, the alt stays empty, which marks the image
      // decorative rather than reading a URL aloud to a screen reader.
      alt: caption,
    });
  });

  log('normal', `block ${props.block?._id ?? 'unsaved'}: ${rows.length} row(s) carried, ${out.length} rendered`);
  log('verbose', `block ${props.block?._id ?? 'unsaved'} urls: ${out.map(o => o.url).join(', ') || '(none)'}`);
  return out;
});

function onError(image) {
  log('light', `load failed for ${image.url} (source: img error event from ${image.host})`);
  failed.value = new Set(failed.value).add(image.key);
}
</script>

<style scoped>
.gallery-empty {
  font-size: 13px; color: #666; padding: 10px 0;
}
.gallery-grid {
  display: grid; gap: 10px; margin-top: 6px;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
}
.gallery-item { margin: 0; }
.gallery-img {
  display: block; width: 100%; height: auto; max-height: 260px;
  object-fit: cover; border-radius: 7px; background: #141414;
}
.gallery-failed {
  font-size: 12px; color: #888; padding: 14px 10px; text-align: center;
  border: 1px dashed #2a2a2a; border-radius: 7px; word-break: break-word;
}
.gallery-caption {
  font-size: 12px; color: #999; margin-top: 4px; line-height: 1.35;
}
</style>
