import mongoose from 'mongoose';
import { categoryValidator } from '../lib/entityTypeRegistry.js';
import Workspace from './Workspace.js';
import { ownerGuard } from '../lib/ownerGuard.js';

const BLOCK_TYPES = ['text', 'timeline_event', 'attribute', 'quote', 'gallery'];

/**
 * Per-type `data` shape rules (KOL-142).
 *
 * `blockSchema.data` is Mixed and deliberately stays that way: a block type's
 * payload is the type's business, and five types with five schemas in here is
 * how `data` stops being extensible. What the three write validators
 * (routes/entities.js, lib/draftApplier.js, lib/graphImporter.js) could check
 * was therefore only "an object" — which is why `gallery` was writable by
 * every path for months while being renderable by none.
 *
 * So the shape rules live here, next to the type list they belong to, as one
 * function each validator calls on each block. The validators are NOT merged:
 * Generator v1's decision to keep the write path's copies separate stands
 * (each one refuses in its own vocabulary — a 400 body, an APPLY_INVALID_BLOCKS
 * failure note, a MALFORMED_DOCUMENT refusal with a `ref`), and this adds a
 * leaf to all of them instead of a shared write helper.
 *
 * Every message names the block type, because a caller posting a whole entity
 * gets one string back and "data.images is not an array" does not say which of
 * nine blocks is wrong.
 */

// A gallery holds image URLs the user already hosts somewhere — there is no
// upload path and these caps are not storage limits, they are what keeps a
// generated or imported block from being unbounded in a document everyone
// reads. 2048 is the conventional safe URL ceiling; the caption is a line of
// prose under a picture, not a text block.
const MAX_GALLERY_IMAGES = 24;
const MAX_IMAGE_URL_LENGTH = 2048;
const MAX_IMAGE_CAPTION_LENGTH = 300;
const IMAGE_URL_PROTOCOLS = ['http:', 'https:'];

function galleryDataError(data) {
  // Absent/null `images` is an empty gallery, not a refusal: the editor seeded
  // `{ images: [] }` before this item but a block stored as `{}` (or one the
  // MCP schema's `z.record(z.unknown())` accepted) must not make an existing
  // entity unsaveable. A *present* non-array is a different thing — that is a
  // writer with the wrong idea of the shape, and it is refused.
  if (data.images == null) return null;
  if (!Array.isArray(data.images)) return 'data.images must be an array of { url, caption } images';
  if (data.images.length > MAX_GALLERY_IMAGES) {
    return `data.images holds ${data.images.length} images, more than the ${MAX_GALLERY_IMAGES} a gallery block allows`;
  }

  for (const [i, image] of data.images.entries()) {
    const at = `data.images[${i}]`;
    if (!image || typeof image !== 'object' || Array.isArray(image)) return `${at} is not an object`;

    if (typeof image.url !== 'string' || !image.url.trim()) return `${at}.url is required and must be a string`;
    if (image.url.length > MAX_IMAGE_URL_LENGTH) {
      return `${at}.url is ${image.url.length} characters, longer than the ${MAX_IMAGE_URL_LENGTH} allowed`;
    }
    // Parsed, never pattern-matched: a regex over a URL is how `javascript:`
    // gets in past one (whitespace, control characters, case, nested schemes).
    // The parser decides what the scheme is, and only http/https render as an
    // image a browser will fetch.
    let parsed;
    try {
      parsed = new URL(image.url);
    } catch {
      return `${at}.url is not a URL`;
    }
    if (!IMAGE_URL_PROTOCOLS.includes(parsed.protocol)) {
      return `${at}.url uses the ${parsed.protocol} scheme; only http: and https: image URLs are allowed`;
    }

    if (image.caption != null) {
      if (typeof image.caption !== 'string') return `${at}.caption must be a string`;
      if (image.caption.length > MAX_IMAGE_CAPTION_LENGTH) {
        return `${at}.caption is ${image.caption.length} characters, longer than the ${MAX_IMAGE_CAPTION_LENGTH} allowed`;
      }
    }
  }

  return null;
}

/**
 * The shape rule for one block's `data`, or null if there is nothing to say.
 * Callers have already checked `type` and that `data` is an object; a block
 * whose type has no rules yet (text, attribute, quote, timeline_event) passes.
 */
function blockDataError(block) {
  if (block?.type !== 'gallery') return null;
  const err = galleryDataError(block?.data ?? {});
  return err ? `gallery block: ${err}` : null;
}

const blockSchema = new mongoose.Schema({
  type: { type: String, required: true, enum: BLOCK_TYPES },
  order: { type: Number, required: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
}, { _id: true });

const entitySchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    // A type's name, checked against the writer's workspace registry
    // (lib/entityTypeRegistry.js) — the only gate, so a deleted type stays
    // unusable and a user-defined one is usable. No enum: the names are the
    // workspace's own.
    category: {
      type: String,
      required: true,
      validate: categoryValidator('Entity'),
    },
    summary: { type: String, required: true },
    tags: { type: [String], default: [] },
    blocks: { type: [blockSchema], default: [] },
    relationships: [{ type: mongoose.Schema.Types.ObjectId, ref: 'RelationshipGroup' }],
    open_questions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'OpenQuestion' }],
    workspaceId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

// Every scoped read filters on workspaceId, and the generator's dedup pass
// looks entities up by (workspace, title). This schema declared no indexes at
// all, unlike RelationshipGroup, OpenQuestion and ChangeLog.
entitySchema.index({ workspaceId: 1, title: 1 });

// Account deletion sweeps content by workspaceId once the workspace is gone.
// One inserted after that deletes itself (lib/ownerGuard.js).
entitySchema.plugin(ownerGuard, { path: 'workspaceId', owner: Workspace });

export { BLOCK_TYPES, blockDataError, MAX_GALLERY_IMAGES, MAX_IMAGE_URL_LENGTH, MAX_IMAGE_CAPTION_LENGTH };
export default mongoose.model('Entity', entitySchema, 'entities');
