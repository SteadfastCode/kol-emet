const clients = new Set();

// Keep SSE connections alive through proxies
setInterval(() => {
  for (const res of clients) {
    try { res.write('data: ping\n\n'); } catch { clients.delete(res); }
  }
}, 30_000);

export function addClient(res) {
  clients.add(res);
  console.log(`[sse] client connected — total: ${clients.size}`);
}

export function removeClient(res) {
  clients.delete(res);
  console.log(`[sse] client disconnected — total: ${clients.size}`);
}

export function broadcast(eventName, data) {
  console.log(`[sse] broadcast ${eventName} to ${clients.size} client(s)`);
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}
