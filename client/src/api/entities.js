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

/**
 * Every entity in the workspace, in one unbounded response — the shape this
 * route has always had, kept for the callers that want the whole graph at once
 * (the graph view builds its node set from it). Prefer `getEntityPage` for
 * anything a person is waiting on.
 */
export const getEntities = () => req('/entities');

/** The page size `loadEntities` walks the workspace in; the server's own cap. */
export const ENTITY_PAGE_SIZE = 200;

/**
 * One page of entities, ordered by title: the paged variant (KOL-067).
 *
 * `?limit=` is what opts into the envelope — `{ items, nextAfter, total }`
 * instead of a bare array — so this function and `getEntities` above hit the
 * same route and get different shapes on purpose. `after` is the previous
 * page's `nextAfter` verbatim, sent back as the two fields it is made of;
 * passing a cursor the server did not issue is a 400 rather than a silent
 * first page.
 *
 * @param {{ limit?: number, after?: { title: string, _id: string }|null }} opts
 * @returns {Promise<{ items: object[], nextAfter: { title: string, _id: string }|null, total: number }>}
 */
export const getEntityPage = ({ limit = ENTITY_PAGE_SIZE, after = null } = {}) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (after) {
    params.set('after[title]', after.title);
    params.set('after[_id]', after._id);
  }
  return req(`/entities?${params}`);
};

/**
 * The workspace's entities matching a keyword, as `GET /entities?q=` matches it
 * (KOL-068): case-insensitively, literally, against a title, a summary, **or
 * any block's markdown**.
 *
 * That last clause is the whole reason this function exists. The browser does
 * not have block content — the list route projects it away (`LIST_FIELDS` in
 * server/src/routes/entities.js) — so a word that lives only in an entity's
 * text could not be searched in the browser at all, however the loaded list was
 * filtered. Asking the server is the only place that word is known.
 *
 * Deliberately unpaged: no `?limit=`, so the response is the bare array this
 * route has always answered rather than `getEntityPage`'s envelope. A result
 * set is a search's whole answer, and `useFilters` narrows it with the category
 * and tag pills in the browser — a page boundary would make a pill able to hide
 * rows that exist. The route's own regex escaping and length cap bound the work
 * (server/src/lib/searchFilter.js).
 *
 * The rows come back under the list projection, so they carry no `blocks`:
 * `useFilters` is what works out which of them matched out of sight.
 */
export const searchEntities = (term) =>
  req(`/entities?q=${encodeURIComponent(term)}`);

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

/**
 * The deleted entities this workspace can still put back (KOL-060) — newest
 * first, ≤50, and only for as long as their snapshots live (the ChangeLog TTL's
 * 30 days). Each is `{ _id (the log entry), entityId, entityTitle, category,
 * actorLabel, actorType, createdAt }`, plus `snapshotCategoryMissing` when the
 * type it was saved under is gone, as on a history entry. An id that is live
 * again is not listed: restoring over it is refused.
 */
export const getDeletedEntities = () => req('/deleted');

/**
 * Puts a deleted entity back from its `deleted` log entry: the same route a
 * rollback uses, which recreates the document at `entityId` when nothing is
 * live there. 409 when that id is live again, or when the snapshot's entity
 * type is gone and no `category` was named — `body.availableCategories` holds
 * the ones to choose from, exactly as for a rollback.
 *
 * Its relationships are NOT rebuilt: the delete pruned the groups it was in.
 */
export const restoreEntity = (entityId, logId, { category } = {}) =>
  rollbackEntity(entityId, logId, { category });
