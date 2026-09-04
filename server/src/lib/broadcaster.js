// clients: Map of clientId -> { res, workspaceId }
//
// Every payload is workspace-scoped. This is a push channel carrying full
// entity documents, so an unscoped broadcast leaks content across tenants
// exactly as an unscoped query would — the filter here is load-bearing, not
// a nicety.
const clients = new Map();

// Keep SSE connections alive through proxies
setInterval(() => {
  for (const [clientId, { res }] of clients) {
    try { res.write('data: ping\n\n'); } catch { clients.delete(clientId); }
  }
}, 30_000);

export function addClient(clientId, res, workspaceId) {
  clients.set(clientId, { res, workspaceId: String(workspaceId) });
  console.log(`[sse] client connected (${clientId}) — total: ${clients.size}`);
}

export function removeClient(clientId) {
  clients.delete(clientId);
  console.log(`[sse] client disconnected (${clientId}) — total: ${clients.size}`);
}

/**
 * @param {string} eventName
 * @param {object} data
 * @param {{workspaceId: any, excludeClientId?: string|null}} opts
 *
 * workspaceId is required. A missing or unmatched one delivers to nobody
 * rather than to everybody: if a future caller forgets it, the failure is a
 * missing live update, not a cross-tenant disclosure.
 */
export function broadcast(eventName, data, opts = {}) {
  const { workspaceId, excludeClientId = null } = opts;
  const target = workspaceId == null ? null : String(workspaceId);

  if (target === null) {
    console.error(`[sse] refusing to broadcast ${eventName} — no workspaceId supplied`);
    return;
  }

  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  let sent = 0;
  for (const [clientId, { res, workspaceId: clientWs }] of clients) {
    if (clientWs !== target) continue;
    if (clientId === excludeClientId) continue;
    try { res.write(payload); sent++; } catch { clients.delete(clientId); }
  }
  console.log(`[sse] broadcast ${eventName} to ${sent}/${clients.size} client(s) in workspace ${target}${excludeClientId ? ` (excluding ${excludeClientId})` : ''}`);
}
