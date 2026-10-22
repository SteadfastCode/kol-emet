/**
 * Read-only MCP sessions: what the in-app assistant's relay may call.
 *
 * `POST /chat` on the Responses-API path does not execute tools itself. It hands
 * the provider this deployment's own MCP endpoint (`MCP_SERVER_URL`) with
 * `MCP_BEARER_TOKEN` and `require_approval: 'never'`, and lets the model call it
 * directly. That token is the *connector's* identity, not the caller's: every
 * tool behind it resolves its workspace and its role from `Settings.mcpUserId`
 * (lib/mcpWorkspace.js). So before KOL-113 a viewer — refused every write by
 * `requireWriteRole` on the REST API and by `mcpWriteWorkspaceId()` on the
 * connector — could ask the assistant to create, rename or delete an entity and
 * the write landed, carrying the MCP user's role, in the MCP user's workspace.
 *
 * The premise `/chat` is mounted on (app.js: "asking the assistant a question
 * reads the graph and writes nothing to it") is worth keeping, so this module is
 * what makes it true rather than merely stated: chat's relay is a **read-only
 * MCP session**, enforced twice over.
 *
 *   1. `allowed_tools` on the tool definition chat sends the provider
 *      (routes/chat.js), so the model is not offered a write tool at all.
 *   2. The scope header below, which routes/mcp.js reads when the session is
 *      initialized and which makes that session register the read tools only.
 *      This is the half that does not depend on a provider honouring (1):
 *      whatever the model asks for, a write tool is not there to be called.
 *
 * Write access through chat is not restored by removing this. It needs the
 * relay to carry the *caller's* identity instead of the connector's — per-user
 * MCP credentials, or an actor and a workspace in the tool arguments — because
 * until it does, a write through chat lands in whichever workspace
 * `Settings.mcpUserId` happens to belong to, which need not be the one the
 * question was asked in.
 */

/**
 * The tools a read-only session registers, and the `allowed_tools` chat sends.
 *
 * Exactly the tools in routes/mcp.js that resolve their workspace with
 * `mcpWorkspaceId()` — the read path, which carries no role check because
 * reading is what a viewer is for. Every write tool there is registered through
 * `writeTool()` and resolves with `mcpWriteWorkspaceId()`, and none of them is
 * on this list.
 *
 * Fails closed both ways: a new write tool is absent, so chat cannot reach it,
 * and a new *read* tool is absent until it is added here — chat loses a
 * capability rather than gaining one. `tests/http/writeRole.test.js` checks this
 * list against the tools the endpoint actually advertises, so neither kind of
 * drift is silent.
 */
export const MCP_READ_TOOLS = Object.freeze([
  'search_entities',
  'get_entity',
  'list_entity_types',
  'list_open_questions',
]);

/**
 * The request header that asks `/mcp` for a read-only session, lower-cased
 * because that is how Node presents `req.headers`.
 *
 * A header rather than a second bearer token: the relay has to reach the same
 * endpoint as the connector with the same credential — one deployment, one
 * `/mcp`, one `MCP_BEARER_TOKEN` — and the scope is a property of the
 * *connection* asking, which is exactly what a request header is for. It is
 * safe for the model's words to be unable to reach it: chat sets these headers
 * on the tool definition, nothing in the conversation does.
 */
export const MCP_SCOPE_HEADER = 'x-kol-emet-mcp-scope';

/** The one value that means anything: every other value is a full session. */
export const MCP_READ_SCOPE = 'read';

/**
 * Whether these request headers ask for a read-only session.
 *
 * Only the exact value counts, and the default is a full session — a header
 * this does not recognise must not quietly narrow the connector's own session,
 * which is the one legitimate write path into the graph through `/mcp`.
 *
 * @param {Record<string, string|string[]|undefined>} [headers] `req.headers`
 */
export function isReadScopeRequest(headers = {}) {
  const raw = headers[MCP_SCOPE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim().toLowerCase() === MCP_READ_SCOPE;
}
