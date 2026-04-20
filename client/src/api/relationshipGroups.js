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
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.status === 204 ? null : res.json();
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
