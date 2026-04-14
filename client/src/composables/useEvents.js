import { onMounted, onUnmounted } from 'vue';

const BASE = import.meta.env.VITE_API_BASE ?? '';

export function useEvents({ onEntryCreated, onEntryUpdated, onEntryDeleted } = {}) {
  let es = null;
  let reconnectTimer = null;

  function connect() {
    es = new EventSource(`${BASE}/events`, { withCredentials: true });

    es.addEventListener('entry:created', (e) => {
      try {
        const payload = JSON.parse(e.data);
        onEntryCreated?.(payload);
      } catch { /* ignore parse errors */ }
    });

    es.addEventListener('entry:updated', (e) => {
      try {
        const payload = JSON.parse(e.data);
        onEntryUpdated?.(payload);
      } catch { /* ignore parse errors */ }
    });

    es.addEventListener('entry:deleted', (e) => {
      try {
        const payload = JSON.parse(e.data);
        onEntryDeleted?.(payload);
      } catch { /* ignore parse errors */ }
    });

    es.onerror = () => {
      es.close();
      es = null;
      reconnectTimer = setTimeout(connect, 3000);
    };
  }

  onMounted(connect);

  onUnmounted(() => {
    clearTimeout(reconnectTimer);
    es?.close();
  });
}
