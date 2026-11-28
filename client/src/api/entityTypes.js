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
    // Every refusal this registry can give is a sentence a person has to read
    // to recover from it — "3 entities use \"Characters\"", "a workspace keeps
    // at least one entity type", the 413 naming the count and the limit — so
    // the body is read for a message and rides along on the error, as in
    // api/entities.js and api/tags.js. Status and body both: the settings
    // screen shows the counts a 409 carries beside the row that was refused.
    const body = await res.json().catch(() => null);
    throw Object.assign(
      new Error(body?.error ?? `${res.status} ${res.statusText}`),
      { status: res.status, body },
    );
  }
  return res.status === 204 ? null : res.json();
}

// The workspace's entity types, sorted by `order` then name.
export const getEntityTypes = () => req('/entity-types');

/**
 * Adds a type → the created row, with a `warning` when a near-duplicate name
 * already exists (the server still creates it; see `EntityTypeSettings.vue`,
 * which shows that warning beside the row it just gained).
 *
 * `name` is trimmed by the server, and 409 means a type already has it.
 *
 * @param {{ name: string, icon?: string|null, color?: { bg?: string|null, text?: string|null }|null, order?: number }} type
 */
export const createEntityType = (type) =>
  req('/entity-types', { method: 'POST', body: JSON.stringify(type) });

/**
 * Updates any of `name`, `icon`, `color` (either half) and `order` → the
 * updated row, with `relabelled: { entities, sourceCategories, targetCategories }`
 * when the name changed.
 *
 * A rename cascades on the server: every entity and relationship type in the
 * workspace that held the old name takes the new one (KOL-151), which is why a
 * caller that holds an entity list refetches it afterwards. 409 means another
 * type has the new name; 413 means the cascade would move too many entities,
 * and nothing at all was written.
 *
 * @param {string} id
 * @param {{ name?: string, icon?: string|null, color?: { bg?: string|null, text?: string|null }|null, order?: number }} patch
 */
export const updateEntityType = (id, patch) =>
  req(`/entity-types/${id}`, { method: 'PUT', body: JSON.stringify(patch) });

/**
 * Removes a type → null (204).
 *
 * 409 while anything in the workspace still names it — the body carries
 * `{ error, inUse, entities, relationshipTypes }` — and 409 for a workspace's
 * last type. Nothing is reassigned: the refusal stands.
 */
export const deleteEntityType = (id) =>
  req(`/entity-types/${id}`, { method: 'DELETE' });
