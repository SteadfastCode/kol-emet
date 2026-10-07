import { sseClientId } from '../composables/useEvents.js';

const BASE_URL = import.meta.env.VITE_API_URL ?? '';

async function req(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (sseClientId && options.method && options.method !== 'GET') {
    headers['X-SSE-Client-Id'] = sseClientId;
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers,
  });
  if (res.status === 401) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  if (!res.ok) {
    // The bulk routes refuse in sentences worth showing — "…is on 201
    // entities; one tag operation may change at most 200." — so the body is
    // read for a message before falling back to the status line, and the
    // status is carried on the error either way.
    const body = await res.json().catch(() => null);
    throw Object.assign(
      new Error(body?.error ?? `${res.status} ${res.statusText}`),
      { status: res.status },
    );
  }
  return res.status === 204 ? null : res.json();
}

// A tag is its own name, so it is the path segment; encode it, or a tag
// holding `/`, `#` or `?` would address a different route.
const tagPath = (tag) => `/tags/${encodeURIComponent(tag)}`;

/** Every distinct tag in the workspace, sorted by the server. */
export const getTags = () => req('/tags');

/** Renames `tag` to `to` on every entity in the workspace → `{ renamed }`. */
export const renameTag = (tag, to) =>
  req(tagPath(tag), { method: 'PUT', body: JSON.stringify({ to }) });

/** Removes `tag` from every entity in the workspace → `{ removed }`. */
export const removeTag = (tag) =>
  req(tagPath(tag), { method: 'DELETE' });
