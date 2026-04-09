export function requireAuth(req, res, next) {
  // Session-based auth (browser clients)
  if (req.session?.userId) return next();

  // Bearer token auth (MCP server / programmatic access)
  const header = req.headers['authorization'] ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token && token === process.env.BEARER_TOKEN) return next();

  res.status(401).json({ error: 'Unauthorized' });
}
