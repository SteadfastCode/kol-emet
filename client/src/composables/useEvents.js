import { onMounted, onUnmounted } from 'vue';

const BASE = import.meta.env.VITE_API_URL ?? '';

// Module-level so the API layer can read it for X-SSE-Client-Id headers
export let sseClientId = null;

export function useEvents({ onEntryCreated, onEntryUpdated, onEntryDeleted } = {}) {
  let es = null;
  let reconnectTimer = null;

  function connect() {
    console.log('[sse] connecting to', `${BASE}/events`);
    es = new EventSource(`${BASE}/events`, { withCredentials: true });

    es.onopen = () => console.log('[sse] connected');

    es.addEventListener('client:id', (e) => {
      try {
        const { clientId } = JSON.parse(e.data);
        sseClientId = clientId;
        console.log('[sse] assigned client id:', clientId);
      } catch (err) { console.error('[sse] parse error (client:id):', err); }
    });

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
      sseClientId = null;
      reconnectTimer = setTimeout(connect, 3000);
    };
  }

  onMounted(connect);

  onUnmounted(() => {
    clearTimeout(reconnectTimer);
    es?.close();
    sseClientId = null;
  });
}
