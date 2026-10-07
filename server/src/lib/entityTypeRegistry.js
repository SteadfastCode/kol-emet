/**
 * The EntityType registry as the write-time gate on category names — the only
 * one, now that `Entity.category` has no enum (Phase 6 step 2).
 *
 * Two things hold a category name: `Entity.category`, and a RelationshipType's
 * `sourceCategory`/`targetCategory`. Both schemas validate through
 * `categoryValidator` below, so every write path — the REST routes, the MCP
 * tools, applying a draft, a changelog rollback — refuses a name the writer's
 * workspace has no type for. The reverse direction lives in
 * routes/entityTypes.js: a type something still uses cannot be deleted, and
 * renaming one carries the new name to everything that used the old one, so the
 * registry and the data cannot drift apart.
 *
 * A workspace with no types at all predates the registry (or its seeding failed
 * at registration) and is checked against the built-in CATEGORIES until
 * scripts/seed-entity-types.js backfills it — the names the enum used to allow,
 * so such a workspace keeps working exactly as before. The route never lets a
 * workspace delete its last type, so an emptied registry cannot reopen that
 * fallback.
 *
 * `registeredCategories` is the same read without a name to check, for a
 * caller that needs the whole list — the history route marks a page of change
 * log entries against one read of it, and the rollback route puts it in a 409
 * so the caller can see what is left to choose from.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * ENTITY_TYPE_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — a read served by the pre-registry fallback, and a write
 *             refused for want of a workspace to check against
 *   normal  — light, plus every name refused because the workspace lacks it
 *   verbose — normal, plus every name accepted, and every whole-list read
 */

import EntityType from '../models/EntityType.js';
import { CATEGORIES } from '../config/categories.js';

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so a test can change it.
  const active = LEVELS[process.env.ENTITY_TYPE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[entityTypeRegistry:${level}] ${msg}`);
}

/**
 * Every category name `workspaceId` accepts, in registry order — or the
 * built-in `CATEGORIES` when the workspace has no types at all, which is the
 * pre-registry fallback described above. One read; `source` says who asked.
 *
 * Callers that check many names (a page of change log entries) take this once
 * rather than calling `isRegisteredCategory` per name.
 */
export async function registeredCategories(workspaceId, source) {
  const names = (await EntityType.find({ workspaceId }).sort({ order: 1, name: 1 }).select('name').lean()).map(t => t.name);

  if (!names.length) {
    log('light', `workspace ${workspaceId} has no entity types, so the built-in categories stand in (source: ${source}; backfill with scripts/seed-entity-types.js)`);
    return CATEGORIES;
  }

  log('verbose', `workspace ${workspaceId} accepts ${names.length} name(s): ${names.join(', ')} (source: ${source})`);
  return names;
}

/**
 * Whether `name` names an entity type in `workspaceId`'s registry — exactly,
 * since that is how `Entity.category` stores it. `source` says who is asking,
 * for the log.
 */
export async function isRegisteredCategory(workspaceId, name, source) {
  const ok = (await registeredCategories(workspaceId, source)).includes(name);
  log(ok ? 'verbose' : 'normal', `"${name}" ${ok ? 'accepted' : 'refused — not a type'} in workspace ${workspaceId} (source: ${source})`);
  return ok;
}

/**
 * A mongoose `validate` spec for a path holding a category name. `model` names
 * the schema in the log and the error.
 *
 * Document validation (create, save, insertMany) reads the document's own
 * workspaceId. Update validation binds `this` to the query, so the workspace
 * comes from the filter — which every scoped update already carries. An update
 * whose filter names no workspace cannot be checked and is refused: that is a
 * tenancy bug in the caller, not a reason to let the name through.
 */
export function categoryValidator(model) {
  return {
    async validator(name) {
      if (name == null) return true; // `required` is a separate validator
      const isQuery = typeof this?.getFilter === 'function';
      const workspaceId = isQuery ? this.getFilter().workspaceId : this?.workspaceId;
      if (workspaceId === undefined) {
        log('light', `refused "${name}" on ${model}: the ${isQuery ? 'update filter' : 'document'} names no workspace (source: ${model} ${isQuery ? 'update' : 'save'})`);
        return false;
      }
      return isRegisteredCategory(workspaceId, name, `${model} ${isQuery ? 'update' : 'save'}`);
    },
    message: props => `"${props.value}" is not an entity type in this workspace`,
  };
}
