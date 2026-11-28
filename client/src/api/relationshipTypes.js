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
    // Status *and* parsed body on the error, as in api/entityTypes.js: every
    // refusal this route gives is a sentence a person has to read to recover
    // from it — the 409 names the type that already holds the name and carries
    // it as `existing`, the 400 names the scopes that are allowed — and the
    // settings screen shows those words beside the row that was refused.
    const body = await res.json().catch(() => null);
    throw Object.assign(
      new Error(body?.error ?? `${res.status} ${res.statusText}`),
      { status: res.status, body },
    );
  }
  return res.status === 204 ? null : res.json();
}

/**
 * The two `scope` values a relationship type can have, and what each names.
 *
 * A relationship carries labels in two places and they are different
 * vocabularies (`server/src/models/RelationshipType.js`): the GROUP has a label
 * — "Marriage", "Depends on" — and each MEMBER of that group has its own —
 * "Wife", "Dependency". `scope` is the discriminator, and it is what lets a
 * label field offer the right half: a group label is never offered a member
 * role. The generator already splits the two to name its edges
 * (`server/src/lib/generator.js`).
 */
export const SCOPES = ['group', 'member'];

/** What each scope is called on screen, singular. */
export const SCOPE_LABELS = { group: 'Group label', member: 'Member role' };

/**
 * The workspace's label vocabulary, sorted by name.
 *
 * `?q=` fuzzy-filters by name on the server (trigram similarity ≥ 0.3, or a
 * substring match). The suggestion lists do not use it: a workspace's
 * vocabulary is small, the whole list arrives in one request, and filtering a
 * list already in hand is what makes a keystroke free.
 *
 * @param {{ q?: string }} [opts]
 * @returns {Promise<Array<{ _id: string, name: string, scope: 'group'|'member', sourceCategory: string|null, targetCategory: string|null }>>}
 */
export const getRelationshipTypes = ({ q } = {}) =>
  req(`/relationship-types${q ? `?q=${encodeURIComponent(q)}` : ''}`);

/**
 * Adds a type → the created row, with a `warning` when a near-duplicate name
 * already exists (the server still creates it; `RelationshipTypeSettings.vue`
 * shows that warning beside the row it just gained).
 *
 * `name` is trimmed by the server. 409 means a type already holds the name,
 * **in either scope** — the check has never been per-scope — and the body
 * carries it as `existing`. `scope` is validated against `SCOPES`: anything
 * else is a 400 and nothing is written (KOL-159). Omitting it leaves the
 * model's `member` default, which is what every create got before KOL-159
 * whatever it sent.
 *
 * @param {{ name: string, scope?: 'group'|'member', sourceCategory?: string|null, targetCategory?: string|null }} type
 */
export const createRelationshipType = (type) =>
  req('/relationship-types', { method: 'POST', body: JSON.stringify(type) });

/**
 * Updates any of `name`, `scope`, `sourceCategory` and `targetCategory` → the
 * updated row.
 *
 * Nothing cascades: the labels already stored on groups and members are plain
 * strings and keep the old name (see the KOL-159 Decision Log entry — a cascade
 * needs an audit trail relationship writes do not have).
 *
 * @param {string} id
 * @param {{ name?: string, scope?: 'group'|'member', sourceCategory?: string|null, targetCategory?: string|null }} patch
 */
export const updateRelationshipType = (id, patch) =>
  req(`/relationship-types/${id}`, { method: 'PUT', body: JSON.stringify(patch) });

/** Removes a type → null (204). Labels already using its name are untouched. */
export const deleteRelationshipType = (id) =>
  req(`/relationship-types/${id}`, { method: 'DELETE' });
