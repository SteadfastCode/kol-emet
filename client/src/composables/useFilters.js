import { ref, computed } from 'vue';

export function useFilters(entries) {
  const searchQuery = ref('');
  const activeCat = ref('All');
  const activeTag = ref(null);

  const filtered = computed(() => {
    const q = searchQuery.value.toLowerCase().trim();
    return entries.value.filter(e => {
      if (activeCat.value !== 'All' && e.category !== activeCat.value) return false;
      if (activeTag.value && !e.tags.map(t => t.toLowerCase()).includes(activeTag.value.toLowerCase())) return false;
      if (q) {
        const hay = [e.title, e.summary, ...(e.tags ?? [])].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  function setCat(cat) { activeCat.value = cat; activeTag.value = null; }
  function setTag(tag) { activeTag.value = tag; activeCat.value = 'All'; }
  function clearTag() { activeTag.value = null; }

  return { searchQuery, activeCat, activeTag, filtered, setCat, setTag, clearTag };
}
