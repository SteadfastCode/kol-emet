import { ref } from 'vue';
import { getRelationshipTypes, createRelationshipType } from '../api/relationshipTypes.js';

export function useRelationshipTypes() {
  const types = ref([]);
  const loading = ref(false);

  async function fetchTypes() {
    loading.value = true;
    try {
      types.value = await getRelationshipTypes();
    } finally {
      loading.value = false;
    }
  }

  async function addType(name, sourceCategory = null, targetCategory = null) {
    const result = await createRelationshipType({ name, sourceCategory, targetCategory });
    await fetchTypes();  // refresh list
    return result;       // may include { warning } if near-duplicate
  }

  return { types, loading, fetchTypes, addType };
}
