import { ref } from 'vue';
import { getEntityPage, getEntity, createEntity, updateEntity, deleteEntity, ENTITY_PAGE_SIZE } from '../api/entities.js';

export function useEntities() {
  const entities = ref([]);
  const selectedEntity = ref(null);
  const sidebarLoading = ref(false);
  const detailLoading = ref(false);

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
   * — `useFilters` searches what is loaded, and every card opens by id.
   *
   * A failing page rejects, as the single request did. What earlier pages
   * already put on screen stays there rather than being rolled back to nothing.
   */
  async function loadEntities() {
    const token = ++loadToken;
    sidebarLoading.value = true;
    const collected = [];
    let after = null;

    try {
      do {
        const page = await getEntityPage({ limit: ENTITY_PAGE_SIZE, after });
        // A newer load has taken over; its pages are the ones that belong in
        // the list, and clearing its loading flag below is its business too.
        if (token !== loadToken) return;

        collected.push(...page.items);
        // Replaced rather than mutated: `useFilters` and the virtual list both
        // recompute off the ref, and a new array is the cheap way to say so.
        entities.value = [...collected];
        sidebarLoading.value = false;

        after = page.nextAfter;
      } while (after);
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
    await loadEntities();
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
    loadEntities,
    selectEntity,
    addEntity,
    editEntity,
    removeEntity,
  };
}
