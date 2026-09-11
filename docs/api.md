# Kol Emet — API Reference

Express REST API. Route definitions live in [`server/src/routes/`](../server/src/routes) and are
mounted in `createApp()` in [`server/src/app.js`](../server/src/app.js). This reference reflects the
routes as mounted there.

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

Tenant scoping is a third middleware, `resolveWorkspace`
([`middleware/workspace.js`](../server/src/middleware/workspace.js)). It runs after `requireAuth` on
every route that touches tenant content, resolves the acting user (the session user, or
`Settings.mcpUserId` for a bearer token), and sets `req.workspaceId` from their workspace membership;
those routes filter their queries on it. No user → 401; no workspace → 403. It fails closed rather
than falling through to unscoped data, and must stay behind `requireAuth` so an anonymous request is
a 401 before any workspace lookup. One known gap — two unscoped `populate()` calls — is described
under [Workspace](data-model.md#workspace).

Mount points and their guards:

| Prefix | Guard | Notes |
|--------|-------|-------|
| `/auth` | mixed | Login/registration; individual routes guard themselves |
| `/mcp` | self | MCP HTTP transport; auth handled inside the handler, and every tool scopes its queries to the MCP user's workspace |
| `/` (oauth) | none | OAuth discovery/authorize/token for the MCP connector |
| `/events` | `requireAuth` + `resolveWorkspace` | Server-Sent Events stream; broadcasts reach only the connection's workspace |
| `/entities` | `requireAuth` + `resolveWorkspace` | Writes additionally use `requireActor` |
| `/relationship-groups` | `requireAuth` + `resolveWorkspace` | Writes use `requireActor` |
| `/relationship-types` | `requireAuth` + `resolveWorkspace` | |
| `/tags` | `requireAuth` + `resolveWorkspace` | |
| `/open-questions` | `requireAuth` + `resolveWorkspace` | |
| `/` (changelog) | `requireAuth` + `resolveWorkspace` | History + rollback under `/entities/:id/...` |
| `/chat` | per-route | AI chat (SSE streaming). `GET /providers`: `requireAuth`; `POST /`: `requireAuth` + `resolveWorkspace` |
| `/conversations` | `requireAuth` + `resolveWorkspace` | Saved AI conversations |
| `/drafts` | `requireAuth` + `resolveWorkspace` | Generated drafts; `POST /:id/apply` uses `requireActor` |

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
| DELETE | `/auth/account` | Hard-delete the signed-in account: the user, every workspace they solely own and everything in it ([`accountDeleter.js`](../server/src/lib/accountDeleter.js)). `requireActor`, session only; a bearer token is 403. Body `{ email, password }` or `{ email, passkey }`: the account's email as a typed confirmation, plus a fresh credential. 204 and the session is destroyed; 400 missing or mismatched email; 403 wrong password or failed passkey; 409 `{ error, memberships }` while the user belongs to a workspace they don't solely own, deleting nothing |
| POST | `/auth/account/passkey-challenge` | WebAuthn challenge for confirming `DELETE /auth/account` with a passkey (`requireActor`, session only). One use, and kept apart from the sign-in challenge |
| POST | `/auth/webauthn/register/begin` · `/complete` | Add a passkey (`requireAuth`) |
| POST | `/auth/webauthn/login/begin` · `/complete` | Passwordless login via passkey |

## AI chat

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/chat/providers` | Providers whose API key is configured on the server (`id`, `name`, `models`, `defaultModel`) |
| POST | `/chat` | Streaming chat over SSE. Body: `{ provider, model, messages, systemPrompt?, conversationId? }`. Persists to the conversation when `conversationId` is supplied. |

Providers are defined in [`lib/aiProviders.js`](../server/src/lib/aiProviders.js) and reached through
an OpenAI-compatible client. Currently registered: **OpenRouter** (primary), the native **Claude
(Anthropic)**, **xAI (Grok)**, **OpenAI** and **Google Gemini**, and **`steadfast`** (self-hosted,
tailnet-only) — see [architecture.md](architecture.md#ai-chat). A provider is only offered if its
API key env var is set.

## Conversations

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/conversations` | List the current user's conversations |
| POST | `/conversations` | Create a conversation |
| GET | `/conversations/:id` | Single conversation with messages |
| PATCH | `/conversations/:id` | Rename (sets `autoTitle: false`) or update |
| DELETE | `/conversations/:id` | Delete |
| POST | `/conversations/:id/title` | Auto-generate a title from the conversation |

## Drafts

A **draft** is a generated set of proposed changes awaiting human review — a pull request against
the graph. Nothing here writes to `entities` or `relationshipgroups` except `POST /:id/apply`.

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/drafts` | List, newest first, max 50. Omits `items`, `source.text`, `diagnostics.rawOutput` and `grounding.systemPrompt` — the list view only needs counts. Excludes `discarded`. Lazily ages out runs stuck on `generating` for >10 min. |
| GET | `/drafts/quota` | Remaining AI allowance for the workspace: `{ granted, spent, remaining, exhausted }` in micro-dollars plus display strings. |
| POST | `/drafts` | Generate, streaming progress over **SSE**. Body: `{ text, provider?, roleStyle? }`. |
| GET | `/drafts/:id` | Full draft including `items` and the source text. |
| PATCH | `/drafts/:id/items/:itemId` | Record one decision. Body: `{ decision: 'accepted' \| 'edited' \| 'rejected', payload?, note? }`. `payload` is required for `edited` and is validated against the same schema `POST /entities` accepts. |
| POST | `/drafts/:id/items/:itemId/retarget` | Resolve a duplicate: `{ targetEntityId }` turns a create into an update against that entity; `null` reverts it to a create. Entity items only. |
| POST | `/drafts/:id/decide-clean` | Accept every **unflagged** pending item. Returns `{ accepted, skippedFlagged, skippedApplied, message }`. |
| POST | `/drafts/:id/apply` | Write the accepted items into the graph (`requireActor`). The only route here that touches entities. |
| GET | `/drafts/:id/export` | This draft as one JSONL training record, pseudonymised. `?raw=1` includes the unparsed model output. |
| DELETE | `/drafts/:id` | **Soft** — sets `status: 'discarded'`. The row is training data and is never removed here. |

### `POST /drafts` (SSE)

The `Draft` row is persisted with `status: 'generating'` **before** the first model call, so a run is
never invisible. Generation deliberately continues after a client disconnect — the provider has
already been paid for those tokens.

Event frames on the stream:

| `type` | Payload |
|--------|---------|
| `created` | `{ draftId }` — emitted immediately, before any model call |
| `stage` | `{ stage: 'entities' \| 'relationships' \| 'normalizing', chunk?, of? }` |
| `done` | `{ draftId, counts, route, budget }` |
| `error` | `{ message, draftId }` |

Pre-stream failures are ordinary JSON errors, not SSE frames:

| Status | Meaning |
|--------|---------|
| 400 | Empty text, or longer than `GENERATOR_MAX_CHARS` (25,000) |
| 402 | Not enough AI allowance to start a run (`GENERATOR_MIN_RUN_MICROS`, default $0.015) |
| 409 | A generation is already running for this workspace — one at a time, since cost is only known after a run finishes |

### Decisions vs. apply

Recording a decision and applying it are separate on purpose. A person who reviews 30 items and then
abandons the draft has still produced 30 labelled examples, and those are the point of the corpus.

Two field groups on each item are written by different parties and never by the other:

- The **human label** — `decision`, `decisionVia`, `decisionNote`, `decidedBy`, `decidedAt`,
  `accepted` — written only by `PATCH`.
- The **system outcome** — `applyState`, `resultId`, `changeLogId`, `applyError`, `appliedAt` —
  written only by the applier. `PATCH` rejects these keys in a request body with a 400, so a client
  cannot forge the record of what happened to a change.

An item whose `applyState` is no longer `pending` cannot be re-decided (409). `POST /:id/apply` takes
an atomic lock via `applyingAt`, so two simultaneous applies cannot both run; a lock older than five
minutes is treated as a crashed apply and reclaimed.

### `GET /drafts/:id/export`

Returns `application/x-ndjson` — one line, schema `kol-emet/draft-export@1`. Every ObjectId is
replaced: references to things created by a sibling item in the same draft become `local:<localKey>`,
and everything else becomes a keyed HMAC pseudonym (`ws_…`, `usr_…`, `ent_…`, `chg_…`). Pseudonyms
are deterministic, so a corpus stays joinable without ever holding a real id.

Requires `EXPORT_HMAC_SECRET`; returns **503** if it is unset rather than exporting with a default
key. If any raw ObjectId survives mapping the export fails with a 500 naming the field — a partial
record is worse than a failure. The bulk equivalent is
[`server/scripts/export-drafts-jsonl.js`](../server/scripts/export-drafts-jsonl.js).

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
