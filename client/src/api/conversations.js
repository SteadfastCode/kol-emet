const BASE_URL = import.meta.env.VITE_API_URL ?? '';

async function req(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers,
  });
  if (res.status === 401) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.status === 204 ? null : res.json();
}

export const listConversations   = ()         => req('/conversations');
export const createConversation  = (data)     => req('/conversations', { method: 'POST', body: JSON.stringify(data) });
export const getConversation     = (id)       => req(`/conversations/${id}`);
export const renameConversation  = (id, title) => req(`/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
export const deleteConversation  = (id)       => req(`/conversations/${id}`, { method: 'DELETE' });
export const generateTitle       = (id)       => req(`/conversations/${id}/title`, { method: 'POST' });
