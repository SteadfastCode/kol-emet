import { ref } from 'vue';
import { getEntities, getEntity, createEntity, updateEntity, deleteEntity } from '../api/entities.js';

export function useEntities() {
  const entities = ref([]);
  const selectedEntity = ref(null);
  const sidebarLoading = ref(false);
  const detailLoading = ref(false);

  async function loadEntities() {
    sidebarLoading.value = true;
    try {
      entities.value = await getEntities();
    } finally {
      sidebarLoading.value = false;
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
