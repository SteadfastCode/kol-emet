# Kol Emet — API Reference

Express REST API. Route definitions live in [`server/src/routes/`](../server/src/routes) and are
mounted in [`server/src/index.js`](../server/src/index.js). This reference reflects the routes as
mounted there.

## Authentication

Two mechanisms, resolved by [`middleware/auth.js`](../server/src/middleware/auth.js):

- **Session cookie** — browser clients. Established by `/auth/login` or `/auth/register`, stored in an
  Express session.
- **Bearer token** — programmatic/MCP access. `Authorization: Bearer <BEARER_TOKEN>` matched against
  the server env var.

Two guards:

- `requireAuth` — allows either a valid session **or** a valid bearer token. Used for reads and
  non-mutating routes.
- `requireActor` — same, but additionally resolves `req.actor` (`{ type: 'user' | 'mcp', userId,
  label }`) for attribution on writes. A bearer write with no `Settings.mcpUserId` configured is
  rejected with a "re-authorize" error.

Mount points and their guards:

| Prefix | Guard | Notes |
|--------|-------|-------|
| `/auth` | mixed | Login/registration; individual routes guard themselves |
| `/mcp` | self | MCP HTTP transport; auth handled inside the handler |
| `/` (oauth) | none | OAuth discovery/authorize/token for the MCP connector |
| `/events` | `requireAuth` | Server-Sent Events stream |
| `/entities` | `requireAuth` | Writes additionally use `requireActor` |
| `/relationship-groups` | `requireAuth` | Writes use `requireActor` |
| `/relationship-types` | `requireAuth` | |
| `/tags` | `requireAuth` | |
| `/open-questions` | `requireAuth` | |
| `/` (changelog) | `requireAuth` | History + rollback under `/entities/:id/...` |
| `/chat` | `requireAuth` | AI chat (SSE streaming) |
| `/conversations` | `requireAuth` | Saved AI conversations |

---

## Entities

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/entities` | List. Query params: `category`, `tag`, `q` (case-insensitive regex over title/summary/blocks). Populates `open_questions`. |
| GET | `/entities/:id` | Single entity, with `relationships` resolved live from `RelationshipGroup` (not the back-reference). |
| POST | `/entities` | Create. Validates block types; normalizes block `order`. Logs to ChangeLog. |
| PUT | `/entities/:id` | Replace/update. Same validation + ChangeLog. |
| DELETE | `/entities/:id` | Delete and prune the entity from all relationship groups. Logs to ChangeLog. |

Block payloads must be `{ type, order, data }` with `type` in the `BLOCK_TYPES` enum; `order` is
re-densified server-side.

## Relationship groups

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/relationship-groups` | List all groups |
| GET | `/relationship-groups/:id` | Single group |
| POST | `/relationship-groups` | Create a group |
| PATCH | `/relationship-groups/:id` | Update group label |
| POST | `/relationship-groups/:id/members` | Add an entity member |
| PATCH | `/relationship-groups/:id/members/reorder` | Reorder members |
| PATCH | `/relationship-groups/:id/members/:entityId` | Update a member's label/notes |
| DELETE | `/relationship-groups/:id/members/:entityId` | Remove a member |
| POST | `/relationship-groups/:id/subgroups` | Nest a subgroup |
| DELETE | `/relationship-groups/:id/subgroups/:subGroupId` | Un-nest a subgroup |
| DELETE | `/relationship-groups/:id` | Delete the group |

## Relationship types

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/relationship-types` | List the label vocabulary |
| POST | `/relationship-types` | Create a type |
| PUT | `/relationship-types/:id` | Update a type |
| DELETE | `/relationship-types/:id` | Delete a type |

## Tags

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/tags` | All unique tags across entities |

## Open questions

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/open-questions` | List. Supports `?status=open|resolved`. |
| GET | `/open-questions/:id` | Single question |
| POST | `/open-questions` | Create |
| PUT | `/open-questions/:id` | Update (question text, status, linked entities) |
| DELETE | `/open-questions/:id` | Delete |

## Changelog / history

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/entities/:id/history` | Recent changes for an entity (≤30 days; TTL) |
| POST | `/entities/:id/rollback/:logId` | Restore the entity from a log entry's snapshot (`requireActor`) |

## Auth

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/auth/register` | Create account (open registration) |
| POST | `/auth/login` | Password login → session |
| POST | `/auth/logout` | End session (`requireAuth`) |
| GET | `/auth/me` | Current session user |
| POST | `/auth/webauthn/register/begin` · `/complete` | Add a passkey (`requireAuth`) |
| POST | `/auth/webauthn/login/begin` · `/complete` | Passwordless login via passkey |

## AI chat

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/chat/providers` | Providers whose API key is configured on the server (`id`, `name`, `models`, `defaultModel`) |
| POST | `/chat` | Streaming chat over SSE. Body: `{ provider, model, messages, systemPrompt?, conversationId? }`. Persists to the conversation when `conversationId` is supplied. |

Providers are defined in [`lib/aiProviders.js`](../server/src/lib/aiProviders.js) and reached through
an OpenAI-compatible client. Currently registered: **xAI (Grok)**, **OpenAI**, **Google Gemini**. A
provider is only offered if its API key env var is set.

## Conversations

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/conversations` | List the current user's conversations |
| POST | `/conversations` | Create a conversation |
| GET | `/conversations/:id` | Single conversation with messages |
| PATCH | `/conversations/:id` | Rename (sets `autoTitle: false`) or update |
| DELETE | `/conversations/:id` | Delete |
| POST | `/conversations/:id/title` | Auto-generate a title from the conversation |

## Events (SSE)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/events` | Server-Sent Events stream for live multi-client sync. On connect the server emits `client:id`; clients echo it back as the `x-sse-client-id` header on writes so the broadcaster can skip the originating tab. |

## OAuth (MCP connector)

Endpoints that let the Claude.ai MCP connector authorize against this server (RFC 8414 discovery +
authorization-code with PKCE):

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/.well-known/oauth-authorization-server` | Discovery document |
| GET | `/authorize` | Approval page |
| POST | `/authorize` | Approve → issue auth code |
| POST | `/oauth/token` | Exchange code for token |

## MCP transport

| Method | Route | Description |
|--------|-------|-------------|
| POST/GET/DELETE | `/mcp` | Streamable-HTTP MCP endpoint. See [architecture.md](architecture.md) for the tool list. |
