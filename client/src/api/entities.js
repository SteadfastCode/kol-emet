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

export const getEntities = () => req('/entities');
export const getEntity = (id) => req(`/entities/${id}`);
export const createEntity = (data) => req('/entities', { method: 'POST', body: JSON.stringify(data) });
export const updateEntity = (id, data) => req(`/entities/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteEntity = (id) => req(`/entities/${id}`, { method: 'DELETE' });
