import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { getMcpUser } from './mcpUserStore.js';

/**
 * The workspace the MCP connector acts in — that of its associated user.
 *
 * Throws rather than returning null: every tool that calls this scopes its
 * queries on the result, and a silent undefined would widen those queries to
 * the whole collection instead of narrowing them.
 *
 * Shared by /mcp and /bridge/mcp: the bridge deliberately acts as the same
 * user the connector does (one identity, two tokens — see routes/bridge.js).
 */
export async function mcpWorkspaceId() {
  const userId = await getMcpUser();
  if (!userId) throw new Error('MCP connector not authorized — re-authorize in wiki settings');
  const workspace = await Workspace.findOne({ 'members.userId': userId }).select('_id').lean();
  if (!workspace) throw new Error('No workspace for the MCP-associated user');
  return workspace._id;
}

export async function resolveMcpActor() {
  const userId = await getMcpUser();
  if (!userId) return null;
  const user = await User.findById(userId).select('email').lean();
  if (!user) return null;
  return { type: 'mcp', userId, label: `${user.email} via AI` };
}
