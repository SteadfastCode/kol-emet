import { ref, computed } from 'vue';
import { getEntityTypes } from '../api/entityTypes.js';

/**
 * The workspace's entity types (GET /entity-types) — what the category pills,
 * the pickers and the category colours read, in place of a hardcoded list.
 *
 * State is module-level, like useToasts, so every component shares the one
 * list. WikiLayout loads it when it mounts; nothing else fetches. Each load
 * clears the list first, so a different account signing in on the same tab
 * never sees the previous workspace's types, and a load overtaken by a newer
 * one is discarded.
 *
 * An empty registry (a workspace that predates it and was never backfilled with
 * server/scripts/seed-entity-types.js) leaves the pills and pickers empty: the
 * server still accepts the built-in names for such a workspace, but the client
 * no longer carries a copy of them.
 *
 * Tiered debug logging: set localStorage.ENTITY_TYPE_LOG_LEVEL to
 * off | light | normal | verbose (default light). The server logs its side on
 * its own ENTITY_TYPE_LOG_LEVEL.
 *   light   — a failed load, or one that found no types, naming what asked
 *   normal  — light, plus each load and how many types it brought
 *   verbose — normal, plus the names in order
 */

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  let setting = null;
  try { setting = localStorage.getItem('ENTITY_TYPE_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((LEVELS[setting] ?? LEVELS.light) >= LEVELS[level]) console.log(`[entityTypes:${level}] ${msg}`);
}

// What a category the registry lacks is painted with — the colours every
// unknown category has always had.
const FALLBACK = { bg: '#333', color: '#aaa' };

const types = ref([]);
let latest = 0;

/** Fetches the registry, replacing the shared list. `source` names the caller, for the log. */
async function loadEntityTypes(source = 'unknown') {
  const seq = ++latest;
  types.value = [];
  try {
    const fetched = await getEntityTypes();
    if (seq !== latest) {
      log('normal', `discarded a load from ${source}: a newer one started`);
      return;
    }
    types.value = Array.isArray(fetched) ? fetched : [];
    if (!types.value.length) {
      log('light', `no entity types for this workspace (load from ${source}); pills and pickers are empty until server/scripts/seed-entity-types.js backfills it`);
    } else {
      log('normal', `loaded ${types.value.length} entity type(s) (load from ${source})`);
    }
    log('verbose', `entity types in order: ${types.value.map(t => t.name).join(', ')}`);
  } catch (err) {
    if (seq !== latest) return;
    log('light', `loading entity types failed (load from ${source}): ${err.message}`);
  }
}

export function useEntityTypes() {
  const names = computed(() => types.value.map(t => t.name));

  /**
   * `{ bg, color }` for a category name, from the registry's `{ bg, text }`;
   * each half the registry lacks comes from `fallback`.
   */
  function styleFor(name, fallback = FALLBACK) {
    const c = types.value.find(t => t.name === name)?.color;
    return { bg: c?.bg || fallback.bg, color: c?.text || fallback.color };
  }

  return { types, names, styleFor, loadEntityTypes };
}
