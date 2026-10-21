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
  // The status rides along, as in api/entities.js: the group walk below reports
  // a page that failed, and "sign in again" is a different sentence from
  // "something went wrong" — which the caller can only tell from the status.
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText}`), { status: res.status });
  return res.status === 204 ? null : res.json();
}

/** The page size the group walk asks for; the server's own cap (GROUP_LIMIT_MAX). */
export const GROUP_PAGE_SIZE = 200;

/**
 * One page of relationship groups, ordered by `_id` (KOL-092).
 *
 * `?limit=` is what opts into the envelope — `{ items, nextAfter }` instead of
 * a bare array — and `after` is the previous page's `nextAfter` verbatim, a
 * bare id (this route's sort is `_id` alone, unlike `/entities`, whose cursor
 * is a title and a tie-break). Passing a cursor the server did not issue is a
 * 400 rather than a silent first page.
 *
 * @param {{ limit?: number, after?: string|null }} opts
 * @returns {Promise<{ items: object[], nextAfter: string|null }>}
 */
export const getGroupPage = ({ limit = GROUP_PAGE_SIZE, after = null } = {}) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (after) params.set('after', after);
  return req(`/relationship-groups?${params}`);
};

/**
 * Every relationship group in the workspace, walked a page at a time and
 * concatenated.
 *
 * This used to be one unbounded request, and it is the request the graph view
 * makes the moment it opens: the route answered with every group in the
 * workspace, each carrying its whole `members` array, in a single
 * `JSON.stringify` on the single event loop every tenant of this API shares
 * (KOL-092). The route now caps a response at `GROUP_PAGE_SIZE`, so the whole
 * set is N requests rather than one — the same bargain `loadEntities` took for
 * the sidebar (KOL-067).
 *
 * A page that fails ends the walk, and the error carries what had already
 * arrived: `partial` (the groups from the pages that landed) and `page` (the
 * one that failed, 1-based). The caller needs both — a graph drawn from three
 * pages of five is *indistinguishable from a complete one*, every node present
 * and some edges simply missing, so "stopped partway" has to be sayable
 * (KOL-083's reasoning, for the graph instead of the sidebar). It is thrown
 * rather than returned because the graph's loader already has a catch for a
 * failed load and an error is where it looks.
 *
 * @param {{ pageSize?: number }} opts
 * @returns {Promise<object[]>} every group, in `_id` order
 */
export async function getAllGroups({ pageSize = GROUP_PAGE_SIZE } = {}) {
  const collected = [];
  let after = null;
  let pageNo = 0;

  do {
    let page;
    try {
      page = await getGroupPage({ limit: pageSize, after });
    } catch (err) {
      throw Object.assign(err, { partial: collected, page: pageNo + 1 });
    }

    pageNo += 1;
    // A server from before the cap answers the bare array however it is asked
    // — the client and the API deploy independently (Netlify and Railway), so a
    // browser on this build can be talking to an older API. Then the array is
    // the whole answer and there is nothing to page.
    if (Array.isArray(page)) return page;

    collected.push(...page.items);
    after = page.nextAfter;
  } while (after);

  return collected;
}

export const createGroup = (data) =>
  req('/relationship-groups', { method: 'POST', body: JSON.stringify(data) });

export const getGroup = (id) =>
  req(`/relationship-groups/${id}`);

export const updateGroupLabel = (id, label) =>
  req(`/relationship-groups/${id}`, { method: 'PATCH', body: JSON.stringify({ label }) });

// data: single { entityId, label?, notes? } or array of them
export const addMember = (groupId, data) => {
  const members = Array.isArray(data) ? data : [data];
  return req(`/relationship-groups/${groupId}/members`, { method: 'POST', body: JSON.stringify({ members }) });
};

export const updateMember = (groupId, entityId, data) =>
  req(`/relationship-groups/${groupId}/members/${entityId}`, { method: 'PATCH', body: JSON.stringify(data) });

export const removeMember = (groupId, entityId) =>
  req(`/relationship-groups/${groupId}/members/${entityId}`, { method: 'DELETE' });

export const deleteGroup = (groupId) =>
  req(`/relationship-groups/${groupId}`, { method: 'DELETE' });

// orderedMembers: [{ refModel, refId }] — full list in new display order
export const reorderMembers = (groupId, orderedMembers) =>
  req(`/relationship-groups/${groupId}/members/reorder`, { method: 'PATCH', body: JSON.stringify({ orderedMembers }) });

export const addSubGroup = (parentGroupId, subGroupId, label = null) =>
  req(`/relationship-groups/${parentGroupId}/subgroups`, { method: 'POST', body: JSON.stringify({ groupId: subGroupId, label }) });

export const removeSubGroup = (parentGroupId, subGroupId) =>
  req(`/relationship-groups/${parentGroupId}/subgroups/${subGroupId}`, { method: 'DELETE' });
