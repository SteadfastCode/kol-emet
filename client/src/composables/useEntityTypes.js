import { ref, computed } from 'vue';
import { getEntityTypes } from '../api/entityTypes.js';

/**
 * The workspace's entity types (GET /entity-types) — what the category pills,
 * the pickers and the category colours read, in place of a hardcoded list.
 *
 * State is module-level, like useToasts, so every component shares the one
 * list. WikiLayout loads it when it mounts, and `entity-type:updated` on
 * `/events` keeps it honest after that (KOL-151) — before that frame existed
 * nothing else ever fetched, so a type renamed in another tab left this one
 * rendering a pill no entity carried any more: it matched nothing, and
 * filtering on it silently emptied the sidebar. Each load clears the list
 * first, so a different account signing in on the same tab never sees the
 * previous workspace's types, and a load overtaken by a newer one is discarded.
 *
 * `applyEntityTypeUpdate` is the frame's half of that: the payload carries the
 * whole row, so the shared list is **patched rather than refetched** — the
 * pills, the pickers and the category colours all read this one list, and a
 * request per frame would buy nothing the frame has not already said.
 * `applyEntityTypeCreated` and `applyEntityTypeDeleted` are the same half of
 * the other two frames (KOL-158), which exist because the registry now has a
 * screen (`components/EntityTypeSettings.vue`): a type added or removed in
 * another tab used to leave this one offering a picker without it and a pill
 * for a type that is gone. All three are also what the *writing* tab applies
 * to its own response — it is excluded from its own frames — so one screen's
 * write repaints every pill in the layout without a refetch.
 *
 * An empty registry (a workspace that predates it and was never backfilled with
 * server/scripts/seed-entity-types.js) leaves the pills and pickers empty: the
 * server still accepts the built-in names for such a workspace, but the client
 * no longer carries a copy of them.
 *
 * Tiered debug logging: set localStorage.ENTITY_TYPE_LOG_LEVEL to
 * off | light | normal | verbose (default light). The server logs its side on
 * its own ENTITY_TYPE_LOG_LEVEL.
 *   light   — a failed load, or one that found no types, naming what asked; and
 *             every frame that could not be applied, with why
 *   normal  — light, plus each load and how many types it brought, and each
 *             frame or own write applied: which row changed, from what source
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

/**
 * Replaces one row in the shared list from an `entity-type:updated` frame, or
 * appends it when this tab has never seen it (a type created while the tab was
 * open, then renamed). Re-sorted on the server's own key — `order`, then name —
 * so the pills keep the order `GET /entity-types` would have given them.
 *
 * `source` names the caller, for the log. Returns whether anything changed.
 */
function applyEntityTypeUpdate(row, source = 'unknown') {
  if (!row?._id) {
    log('light', `ignored an entity type update with no _id (source: ${source})`);
    return false;
  }

  const id = String(row._id);
  const idx = types.value.findIndex(t => String(t._id) === id);
  const was = idx === -1 ? null : types.value[idx].name;
  const next = idx === -1 ? [...types.value, row] : types.value.map((t, i) => (i === idx ? row : t));

  types.value = sorted(next);
  log('normal', `applied an entity type update: ${id} ${was === null ? 'was not in this tab\'s list, appended' : `"${was}" →`} "${row.name}" (source: ${source})`);
  return true;
}

/** The server's own key: `order`, then name — the order `GET /entity-types` gives. */
function sorted(rows) {
  return [...rows].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name)));
}

/**
 * Adds a row to the shared list — from an `entity-type:created` frame, or from
 * this tab's own `POST /entity-types` once it has answered (KOL-158).
 *
 * The other half of `applyEntityTypeDeleted` below, and the reason both exist:
 * until the registry had a screen, a tab's copy of it could only go stale by a
 * rename, so the rename frame was the only one KOL-151 needed. Now that a
 * create and a delete are ordinary browser writes, a tab that heard neither
 * would offer a category picker missing the option another tab just added and
 * render a pill for a type that is gone — the registry is loaded once, on
 * mount. Patched from the payload, which carries the whole row, so no frame
 * costs a request.
 *
 * Idempotent on `_id`: a row already here is replaced rather than doubled, so
 * the writing tab applying its own response and a frame arriving for the same
 * row cannot leave two.
 *
 * `source` names the caller, for the log. Returns whether anything changed.
 */
function applyEntityTypeCreated(row, source = 'unknown') {
  if (!row?._id) {
    log('light', `ignored an entity type create with no _id (source: ${source})`);
    return false;
  }

  const id = String(row._id);
  const seen = types.value.some(t => String(t._id) === id);
  types.value = sorted(seen ? types.value.map(t => (String(t._id) === id ? row : t)) : [...types.value, row]);
  log('normal', `applied an entity type create: ${id} "${row.name}"${seen ? ' (already in this tab\'s list, replaced)' : ''} (source: ${source})`);
  return true;
}

/**
 * Drops a row from the shared list — from an `entity-type:deleted` frame, or
 * from this tab's own `DELETE /entity-types/:id` once it has answered.
 *
 * A delete the server allowed is a type nothing in the workspace names (it is
 * 409 otherwise), so there is no entity on screen to repaint; what is left
 * stale is the pill and the picker, and dropping the row is the whole of the
 * repair. A row this tab never had is not a failure — a type created and
 * deleted again while this tab was open — so it is logged and reported false.
 */
function applyEntityTypeDeleted(id, source = 'unknown') {
  if (!id) {
    log('light', `ignored an entity type delete with no id (source: ${source})`);
    return false;
  }

  const wanted = String(id);
  const kept = types.value.filter(t => String(t._id) !== wanted);
  if (kept.length === types.value.length) {
    log('light', `an entity type delete named ${wanted}, which is not in this tab's list (source: ${source})`);
    return false;
  }

  const was = types.value.find(t => String(t._id) === wanted)?.name;
  types.value = kept;
  log('normal', `applied an entity type delete: ${wanted} "${was}" (source: ${source})`);
  return true;
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

  return {
    types, names, styleFor, loadEntityTypes,
    applyEntityTypeUpdate, applyEntityTypeCreated, applyEntityTypeDeleted,
  };
}
