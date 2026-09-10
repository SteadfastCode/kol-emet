import Workspace from '../models/Workspace.js';
import { getMcpUser } from '../lib/mcpUserStore.js';

/**
 * Resolves the acting user id from either auth path.
 * Session → req.session.userId. Bearer (MCP) → the associated wiki user.
 * Returns null when neither yields a user.
 */
export async function resolveUserId(req) {
  if (req.session?.userId) return req.session.userId;

  const header = req.headers['authorization'] ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token && token === process.env.BEARER_TOKEN) return await getMcpUser();

  return null;
}

/**
 * Sets req.workspaceId to the workspace the caller is acting in.
 *
 * Every scoped query must filter on it, so a missing workspace is a hard 403
 * rather than a silent fall-through to unscoped data — failing closed is the
 * whole point of this middleware.
 *
 * Mounted after requireAuth on every route that touches tenant content — see
 * app.js (chat mounts it per-route). /mcp never passes through here: its tools
 * scope themselves via mcpWorkspaceId() in routes/mcp.js.
 */
export async function resolveWorkspace(req, res, next) {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // A user may later belong to several; today registration creates exactly one.
    const workspace = await Workspace.findOne({ 'members.userId': userId })
      .select('_id')
      .lean();

    if (!workspace) {
      return res.status(403).json({ error: 'No workspace for this user' });
    }

    req.workspaceId = workspace._id;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
