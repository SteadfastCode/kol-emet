import User from '../models/User.js';
import { getMcpUser } from '../lib/mcpUserStore.js';

export function requireAuth(req, res, next) {
  // Session-based auth (browser clients)
  if (req.session?.userId) return next();

  // Bearer token auth (MCP server / programmatic access)
  const header = req.headers['authorization'] ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token && token === process.env.BEARER_TOKEN) return next();

  res.status(401).json({ error: 'Unauthorized' });
}

// Resolves req.actor for write operations.
// Session → { type: 'user', userId, label: email }
// Bearer  → { type: 'mcp',  userId, label: "email via AI" }
// Bearer with no associated user → 401 (must re-authorize)
export async function requireActor(req, res, next) {
  try {
    const header = req.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const isMcp = token && token === process.env.BEARER_TOKEN;

    let userId;
    let actorType;

    if (isMcp) {
      userId = getMcpUser();
      if (!userId) {
        return res.status(401).json({ error: 'MCP connector not authorized — re-authorize in wiki settings' });
      }
      actorType = 'mcp';
    } else {
      userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      actorType = 'user';
    }

    const user = await User.findById(userId).select('email').lean();
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    req.actor = {
      type:    actorType,
      userId,
      label:   actorType === 'mcp' ? `${user.email} via AI` : user.email,
    };
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
