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

Mount points and their guards:

| Prefix | Guard | Notes |
|--------|-------|-------|
| `/auth` | mixed | Login/registration; individual routes guard themselves |
| `/templates` | none | Workspace templates a signup can start from; public because the signup form is shown before an account exists |
| `/mcp` | self | MCP HTTP transport; auth handled inside the handler, and every tool scopes its queries to the MCP user's workspace |
| `/` (oauth) | none | OAuth discovery/authorize/token for the MCP connector |
| `/bridge/mcp`, `/bridge/*`, `/.well-known/*bridge*` | self | The Steadfast bridge: its own MCP transport behind `BRIDGE_TOKEN` (503 when unset), plus its own OAuth issuer and RFC 9728 resource metadata. Scoped to the MCP user's workspace. See architecture.md |
| `/events` | `requireAuth` + `resolveWorkspace` | Server-Sent Events stream; broadcasts reach only the connection's workspace. Re-checked after connect: the stream closes when its session leaves the store, and one user holds at most `EVENTS_MAX_STREAMS_PER_USER` |
| `/entities` | `requireAuth` + `resolveWorkspace` | Writes additionally use `requireActor` |
| `/relationship-groups` | `requireAuth` + `resolveWorkspace` | Writes use `requireActor` |
| `/relationship-types` | `requireAuth` + `resolveWorkspace` | |
| `/entity-types` | `requireAuth` + `resolveWorkspace` | Gates the category names entities and relationship types can hold |
| `/tags` | `requireAuth` + `resolveWorkspace` | Writes use `requireActor` |
| `/open-questions` | `requireAuth` + `resolveWorkspace` | |
| `/` (changelog) | `requireAuth` + `resolveWorkspace` | History + rollback under `/entities/:id/...`, and `/deleted` |
| `/chat` | per-route | AI chat (SSE streaming). `GET /providers`: `requireAuth`; `POST /`: `requireAuth` + `resolveWorkspace` |
| `/conversations` | `requireAuth` + `resolveWorkspace` | Saved AI conversations |
| `/drafts` | `requireAuth` + `resolveWorkspace` | Generated drafts; `POST /:id/apply` uses `requireActor` |

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
| GET | `/open-questions` | List. Supports `?status=open|resolved`. |
| GET | `/open-questions/:id` | Single question |
| POST | `/open-questions` | Create. `entry_ids` naming entities outside the caller's workspace are dropped. |
| PUT | `/open-questions/:id` | Update (question text, status, linked entities; same `entry_ids` rule) |
| DELETE | `/open-questions/:id` | Delete |

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
| POST | `/auth/register` | Create account (open registration). Body `{ email, password, template? }`: `template` is a key from [`GET /templates`](#templates) and decides what the new workspace is seeded with; left out, it is `worldbuilding`. 201 `{ ok: true }` and a session; 400 missing email or password; 400 `Unknown template` for a `template` that names none (including `null` or a non-string), creating no user or workspace; 409 email already registered. Throttled: 429 `Too many attempts. Try again later.` with a `Retry-After` once a client address has created its limit of accounts (default 10 per 60 minutes — its own counter and its own window, not the sign-in one), checked before the duplicate lookup and the password hash and creating no user or workspace. Only a *created* account is counted, so a 400 or a 409 leaves the budget untouched ([`lib/attemptLimiter.js`](../server/src/lib/attemptLimiter.js)) |
| POST | `/auth/login` | Password login → session. 401 `Invalid email or password` for both a wrong password and an unknown address (byte-identical). Throttled: 429 `Too many attempts. Try again later.` with a `Retry-After` once an email or a client address is over its failure limit, checked before the password is compared and identical for known and unknown addresses; a successful sign-in clears that email's counter ([`lib/attemptLimiter.js`](../server/src/lib/attemptLimiter.js)) |
| POST | `/auth/logout` | End session (`requireAuth`) |
| GET | `/auth/me` | Current session user |
| DELETE | `/auth/account` | Hard-delete the signed-in account: the user, every workspace they solely own and everything in it ([`accountDeleter.js`](../server/src/lib/accountDeleter.js)). `requireActor`, session only; a bearer token is 403. Body `{ email, password }` or `{ email, passkey }`: the account's email as a typed confirmation, plus a fresh credential. 204 and the session is destroyed; 400 missing or mismatched email; 403 wrong password or failed passkey; 429 once the account is over its failed-confirmation limit; 409 `{ error, memberships }` while the user belongs to a workspace they don't solely own, deleting nothing |
| POST | `/auth/account/passkey-challenge` | WebAuthn challenge for confirming `DELETE /auth/account` with a passkey (`requireActor`, session only). One use, and kept apart from the sign-in challenge |
| POST | `/auth/webauthn/register/begin` · `/complete` | Add a passkey (`requireAuth`): the prompt after signup, and Settings → Passkeys. `/begin` carries the account's stable WebAuthn user handle as `user.id`, so every passkey on an account is one WebAuthn user; an account registered before KOL-052 has one written here on its first registration. `/complete` answers 409 when the credential id is already registered — to this account or any other, with the same message either way (WebAuthn §7.1) |
| GET | `/auth/webauthn/passkeys` | The signed-in user's passkeys, for Settings: `{ passkeys: [{ credentialID, deviceType, backedUp, createdAt, lastUsedAt }], hasPassword, userHandle, rpId }`. `userHandle` (null on an account registered before KOL-052) and `rpId` (`WEBAUTHN_RP_ID`, not necessarily the client's host) are what a `PublicKeyCredential.signal*` call needs to name the account; they are siblings of `passkeys`, so each summary stays the explicit field list it is. `requireAuth`, session only; a bearer token is 403. Never includes a public key |
| DELETE | `/auth/webauthn/passkeys/:credentialID` | Remove one of the signed-in user's own passkeys (`requireAuth`, session only). Answers the list as it now stands; 404 when this account holds no such passkey, another account's included; 409 when it is the last way into an account with no password |
| POST | `/auth/webauthn/login/begin` · `/complete` | Passwordless login via passkey. With an email or without one (discoverable credentials). Records the passkey's `lastUsedAt` and sync status. `/complete` answers 401 `Passkey not recognized` when no account holds the credential — the one refusal the client signals to the authenticator — and 401 `Passkey authentication failed` when the assertion did not verify. Throttled by client address (no email in its body), sharing that counter with `/auth/login`: 429 with a `Retry-After` |

## Templates

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/templates` | The workspace templates registration can seed from, as `[{ key, name, description }]` in definition order, the default (`worldbuilding`) first. No auth, and it sets no session: the signup form's "Start with" picker reads it. Code-defined in [`config/templates.js`](../server/src/config/templates.js); only these three fields are returned, never a template's content |

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
| POST | `/drafts/compose` | Build a draft from a docker-compose file — no model, no allowance. Body: `{ text, filename? }`. Returns **201** with the full draft, already `ready`. See below. |
| POST | `/drafts/openapi` | Build a draft from an OpenAPI 3.x or Swagger 2.0 document (JSON or YAML) — no model, no allowance. Body: `{ text, filename? }`. Returns **201** with the full draft, already `ready`. See below. |
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
- **One user may hold at most `EVENTS_MAX_STREAMS_PER_USER` (default 10).** The next connection
  answers `200` with one `event: error` frame, `{"error":"too-many-streams","limit":10}`, and closes
  — not a status code, which an `EventSource` reports as an indistinguishable network error. It is
  refused before any `client:id` is issued, and the streams already open are untouched. The cap is
  per user; connections on the bearer token share one allowance. Both the cap and the sweep are
  per API instance (in-process state, as with the auth counters).

Logging is `SSE_LOG_LEVEL` (`off | light | normal | verbose`, default `light`); the light tier names
the reason every connection ended.

## OAuth (MCP connector)

Endpoints that let the Claude.ai MCP connector authorize against this server (RFC 8414 discovery +
authorization-code with PKCE):

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/.well-known/oauth-authorization-server` | Discovery document |
| GET | `/authorize` | Approval page |
| POST | `/authorize` | Approve → issue auth code. `application/x-www-form-urlencoded` (the approval page's form) |
| POST | `/oauth/token` | Exchange code for token. `application/x-www-form-urlencoded` |

These two and the bridge's own `POST /bridge/authorize` and `POST /bridge/oauth/token` are the only
endpoints that parse a form body, and each mounts `express.urlencoded` itself — see the
[origin guard](#authentication). Every other route takes JSON.

## MCP transport

| Method | Route | Description |
|--------|-------|-------------|
| POST/GET/DELETE | `/mcp` | Streamable-HTTP MCP endpoint. See [architecture.md](architecture.md) for the tool list. |
