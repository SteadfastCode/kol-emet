import { ref } from 'vue';
import { getEntityPage, getEntity, createEntity, updateEntity, deleteEntity, ENTITY_PAGE_SIZE } from '../api/entities.js';

/**
 * Tiered debug logging: set localStorage.ENTITY_LOAD_LOG_LEVEL to
 * off | light | normal | verbose (default light). The walk is several requests
 * deep, asynchronous and raced against other loads, and none of that is visible
 * in the sidebar — a row that should be there and is not looks the same whether
 * a page failed, a page was discarded as stale, or the workspace simply ends
 * there.
 *   light   — every failed page, naming the load's source, which page it was,
 *             and how much of the workspace was already on screen
 *   normal  — light, plus each load and page that landed (with its source) and
 *             each page discarded because a newer load took the list
 *   verbose — normal, plus the titles each page brought, in order
 */
const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  let setting = null;
  try { setting = localStorage.getItem('ENTITY_LOAD_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((LEVELS[setting] ?? LEVELS.light) >= LEVELS[level]) console.log(`[entityLoad:${level}] ${msg}`);
}

const SESSION_EXPIRED = 'Your session has expired. Sign in again to load the rest of your workspace.';
const LOAD_FAILED = 'Part of your workspace could not be loaded.';

export function useEntities() {
  const entities = ref([]);
  const selectedEntity = ref(null);
  const sidebarLoading = ref(false);
  const detailLoading = ref(false);

  /**
   * How the last load of `entities` ended, when it ended badly (KOL-083):
   * `{ message, status, loaded, total, source }`, or null after a load that
   * walked the whole workspace. The sidebar renders it; see `loadEntities`.
   */
  const loadError = ref(null);

  /**
   * Which `loadEntities` run owns `entities`. A load is several requests now,
   * and the layout starts one from a handful of places — mount, a draft apply,
   * a tag change, a restore, a create — so two can overlap. Without a token the
   * slower run's later pages would append onto the faster run's list and the
   * sidebar would show rows twice. The newest run wins; an older one notices
   * its token is stale and stops writing.
   */
  let loadToken = 0;

  /**
   * The workspace's entities, a page at a time (KOL-067).
   *
   * `GET /entities` used to answer with every row in the workspace in one go,
   * and this is the request that decides how long a workspace takes to open.
   * It now walks pages of `ENTITY_PAGE_SIZE` and appends, and `sidebarLoading`
   * is cleared after the *first* page: the sidebar paints the first 200 rows
   * immediately instead of waiting for the whole workspace, and the rest arrive
   * under it. A partial list is the right thing on screen while more is coming
   * — the search box asks the server rather than this list (KOL-068), the pills
   * narrow what has arrived, and every card opens by id.
   *
   * A failing page keeps what earlier pages already put on screen, rather than
   * rolling the list back to nothing — but it says so (KOL-083). A walk that
   * stops on page 3 of 5 leaves a list that is *indistinguishable from a
   * complete one*: `sidebarLoading` was cleared after page 1, so there is no
   * spinner left to miss, and the count above the list reads as the whole
   * workspace. So the failure is recorded in `loadError` for the sidebar to
   * show, with how many rows of how many are actually there and a retry.
   *
   * It is recorded rather than thrown. A rejection had no catch at any call
   * site — the layout starts most loads without awaiting them — and the one
   * caller that does await (`addEntity`) would have reported a create that
   * succeeded as a failure. `loadError` reaches the one place that can do
   * something about it.
   *
   * @param {string} source names the caller, for the log and the error record
   */
  async function loadEntities(source = 'unknown') {
    const token = ++loadToken;
    sidebarLoading.value = true;
    loadError.value = null;
    const collected = [];
    let after = null;
    let pageNo = 0;
    let total = null;

    try {
      do {
        const page = await getEntityPage({ limit: ENTITY_PAGE_SIZE, after });
        // A newer load has taken over; its pages are the ones that belong in
        // the list, and clearing its loading flag below is its business too.
        if (token !== loadToken) {
          log('normal', `discarded page ${pageNo + 1} of the load from ${source}: a newer load owns the list`);
          return;
        }

        pageNo += 1;
        if (Number.isInteger(page.total)) total = page.total;
        collected.push(...page.items);
        // Replaced rather than mutated: `useFilters` and the virtual list both
        // recompute off the ref, and a new array is the cheap way to say so.
        entities.value = [...collected];
        sidebarLoading.value = false;

        after = page.nextAfter;
        log('normal', `load from ${source}: page ${pageNo} brought ${page.items.length} row(s), ${collected.length} of ${total ?? '?'} on screen`);
        log('verbose', `load from ${source}: page ${pageNo} titles: ${page.items.map((e) => e.title).join(', ')}`);
      } while (after);

      log('normal', `load from ${source} finished: ${collected.length} row(s) over ${pageNo} page(s)`);
    } catch (err) {
      // A superseded run's failure is not this list's problem: the newer run
      // owns both the rows and the banner over them.
      if (token !== loadToken) {
        log('normal', `ignored a failed page ${pageNo + 1} from the load from ${source}: a newer load owns the list (${err.message})`);
        return;
      }
      loadError.value = {
        message: err.status === 401 ? SESSION_EXPIRED : LOAD_FAILED,
        status: err.status ?? null,
        loaded: collected.length,
        total,
        source,
      };
      log('light', `load from ${source} failed on page ${pageNo + 1} with ${collected.length} of ${total ?? '?'} row(s) on screen: ${err.message}`);
    } finally {
      if (token === loadToken) sidebarLoading.value = false;
    }
  }

  async function selectEntity(id) {
    if (!id) { selectedEntity.value = null; return; }
    detailLoading.value = true;
    try {
      selectedEntity.value = await getEntity(id);
    } finally {
      detailLoading.value = false;
    }
  }

  async function addEntity(data) {
    const entity = await createEntity(data);
    await loadEntities('a new entity was created');
    return entity;
  }

  async function editEntity(id, data) {
    const updated = await updateEntity(id, data);
    const idx = entities.value.findIndex(e => e._id === id);
    if (idx !== -1) entities.value[idx] = updated;
    if (selectedEntity.value?._id === id) selectedEntity.value = updated;
    return updated;
  }

  async function removeEntity(id) {
    await deleteEntity(id);
    entities.value = entities.value.filter(e => e._id !== id);
    if (selectedEntity.value?._id === id) selectedEntity.value = null;
  }

  return {
    entities,
    selectedEntity,
    sidebarLoading,
    detailLoading,
    loadError,
    loadEntities,
    selectEntity,
    addEntity,
    editEntity,
    removeEntity,
  };
}
