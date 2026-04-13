import { ref } from 'vue';

export function useNavigation() {
  const breadcrumbs = ref([]);  // [{ id, title }]

  function startNavigation(id, title) {
    breadcrumbs.value = [{ id, title }];
  }

  function pushCrumb(id, title) {
    // Avoid duplicate consecutive crumbs
    const last = breadcrumbs.value.at(-1);
    if (last?.id === id) return;
    breadcrumbs.value.push({ id, title });
  }

  function navigateToIndex(index) {
    breadcrumbs.value = breadcrumbs.value.slice(0, index + 1);
    return breadcrumbs.value[index];
  }

  function clearNavigation() {
    breadcrumbs.value = [];
  }

  return { breadcrumbs, startNavigation, pushCrumb, navigateToIndex, clearNavigation };
}
