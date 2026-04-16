const BASE_URL = import.meta.env.VITE_API_URL ?? '';

export async function getProviders() {
  const res = await fetch(`${BASE_URL}/chat/providers`, { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Stream a chat completion. Yields event objects:
 *   { type: 'delta',  content: string }
 *   { type: 'done' }
 *   { type: 'error',  message: string }
 */
export async function* streamChat({ provider, model, messages, conversationId }) {
  const res = await fetch(`${BASE_URL}/chat`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model, messages, conversationId }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // hold back incomplete line

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          yield JSON.parse(line.slice(6));
        } catch {
          // malformed chunk — skip
        }
      }
    }
  }
}
