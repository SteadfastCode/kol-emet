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
    // Some refusals carry what the caller needs to recover and are worth
    // showing as written — a 409 from a rollback names the entity type the
    // snapshot was saved under and the ones the workspace has now — so the
    // body is read for a message and rides along on the error, as in
    // api/tags.js. Status and body both, since the body is what a picker reads.
    const body = await res.json().catch(() => null);
    throw Object.assign(
      new Error(body?.error ?? `${res.status} ${res.statusText}`),
      { status: res.status, body },
    );
  }
  return res.status === 204 ? null : res.json();
}

export const getEntities = () => req('/entities');
export const getEntity = (id) => req(`/entities/${id}`);
export const createEntity = (data) => req('/entities', { method: 'POST', body: JSON.stringify(data) });
export const updateEntity = (id, data) => req(`/entities/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteEntity = (id) => req(`/entities/${id}`, { method: 'DELETE' });

/**
 * The entity's recent changes, newest first (≤50, ≤30 days — the ChangeLog
 * TTL). An entry the server marks `snapshotCategoryMissing` was saved under an
 * entity type the workspace no longer has, and restoring it needs a category
 * named below.
 */
export const getEntityHistory = (id) => req(`/entities/${id}/history`);

/**
 * Restores the entity from a log entry's snapshot. `category` is the one field
 * of a snapshot a rollback overrides: send one when the snapshot's own type was
 * renamed or deleted, or the server answers 409 with `snapshotCategory` and
 * `availableCategories` on the error's `body`.
 */
export const rollbackEntity = (id, logId, { category } = {}) =>
  req(`/entities/${id}/rollback/${logId}`, {
    method: 'POST',
    body: JSON.stringify(category ? { category } : {}),
  });
