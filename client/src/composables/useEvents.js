import { onMounted, onUnmounted } from 'vue';

const BASE = import.meta.env.VITE_API_URL ?? '';

export function useEvents({ onEntryCreated, onEntryUpdated, onEntryDeleted } = {}) {
  let es = null;
  let reconnectTimer = null;

  function connect() {
    console.log('[sse] connecting to', `${BASE}/events`);
    es = new EventSource(`${BASE}/events`, { withCredentials: true });

    es.onopen = () => console.log('[sse] connected');

    es.addEventListener('entry:created', (e) => {
      console.log('[sse] entry:created', e.data);
      try {
        const payload = JSON.parse(e.data);
        onEntryCreated?.(payload);
      } catch (err) { console.error('[sse] parse error (created):', err); }
    });

    es.addEventListener('entry:updated', (e) => {
      console.log('[sse] entry:updated', e.data);
      try {
        const payload = JSON.parse(e.data);
        onEntryUpdated?.(payload);
      } catch (err) { console.error('[sse] parse error (updated):', err); }
    });

    es.addEventListener('entry:deleted', (e) => {
      console.log('[sse] entry:deleted', e.data);
      try {
        const payload = JSON.parse(e.data);
        onEntryDeleted?.(payload);
      } catch (err) { console.error('[sse] parse error (deleted):', err); }
    });

    es.onerror = (err) => {
      console.warn('[sse] error / disconnected, readyState:', es?.readyState, err);
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
