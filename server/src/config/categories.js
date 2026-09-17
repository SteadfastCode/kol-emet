/**
 * Entity categories on the server: the built-in list, and the lookup that
 * resolves a workspace's own.
 *
 * Categories are user-defined per workspace (Phase 6): the EntityType registry
 * (models/EntityType.js) holds them, and `Entity.category` is checked against
 * it alone (lib/entityTypeRegistry.js) — there is no schema enum any more.
 *
 * CATEGORIES is the worldbuilding template's seed list (config/templates.js),
 * and the names a workspace with no types at all — one that predates the
 * registry, or whose seeding failed — is held to until
 * scripts/seed-entity-types.js backfills it. getCategories() applies the same
 * fallback, so a caller offering it never offers a name the write would refuse.
 */

import EntityType from '../models/EntityType.js';

export const CATEGORIES = [
  'Characters',
  'Worlds',
  'Organizations',
  'Lore & Mechanics',
  'Timeline',
  'Open Questions',
];

/**
 * The names of `workspaceId`'s entity types, in display order (`order`, then
 * name, as GET /entity-types sorts them), or CATEGORIES when it has none.
 *
 * @returns {Promise<string[]>}
 */
export async function getCategories(workspaceId) {
  const types = await EntityType.find({ workspaceId }).sort({ order: 1, name: 1 }).select('name').lean();
  return types.length ? types.map(t => t.name) : CATEGORIES;
}
