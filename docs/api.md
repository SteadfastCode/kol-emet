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

A write that authenticates with the **session cookie** must also come from this deployment's own
client. `originGuard` ([`middleware/originGuard.js`](../server/src/middleware/originGuard.js)) is
mounted directly after the session middleware and ahead of every router, and on `POST`, `PUT`,
`PATCH` and `DELETE` from a signed-in session it requires the request's `Origin` — or its `Referer`
when `Origin` is absent — to be `CLIENT_ORIGIN` or this API's own origin (the OAuth approval pages
post back to themselves). Anything else is **403 `{ "error": "CROSS_ORIGIN_REQUEST" }`**, before the
route runs. A bearer caller is exempt: it sends a token and no cookie, so no browser can ride it.

Why it exists: the session cookie is `sameSite: 'none'` in production, because the client and the API
answer on sibling subdomains, so a browser attaches it to cross-site requests. CORS does not stop a
*simple* request (a form POST, no custom headers) — it is sent with no preflight and only the
*response* is withheld, so the write has already happened. The second layer is body parsing:
`express.urlencoded` is mounted only on the four form-encoded [OAuth](#oauth-mcp-connector)
endpoints, never on the app, so a cross-site simple POST cannot form a body any other route reads.
Set `CLIENT_ORIGIN` on every deployment; unset, the allowlist is the API's own origin alone (and
`cors()` is already answering `Access-Control-Allow-Origin: *`, which no browser uses with
credentials). `ORIGIN_GUARD_LOG_LEVEL` (`off | light | normal | verbose`, default `light`) names
every refusal with the header it read and the allowlist it missed.

Tenant scoping is a third middleware, `resolveWorkspace`
([`middleware/workspace.js`](../server/src/middleware/workspace.js)). It runs after `requireAuth` on
every route that touches tenant content, resolves the acting user (the session user, or
`Settings.mcpUserId` for a bearer token), and sets `req.workspaceId` from their workspace membership;
those routes filter their queries on it. No user → 401; no workspace → 403. It fails closed rather
than falling through to unscoped data, and must stay behind `requireAuth` so an anonymous request is
a 401 before any workspace lookup. Populated id arrays (`open_questions`, `entry_ids`) are scoped
the same way; see [Workspace](data-model.md#workspace).

**Which** workspace is an explicit choice, not whatever a `findOne` returned (KOL-090). The acting
workspace is `req.session.workspaceId` when the caller is still a member of it, else the default:
**the oldest workspace they own, else the oldest they are a member of**, over the membership list
sorted `createdAt` then `_id` so the order is total. A selection is re-checked against the live
membership list on every request — a session holding an id is not authority to act in it — and a
*stale* one (the membership was revoked, or the workspace deleted) **falls back to the default
rather than answering 403**, so losing access to one workspace cannot lock a user out of their own.
`/mcp` keeps its bearer identity and takes the same default: a connector carries no session to hold
a choice in. See [Workspaces](#workspaces).

### Roles

`Workspace.members[].role` is one of `owner`, `editor`, `viewer`, and `resolveWorkspace` reads the
caller's own membership onto every request (`req.workspaceRole`); `GET /workspace` hands it to the
client so the UI can hide what a role may not do. The server never trusts that copy.

**`editor` is the write floor.** `requireWriteRole`
([`middleware/workspace.js`](../server/src/middleware/workspace.js)) is mounted beside
`resolveWorkspace` on every router that writes the graph: `GET`, `HEAD` and `OPTIONS` pass through
untouched — reading is what a viewer is for — and every other method goes through
`requireWorkspaceRole('editor')`, so a viewer's write is **403 `{ "error":
"NOT_WORKSPACE_EDITOR" }`** before the route runs and before any AI allowance is read. Roles are a
floor, not an exact match, so an owner passes an `editor` gate. It is mounted once per router rather
than per route, so a route added to one of them later inherits the gate; the one exception is the
changelog router, which is mounted at `/` (a gate there would judge every request on its way to a
later mount), so its single write carries the gate on the route itself.

The membership writes of [Collaborators](#collaborators) ask for `owner` too, and so do `PATCH /workspace` and
`POST /import`. Three content routes deliberately have no write gate — `GET /export` (a read),
`/chat` and `/conversations` (asking the assistant a question reads the graph and writes nothing to
it, and a saved conversation is the asker's own row). A floor on who may *spend* the workspace's AI
allowance is a pricing decision, not a permission one, and has not been made.

"Writes nothing to it" is enforced, not assumed (KOL-113). On the Responses-API path `POST /chat`
executes no tools itself: it hands the provider this deployment's own `/mcp` endpoint with
`MCP_BEARER_TOKEN` and `require_approval: 'never'`. That token is the *connector's* identity — the
tools behind it act as `Settings.mcpUserId` — so an unrestricted relay was this gate, bypassed one
mount over: a viewer could ask the assistant to create or delete an entity and the write landed.
Chat's relay is therefore a **read-only MCP session**
([`lib/mcpScope.js`](../server/src/lib/mcpScope.js)): `allowed_tools` is `MCP_READ_TOOLS`, and the
request carries `x-kol-emet-mcp-scope: read`, which `/mcp` honours by registering **no write tools
on that session at all** — the half that does not depend on a provider honouring `allowed_tools`.
Restoring write access through chat needs the relay to carry the *caller's* identity rather than the
connector's, not the removal of this.

**The reads behind that token are the connector's too, so read-only was only half of it (KOL-114).**
A relayed `search_entities` or `get_entity` resolves its workspace with `mcpWorkspaceId()`, which
reads `Settings.mcpUserId`'s workspace and never `req.workspaceId` — so for a caller who is not a
member of the connector's workspace, a relayed read answers out of another tenant's graph. The relay
is therefore offered **only when the connector stands in the caller's own workspace**
(`relayDecision()` in [`routes/chat.js`](../server/src/routes/chat.js)); every other turn — and any
turn where the connector is unauthorized or its workspace cannot be resolved — falls back to the
Chat Completions path, whose `search_entities`, `get_entity` and `save_memory` this route executes
itself against `req.workspaceId`. Both paths emit the same SSE events, so the fallback is invisible
to the client; what it costs is `list_entity_types` and `list_open_questions`, which the Completions
path has never offered. Naming the caller's workspace in a header on the relay instead was rejected:
the credential beside it is the connector's, so that would let any holder of `MCP_BEARER_TOKEN` read
*any* workspace.

`/mcp` never passes through this middleware — it has its own bearer gate and each tool scopes
itself — so the same floor is enforced there by
[`lib/mcpWorkspace.js`](../server/src/lib/mcpWorkspace.js): read tools call `mcpWorkspaceId()`, the
ten write tools call `mcpWriteWorkspaceId()`, which refuses below `editor` with a tool error naming
the role it read. A session opened with `x-kol-emet-mcp-scope: read` never registers those ten at
all (see chat's relay, above). `/bridge/*` carries its own token and no workspace role.

`WORKSPACE_LOG_LEVEL` (`off | light | normal | verbose`, default `light`) names every refusal with
the role read, the role required and the request it came from.

Mount points and their guards:

| Prefix | Guard | Role | Notes |
|--------|-------|------|-------|
| `/auth` | mixed | none | Login/registration; individual routes guard themselves |
| `/templates` | none | none | Workspace templates a signup can start from; public because the signup form is shown before an account exists |
| `/mcp` | self | `editor` to write | MCP HTTP transport; auth handled inside the handler, and every tool scopes its queries to the MCP user's workspace — which is why chat relays here only for a caller already in that workspace (KOL-114). A session opened with `x-kol-emet-mcp-scope: read` (chat's relay) registers the four read tools only |
| `/` (oauth) | mixed | none | OAuth discovery/authorize/token for the MCP connector. Discovery, the approval page and the token exchange are public; `POST /authorize` — which *binds* the MCP identity — takes a live login session (`requireLoginSession`) |
| `/bridge/mcp`, `/bridge/*`, `/.well-known/*bridge*` | self | none | The Steadfast bridge: its own MCP transport behind `BRIDGE_TOKEN` (503 when unset), plus its own OAuth issuer and RFC 9728 resource metadata. Scoped to the MCP user's workspace. See architecture.md |
| `/workspaces` | `requireAuth` | any member | The caller's memberships, which one this session acts in, and creating another. Deliberately **no** `resolveWorkspace`: a membership list is not content in one workspace, the choice must not be gated on the role held in the workspace being left, and a create happens outside any workspace at all. Mounted ahead of the `/` changelog catch-all, whose `resolveWorkspace` would otherwise 403 a caller with no membership at all |
| `/invites` | `requireAuth` | the invitee themselves | The invitee's side of a collaborator invite (KOL-124): their own pending invitations, and accepting or declining one. No `resolveWorkspace`, for the same reasons as `/workspaces` — an invitation is about a workspace the caller is **not** a member of, so there is no role in it to gate on. An invite is matched to the caller by the address their account is keyed by |
| `/events` | `requireAuth` + `resolveWorkspace` | any member | Server-Sent Events stream; broadcasts reach only the connection's workspace. Re-checked after connect: the stream closes when its session leaves the store, and one user holds at most `EVENTS_MAX_STREAMS_PER_USER` |
| `/entities` | `requireAuth` + `resolveWorkspace` | `editor` to write | Writes additionally use `requireActor` |
| `/relationship-groups` | `requireAuth` + `resolveWorkspace` | `editor` to write | Writes use `requireActor` |
| `/relationship-types` | `requireAuth` + `resolveWorkspace` | `editor` to write | |
| `/entity-types` | `requireAuth` + `resolveWorkspace` | `editor` to write | Gates the category names entities and relationship types can hold |
| `/tags` | `requireAuth` + `resolveWorkspace` | `editor` to write | Writes use `requireActor` |
| `/open-questions` | `requireAuth` + `resolveWorkspace` | `editor` to write | |
| `/` (changelog) | `requireAuth` + `resolveWorkspace` | `editor` to roll back | History + rollback under `/entities/:id/...`, and `/deleted` |
| `/chat` | per-route | any member | AI chat (SSE streaming). `GET /providers`: `requireAuth`; `POST /`: `requireAuth` + `resolveWorkspace` |
| `/conversations` | `requireAuth` + `resolveWorkspace` | any member | Saved AI conversations |
| `/drafts` | `requireAuth` + `resolveWorkspace` | `editor` to write | Generated drafts; `POST /:id/apply` uses `requireActor` |

## Route parameters

Any route taking an id in its path — `:id`, and the `:logId`, `:entityId` and `:subGroupId` beside it
— answers **400 `{ "error": "INVALID_ID", "param": "<name>" }`** when that parameter is not a valid
24-hex ObjectId, before the route runs. The check is
[`middleware/objectId.js`](../server/src/middleware/objectId.js), registered with `router.param` on
`/entities`, the changelog routes, `/relationship-groups`, `/open-questions`, `/conversations` and
`/drafts`.

400 and not 404 on purpose: a **well-formed** id belonging to another workspace stays 404 (see
[Entities](#entities)), so the API never confirms another tenant's row exists, while a malformed id
cannot name anyone's row and so reveals nothing by being refused — it is simply a request the caller
got wrong. Previously these reached Mongoose and came back as 500 carrying the driver's own cast
message. `OBJECT_ID_LOG_LEVEL` (`off | light | normal | verbose`, default `light`) names every
refusal with the parameter, the URL and the mount it came from.

## Errors

Anything a route does not answer deliberately reaches one error middleware,
[`middleware/errorHandler.js`](../server/src/middleware/errorHandler.js), mounted last in
`createApp`. Every router's catches end in `next(err)`, so the driver's own text never reaches a
caller: no `E11000 duplicate key error collection: … index: …`, no `Entity validation failed:
category: …`, no pool error carrying a connection string.

| Status | Body | When |
|--------|------|------|
| 400 | `{ "error": "VALIDATION_FAILED", "fields": ["category", "summary"] }` | A write failed schema validation. `fields` are this API's own schema paths — what a client needs to mark the offending inputs. Never the values. |
| 400 | `{ "error": "INVALID_VALUE", "fields": ["workspaceId"] }` | A value could not be cast to the type its field holds. |
| 409 | `{ "error": "DUPLICATE", "fields": ["email"] }` | A unique index rejected the write. `fields` are the index's key names, never the colliding values. |
| 400 | `{ "error": "MALFORMED_JSON" }` | The body is not the JSON its `Content-Type` declared. |
| 413 | `{ "error": "BODY_TOO_LARGE" }` | The body is over the parser's limit — 100 kB everywhere except [`POST /import`](#import), which allows `IMPORT_BODY_LIMIT` (default 8 MB) and answers its own `IMPORT_TOO_LARGE`. |
| 415 | `{ "error": "UNSUPPORTED_ENCODING" }` / `{ "error": "UNSUPPORTED_CHARSET" }` | The `Content-Encoding` or `charset` the request declares is not one this server reads. |
| 500 | `{ "error": "INTERNAL", "ref": "a1b2c3d4" }` | Anything else. `ref` is a short id written to the server log beside the real stack — quote it in a bug report; nothing about the deployment is in the body. |

The three body rows above come from the body parser, which runs ahead of every router *and* ahead
of the session middleware — so an unreadable body is answered as such even on an endpoint that
would otherwise have refused the request as unauthenticated, and before any route sees it. Three rarer
codes come from the same place: `BODY_SIZE_MISMATCH` (400, the body's length is not its
`Content-Length`), `REQUEST_ABORTED` (400, the client hung up mid-body) and, on the two
form-encoded OAuth endpoints only, `TOO_MANY_PARAMETERS` (413) and `MALFORMED_BODY` (400).

A route may also raise a refusal of its own as a status with a code (`httpError(503,
'EXPORT_NOT_CONFIGURED')`), which is answered as `{ "error": "<code>" }` at that status. The codes
in use: `INVALID_ID` (see [Route parameters](#route-parameters)), `INVALID_WORKSPACE_NAME`,
`NOT_WORKSPACE_OWNER` / `NOT_WORKSPACE_EDITOR` / `NOT_WORKSPACE_VIEWER`, `EXPORT_NOT_CONFIGURED`.

It has to come from `httpError()` itself, which marks the errors it raises; carrying a `status` and
a `code` is not enough (KOL-101). The OpenAI client — which every AI provider in the registry is
reached through — hangs exactly that pair on every API error it raises, with `code` taken straight
out of the response body (`invalid_api_key`, `insufficient_quota`, `context_length_exceeded`), and
those are **500 `INTERNAL` with a `ref`**: a string owned by a provider's SDK is not a code this API
chose, and not one a client can branch on, since it changes with the provider and with the SDK
version. The reason goes to the log under that `ref`, as for any other 500.

Everything documented per-route below is unchanged: a 400/403/404/409 a route answers on purpose
carries the sentence it has always carried, because that wording is part of its contract. Only the
catch-all was replaced.

`ERROR_LOG_LEVEL` (`off | light | normal | verbose`, default `light`). The light tier logs one line
per handled error with the route, the status it chose, the code, the `ref` when there is one, and
*which rule* chose it — plus, for a 500, the real stack prefixed with that same `ref`. `off` means
nothing at all, the stack included.

A failure that is **stored** rather than answered goes through the same rules, in
[`lib/failureNote.js`](../server/src/lib/failureNote.js). `POST /drafts` writes why a run failed onto
the draft and `GET /drafts/:id` returns the whole document, so an `err.message` kept there would
reach a caller in a plain JSON body a request later — the driver's text with a delay (KOL-100). What
is stored instead is a sentence of ours plus a code: `diagnostics.errorCode` (and `item.applyError`
for an apply), with `diagnostics.errorRef` indexing the log line that holds the real error. A
refusal this codebase wrote on purpose — `No AI provider is configured on the server` — is stored
verbatim and has no `ref`, which is the same distinction a producer's parse error is published by.
`ERROR_LOG_LEVEL` governs both.

Out of scope here: `/mcp` and `/bridge/mcp` answer JSON-RPC error objects on their own protocol, and
the SSE routes report failures as stream events because their headers went out first — see
[Events](#events-sse) and [`POST /drafts`](#post-drafts-sse).

---

## Health

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/health` | Liveness and database readiness. **200** `{ "status": "ok", "db": "up", "uptimeSeconds": 1234 }` when `mongoose.connection.readyState` is `1`; **503** `{ "status": "degraded", "db": "down", "uptimeSeconds": 1234 }` for every other state. No auth, and it establishes no session (no `Set-Cookie`), so a monitor can poll it. `HEAD /health` answers the same status with no body. Sent `Cache-Control: no-store`. |

The only route whose job is to be polled, and the only one mounted ahead of `requireAuth` for that
reason ([`routes/health.js`](../server/src/routes/health.js)). The deploy signal available until now
was the host's own commit status, which says a container started — not that it can still reach
Mongo. Note which failure that leaves invisible: `index.js` listens only *after* the first connect
succeeds, so a boot with no database never serves at all; what happens in production is the
connection dropping **later**. Mongoose keeps the process up and reconnects in the background, so
the API goes on answering 200 while `readyState` is `0` or `2`, and every tenant route turns that
window into a stall a user reads as their own connection. Only `1` is `up` here.

The body is those three keys and deliberately nothing else — no version, no commit, no collection
counts, no environment or provider names. This endpoint is unauthenticated and meant to be polled,
and a status endpoint that describes its deployment is a reconnaissance endpoint; what it publishes
is "working / not working", which is what a monitor needs. `server/tests/http/health.test.js`
asserts the exact key set, so a fourth key is a deliberate change to that assertion rather than
something that arrives in passing.

A cross-origin `GET /health` is **not** refused: `originGuard` checks unsafe methods only (see
[Authentication](#authentication)), so the route needs no exemption from it.

`HEALTH_LOG_LEVEL` (`off | light | normal | verbose`, default `light`). A monitor polls every few
seconds, so the light tier logs only the *transitions* — one line each time the answer changes,
naming the previous answer, the new one and the `readyState` behind it. `normal` logs every answer;
`verbose` adds the caller's method and path.

Out of scope: the AI providers and every other outbound dependency (an instance whose OpenRouter key
is wrong is not *down*), Prometheus/OpenTelemetry metrics and a status page. Pointing the host's own
healthcheck setting at `/health` is a dashboard change, not a repo one.

---

## Entities

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/entities` | List, **without `blocks`**. Each entity carries `_id`, `title`, `category`, `summary`, `tags`, `open_questions`, `relationships`, `createdAt`, `updatedAt` — everything the list path reads; block content comes from `GET /entities/:id`. `?include=blocks` returns the unprojected documents instead (comma-separated, so later opt-ins join it). Query params: `category`, `tag`, `q` (case-insensitive **literal** substring over title/summary/block markdown — the term is regex-escaped, so punctuation searches instead of compiling). Each of these and `include` is trimmed, and ignored unless it is a non-empty string, so a repeated parameter or a bracketed operator (`?category[$ne]=X`) is no filter rather than one the caller wrote; `q` is capped at 200 characters. Note that `q` still searches block markdown — the projection governs the response, not the query. Populates `open_questions`. **Pagination (opt-in):** with `?limit=` (an integer 1–200; clamped to 200 above it, and *no limit* for anything else — `0`, `-1`, `abc`, a repeated parameter or `?limit[$gt]=1`) the response is an envelope `{ items, nextAfter: { title, _id } | null, total }` instead of a bare array, `total` counting the whole filtered set rather than the page. Without `limit` the response is the unbounded bare array it has always been, so existing callers are unaffected. Pages are keyset, not offset: send the previous page's `nextAfter` back as `?after[title]=<title>&after[_id]=<id>` (titles are not unique, hence both; the sort is `title` then `_id`). `nextAfter` is `null` on the last page. A present but unusable `after` is **400** rather than a silent first page. |
| GET | `/entities/:id` | Single entity, with `relationships` resolved live from `RelationshipGroup` (not the back-reference). |
| POST | `/entities` | Create. Validates block types; normalizes block `order`. 400 if `category` is not a type in the workspace's [registry](#entity-types). Ignores `workspaceId`, `open_questions` and `relationships` in the body (server-maintained). Logs to ChangeLog. |
| PUT | `/entities/:id` | Replace/update. Same validation, ignored fields + ChangeLog. |
| DELETE | `/entities/:id` | Delete and prune the entity from all relationship groups. Logs to ChangeLog. |

Block payloads must be `{ type, order, data }` with `type` in the `BLOCK_TYPES` enum; `order` is
re-densified server-side.

## Relationship groups

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/relationship-groups` | List the workspace's groups, ordered by `_id` (insertion order). `members` is **not** populated — ids only; `GET /relationship-groups/:id` is where a populated group comes from. **Pagination (opt-in):** with `?limit=` (an integer 1–200; clamped to 200 above it, and *no limit* for anything else — `0`, `-1`, `abc`, a repeated parameter or `?limit[$gt]=1`) the response is an envelope `{ items, nextAfter: <id> | null }` instead of a bare array. Without `limit` the response is the unbounded bare array it has always been, so existing callers are unaffected. Pages are keyset, not offset: send the previous page's `nextAfter` back as `?after=<id>`. `nextAfter` is `null` on the last page, and a present but unusable `after` is **400** rather than a silent first page. There is no `total`: nothing pages this route for a "page 2 of 7", and a count per page is a second query. |
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
| POST | `/relationship-types` | Create a type. 400 if a non-null `sourceCategory`/`targetCategory` is not an entity type in the workspace. |
| PUT | `/relationship-types/:id` | Update a type (same check) |
| DELETE | `/relationship-types/:id` | Delete a type |

## Entity types

The per-workspace registry of entity types (Phase 6). `Entity.category` has no hardcoded enum: it
must name a type in this registry, and so must a relationship type's
`sourceCategory`/`targetCategory`. A workspace with no types is held to the six built-in categories.
The client and the MCP/chat category lists move onto the registry in later Phase 6 steps. See
[EntityType](data-model.md#entitytype).

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/entity-types` | List the workspace's types, sorted by `order` then `name`. `?q=` fuzzy-filters by name. |
| POST | `/entity-types` | Create `{ name, icon?, color?: { bg, text }, order? }`. Any non-blank `name` (trimmed) is allowed, and entities can use it at once; a blank one is 400. 409 on an existing name (case-insensitive). A near-duplicate still creates, with a `warning`. `order` defaults to after the last type. |
| PUT | `/entity-types/:id` | Update any of `name` (non-blank, trimmed), `icon`, `color` (either half), `order`. 409 if another type has the new name (case-insensitive). A rename, including a change of case alone, cascades: every entity `category` and relationship type `sourceCategory`/`targetCategory` in the workspace that held the old name takes the new one, and the response adds `relabelled: { entities, sourceCategories, targetCategories }`. The steps are ordered, not transactional; if the cascade fails the type keeps its new name and the answer is 500, and renaming it back repairs the data. |
| DELETE | `/entity-types/:id` | Delete. 409 with the same counts while anything names the type, and 409 for the workspace's last type. |

A foreign or malformed id is 404.

## Tags

A tag is a plain string in an entity's `tags` array; there is no tag document. These routes edit
that string across the whole workspace.

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/tags` | All unique tags across entities |
| PUT | `/tags/:tag` | Rename `:tag` to `to` on every entity in the workspace → `{ renamed, from, to }`. `to` is trimmed; a blank or non-string one is 400. Merges: an entity already carrying `to` keeps exactly one copy (`$addToSet` then `$pull`). A rename to itself is a 200 no-op (`renamed: 0`). 404 when no entity carries `:tag`. |
| DELETE | `/tags/:tag` | Remove `:tag` from every entity in the workspace → `{ removed, tag }`. 404 when no entity carries it. |

Both writes take `requireActor` and record **one `ChangeLog` entry per changed entity**, written
before the response — so each entity rolls back individually through `/entities/:id/rollback/:logId`
— and each entry broadcasts `entity:updated` on `/events`. That cost is bounded: an operation
affecting more than **200** entities is refused with **413** and
`{ error, affected, limit }`, naming the count, and writes nothing at all.

Both are scoped to the caller's workspace, so an identically-named tag in another workspace is a
different tag and is never touched. `:tag` is a URL path segment — percent-encode a tag containing
`/`, `#` or `?`.

## Open questions

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/open-questions` | List, newest first (ordered by `_id` descending, which is creation order and, unlike `createdAt`, unique). Supports `?status=open|resolved`. Populates `entry_ids`. **Pagination (opt-in):** with `?limit=` (an integer 1–200; clamped to 200 above it, and *no limit* for anything else — `0`, `-1`, `abc`, a repeated parameter or `?limit[$gt]=1`) the response is an envelope `{ items, nextAfter: <id> | null }` instead of a bare array. Without `limit` the response is the unbounded bare array it has always been, so existing callers are unaffected. Pages are keyset, not offset: send the previous page's `nextAfter` back as `?after=<id>`. `nextAfter` is `null` on the last page, and a present but unusable `after` is **400** rather than a silent first page. There is no `total`: nothing pages this route for a "page 2 of 7", and a count per page is a second query. |
| GET | `/open-questions/:id` | Single question, with `entry_ids` populated (`title`, `category`). 404 for a question outside the workspace. |
| POST | `/open-questions` | Create `{ question, entry_ids?: ObjectId[] }` → **201** with the created document (not populated). A missing or blank `question` is **400** `{ error: "VALIDATION_FAILED", fields }`. `status` is always `open` on a new question; it is not taken from the body. Each kept `entry_ids` entry gets the question `$addToSet`-ed onto its `open_questions`, so the link exists on both sides. `entry_ids` naming entities outside the caller's workspace are **dropped, not refused** — they are never stored and their entities are never back-linked — so the response is the only account of what was actually linked. Broadcasts [`question:created`](#the-frames) to the workspace's other tabs. |
| PUT | `/open-questions/:id` | Update `{ question?, status?, entry_ids? }` → 200 with the question, `entry_ids` populated. **Only the fields the body names are written**, so a `{ status }` write cannot rewrite the text and a `{ question }` write cannot change the status; a body naming none is a 200 no-op. `status` must be `open` or `resolved` and `question` must be non-blank — the update runs the schema's validators, so another value is **400** `{ error: "VALIDATION_FAILED", fields }` and nothing is written (only the paths the body names are validated). `entry_ids` **replaces** the list and syncs the back-links on both sides — removed entities are `$pull`-ed, added ones `$addToSet`-ed — under the same workspace rule as POST. 404 for a question outside the workspace. A write that happened broadcasts [`question:updated`](#the-frames); a refused one broadcasts nothing. |
| DELETE | `/open-questions/:id` | Delete → **204**, and the question's id is `$pull`-ed from the `open_questions` of every entity it was linked to. 404 for a question outside the workspace, including a second delete of the same id. Broadcasts [`question:deleted`](#the-frames), which carries the row that is gone — the 204 carries nothing and this collection keeps no snapshot anywhere else (it has no `ChangeLog` trail and no rollback route). |

Open questions are *read* on the entity as well: `GET /entities` and `GET /entities/:id` populate
each entity's `open_questions` with `question` and `status` (workspace-scoped —
[`lib/scopedPopulate.js`](../server/src/lib/scopedPopulate.js)), which is how the browser
renders them without touching this route. The browser's client is
[`client/src/api/openQuestions.js`](../client/src/api/openQuestions.js); it splits a resolve from a
rename into two single-field `PUT`s on purpose, so neither write can carry a stale copy of the
other's field.

These routes take `requireAuth` + `resolveWorkspace` + `requireWriteRole`, and — unlike
`/entities`, `/tags` and `/relationship-groups` — **no `requireActor` and no `ChangeLog` trail**:
an open question's history is not recorded and a deleted one cannot be rolled back.

## Changelog / history

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/entities/:id/history` | Recent changes for an entity (newest first, ≤50, ≤30 days; TTL). An entry whose `snapshot.category` names an entity type the workspace no longer has also carries `snapshotCategoryMissing: true` — see below |
| POST | `/entities/:id/rollback/:logId` | Restore the entity from a log entry's snapshot (`requireActor`). Body `{ category? }`. **200** with the entity for a live one; **201** when the entry is a `deleted` one and the entity had to be recreated — see below |
| GET | `/deleted` | The deleted entities this workspace can still put back — see below |

A snapshot records the category name as it was spelled then, and a type rename
cascades to entities without writing a `ChangeLog` — so a snapshot can name a
type the workspace no longer has. The rollback checks before it writes:

- **409** `{ error, snapshotCategory, availableCategories }` when the snapshot's
  category is not a type in the workspace (renamed or deleted since). Nothing is
  written and no change is recorded; no retry of the same request will succeed.
- **200** for that same request carrying `{ "category": "<one of
  availableCategories>" }`. `category` is the only field of a snapshot a
  rollback overrides — the caller's decision about which type to restore the
  version under; everything else restores as recorded. A name the workspace
  does not have is **400** `{ error, snapshotCategory, availableCategories }`.

`GET .../history` marks the same condition with `snapshotCategoryMissing: true`
so a client can ask for the choice before the click, from one registry read for
the whole page. The reasoning — in particular why a rename does *not* rewrite
snapshots — is the KOL-059 Decision Log entry in `kol_emet_spec.md`.

### Restoring a deleted entity

`DELETE /entities/:id` removes the document, and `logDelete` keeps the whole
thing in the `deleted` entry's snapshot for the `ChangeLog` TTL's 30 days. The
same rollback route puts it back: on a **`deleted`** entry whose entity is gone
it *recreates* the document rather than updating one.

- **201** with the entity. It comes back at its original `_id` (so an open
  question's `entry_ids`, a bookmarked URL and anything else holding that id
  resolve again) with the snapshot's own fields — title, summary, category,
  tags, blocks (block `_id`s included) and `open_questions`.
- **The workspace is the caller's**, never the snapshot's: a snapshot taken
  before tenancy carries `workspaceId: null`, and restoring that would orphan the
  entity out of every workspace.
- **`relationships` comes back empty.** The delete pruned the relationship groups
  the entity was in, so the ids the snapshot holds name groups that are gone or
  that no longer list it. Re-deriving those edges is drift detection, not a
  restore; the UI says so.
- **409** `{ error, entityId }` when that id is live again — a restore never
  silently overwrites an entity. Roll that one back from its own history instead.
- **409 / 400** for a stale snapshot category, exactly as a rollback above, and
  the same `{ category }` resolves it.
- `createdAt` is the restore's, not the original's; the original is still in the
  snapshot. A `created` `ChangeLog` entry is written, attributed to the caller,
  and `entity:created` is broadcast to the workspace's other tabs.
- An **`updated`** entry is still **404** when the entity is gone: its snapshot is
  one version of a live entity, not the delete's record of the whole document. A
  deleted entity comes back through its own `deleted` entry.

`GET /deleted` is the way back in that outlives the delete toast: this
workspace's `deleted` entries, newest first, ≤50, as
`{ _id (the log entry), entityId, entityTitle, category, actorLabel, actorType,
createdAt }` — no snapshots, so a page of 50 does not carry 50 whole entities.
An id that is live again is dropped (restoring over it is refused), as is an
older entry for an id a newer one already covers. A row whose snapshot category
is gone carries `snapshotCategoryMissing: true`, from one registry read for the
page. The "Recently deleted" group in Settings
(`client/src/components/RecentlyDeleted.vue`) is this list plus a Restore per
row; the reasoning is the KOL-060 Decision Log entry in `kol_emet_spec.md`.

## Auth

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/auth/register` | Create account (open registration). Body `{ email, password, template?, workspaceName? }`: `template` is a key from [`GET /templates`](#templates) and decides what the new workspace is seeded with; left out, it is `worldbuilding`. `workspaceName` names the new workspace (trimmed, 1–80 characters, the same rule as [`PATCH /workspace`](#workspace)); left out, it is `My Workspace`, and an unusable one is 400 `INVALID_WORKSPACE_NAME` creating no user or workspace. 201 `{ ok: true }` and a session; 400 missing email or password; 400 `Unknown template` for a `template` that names none (including `null` or a non-string), creating no user or workspace; 409 email already registered. Throttled: 429 `Too many attempts. Try again later.` with a `Retry-After` once a client address has created its limit of accounts (default 10 per 60 minutes — its own counter and its own window, not the sign-in one), checked before the duplicate lookup and the password hash and creating no user or workspace. The slot is *reserved* at that check rather than counted after the writes, so the ceiling holds for requests that arrive together and not only for a sequence of them; a 400 is refused before the reservation and a 409 hands it back, so only a *created* account spends the budget ([`lib/attemptLimiter.js`](../server/src/lib/attemptLimiter.js)) |
| POST | `/auth/login` | Password login → session. 401 `Invalid email or password` for both a wrong password and an unknown address (byte-identical). Throttled: 429 `Too many attempts. Try again later.` with a `Retry-After` once an email or a client address is over its failure limit, checked before the password is compared and identical for known and unknown addresses; a successful sign-in clears that email's counter ([`lib/attemptLimiter.js`](../server/src/lib/attemptLimiter.js)) |
| POST | `/auth/logout` | End session (`requireAuth`) |
| POST | `/auth/sessions/revoke-all` | End every *other* session on the signed-in account — the borrowed laptop, the lost phone (see [Sessions](#sessions)). `requireActor`, session only; a bearer token is 403. Body `{ password }` or `{ passkey }`; no typed email, unlike the deletion route. 200 `{ ok: true, revokedAt }` and the calling session is re-stamped so this device stays signed in, keeping its live `/events` streams (see [Ending a stream](#ending-a-stream)); 400 no credential offered; 403 wrong password or failed passkey — not 401, the session is still good; 429 once the account is over its failed-confirmation limit, which it shares with `DELETE /auth/account` and `POST /auth/password` |
| POST | `/auth/sessions/passkey-challenge` | WebAuthn challenge for confirming `POST /auth/sessions/revoke-all` with a passkey (`requireActor`, session only). One use, under its own session key: not the sign-in challenge, not the deletion one and not the password-change one. 400 when the account holds no passkey |
| GET | `/auth/me` | Current session user |
| DELETE | `/auth/account` | Hard-delete the signed-in account: the user, every workspace they solely own and everything in it ([`accountDeleter.js`](../server/src/lib/accountDeleter.js)). `requireActor`, session only; a bearer token is 403. Body `{ email, password }` or `{ email, passkey }`: the account's email as a typed confirmation, plus a fresh credential. 204 and the session is destroyed; 400 missing or mismatched email; 403 wrong password or failed passkey; 429 once the account is over its failed-confirmation limit; 409 `{ error, memberships }` while the user belongs to a workspace they don't solely own, deleting nothing |
| POST | `/auth/password` | Replace the signed-in account's password (see [Password](#password)). Session only; a bearer token is 403. Body `{ currentPassword, newPassword }` or `{ newPassword, passkey }`. 200 `{ ok: true }` and the caller stays signed in; 400 a new password under the minimum (the policy's own sentence) or no credential offered; 403 wrong current password or failed passkey — not 401, the session is still good; 429 once the account is over its failed-confirmation limit, which it shares with `DELETE /auth/account` |
| POST | `/auth/password/passkey-challenge` | WebAuthn challenge for confirming `POST /auth/password` with a passkey (session only). One use, under its own session key: not the sign-in challenge, and not the deletion one. 400 when the account holds no passkey |
| POST | `/auth/account/passkey-challenge` | WebAuthn challenge for confirming `DELETE /auth/account` with a passkey (`requireActor`, session only). One use, and kept apart from the sign-in challenge |
| POST | `/auth/webauthn/register/begin` · `/complete` | Add a passkey (`requireAuth`): the prompt after signup, and Settings → Passkeys. `/begin` carries the account's stable WebAuthn user handle as `user.id`, so every passkey on an account is one WebAuthn user; an account registered before KOL-052 has one written here on its first registration. `/complete` answers 409 when the credential id is already registered — to this account or any other, with the same message either way (WebAuthn §7.1) |
| GET | `/auth/webauthn/passkeys` | The signed-in user's passkeys, for Settings: `{ passkeys: [{ credentialID, deviceType, backedUp, createdAt, lastUsedAt }], hasPassword, userHandle, rpId }`. `userHandle` (null on an account registered before KOL-052) and `rpId` (`WEBAUTHN_RP_ID`, not necessarily the client's host) are what a `PublicKeyCredential.signal*` call needs to name the account; they are siblings of `passkeys`, so each summary stays the explicit field list it is. `requireAuth`, session only; a bearer token is 403. Never includes a public key |
| DELETE | `/auth/webauthn/passkeys/:credentialID` | Remove one of the signed-in user's own passkeys (`requireAuth`, session only). Answers the list as it now stands; 404 when this account holds no such passkey, another account's included; 409 when it is the last way into an account with no password |
| POST | `/auth/webauthn/login/begin` · `/complete` | Passwordless login via passkey. With an email or without one (discoverable credentials). Records the passkey's `lastUsedAt` and sync status. `/complete` answers 401 `Passkey not recognized` when no account holds the credential — the one refusal the client signals to the authenticator — and 401 `Passkey authentication failed` when the assertion did not verify. Throttled by client address (no email in its body), sharing that counter with `/auth/login`: 429 with a `Retry-After` |

## Password

One rule, in one place: [`lib/passwordPolicy.js`](../server/src/lib/passwordPolicy.js) exports
`passwordProblem(value)`, which answers `null` or a single sentence. **A 12-character minimum, and
nothing else** — length, not composition. NIST SP 800-63B stopped recommending the
upper/lower/digit/symbol rules because they push people towards `Password1!` and away from the long
passphrases that actually resist guessing. There is no maximum either: bcrypt reads the first 72
bytes of any password, and both routes below hash the same way, so a long passphrase still signs in.

Who asks, and who does not:

- **`POST /auth/register`** asks, after its missing-field refusal (which keeps its own wording, so a
  client can tell "you left it blank" from "it is too short") and before any counter, lookup or
  hash. A refusal creates no user and no workspace.
- **`POST /auth/password`** asks, with the same call, so what it takes to create an account and what
  it takes to change one cannot drift apart.
- **`POST /auth/login` never asks.** An account whose stored password is shorter than the minimum
  goes on signing in: locking out everyone who registered before the rule is a worse failure than a
  short password, and a sign-in form that refuses a *correct* password teaches nobody anything they
  can act on. The policy gates writes.

`POST /auth/password` re-authenticates exactly as [`DELETE /auth/account`](#auth) does, because a
session is a thing a borrowed laptop also has and the premise of changing a password is that the old
one may be known to someone else. The body carries the **current password**, or a **passkey
assertion** against a single-use challenge from `POST /auth/password/passkey-challenge` — the latter
is also how an account with no password of its own sets one. A failed re-authentication is **403, not
401**: the session is still good, and a 401 reads to a client as "you have been signed out". Failed
confirmations are counted by [`lib/attemptLimiter.js`](../server/src/lib/attemptLimiter.js) under the
account's own `user` key — the key `DELETE /auth/account` counts under too, deliberately: it is the
same guess at the same secret, so two keys would hand one session twice the tries. Checked before the
bcrypt compare and the signature verification, so a blocked caller costs neither.

Session only, and **not `requireActor`**: that guard also admits the MCP bearer token, one secret
shared with an AI connector, and a connector does not get to change someone's password — with or
without the old one. A bearer caller is 403, as at passkey management.

A successful change leaves **the caller signed in** and does **not** end the account's other
sessions — that is [`POST /auth/sessions/revoke-all`](#sessions), asked for separately and on
purpose: a password changed because it was weak is not the same event as a device out of its owner's
hands, and a change that silently signed every other browser out would be the more surprising of the
two. Also out of scope today: password reset by email (it needs a mail credential), breach-list or
zxcvbn scoring, and forcing a rotation on existing accounts.

`PASSWORD_LOG_LEVEL` (`off | light | normal | verbose`, default `light`) traces the route: every
refusal with its reason and the user id, every password actually changed and which credential
confirmed it, each challenge issued at `normal`. Neither password is ever logged, nor its length. The
client logs its own side on `localStorage.PASSWORD_LOG_LEVEL`.

## Sessions

A session is a row in the session store keyed by its own id, and that store **cannot be searched by
user**: `connect-mongo` holds each session serialized, so "end every session this account has" is
not a query the API can write. `POST /auth/logout` therefore ends only the session it is called
from — which left a session on a borrowed laptop, or one on a stolen phone, with no way for its
owner to end it at all.

`POST /auth/sessions/revoke-all` is that way, and it is **a timestamp rather than a session table**:

- Every sign-in stamps the session it creates with `issuedAt`, epoch milliseconds —
  `POST /auth/login`, `POST /auth/register` and `POST /auth/webauthn/login/complete`, all three
  through one function in [`routes/auth.js`](../server/src/routes/auth.js) so none can be forgotten.
- The account carries `credentialsChangedAt` ([`models/User.js`](../server/src/models/User.js)),
  written at creation and bumped by this route.
- `requireAuth` and `requireActor` ([`middleware/auth.js`](../server/src/middleware/auth.js))
  compare the two on every session request. A session that **predates** the bump is destroyed in the
  store, has its cookie cleared with the attributes it was set with, and is answered **401**. Equal
  stands, which is how the calling session survives: the route re-stamps it with the very
  millisecond it writes to the account.

A table of live sessions would be a second register of the same fact — one that has to stay true
through every expiry, every store swap and every instance — and the store could not populate it
anyway. The cost of the timestamp instead is one indexed read per session request, in middleware
that already runs on all of them.

Two asymmetries, both deliberate:

- **No `credentialsChangedAt` means nothing was ever revoked**, so the session stands. Accounts
  registered before this feature have no such field, and reading its absence as "revoked at the dawn
  of time" would sign every existing user out on deploy.
- **A session with no `issuedAt`, on an account that *has* revoked, is over.** It was issued before
  the stamp existed, so it cannot be shown to postdate the revocation — and the premise of the
  feature is that the device holding it may not be in its owner's hands.

Re-authentication is [`DELETE /auth/account`](#auth)'s, for the same reason that route has one: a
session is a thing a borrowed laptop also has. The body carries the current **password**, or a
**passkey assertion** against a single-use challenge from `POST /auth/sessions/passkey-challenge`.
A failed one is **403, not 401** — a 401 from this route would read as "you have been signed out",
which is precisely what it promises not to do to the caller. There is **no typed email**: that
confirmation exists on the deletion route because deletion is irreversible, and this is undone by
signing in again.

Every live [`GET /events`](#events-sse) stream the account holds in the process is closed too, the
caller's own included: a revoked session is not noticed until its browser next asks for something,
and an SSE stream has already asked. The caller's client reconnects within seconds and is accepted.

Out of scope, and not accidents: **listing** active sessions with device, address or location (the
store cannot enumerate them by user — that is the whole reason this is a timestamp), notifying the
account by email, revoking the MCP bearer token or OAuth grants (KOL-014 owns per-connector
identity), and bumping the timestamp automatically when a password changes or a passkey is removed.
That connector carve-out is about a *token already issued* outliving the bump until it is rotated.
It never meant a revoked session could mint a **new** grant: both OAuth approval forms require a
live session, so the revoked device cannot re-point `Settings.mcpUserId` or get a code
([OAuth](#oauth-mcp-connector), KOL-098).
A deleted account's sessions are not bumped either; they are refused by the id check in
`GET /auth/me` and `requireActor`.

`SESSION_REVOKE_LOG_LEVEL` (`off | light | normal | verbose`, default `light`) traces both halves:
every session the check ends, naming the user, the session and both timestamps; every revocation and
every session stamped at a sign-in at `normal`; each accepted session's comparison at `verbose`. Ids
and timestamps only — never an email or a credential. The client logs its own side on
`localStorage.SESSION_REVOKE_LOG_LEVEL`.

## Templates

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/templates` | The workspace templates registration can seed from, as `[{ key, name, description }]` in definition order, the default (`worldbuilding`) first. No auth, and it sets no session: the signup form's "Start with" picker reads it. Code-defined in [`config/templates.js`](../server/src/config/templates.js); only these three fields are returned, never a template's content |

## AI chat

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/chat/providers` | Providers whose API key is configured on the server (`id`, `name`, `models`, `defaultModel`) |
| POST | `/chat` | Streaming chat over SSE. Body: `{ provider, model, messages, systemPrompt?, conversationId? }`. Tools are read-only on both paths — on the Responses-API path the relayed `/mcp` session carries no write tools (KOL-113; see [Roles](#roles)). **The relay reads as the connector, not as the caller**, so it is used only when `Settings.mcpUserId`'s workspace *is* the caller's; otherwise the turn takes the Chat Completions path and the tools run here against `req.workspaceId` (KOL-114). Either way no tool answers out of another tenant's graph. Persists to the conversation when `conversationId` is supplied — which must belong to the caller **and to the workspace the request acted in**, or it is `404 Conversation not found` before the stream opens and before anything is billed (KOL-091). The system prompt is built from the caller's memories *in that workspace* only. |

Providers are defined in [`lib/aiProviders.js`](../server/src/lib/aiProviders.js) and reached through
an OpenAI-compatible client. Currently registered: **OpenRouter** (primary), the native **Claude
(Anthropic)**, **xAI (Grok)**, **OpenAI** and **Google Gemini**, and **`steadfast`** (self-hosted,
tailnet-only) — see [architecture.md](architecture.md#ai-chat). A provider is only offered if its
API key env var is set.

## Conversations

A conversation belongs to a user **and** to the workspace it was held in, so every route here
filters on both (KOL-091). A chat is reachable only from the workspace it was created in; from any
other one it is absent from the list and `404 Conversation not found` by id — the same answer a
chat that never existed gets. A row written before tenancy (`workspaceId: null`) reads as the
caller's current workspace, so pre-switcher history is not lost; see
[data-model.md](data-model.md#both-are-scoped-to-a-workspace-not-just-a-user-closed-2026-10-21-kol-091).

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/conversations` | List the caller's conversations in the acting workspace, newest first |
| POST | `/conversations` | Create a conversation, stamped with the acting workspace |
| GET | `/conversations/:id` | Single conversation with messages |
| PATCH | `/conversations/:id` | Rename (sets `autoTitle: false`) or update |
| DELETE | `/conversations/:id` | Delete |
| POST | `/conversations/:id/title` | Auto-generate a title from the conversation |

Set `CONVERSATION_LOG_LEVEL` (`off`/`light`/`normal`/`verbose`, default `light`) to trace a 404: the
light tier says whether the row exists at all, belongs to another user, or is the caller's own in a
different workspace — which is the one thing a 404 cannot say for itself.

## Drafts

A **draft** is a generated set of proposed changes awaiting human review — a pull request against
the graph. Nothing here writes to `entities` or `relationshipgroups` except `POST /:id/apply`.

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/drafts` | List, newest first, max 50. Omits `items`, `source.text`, `diagnostics.rawOutput` and `grounding.systemPrompt` — the list view only needs counts. Excludes `discarded`. Lazily ages out runs stuck on `generating` for >10 min. |
| GET | `/drafts/quota` | Remaining AI allowance for the workspace: `{ granted, spent, remaining, exhausted }` in micro-dollars plus display strings. |
| POST | `/drafts` | Generate, streaming progress over **SSE**. Body: `{ text, provider?, roleStyle? }`. |
| POST | `/drafts/compose` | Build a draft from a docker-compose file — no model, no allowance. Body: `{ text, filename? }`. Returns **201** with the full draft, already `ready`. See below. |
| POST | `/drafts/openapi` | Build a draft from an OpenAPI 3.x or Swagger 2.0 document (JSON or YAML) — no model, no allowance. Body: `{ text, filename? }`. Returns **201** with the full draft, already `ready`. See below. |
| POST | `/drafts/kubernetes` | Build a draft from a `---` stream of Kubernetes manifests — no model, no allowance. Body: `{ text, filename? }`. Returns **201** with the full draft, already `ready`. See below. |
| POST | `/drafts/sql` | Build a draft from a SQL schema dump — no model, no allowance. Body: `{ text, filename? }`. Returns **201** with the full draft, already `ready`. See below. |
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
| `stage` | `{ stage: 'entities' \| 'relationships' \| 'open_questions' \| 'normalizing', chunk?, of? }` |
| `done` | `{ draftId, counts, route, budget }` |
| `error` | `{ message, code, ref, draftId }` — `message` is a sentence safe to show, `code` what to branch on, `ref` (an unmapped failure only, else `null`) the server log's index to the real error. Never the provider's own text — see [Errors](#errors) |

Pre-stream failures are ordinary JSON errors, not SSE frames:

| Status | Meaning |
|--------|---------|
| 400 | Empty text, or longer than `GENERATOR_MAX_CHARS` (25,000) |
| 402 | Not enough AI allowance to start a run (`GENERATOR_MIN_RUN_MICROS`, default $0.015) |
| 409 | A generation is already running for this workspace — one at a time, since cost is only known after a run finishes |

### `POST /drafts/compose`

The first vertical-ingestion producer ([`server/src/lib/producers/dockerCompose.js`](../server/src/lib/producers/dockerCompose.js)).
The client reads the file in the browser and sends its text; the server parses the YAML and returns
the finished draft in one response — no SSE, no allowance check, no generation lock, because no model
is called. The draft then goes through the same decision and apply routes as a generated one.

Recorded on the draft: `source.producer: 'docker-compose'`, `source.producerVersion: 'docker-compose@1'`,
`source.textHash` computed exactly as `POST /drafts` computes it (SHA-256 of the trimmed text, **after
redaction** — see below), `grounding.categories` from the workspace's entity types, and
`route.strategy: 'deterministic'`. `filename`, when given, becomes the draft's title.

**Credentials are stripped before the file is stored** ([`redactSecrets.js`](../server/src/lib/producers/redactSecrets.js)).
Unlike a braindump, the client sends a compose file without ever putting it in the textarea, so nobody
reviews what is uploaded — and Draft has no TTL, the JSONL export carries `source.text` and every
evidence quote out verbatim, and `verbose` logging prints quotes. So the redaction happens once, at the
seam: everything below it — `source.text`, `textHash`, every `input.evidence.quote`, every log line —
is the redacted file, and the raw one is never written anywhere. `source.redactedCount` says how many
values were removed.

| Rule | Example | Becomes |
|------|---------|---------|
| A key that names a credential (`*_PASSWORD`, `*_SECRET`, `*_TOKEN`, `*_API_KEY`, `*_PRIVATE_KEY`, …) | `POSTGRES_PASSWORD: hunter2` | `POSTGRES_PASSWORD: REDACTED` |
| `KEY=value` inside one scalar — `environment`'s list form, a `command` flag, a connection string | `- MYSQL_ROOT_PASSWORD=hunter2` | `- MYSQL_ROOT_PASSWORD=REDACTED` |
| A URL's userinfo, wherever it appears | `postgres://app:app@postgres:5432/app` | `postgres://REDACTED@postgres:5432/app` |
| A value shaped like a credential whatever it is called: JWT, `sk-…`, `ghp_…`, `xox?-…`, `AKIA…`, `AIza…`, a PEM block | `SETTINGS: AKIAIOSFODNN7EXAMPLE` | `SETTINGS: REDACTED` |

Two shapes are Kubernetes' own. An env var is written as a two-key mapping, so the credential's name
is a *sibling* key — `- name: SESSION_SECRET` / `value: …` — and the `value:` is judged by the `name:`
beside it. And in any object whose `kind` is `Secret`, **every** value under `data` / `stringData` goes
by position whatever it is called, because `POSTGRES_USER` is not a secret word and in a Secret it is
still a value nobody uploaded on purpose. *Any* object, at any depth, not only a document's own root:
`kubectl get secrets -o yaml` emits one document whose root is a `kind: List` with the Secrets under
`items`, and a wrapped Secret is a Secret. A `ConfigMap`'s `data` is deliberately *not* redacted —
wrapped or not — because that is where a manifest keeps the endpoints the producer's edges are made of;
only the mapping that itself says `kind: Secret` is read by position, never the one containing it.

A key that names an **address** (`*_URL`, `*_URI`, `*_HOST`, `*_ENDPOINT`, `*_DSN`, …) keeps its value
and loses only its userinfo: the host is what the producer turns into an edge, and it is not the secret.
Redaction preserves the file's line count, so a YAML error still names the line the person sees in their
editor, and evidence offsets are offsets into the text that was stored.

| Compose | Proposed |
|---------|----------|
| `services.<name>` | Entity titled `<name>`: **Data Store** when the image's own name (registry, namespace and tag stripped) is postgres/postgresql, mysql, mariadb, mongo/mongodb, redis, memcached, elasticsearch, rabbitmq, kafka or minio; otherwise **Service**. An `attribute` block each for `image` and `ports`; tag `docker-compose`. |
| `depends_on` (list or map form), `links` | `Depends on` group — Dependent, Dependency |
| An `environment` value holding a URL whose host is another service (its name, `hostname` or `container_name`) | `Calls` group — Caller, Callee |
| An `environment` URL whose host is not a service (loopback, `host.docker.internal` and `${…}` hosts ignored) | One **External Dependency** entity per host, plus a `Depends on` group |

Every item's `input.evidence.quote` is the YAML line that produced it, with offsets into `source.text`.
Titles are deduplicated against the workspace as a braindump's are: an exact normalized-title match
becomes `op: 'update'` (`matchedBy: 'exact-normalized-title'`), and such an update leaves out any
attribute block the entity already has, so re-importing an unchanged file does not stack copies. A
near-miss is flagged `duplicate_candidate`, never merged. **Groups are deduplicated the same way**: an
edge the workspace already holds under the same label becomes `op: 'update'`
(`matchedBy: 'same-members-and-label'`) carrying `proposed.targetGroupId`, so a re-import brings the
roles on that link up to date rather than adding a second copy of it. YAML `<<` merge keys and anchors
are followed.

| Status | Meaning |
|--------|---------|
| 201 | The draft, `status: 'ready'` |
| 400 | `text` missing or longer than 60,000 characters; invalid YAML (`{ error, line }` — the message names the line in the file as sent); no top-level `services:` mapping; or the workspace lacks an entity type the file needs (`{ error, missingCategories }`) — no draft is created |

`COMPOSE_LOG_LEVEL` = `off | light | normal | verbose` (default `light`) logs each draft created, refusals
and drop reasons, and each proposed item. `REDACT_LOG_LEVEL`, same tiers, logs one line per file redacted,
then the key and rule behind each redaction, then the line it landed on — never a redacted value.

### `POST /drafts/openapi`

The second vertical-ingestion producer ([`server/src/lib/producers/openApi.js`](../server/src/lib/producers/openApi.js)),
and the same route as `/drafts/compose` with a different parse: one request in, the finished draft
out, no SSE, no allowance check, no generation lock, and the same decision and apply routes
afterwards. Recorded on the draft: `source.producer: 'openapi'`, `source.producerVersion:
'openapi@1'`, the same `source.textHash`, `grounding.categories`, and `route.strategy:
'deterministic'`. **Credentials are stripped before the document is stored**, by the same
`redactSecrets` pass and for the same reasons as a compose file — a spec routinely carries an
example API key, and the client uploads it without ever showing it in the textarea.

Accepts **JSON and YAML** (JSON is YAML, so one reader gives both line numbers), **OpenAPI 3.x** and
**Swagger 2.0**. Anything else is a 400 naming the top-level keys it found instead.

| OpenAPI | Proposed |
|---------|----------|
| `info.title` | One **Service**, with an `attribute` block for `info.version` (*API version*) and one for the spec version (*Spec version*, e.g. `OpenAPI 3.1.0`), plus a `text` block from `info.description`. Tag `openapi`. |
| Each tag the document uses — its declared `tags[]` first, in order, then any tag an operation names; an operation that names none is grouped under its **first path segment**, so a document that declares no tags maps to one entity per path prefix | One **API** per tag, with an `attribute` block (*Operations*) listing `GET /pets, POST /pets, …` in document order, capped at 40 with `…and N more`. Joined to the service by an `Exposes` group — Provider, Endpoint |
| Each `servers[].url` host that is not the service's own (the **first** server is where the API itself answers; loopback, `{template}` and relative URLs are ignored) | One **External Dependency** per host, plus a `Depends on` group — Dependent, Dependency |

Only local `#/components/…` `$ref`s are followed, one level deep, and only where one can change the
mapping — a path item. An unresolvable ref, an external ref and a ref to a ref are each a **drop
reason**, not a 400: one broken reference should not cost a reviewer the rest of the document.
Request and response schemas are not read at all.

Titles are deduplicated against the workspace exactly as a compose draft's are: an exact
normalized-title match becomes `op: 'update'` (`matchedBy: 'exact-normalized-title'`), and such an
update leaves out any attribute **or text** block the entity already has, so re-importing an
unchanged document neither stacks attributes nor appends `info.description` twice. Groups are
deduplicated as a compose draft's are, by member ids and label (`matchedBy:
'same-members-and-label'`), so a re-import updates each `Exposes` and `Depends on` link rather than
adding a second one. A near-miss is flagged `duplicate_candidate`, never merged. YAML anchors and
`<<` merge keys are followed.

| Status | Meaning |
|--------|---------|
| 201 | The draft, `status: 'ready'` |
| 400 | `text` missing or longer than 60,000 characters; invalid JSON or YAML (`{ error, line }`); no top-level `openapi:`/`swagger:` key (the message names what it found, and says so when the file looks like a compose file); a version other than 3.x or 2.0; no `info.title`; or the workspace lacks an entity type the document needs (`{ error, missingCategories }`) — no draft is created |

`OPENAPI_LOG_LEVEL` = `off | light | normal | verbose` (default `light`), the same tiers
`COMPOSE_LOG_LEVEL` has and a separate setting, so one producer's lines can be read without the
other's.

### `POST /drafts/kubernetes`

The third vertical-ingestion producer
([`server/src/lib/producers/kubernetes.js`](../server/src/lib/producers/kubernetes.js)), and the same
route as `/drafts/compose` and `/drafts/openapi` with a different parse: one request in, the finished
draft out, no SSE, no allowance check, no generation lock, and the same decision and apply routes
afterwards. Recorded on the draft: `source.producer: 'kubernetes'`, `source.producerVersion:
'kubernetes@1'`, the same `source.textHash`, `grounding.categories`, and `route.strategy:
'deterministic'`. **Credentials are stripped before the manifests are stored**, by the same
`redactSecrets` pass — which for this producer also reads Kubernetes' `{ name, value }` env shape and
a `Secret`'s `stringData` (see the table above).

**Multi-document YAML is the unit of iteration.** A manifest arrives as a `---` stream — that is what
`kubectl kustomize`, `helm template` and `kubectl get -o yaml` all emit — and every document in it is
read, against one line counter, so an evidence offset and an error's line number are both into the
whole file. A file in which *no* document declares both `apiVersion` and `kind` is a 400: that pair is
how Kubernetes itself identifies an object, and `kind` alone is a word other formats use.

| Manifest | Proposed |
|----------|----------|
| `Deployment`, `StatefulSet`, `DaemonSet` | Entity titled `metadata.name` — or `<name>.<namespace>` when another object in the stream carries the same name in a different namespace, so a `kubectl get all -A` dump proposes both rather than the second being dropped as a duplicate of the first: **Data Store** when the first container's image is one of the names the compose producer knows (postgres, mysql, redis, …; the same list, imported rather than copied); otherwise **Service**. An `attribute` block each for the kind and apiVersion (*Kind*), the container images (*Image*), `spec.replicas` (*Replicas*) and, when the object declares one, `metadata.namespace` (*Namespace*); tag `kubernetes`. |
| `Service` | One **API** per `spec.ports[]` entry, titled `<service name>:<port>` (the name namespace-qualified on the same rule as a workload's), with an `attribute` block for the port and protocol (*Port*, e.g. `80/TCP → 8080`), one for `spec.type` (*Service type*) and one for a declared `metadata.namespace` (*Namespace*). Joined by an `Exposes` group — Provider, Endpoint — to the workload **in the Service's own namespace** whose pod labels match **all** of `spec.selector`, as Kubernetes itself matches them: a selector never reaches across a namespace. |
| `PersistentVolumeClaim` | One **Data Store**, with an `attribute` block each for the requested size (*Storage*), `accessModes` (*Access modes*), `storageClassName` (*Storage class*) and a declared `metadata.namespace` (*Namespace*) |
| An `env[].value`, or a value of a `ConfigMap` an `envFrom[].configMapRef` names, holding a URL whose host is another workload — or a `Service` in front of one. Four readings, in order: an exact `metadata.name`; a bare name (`cache`), read in the **reading pod's own namespace** first, where Kubernetes' search path looks, and otherwise in the one namespace that name appears in; `service.namespace` (`cache.prod`), which reaches the object in **that namespace and no other**; and a cluster-DNS name (`cache.prod.svc`, `cache.prod.svc.cluster.local`), the same but falling back to the only `cache` in the file, because the suffix already proves the host is in-cluster. | `Calls` group — Caller, Callee. The edge reaches the **workload**, not the Service object, because that is what answers. |
| Such a URL whose host is nothing in the file (loopback and `$(VAR)` / `${VAR}` hosts ignored) | One **External Dependency** per host, plus a `Depends on` group — Dependent, Dependency. A host outside those readings is external even when its first label matches something in the file: `api.stripe.com` beside a Deployment called `api` is a dependency, not a call, and `cache.prod` beside a `cache` in `team-b` is one too — that `cache` is a different object. |

A `kind` this mapping has no reading for — `Ingress`, `HorizontalPodAutoscaler`, a CRD — is a **drop
reason** naming the kind, not a refusal: a namespace dump is mostly objects a graph has nothing to say
about, and refusing the stream over one of them would cost a reviewer every workload in it.
`ConfigMap`, `Secret`, `Namespace`, `ServiceAccount` and `List` are passed over silently — a
ConfigMap's values are read, but a node per ConfigMap says nothing a reviewer wants, and a Secret is
not read at all. A `Service` with no selector, one no workload in its namespace matches, one with no ports, a workload
with no `metadata.name` and a workload with no containers are each a drop reason too. So is a **bare**
host that is a name in several namespaces and in none of them the reading pod's: the file holds
candidates, so the host is not an External Dependency, and choosing one of them would be a guess. `env[].valueFrom`
and `envFrom[].secretRef` are not followed; neither are volume mounts, so a claim is proposed without
an edge to the workload that mounts it.

Titles and groups are deduplicated against the workspace exactly as the other two producers' are
(`matchedBy: 'exact-normalized-title'` / `'same-members-and-label'`), so re-importing an unchanged
stream proposes updates rather than a second copy of everything, and leaves out the blocks its targets
already carry. A near-miss is flagged `duplicate_candidate`, never merged. YAML anchors and `<<` merge
keys are followed, within the document that declares them.

| Status | Meaning |
|--------|---------|
| 201 | The draft, `status: 'ready'` |
| 400 | `text` missing or longer than 60,000 characters; invalid YAML in any document (`{ error, line }` — the line in the file as sent); no document declaring both `apiVersion` and `kind`; or the workspace lacks an entity type the manifests need (`{ error, missingCategories }`) — no draft is created |

`KUBERNETES_LOG_LEVEL` = `off | light | normal | verbose` (default `light`), the same tiers and a
separate setting again.

### `POST /drafts/sql`

The fourth vertical-ingestion producer
([`server/src/lib/producers/sqlSchema.js`](../server/src/lib/producers/sqlSchema.js)), and the same
route as the other three with a different parse: one request in, the finished draft out, no SSE, no
allowance check, no generation lock, and the same decision and apply routes afterwards. Recorded on
the draft: `source.producer: 'sql-schema'`, `source.producerVersion: 'sql-schema@1'`, the same
`source.textHash`, `grounding.categories`, `route.strategy: 'deterministic'`, and
`diagnostics.parsedVia: ['sql']` — this is the one producer the `yaml` reader does not read.
**Credentials are stripped before the dump is stored**, by the same `redactSecrets` pass and for the
same reasons: a dump's header records the connection string it was taken with, and a column `DEFAULT`
is where a seeded token ends up.

The input is **the DDL**: `pg_dump --schema-only`, `mysqldump --no-data`, a migration directory
concatenated, a schema exported by a GUI. It is the one producer that needs no credential of any kind
— the file is already on the customer's disk. Reading a live database or an ORM's migrations is not
this route.

**The dump is lexed, not pattern-matched.** Comments (`--`, `#`, `/* */`) are dropped; a string
literal, a dollar-quoted body (`$$ … $$`, so a Postgres function's semicolons do not end its
statement) and a quoted identifier (`"…"`, `` `…` ``, `[…]`) are each one token. So a comment or a
string holding the word REFERENCES, a semicolon or a bracket cannot change the reading, and an
identifier's quotes are not part of its name.

| SQL | Proposed |
|-----|----------|
| `CREATE TABLE` (ANSI, plus `IF NOT EXISTS`, `TEMPORARY`/`UNLOGGED`, and the Postgres, MySQL and SQL Server identifier quotings) | One **Data Store** titled the table's name — or `<schema>.<name>` when the file declares the same bare name under more than one schema, so a multi-schema dump proposes both rather than the second being dropped as a duplicate. An `attribute` block for a declared schema (*Schema*) and one per column, labelled with the column's name and valued with its type plus `PRIMARY KEY`, `NOT NULL` and `UNIQUE` as declared — inline, as a table-level constraint, or in a trailing `ALTER TABLE`; tag `sql-schema`. Capped at 80 columns, the rest a drop reason. |
| A column's inline `REFERENCES`, a table-level `FOREIGN KEY (…) REFERENCES …`, and `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` — the form **pg_dump** emits for every key it writes | `Depends on` group — Dependent, Dependency. One link per pair of tables however many keys join them, and however many columns a key spans. A key a table has on itself proposes none. |
| `ALTER TABLE … ADD CONSTRAINT … PRIMARY KEY (…)` / `… UNIQUE (…)` — again the form **pg_dump** emits, and the only place a Postgres dump declares either | The `PRIMARY KEY` / `UNIQUE` marker on each column the constraint names, exactly as the inline form puts it there. Applied once every `CREATE TABLE` in the file has been read, so a statement order that puts the ALTER first reads the same. |

A column's `DEFAULT` is deliberately not carried into its attribute: it is where a dump keeps a
credential, and `redactSecrets` has already taken that out. A `PRIMARY KEY (a, b)` or `UNIQUE (a, b)`
over several columns, inline or in an ALTER, marks each of them `PRIMARY KEY (composite)` /
`UNIQUE (composite)`, because a column that is one of two in a key is not a key on its own. MySQL's
inline `KEY`/`UNIQUE KEY` indexes are read as constraints, not columns — and a column *called* `key`
is still a column.

An `ALTER TABLE` is read for the constraints it **adds**, one per comma-separated action, each from
that action's `ADD` — so a MySQL `ALTER TABLE x ADD PRIMARY KEY (…), ADD CONSTRAINT …` yields all of
them and a SQL Server `ALTER TABLE x WITH CHECK ADD CONSTRAINT …` is read, while `ADD COLUMN flag
boolean PRIMARY KEY` (a column, not a table constraint), `ALTER COLUMN … SET NOT NULL` and `DROP
CONSTRAINT` are not mined for keys at all. A constraint naming a table the file does not declare, or
a column that table does not have, is passed over in silence rather than as a drop reason: there is
no proposal for it to mark. Indexes, views, triggers, grants and `ALTER TABLE … ADD COLUMN` are not
read.

A foreign key's target resolves as ambiguously as SQL resolves it: the exact `schema.name`; failing
that the referencing table's **own** schema, where the search path looks first; failing that the one
table of that name the file declares. A bare name the file declares in several schemas and in none of
them the referencing table's is a **drop reason**, not a guess. A target the file does not declare at
all can still land on an entity the workspace already has, by title; otherwise it is dropped and said
so.

A statement with no reading — `CREATE TABLE … AS SELECT` (no column list), an unclosed column list, a
quote or comment that runs off the end of the file — is a **drop reason**, not a refusal: refusing a
2,000-line dump over one materialised view would cost the reviewer every table in it. Everything that
is neither a `CREATE TABLE` nor an `ALTER TABLE … ADD CONSTRAINT` is passed over in silence, because a
dump is mostly `SET`, `CREATE INDEX`, `COMMENT ON` and, with data, thousands of INSERTs.

Titles and groups are deduplicated against the workspace exactly as the other three producers' are
(`matchedBy: 'exact-normalized-title'` / `'same-members-and-label'`), so re-importing an unchanged
dump proposes updates rather than a second copy of everything, and leaves out the column blocks its
targets already carry. A near-miss is flagged `duplicate_candidate`, never merged.

| Status | Meaning |
|--------|---------|
| 201 | The draft, `status: 'ready'` |
| 400 | `text` missing or longer than 60,000 characters; no readable `CREATE TABLE` in the file (the message says what the producer reads, and names the first drop reason when a `CREATE TABLE` was found but could not be read); or the workspace lacks the `Data Store` entity type (`{ error, missingCategories }`) — no draft is created |

`SQL_SCHEMA_LOG_LEVEL` = `off | light | normal | verbose` (default `light`), the same tiers and a
separate setting again.

The client sends a `.sql` file here on its **extension** — the only producer chosen that way, since a
dump has no top-level key to read and nothing else arrives under that name
([`client/src/lib/importFile.js`](../client/src/lib/importFile.js)).

**Out of scope:** Helm charts and kustomize overlays (templated input, and their own problem), reading
a live cluster or any kubeconfig, and drift detection.

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

## Workspace

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/workspace` | The caller's workspace: `{ _id, name, role, createdAt }`. `role` is the caller's own membership role (`owner` \| `editor` \| `viewer`), read from the `members` array by `resolveWorkspace` and never from a request, so a client can hide what an editor or a viewer may not do |
| PATCH | `/workspace` | Rename it. Body `{ name }`, trimmed, 1–80 characters. **Owners only**: 403 `{ error: 'NOT_WORKSPACE_OWNER' }` for any other role. 400 `{ error: 'INVALID_WORKSPACE_NAME' }` for an empty, whitespace-only, over-long or non-string name, changing nothing. Answers the same shape as `GET` |
| GET | `/workspace/members` | Who is in it: `[{ userId, email, role, isOwner }]` in `members` order. **Any member** — see [Collaborators](#collaborators). `email` is `null` for a member whose account is gone; `isOwner` marks the one `Workspace.ownerId` names |
| POST | `/workspace/invites` | Invite an address (KOL-124). Body `{ email, role? }`; `role` defaults to `editor`. **Owners only.** 201 with `{ _id, email, role, invitedBy, createdAt }`; **200** with the same row when that address was already invited (the role is updated rather than a second invite written). 400 `INVALID_EMAIL` / `INVALID_ROLE`, 409 `ALREADY_A_MEMBER`. **No mail is sent and no link is minted**, and the answer says nothing about whether the address has an account |
| GET | `/workspace/invites` | The addresses waiting on this workspace, oldest first, each `{ _id, email, role, invitedBy, createdAt }`. **Any member** |
| DELETE | `/workspace/invites/:inviteId` | Withdraw one. **Owners only.** 204; 404 for an id that is not an invite of *this* workspace (never 403); 400 `INVALID_ID` |
| PATCH | `/workspace/members/:userId` | Change a member's role. Body `{ role }`. **Owners only.** 200 `{ userId, role }`; 400 `INVALID_ROLE`; 404 for a user who is not a member; **409 `LAST_OWNER`** when it would demote the workspace's only owner, writing nothing |
| DELETE | `/workspace/members/:userId` | Remove a membership. **Owners only.** 204; 404 for a non-member; **409 `LAST_OWNER`** for the only owner. Their content stays — it belongs to the workspace — and they lose access on their next request |

Registration has created a workspace since tenancy landed, and until KOL-071 nothing read its name
back — every tenant's workspace was "My Workspace" and indistinguishable from every other. So
`POST /auth/register` now takes an optional `workspaceName` (the same rule, and the same
`INVALID_WORKSPACE_NAME` refusal, creating no account), the Workspace group in Settings
(`client/src/components/WikiLayout.vue`) shows the name with an inline rename for an owner, and the
signup form offers the name as an optional field.

- **Scoped by the mount.** `requireAuth` + `resolveWorkspace`, like every other tenant-content
  route, so the workspace read or renamed is the caller's own and there is no parameter with which
  to name another. Unauthenticated is **401**.
- **The role check lives once.** `requireWorkspaceRole('owner')` in
  [`middleware/workspace.js`](../server/src/middleware/workspace.js), beside `resolveWorkspace`,
  because collaborator invites, member removal and billing will each need exactly it. It is
  hierarchical — a gate asking for `editor` passes an owner too — and it fails closed: with no
  `req.workspaceRole` (a route mounted without `resolveWorkspace`) nothing passes.
- **Only `name` is read from a body**, so a forged `_id`, `members`, `ownerId` or `aiBudget` there is
  ignored. The 80-character cap is counted in code points, so it is the same cap for a Hebrew or an
  emoji name as for an ASCII one.
- Logging is `WORKSPACE_LOG_LEVEL` (`off | light | normal | verbose`, default `light`): the light
  tier names every rename with the old name, the new one and who asked, and every role refusal with
  the role it read — the **source** of a change, not just its result.

## Workspaces

Which workspace a request acts in, for a user who belongs to more than one (KOL-090) — and, since
KOL-123, where a second one comes from.

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/workspaces` | Every workspace the caller is a member of, each `{ _id, name, role, createdAt }` — the same shape as `GET /workspace` — sorted `createdAt` then `_id`, so oldest first and the order is total. `role` is the caller's own in each. Both auth paths; a session caller with no membership gets `[]`, not 403 |
| POST | `/workspaces/:id/select` | Make `:id` the workspace this session acts in: checks membership, writes `req.session.workspaceId`, saves the session before answering, and returns the selected workspace in the same shape. **Session only** — a bearer connector has no session to hold a choice in and is 401. 404 `{ error: 'Not found' }` for an id the caller is not a member of, writing nothing (never 403, which would confirm the row exists); 400 `INVALID_ID` for a malformed one |
| POST | `/workspaces` | Create one, owned by the caller (KOL-123). Body `{ name, template? }`. `name` is the rule `PATCH /workspace` uses — trimmed, 1–80 code points, else 400 `INVALID_WORKSPACE_NAME` — and is not unique. `template` is a key from [`GET /templates`](#templates): absent seeds the default (`worldbuilding`), a key that names none is 400 `Unknown template` (registration's wording), and **`null` seeds nothing**, which is the only kind of workspace [`POST /import`](#import) will write into. 201 with the new workspace in the same `{ _id, name, role, createdAt }` shape, `role: 'owner'`. 409 `{ error: 'WORKSPACE_LIMIT_REACHED', limit }` once the caller already **owns** `WORKSPACE_MAX_PER_OWNER` (default 10), writing nothing. **Session only**, like `/select` and for the same reason. Only `name` and `template` are read from the body. It does **not** select what it creates |

- **The choice is session state**, server-side, not a client preference: the client cannot scope its
  own reads, so a workspace chosen in a client store while the server resolved another is exactly
  the read-A-write-B split this removes.
- **Membership is re-checked every request** (see [Authentication](#authentication)), and a stale
  selection falls back to the default instead of refusing. The id is left in the session rather than
  cleared — `resolveWorkspace` also runs on `/events`, whose response ends only when the stream
  does, so a session written there would be saved minutes later on top of whatever was chosen since.
  `POST /workspaces/:id/select` is the only writer.
- **The default is ownership-then-age**: the oldest workspace the caller owns, else the oldest they
  are a member of. Ownership first because an invitation to someone else's workspace — which, once
  invites land, can arrive unasked — must not become where a user's own writes go. "Owns" is read
  from their own membership role, the same fact every role gate judges, not from `Workspace.ownerId`.
- The switcher is in the Workspace group in Settings (`client/src/components/WikiLayout.vue`),
  beside the New workspace form, and the page reloads after a switch: the entity list, the type
  registry and the `/events` stream are all bound to the workspace being left. It used to hide
  itself at a single membership, which was every account before `POST /workspaces` existed.
- **A create is not a selection.** `POST /workspaces` leaves `req.session.workspaceId` alone and
  the client follows it with `POST /workspaces/:id/select`, so that route stays the only writer of
  which workspace a session acts in — and the tab has to reload either way. Creating is also the
  one thing here that is *not* done inside a workspace, which is why this mount carries no
  `resolveWorkspace`: the caller is not acting in the new one yet.
- **The create-and-seed pair lives once**, in `createWorkspace()`
  ([`lib/workspaceSeeder.js`](../server/src/lib/workspaceSeeder.js)), shared with
  `POST /auth/register`: the `owner` membership, the `template` key stored on the document and the
  best-effort seed are the same on both paths, and a seeding failure leaves a usable workspace
  rather than failing the request.
- **The cap counts ownership, not membership** (`WORKSPACE_MAX_PER_OWNER`, default 10): a
  membership can arrive unasked once invites land, and being invited into other people's
  workspaces must not use up a user's own allowance. It is a count read before the write rather
  than a reservation taken with it, so creates that arrive *together* can overshoot it — bounded by
  the caller's own concurrency and once only, since every later request sees the higher count.
  Closing that needs a transaction (single mongod — see [Import](#import)) or a counter on `User`
  that would be a second source of truth for a number the workspaces already state.

**Not here yet:** deleting a workspace, moving content between workspaces, per-workspace billing or
per-plan limits, and enforcing `editor`/`viewer` differently than [Roles](#roles) already does.

## Collaborators

How a workspace gets a member who is not its owner (KOL-124). `Workspace.members[].role` has
carried `owner | editor | viewer` since KOL-071 and every content write has been gated on it since
KOL-103 — but registration wrote the single owner and no route added, re-roled or removed a
membership, so `editor` and `viewer` were unreachable on a real deployment and the write floor was
exercised only by tests. The routes are split across two mounts: the owner's half is on
[`/workspace`](#workspace) (there is a role there to gate on), the invitee's half is `/invites`.

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/invites` | The caller's own pending invitations, oldest first, each `{ _id, workspaceId, workspaceName, role, invitedByEmail, createdAt }`. Matched on the address their account is keyed by. Both auth paths; no invitations is `[]` |
| POST | `/invites/:id/accept` | Join the workspace, as the role the invite names. 200 with `{ _id, name, role, createdAt }` — the `GET /workspace` shape. **Session only.** 404 for an id not addressed to this account (never 403), and for one whose workspace has since been deleted, which also drops the invite. The invite is spent; a second accept is 404 and the membership is never duplicated |
| POST | `/invites/:id/decline` | Drop it. 204. **Session only.** 404 for an id not addressed to this account. The inviter is not told |

- **An invite names an email address and delivers nothing.** No mail is sent and no invite link or
  token is minted: an outbound mail credential is out of scope, so a link nobody could receive
  would be a secret with no delivery channel and a second way into a workspace to secure. The
  inviter passes the word on themselves; the invitee finds the invitation in their own Settings.
- **The address is the identifier registration already keeps unique.** `User.email` and
  `WorkspaceInvite.email` are both stored trimmed and lowercased, so the match is an equality test
  between two stored primitives — never a case-insensitive regex built from a request, which an
  `email` of `{"$regex": "."}` would turn into a way to claim every invite in the deployment.
- **An address with no account simply waits**, and **nothing tells the inviter whether it is
  registered** — the status and the body are the same either way, which is the privacy answer as
  well as the product one: an invite form must not be a way to ask who has an account here. A typo
  therefore waits rather than being refused, which is why an owner can withdraw an invite.
- **The two reads are role-blind**, like every read on a content route: knowing who else is in a
  workspace, and who has been asked to join it, is part of working in one. Every *write* is
  `requireWorkspaceRole('owner')`, on the route rather than at the mount, so those reads stay open.
- **A workspace always keeps at least one owner.** The last one cannot be demoted or removed (409
  `LAST_OWNER`) — the mirror of KOL-025's "an account keeps one way in": a workspace with no owner
  could never be renamed, invited into or managed again by anyone. `Workspace.ownerId` is kept
  naming a member who holds the role, so when that member is demoted or removed it moves to another
  owner; otherwise [account deletion](#auth) — which reads `ownerId` to decide sole ownership —
  would refuse forever for someone who is no longer a member at all.
- **A removed member loses access on their next request.** Nothing is cleared from their session:
  `resolveWorkspace` re-reads the membership list every time, so their selection of that workspace
  stops resolving and falls back to one they are still in (see [Workspaces](#workspaces)). Their
  content stays — it belongs to the workspace.
- **Accepting is not selecting.** `POST /workspaces/:id/select` stays the only writer of which
  workspace a session acts in, so an accepted workspace appears in the switcher and going there is
  a second, deliberate step.
- **A shared workspace blocks account deletion**, and always has:
  [`lib/accountDeleter.js`](../server/src/lib/accountDeleter.js) refuses while the account is a
  member of a workspace it does not solely own, reporting those memberships (409). This item makes
  that refusal reachable for the first time. A *pending invite* is not a membership and does not
  block a deletion — it is swept with the account, wherever it is, so it cannot be offered to
  whoever next registers that address.
- **Out of scope here:** email delivery and invite links, seat billing, per-entity or per-category
  permissions, transferring ownership outright (inviting a co-owner is how a workspace gets a
  second one), and per-user MCP identity (KOL-014) — a shared workspace makes that sharper but does
  not change it: the connector still acts as one `Settings.mcpUserId`.

## Export

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/export` | The caller's whole workspace as one canonical JSON document, as an `attachment`. |

The way a user takes their graph out of the product, and the form a Git connector will commit —
`server/src/lib/graphExporter.js` builds the document, `server/src/routes/export.js` is the HTTP skin
on it. The response is `application/json`, indented two spaces, with
`Content-Disposition: attachment; filename="<workspace>-<YYYY-MM-DD>.json"` (the name is an ASCII
slug of the workspace name, falling back to `workspace`, and the day is the export's own, in UTC).

```jsonc
{
  "version": "kol-emet/workspace-export@1",
  "exportedAt": "2026-10-10T08:30:00.000Z",
  "workspace":          { "name": "My Workspace" },
  "entityTypes":        [{ "_id", "name", "icon", "color": { "bg", "text" }, "order", "createdAt", "updatedAt" }],
  "relationshipTypes":  [{ "_id", "name", "scope", "sourceCategory", "targetCategory", "createdAt", "updatedAt" }],
  "entities":           [{ "_id", "title", "category", "summary", "tags", "blocks", "relationships", "open_questions", "createdAt", "updatedAt" }],
  "relationshipGroups": [{ "_id", "label", "members": [{ "refId", "refModel", "label", "notes" }], "createdAt" }],
  "openQuestions":      [{ "_id", "question", "status", "entry_ids", "createdAt", "updatedAt" }]
}
```

- **Deterministic.** The same graph exported twice is byte-identical, because diffability is the
  point. Every collection is sorted by a stable key — entities by `title` then `_id`, types by
  `order` then `name` then `_id`, groups and open questions by `_id` — sets of ids (`relationships`,
  `open_questions`, `entry_ids`) are sorted too, and blocks come back in their own `order`. A
  relationship group's `members` keep their stored order, which the reorder route owns. Every
  `ObjectId` is a string and every date an ISO-8601 string. The **only** field that is not a function
  of the data is `exportedAt`, which `exportWorkspace()` takes as an argument for exactly that reason.
- **Content only.** The document is built from an allowlist per collection, so no `workspaceId`,
  `aiBudget`, `ownerId`, `userId`, `email` or `passwordHash` appears anywhere in it — and a schema
  field added later cannot leak in by default. ChangeLog history and drafts are not included.
- **Scoped by the mount.** `requireAuth` + `resolveWorkspace`, like every other tenant-content
  route, so the workspace exported is the caller's own and there is no parameter with which to name
  another. Unauthenticated is **401**.
- Logging is `EXPORT_LOG_LEVEL` (`off | light | normal | verbose`, default `light`): the light tier
  names the workspace, the per-collection counts, the byte size and the **source** — this route, or
  a script that calls the same function.

Streaming does not exist, so a workspace is serialized in one go.

## Import

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/import` | One export document into the caller's **empty** workspace. Owner only. |

The other end of `GET /export`, and the half that makes the export provable: a graph exported,
imported and exported again is byte-identical but for the ids (KOL-077).
`server/src/lib/graphImporter.js` writes the documents, `server/src/routes/import.js` is the HTTP
skin on it. The body is the export document itself — `Content-Type: application/json`, not a
multipart upload — and the answer is **201** with what it wrote:

```jsonc
{
  "version": "kol-emet/workspace-export@1",
  "imported": { "entityTypes": 0, "relationshipTypes": 1, "entities": 18, "relationshipGroups": 7, "openQuestions": 3 },
  "skipped":  { "entityTypes": 6, "relationshipTypes": 4 },   // already in the workspace, by name
  "dropped":  { "members": 0, "questionEntries": 0 }          // references with no target in the file
}
```

- **Empty workspace only.** No entities, no relationship groups and no open questions, or it is
  **409 `WORKSPACE_NOT_EMPTY`** and writes nothing. That refusal is the design and not a gap:
  merging a graph into one that already exists needs an id-collision policy — does a colliding id
  mean "the same thing" or "a different thing"? — and that is a product decision this endpoint
  deliberately does not make. Registration seeds starter content, so an owner clears a workspace or
  uses a new one before importing — and since KOL-123 there is one to use:
  [`POST /workspaces`](#workspaces) with `template: null` creates a workspace seeded with nothing,
  which is where an import lands. The **type registries are exempt**: a seeded workspace always has
  types, and a rule that counted them could never import anything (an *empty* workspace has none,
  so the import creates them).
- **Every id is new.** Entity types, relationship types, entities, relationship groups and open
  questions each get a fresh `ObjectId` and every reference is rewritten to it — a group's
  `members[].refId` (with its `refModel` discriminator and its **array order**, which is meaning the
  reorder route writes), a question's `entry_ids`, and `Entity.relationships` /
  `Entity.open_questions`, which are **rebuilt** from the groups and the questions rather than copied
  from the file, since they are a cache of what those say. A reference to a row the document does not
  carry is **dropped** rather than written: an id this import did not mint could name another
  tenant's row. Block `_id`s are Mongoose's; nothing references a block.
- **The workspace comes from the mount, never the body.** `requireAuth` + `resolveWorkspace` like
  every other tenant-content route, then `requireWorkspaceRole('owner')` — an import writes a whole
  graph, so it is the owner's call, not an editor's (**403 `NOT_WORKSPACE_OWNER`**). A `workspaceId`
  anywhere in the uploaded file is never read, so a hand-edited document cannot write into another
  tenant. Unauthenticated is **401**.
- **A type already present by name is kept**, case-insensitively — the unique index on
  (`workspaceId`, `name`) is — and counted under `skipped`. Since `Entity.category` holds a type's
  *name*, the categories of imported entities are rewritten to the name the workspace actually
  holds: a workspace whose type is `worlds` importing a file whose type is `Worlds` ends with one
  type and every entity filed under `worlds`.
- **Refusals**, all of which write nothing: **400 `MALFORMED_JSON`** (the bytes are not JSON),
  **400 `MALFORMED_DOCUMENT`** (a row is not what it must be), **400 `UNSUPPORTED_VERSION`** (a
  `version` this server does not read — checked first, before any shape),
  **409 `WORKSPACE_NOT_EMPTY`**, **413 `IMPORT_TOO_LARGE`** (over a per-collection cap, or over the
  body limit). The *reason* — which field, which count, which version — stays in the server log: a
  response that narrated the document back would be an oracle for a hand-edited one.
- **Caps.** Per collection, so one upload cannot write an unbounded graph: 200 entity types, 1000
  relationship types, 5000 entities, 10 000 relationship groups, 5000 open questions, each
  overridable with `IMPORT_MAX_ENTITY_TYPES`, `IMPORT_MAX_RELATIONSHIP_TYPES`, `IMPORT_MAX_ENTITIES`,
  `IMPORT_MAX_RELATIONSHIP_GROUPS`, `IMPORT_MAX_OPEN_QUESTIONS`. The body limit is
  `IMPORT_BODY_LIMIT` (default `8mb`) — `/import` has a parser of its own, mounted ahead of the
  app-wide 100 kB one, which is also what turns a parse failure into a 400 instead of a 500.
- **One `workspace:imported` frame** on [`/events`](#events-sse) (KOL-102), carrying the same
  counts as the 201 and the actor, to every other stream in the workspace — never to another
  tenant's, and never back to the client that asked (`x-sse-client-id`). An import writes a whole
  graph and emits none of the per-entity events the normal write path does, so without it every
  other tab showed the pre-import workspace until a reload.
- Logging is `IMPORT_LOG_LEVEL` (`off | light | normal | verbose`, default `light`): the light tier
  names the document's version, the per-collection counts, the **source**, the frame it broadcast
  and the reason behind every refusal.

Not imported: `ChangeLog` and `Draft` (history waits on KOL-019 settling whether it is permanent),
and nothing about the account or the workspace itself — an import never renames a workspace. There
is no transaction (the deployment is a single mongod), so every question that can be settled from the
document is settled before the first insert; a write failing midway leaves a partial graph whose
owner has to clear it before retrying. YAML and Markdown input, streaming, and merging into a
non-empty workspace are each their own item.

## Events (SSE)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/events` | Server-Sent Events stream for live multi-client sync. On connect the server emits `client:id`; clients echo it back as the `x-sse-client-id` header on writes so the broadcaster can skip the originating tab. |

### The frames

| Frame | Sent by | Carries | What the client does with it |
|-------|---------|---------|------------------------------|
| `client:id` | the route, on connect | `{ clientId }` | stores it and echoes it as `x-sse-client-id` on every write |
| `entity:created` | every entity create | `{ entity, actor, changes }` | inserts the row |
| `entity:updated` | every entity update | `{ entity, actor, changes }` | replaces the row |
| `entity:deleted` | every entity delete | `{ entityId, entityTitle, actor, snapshot, deletedAt }` | drops the row |
| `question:created` | `POST /open-questions`, and the MCP `add_open_question` | `{ question, entry_ids }` | refetches the entity on screen if `entry_ids` names it |
| `question:updated` | `PUT /open-questions/:id` | `{ question, entry_ids }` | as above |
| `question:deleted` | `DELETE /open-questions/:id` | `{ questionId, question, entry_ids }` | as above, or if the panel is showing that question |
| `draft:applied` | `POST /drafts/:id/apply` | `{ draftId, applied, failed, blocked, skipped, actor }` | refetches the list |
| `workspace:imported` | `POST /import` | `{ version, imported, actor }` | refetches the list |
| `error` | the server, before it closes a stream | `{ error, limit? }` | see *Ending a stream* below |

`draft:applied` and `workspace:imported` are the **bulk writes**: one frame for a request that wrote many rows, rather than a
burst of per-entity events a 30-item apply would flood every open tab with (the applier passes
`broadcast: false` through `lib/changeLogger.js`; the importer never used the per-entity path at
all). The trade is that one frame cannot say *which* rows moved, so the client refetches rather
than patching — and that a frame nothing listens for is a bulk write no other tab ever sees, which
is what KOL-102 fixed. Both exclude the client that asked, by its `x-sse-client-id`, since that one
has the response.

The three `question:*` frames (KOL-116) are the open-question collection's own vocabulary. Entity
frames come out of `lib/changeLogger.js` — the audit row and the broadcast are one call — and this
collection writes no `ChangeLog`, so there was nothing to inherit and `/open-questions` broadcast
nothing at all: a second tab went on rendering a question that had been renamed, resolved or
deleted. `question` is the row as the panel renders it (`_id`, `question`, `status`, timestamps) and
`entry_ids` is **always bare string ids**, never the populated `{ title, category }` rows `PUT`
answers with — they are what lets a listener decide whether the entity it is showing is affected
without a refetch. The MCP `add_open_question` tool emits `question:created` itself, since it writes
the collection directly rather than through the route, and excludes no client (an MCP session holds
no `/events` stream). No actor is named on these frames: the route resolves none.

Not broadcast yet, and deliberately: relationship-group writes (they have no `ChangeLog` and so
need an event vocabulary of their own) and anything on `/chat`, which is a separate SSE channel with
its own client.

### Ending a stream

A stream is bounded in both lifetime and number (KOL-062), because it is authenticated once and then
held open while whole entity documents are pushed down it:

- **It ends when its session does.** The connection records the session it was opened by, and the
  30-second keep-alive sweep closes it once that session is no longer in the session store — expiry,
  a logout elsewhere, a cleared store. `POST /auth/logout` and `DELETE /auth/account` close their
  streams immediately rather than leaving up to 30 seconds of pushed content to a browser that has
  signed out; account deletion closes **every** stream of that account in the process, since the
  session store cannot be searched by user. A closed stream gets one `event: error` frame with
  `{"error":"session-ended"}` before the socket ends. Connections authenticated with `BEARER_TOKEN`
  have no stored session and are never swept for one.
- **`session-ended` is only ever sent to a session that really has ended.** It is final to the
  client — the tab stops reconnecting for good — so `POST /auth/sessions/revoke-all` closes the
  account's *other* streams and leaves the calling session's open (KOL-112). It used to close those
  too and assume the browser would re-dial; nothing re-dials, so the one device the route promises
  to keep signed in was the one left with dead live sync and a toast saying it had been signed out.
- **One user may hold at most `EVENTS_MAX_STREAMS_PER_USER` (default 10).** The next connection
  answers `200` with one `event: error` frame, `{"error":"too-many-streams","limit":10}`, and closes
  — not a status code, which an `EventSource` reports as an indistinguishable network error. It is
  refused before any `client:id` is issued, and the streams already open are untouched. The cap is
  per user; connections on the bearer token share one allowance. Both the cap and the sweep are
  per API instance (in-process state, as with the auth counters).

An `EventSource` dispatches **both** of those server frames and a plain dropped socket as `error`,
and only the frames carry `data` — which is how the client tells them apart
(`client/src/composables/useEvents.js`, KOL-102):

- `session-ended` and `too-many-streams` **end the loop**. Reconnecting would fetch the same
  refusal forever, so nothing is scheduled and the user is told instead ("signed out in another
  window", or the limit by number). Reload is the way back. Which makes it a contract on the
  server: a stream it wants back gets some other code, never `session-ended`.
- a `server-restarting` frame (what the SIGTERM sequence sends, KOL-093), or any code this build
  does not know, is **retried** — a stop that is wrong leaves a tab permanently blind, so an
  unrecognised code errs towards coming back.
- a dropped socket is retried with an **exponentially growing, jittered, capped** delay (1 s
  doubling to 30 s, ±25 %) rather than the fixed 3 s it used to re-dial: every tab in the
  deployment loses its stream in the same instant, so a fixed delay has them all return in the same
  instant too. A connection that opens resets the backoff.

Logging is `SSE_LOG_LEVEL` (`off | light | normal | verbose`, default `light`) on both ends — the
environment variable on the server, `localStorage.SSE_LOG_LEVEL` in the browser. Server-side the
light tier names the reason every connection ended; client-side it names every connect, every
ending with the source that caused it (which frame, or which transport failure) and every reconnect
with its attempt number and delay, and carries no payload — `normal` adds each frame's name and the
id it is about, `verbose` the frame itself.

## OAuth (MCP connector)

Endpoints that let the Claude.ai MCP connector authorize against this server (RFC 8414 discovery +
authorization-code with PKCE):

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/.well-known/oauth-authorization-server` | Discovery document |
| GET | `/authorize` | Approval page. Offers the Allow button only to a signed-in visitor; otherwise it says to sign in first, because the POST below would refuse |
| POST | `/authorize` | Approve → set `Settings.mcpUserId` to the signed-in user, issue auth code. `application/x-www-form-urlencoded` (the approval page's form). **Requires a live login session** — 401 for a revoked session (which it also ends), for an anonymous caller and for a bearer token. Sweeps expired codes before issuing, and answers **503** `too many pending authorizations` when the pending-code map is at its ceiling — ahead of the identity write, so a refused approval binds nothing |
| POST | `/oauth/token` | Exchange code for token. `application/x-www-form-urlencoded` |

These two and the bridge's own `POST /bridge/authorize` and `POST /bridge/oauth/token` are the only
endpoints that parse a form body, and each mounts `express.urlencoded` itself — see the
[origin guard](#authentication). Every other route takes JSON.

Approving a connector is the one place the MCP bearer identity is *created*, so both approval forms
sit behind `requireLoginSession` (KOL-098): a live, unrevoked session and nothing else. A bearer
caller is deliberately not enough — a connector that could re-point the identity it acts as is a
connector whose revocation does not hold. This is not in tension with the connector carve-out in
[Sessions](#sessions): that carve-out is about a bearer token
surviving a revocation until it is rotated, never about a revoked *session* minting a new grant.

An authorization code is held in memory for five minutes, and the map holding them is bounded two
ways (KOL-088): every issue first drops the codes whose five minutes are up, and an approval that
would push the map past `OAUTH_MAX_PENDING_CODES` (default `500`) is refused with a 503 instead.
Before this, `expiresAt` was read only at redemption, so a code nobody redeemed was never removed.

Logging is `OAUTH_LOG_LEVEL` (`off | light | normal | verbose`, default `light`). **No tier prints a
code, a `code_verifier` or a `code_challenge`** — each code redeems for `MCP_BEARER_TOKEN`, the
workspace-wide write token, and the router used to print `req.query` and `req.body` whole plus
`[...authCodes.keys()]` on a miss, which made the log (the deploy console, on a hosted box) a list of
live credentials. A code appears only as a **fingerprint**: the first 8 hex of its SHA-256, enough to
tie an issue to its redemption and not enough to redeem. `light` names the source of every decision
— the route, the grant type, the rule that refused, that fingerprint, and the identity each approval
binds; `normal` adds each code issued and redeemed with the outstanding **count** (never the keys),
each sweep, and discovery; `verbose` adds `redirect_uri` and `resource`. `state` is never logged at
any tier.

## MCP transport

| Method | Route | Description |
|--------|-------|-------------|
| POST/GET/DELETE | `/mcp` | Streamable-HTTP MCP endpoint. See [architecture.md](architecture.md) for the tool list. |
