const BASE_URL = import.meta.env.VITE_API_URL ?? '';

async function req(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (res.status === 401) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.status === 204 ? null : res.json();
}

export const getRelationshipTypes = (q) =>
  req(`/relationship-types${q ? `?q=${encodeURIComponent(q)}` : ''}`);

export const createRelationshipType = (data) =>
  req('/relationship-types', { method: 'POST', body: JSON.stringify(data) });

export const updateRelationshipType = (id, data) =>
  req(`/relationship-types/${id}`, { method: 'PUT', body: JSON.stringify(data) });

export const deleteRelationshipType = (id) =>
  req(`/relationship-types/${id}`, { method: 'DELETE' });
