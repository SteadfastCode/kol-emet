// clients: Map of clientId -> res
const clients = new Map();

// Keep SSE connections alive through proxies
setInterval(() => {
  for (const [clientId, res] of clients) {
    try { res.write('data: ping\n\n'); } catch { clients.delete(clientId); }
  }
}, 30_000);

export function addClient(clientId, res) {
  clients.set(clientId, res);
  console.log(`[sse] client connected (${clientId}) — total: ${clients.size}`);
}

export function removeClient(clientId) {
  clients.delete(clientId);
  console.log(`[sse] client disconnected (${clientId}) — total: ${clients.size}`);
}

export function broadcast(eventName, data, excludeClientId = null) {
  console.log(`[sse] broadcast ${eventName} to ${clients.size} client(s)${excludeClientId ? ` (excluding ${excludeClientId})` : ''}`);
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [clientId, res] of clients) {
    if (clientId === excludeClientId) continue;
    try { res.write(payload); } catch { clients.delete(clientId); }
  }
}
