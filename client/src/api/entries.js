const HEADERS = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${import.meta.env.VITE_BEARER_TOKEN}`,
};

async function req(url, options = {}) {
  const res = await fetch(url, { ...options, headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.status === 204 ? null : res.json();
}

export const getEntries = () => req('/entries');
export const createEntry = (data) => req('/entries', { method: 'POST', body: JSON.stringify(data) });
export const updateEntry = (id, data) => req(`/entries/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteEntry = (id) => req(`/entries/${id}`, { method: 'DELETE' });
