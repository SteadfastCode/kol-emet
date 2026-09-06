import { sseClientId } from '../composables/useEvents.js';

const BASE_URL = import.meta.env.VITE_API_URL ?? '';

async function req(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (sseClientId && options.method && options.method !== 'GET') {
    headers['X-SSE-Client-Id'] = sseClientId;
  }
  const res = await fetch(`${BASE_URL}${path}`, { ...options, credentials: 'include', headers });

  if (res.status === 401) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  if (!res.ok) {
    // 402 (allowance) and 409 (already running) carry a body worth showing.
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `${res.status} ${res.statusText}`), {
      status: res.status,
      body,
    });
  }
  return res.status === 204 ? null : res.json();
}

export const listDrafts   = ()   => req('/drafts');
export const getDraft     = (id) => req(`/drafts/${id}`);
export const getAllowance = ()   => req('/drafts/quota');
export const discardDraft = (id) => req(`/drafts/${id}`, { method: 'DELETE' });

export const decideItem = (draftId, itemId, body) =>
  req(`/drafts/${draftId}/items/${itemId}`, { method: 'PATCH', body: JSON.stringify(body) });

export const retargetItem = (draftId, itemId, targetEntityId) =>
  req(`/drafts/${draftId}/items/${itemId}/retarget`, {
    method: 'POST', body: JSON.stringify({ targetEntityId }),
  });

export const acceptClean = (draftId) =>
  req(`/drafts/${draftId}/decide-clean`, { method: 'POST' });

export const applyDraft = (draftId) =>
  req(`/drafts/${draftId}/apply`, { method: 'POST' });

/**
 * Start a generation, yielding progress events:
 *   { type: 'created', draftId }
 *   { type: 'stage',   stage, chunk?, of? }
 *   { type: 'done',    draftId, counts, route, budget }
 *   { type: 'error',   message }
 *
 * Validation and allowance failures arrive as ordinary HTTP errors BEFORE the
 * stream opens, so they throw rather than appearing as an error event — the
 * caller only has to handle SSE errors for genuine mid-run failures.
 *
 * Abandoning this generator does not cancel the run: the server finishes and
 * saves it, because the provider has already been paid for those tokens.
 */
export async function* streamDraft({ text, provider, roleStyle }) {
  const res = await fetch(`${BASE_URL}/drafts`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, provider, roleStyle }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `${res.status} ${res.statusText}`), {
      status: res.status,
      body,
    });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try { yield JSON.parse(line.slice(6)); } catch { /* malformed chunk */ }
      }
    }
  }
}
