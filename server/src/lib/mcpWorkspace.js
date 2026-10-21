import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { getMcpUser } from './mcpUserStore.js';
// The ranks and the write floor, from the middleware that owns them: /mcp
// never passes through requireWriteRole, but it must refuse on the same rule.
import { ROLE_RANK, WRITE_ROLE } from '../middleware/workspace.js';

/**
 * The workspace the MCP connector acts in — that of its associated user.
 *
 * Throws rather than returning null: every tool that calls this scopes its
 * queries on the result, and a silent undefined would widen those queries to
 * the whole collection instead of narrowing them.
 *
 * Shared by /mcp and /bridge/mcp: the bridge deliberately acts as the same
 * user the connector does (one identity, two tokens — see routes/bridge.js).
 *
 * This is the *read* path and carries no role check — reading is what a viewer
 * is for. A write tool calls `mcpWriteWorkspaceId()` below instead.
 */
export async function mcpWorkspaceId() {
  return (await mcpWorkspace()).workspaceId;
}

/**
 * The same lookup, plus the role the membership carries.
 *
 * `members` was already being read to find the workspace, so the role costs
 * nothing extra — and /mcp is the one front door that never passes through
 * `resolveWorkspace`/`requireWriteRole` (routes/mcp.js has its own bearer
 * check), so without this a viewer who authorized the connector would keep
 * full write access to the graph through Claude while the REST API refused
 * them (KOL-103).
 *
 * @returns {Promise<{ workspaceId: import('mongoose').Types.ObjectId, role: string|null, userId: string }>}
 */
export async function mcpWorkspace() {
  const userId = await getMcpUser();
  if (!userId) throw new Error('MCP connector not authorized — re-authorize in wiki settings');
  const workspace = await Workspace.findOne({ 'members.userId': userId }).select('_id members').lean();
  if (!workspace) throw new Error('No workspace for the MCP-associated user');
  const membership = (workspace.members ?? []).find(m => String(m.userId) === String(userId));
  return { workspaceId: workspace._id, role: membership?.role ?? null, userId: String(userId) };
}

/**
 * What a write tool calls instead of `mcpWorkspaceId()`: the workspace, or a
 * thrown refusal naming the role that was read and the one a write needs.
 *
 * Thrown rather than returned, for the same reason `mcpWorkspaceId()` throws on
 * a missing workspace: the SDK turns a throw into a tool result carrying
 * `isError: true` and this message, which is what the model sees and can
 * explain, while a falsy return would widen the caller's query to the whole
 * collection. Fails closed — a membership with no role at all passes nothing.
 */
export async function mcpWriteWorkspaceId() {
  const { workspaceId, role } = await mcpWorkspace();
  if ((ROLE_RANK[role] ?? 0) < ROLE_RANK[WRITE_ROLE]) {
    throw new Error(
      `NOT_WORKSPACE_EDITOR: this connector is authorized as a user whose role in the workspace is ` +
      `${role ?? 'none'}, and ${WRITE_ROLE} is the floor for any write. Reads still work. ` +
      `Ask a workspace owner to raise the role, or re-authorize the connector as a member who may write.`
    );
  }
  return workspaceId;
}

export async function resolveMcpActor() {
  const userId = await getMcpUser();
  if (!userId) return null;
  const user = await User.findById(userId).select('email').lean();
  if (!user) return null;
  return { type: 'mcp', userId, label: `${user.email} via AI` };
}
