import { ref } from 'vue';
import { getEntries, getEntry, createEntry, updateEntry, deleteEntry } from '../api/entries.js';

export function useEntries() {
  const entries = ref([]);
  const selectedEntry = ref(null);
  const sidebarLoading = ref(false);
  const detailLoading = ref(false);

  async function loadEntries() {
    sidebarLoading.value = true;
    try {
      entries.value = await getEntries();
    } finally {
      sidebarLoading.value = false;
    }
  }

  async function selectEntry(id) {
    if (!id) { selectedEntry.value = null; return; }
    detailLoading.value = true;
    try {
      selectedEntry.value = await getEntry(id);
    } finally {
      detailLoading.value = false;
    }
  }

  async function addEntry(data) {
    const entry = await createEntry(data);
    await loadEntries();
    return entry;
  }

  async function editEntry(id, data) {
    const updated = await updateEntry(id, data);
    const idx = entries.value.findIndex(e => e._id === id);
    if (idx !== -1) entries.value[idx] = updated;
    if (selectedEntry.value?._id === id) selectedEntry.value = updated;
    return updated;
  }

  async function removeEntry(id) {
    await deleteEntry(id);
    entries.value = entries.value.filter(e => e._id !== id);
    if (selectedEntry.value?._id === id) selectedEntry.value = null;
  }

  return {
    entries,
    selectedEntry,
    sidebarLoading,
    detailLoading,
    loadEntries,
    selectEntry,
    addEntry,
    editEntry,
    removeEntry,
  };
}
