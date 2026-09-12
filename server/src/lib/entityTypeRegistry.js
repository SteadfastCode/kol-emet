/**
 * The EntityType registry as a write-time gate — what keeps the registry and
 * the data from drifting apart while `Entity.category` still has its enum.
 *
 * Two things hold a category name: `Entity.category`, and a RelationshipType's
 * `sourceCategory`/`targetCategory`. Both schemas validate through
 * `categoryValidator` below, so every write path — the REST routes, the MCP
 * tools, applying a draft, a changelog rollback — refuses a name the writer's
 * workspace has no type for, the same way the enum refuses a name outside it.
 * The reverse direction lives in routes/entityTypes.js: a type something still
 * uses cannot be renamed or deleted, and a type's name must be one the enum
 * accepts (`canonicalCategory`), so every registered type is usable.
 *
 * A workspace with no types at all predates the registry (or its seeding failed
 * at registration) and is checked against the enum alone until
 * scripts/seed-entity-types.js backfills it. The route never lets a workspace
 * delete its last type, so an emptied registry cannot reopen that fallback.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * ENTITY_TYPE_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — a write allowed only by the pre-registry fallback, and a write
 *             refused for want of a workspace to check against
 *   normal  — light, plus every name refused because the workspace lacks it
 *   verbose — normal, plus every name accepted
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
 * The enum's spelling of `name`, matched case-insensitively, or null when the
 * enum has no such category. A registered type must be usable by an entity, so
 * while the enum stands a type's name is one of its values.
 */
export function canonicalCategory(name) {
  const wanted = String(name).trim().toLowerCase();
  return CATEGORIES.find(c => c.toLowerCase() === wanted) ?? null;
}

/**
 * Whether `name` names an entity type in `workspaceId`'s registry — exactly,
 * since that is how `Entity.category` stores it. `source` says who is asking,
 * for the log.
 */
export async function isRegisteredCategory(workspaceId, name, source) {
  const names = (await EntityType.find({ workspaceId }).select('name').lean()).map(t => t.name);

  if (!names.length) {
    log('light', `workspace ${workspaceId} has no entity types, so "${name}" was checked against the built-in categories only (source: ${source}; backfill with scripts/seed-entity-types.js)`);
    return true;
  }

  const ok = names.includes(name);
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
