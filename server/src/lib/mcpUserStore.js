// Stores the userId of the wiki user who authorized the MCP connector via OAuth.
// Reset on server restart — user must re-authorize after deploy.
let mcpUserId = null;

export function setMcpUser(userId) {
  mcpUserId = String(userId);
}

export function getMcpUser() {
  return mcpUserId;
}
