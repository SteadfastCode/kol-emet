# Kol Emet — Hosted Wiki App

## Naming & Identity

- **Kol Emet** (Hebrew: *Voice of Truth*) is the personal instance name and the repository/code name for this project
- The repo will be named `kol-emet` — this serves as the internal codename
- A separate, marketable product name will be developed later under the **Steadfast Code** brand
- Daniel's personal instance will be hosted at **danielecker.dev**

---

## Concept

A hosted app for building and maintaining a **structured knowledge graph** — entities plus typed,
nestable relationships — that you create and keep current by *talking to an AI agent* (via MCP), not
just by hand-editing. Daniel's World Train series bible is the first instance, but that is a
deployment detail, not the product. Accessible from any device, persistent, multi-tenant.

---

## Product Direction

> Captures the strategic pivot. Sequenced work lives in [docs/roadmap.md](docs/roadmap.md).

**Positioning.** Kol Emet is an **AI-maintained knowledge graph for interconnected systems** — not a
documentation/prose tool. The durable differentiator is not "chat with an AI to write docs" (table
stakes); it is a **structured entity + relationship graph that an agent builds and maintains for you**
through the MCP tools, with manual editing always available. Most prose docs don't need this; systems
with many interconnected parts do.

**Beachhead → expansion.** Lead with **worldbuilding** (already works; a forgiving, underserved
proving ground for the graph+agent loop) and generalize the engine underneath it. The commercial
expansion is **software/system architecture** (teams, seats, B2B budget). Worldbuilding-first
*de-risks* architecture because the generalization work — user-defined entity types, templates,
graph generation — is exactly what carries the engine across.

**The hook (two stages).** (1) *Assistant* — the agent helps you build the graph one piece at a time
(largely built today). (2) *Generator* — point it at unstructured input (a braindump, a doc, or for
software: a **repo / OpenAPI spec / compose / k8s / DB schema**) and it proposes the whole graph. The
generator is the real draw; the software vertical's inputs make it a far stronger, more defensible
demo.

**Never stale, always reviewed.** The graph is *derived* from its sources: when a source changes, the
system detects drift and **proposes** an update — the model never goes out of date. Every generated or
drift-driven change lands as a **reviewable diff a human accepts** (no silent bulk writes). Drift
detection, version control, and this approval step are **one mechanism**: a proposed change is a
*pull request against the graph*.

**Git-native / repo-resident (dual-mode, DB-canonical first).** The graph gets a canonical
serializable form; a Git connector round-trips it into the customer's repo so it is versioned by
*their* Git, reviewed in *their* PRs, updated by *their* CI — "it lives in your repo and versions
itself." Storage stays DB-canonical initially (keeps SaaS + worldbuilding simple); repo-canonical is
an open question to revisit for pure-dev customers.

---

## Stack

- **Frontend:** Vue 3 + Vite
- **Backend:** Node.js + Express
- **Database:** MongoDB
- **MCP server:** Lightweight wrapper around the REST API
- **Hosting:** danielecker.dev (personal instance); future product hosting TBD under Steadfast Code
- **Target environment:** Linux-based self-hosted server; should also be compatible with local AI model setups for future self-hosted AI rig integration

---

## Architecture Notes

- Build with **multi-tenancy in mind** from the start — avoid hardcoding single-user assumptions even in the personal instance. This makes productization significantly cheaper later.
- The MCP layer should not assume a specific AI provider — keep it model-agnostic so it works with local models (e.g., Ollama) as well as cloud APIs
- Decisions made during the build should be logged in the Decision Log section below so the reasoning is preserved

---

## Data Model

> This section captured the original single-entry shape. The model has since evolved — long-form
> content moved into an ordered `blocks` array (no more `body`), and relationships and open questions
> became their own collections. **See [docs/data-model.md](docs/data-model.md) for the current
> schemas.** Summary of the central `Entity` document:

- `_id` — MongoDB ObjectId (primary key)
- `title` — string
- `category` — one of: Characters, Worlds, Organizations, Lore & Mechanics, Timeline, Open Questions
- `summary` — one-line description
- `tags` — array of strings (queryable)
- `blocks` — ordered content blocks `{ _id, type, order, data }`; `type` ∈ text, timeline_event, attribute, quote, gallery
- `relationships` — refs → `RelationshipGroup` (back-reference; groups are the source of truth)
- `open_questions` — refs → `OpenQuestion`
- `workspaceId` — multi-tenancy key; enforced per request (`resolveWorkspace`)
- `createdAt` / `updatedAt` — timestamps

Supporting collections: `RelationshipGroup`, `RelationshipType`, `OpenQuestion`, `ChangeLog`
(30-day TTL audit trail), `Conversation` (saved AI chats), `User`, `Settings`.

---

## API Endpoints

> The resource route is now `/entities` (not `/entries`), and the surface has grown to cover
> relationships, change history, AI chat, live sync, auth, and MCP. **Full reference:
> [docs/api.md](docs/api.md).** Core routes:

| Method | Route | Description |
|--------|-------|-------------|
| GET | /entities | All entities. Optional query params: `category`, `tag`, `q` (search) |
| GET | /entities/:id | Single entity, with relationships resolved live |
| POST | /entities | Create new entity |
| PUT | /entities/:id | Update entity |
| DELETE | /entities/:id | Delete entity |
| GET | /tags | All unique tags across entities |
| GET | /open-questions | Open questions (supports `?status=open|resolved`) |

---

## MCP Tools (for Claude access)

> Now served as a Streamable-HTTP MCP endpoint at `/mcp` with an OAuth flow (the standalone stdio
> stub was removed). The toolset has grown to include relationship management. Full list in
> [docs/architecture.md](docs/architecture.md#mcp-integration).

| Tool | Description |
|------|-------------|
| `search_entities` | Search by keyword, tag, or category |
| `get_entity` | Retrieve a single entity by id (with relationships) |
| `list_entity_types` | List the workspace's entity types (the valid category names) |
| `create_entity` | Add a new entity |
| `update_entity` | Edit an existing entity |
| `add_open_question` | Attach or update an open question on an entity |
| `list_open_questions` | Return open questions (filter by status) |
| `add_relationship` … `remove_subgroup_from_relationship` | Relationship-group management (7 tools) |

---

## Seed Data

Import from the `world_train_wiki.html` artifact — 18 entries built and categorized during the origins brainstorming session. This file lives in the World Train Claude project and will need to be exported/located before the seed script is written.

---

## Notes

- Claude needs read AND write access via MCP to be useful as a collaborator
- Authentication: session cookies (bcrypt, 12 rounds) + WebAuthn passkeys for browser clients, and a
  bearer token for MCP/programmatic access. Registration is open. *(The original "simple bearer
  token" plan was superseded once the target became a multi-tenant product — see Decision Log.)*
- Vue frontend should match the same UX as the current HTML artifact: category pills, tag filtering, search, expandable entries, open question badges
- Dark mode support preferred

---

## Build Workflow

- All construction happens in **Claude Code** on Daniel's local machine
- This Claude project is for higher-level decisions, architecture, and planning
- Do not use the web chat interface for implementation

---

## Decision Log

*Running notes on key technical decisions and the reasoning behind them. Add entries as the build progresses.*

- **MongoDB over SQLite** — Consistent with Daniel's existing Steadfast Code projects. Tags modeled as arrays rather than comma-separated strings, which is more natural in MongoDB and easier to query.
- **Block-based content over a flat `body` string** — Entry bodies became an ordered `blocks` array (text, timeline_event, attribute, quote, gallery). Structured, individually reorderable content the frontend and MCP can manipulate per-block; the legacy `body` field was migrated out and dropped.
- **Relationships as groups, not directed edges** — A relationship is a `RelationshipGroup` with a member list; a pairwise link is just a two-member group, and families/factions are many-member groups. Members use a unified array with a `refModel` discriminator (`Entity` | `RelationshipGroup`), so groups can nest and array position encodes order. Chosen over dual entity/subgroup arrays to keep ordering and traversal uniform. The group's `members` array — not the back-reference on `Entity` — is the source of truth.
- **Session + passkey auth over "simple bearer token"** — The original private-tool plan called for a bare bearer token. Since the real target is a multi-tenant SaaS product, auth moved to session cookies (bcrypt) plus WebAuthn passkeys, with open registration; the bearer token remains only for MCP/programmatic access.
- **Change history with a 30-day TTL** — Entity writes append to a `ChangeLog` with a pre-change `snapshot` (enables rollback) and an `actorType` (`user` vs. `mcp`) so history can distinguish human edits from AI/background writes. TTL-expired after 30 days: this is recent undo/audit, not permanent provenance.
- **MCP over HTTP + OAuth, not stdio** — The standalone stdio MCP process was replaced by a Streamable-HTTP endpoint (`/mcp`) inside the Express app, with an OAuth authorization-code + PKCE flow so the Claude.ai connector can authorize. Keeps MCP on the same deployed API and auth surface rather than a separately-run local process.
- **AI chat via an OpenAI-compatible client** — In-app chat and MCP responses route through a provider registry (`aiProviders.js`) using the OpenAI client shape, with per-provider base URLs (currently xAI/Grok, OpenAI, Gemini). Keeps the layer provider-agnostic; a local Ollama provider drops in the same way.
- **Reposition as a knowledge-graph platform, not a documentation tool** — The differentiator is the structured entity + relationship graph maintained conversationally by an agent, not AI prose assistance (which is now table stakes). "Documentation" undersells and mis-targets it; "AI-maintained knowledge graph for interconnected systems" is the product. See Product Direction.
- **Worldbuilding as beachhead, architecture as expansion** — Lead with worldbuilding (already works, forgiving, underserved) to prove the graph+agent loop; expand into software/system architecture for the real market (teams/B2B). Rejected both "stay niche" (too small) and "general documentation tool" (undifferentiated, brutal incumbents). The generalization work is shared between the two, so beachhead-first is cheap.
- **User-defined entity types over a hardcoded enum** — The `category` enum (Characters/Worlds/…) will become per-workspace user-defined types so the engine serves any domain. `RelationshipType` is already data-driven, so relationships generalize for free; templates (entity-type + relationship-type bundles) become the multi-vertical mechanism.
- **Generator with a human-approval diff; no silent bulk writes** — Bulk graph generation and drift-driven updates always land as a reviewable draft a human accepts. Framed as a *pull request against the graph*, this unifies generation, drift detection, and versioning into one mechanism.
- **Never-stale via continuous sync** — The graph is derived from connected sources; source changes are detected and proposed as updates, so the model doesn't rot. Directly targets the failure mode (staleness) that kills documentation products.
- **Git-native, dual-mode storage — DB-canonical first (decided 2026-09-03)** — The graph gets a canonical serializable form; a Git connector round-trips it into the customer's repo (versioned by their Git, reviewed in their PRs, updated by their CI). **MongoDB is the source of truth**; the Git connector is a round-trip, not the store. This keeps multi-tenant SaaS and non-technical (worldbuilding) users simple. Whether to ever make a repo *canonical* for pure-dev customers is left open. **Consequence:** the `ChangeLog` 30-day TTL must be lifted for versioned workspaces — history becomes the product, so it can't expire. (Supersedes the TTL rationale above for versioned workspaces.)
- **Structure ChangeLog/generator-diff records to be fine-tune-ready (decided 2026-09-03)** — Long-run parallel track: fine-tune a self-hosted open-source model on our own accept/edit/reject signal (structured extraction, MCP tool-calling for graph maintenance) rather than hand-authoring training data. This only works if `ChangeLog` entries and Generator v1's approve/edit/reject decisions are captured as structured input→proposed-output→accepted-output triples, not free text. Not on the launch critical path — cloud providers (OpenRouter/native) stay the default — but the data shape should be decided now since it's cheap today and expensive to retrofit later. Self-hosted is a genuinely offerable provider option once tuned, per the existing Ollama-compatible provider registry, but never the default backing paying customers. The self-hosted target is the `steadfast-ai` box (own repo at `C:\repos\steadfast-ai`; GTX 1080 Ti / 11GB VRAM, Ollama behind an OpenAI-compatible gateway on the tailnet).
- **`Draft` is the training corpus, not a work queue (decided 2026-09-06)** — Generator v1's `Draft` collection has **no TTL** anywhere, unlike `ChangeLog`'s 30 days: `ChangeLog` is undo, `Draft` is the fine-tune asset from the entry above and must be permanent. Three consequences follow. `DELETE /drafts/:id` is a soft `status: 'discarded'`. A rejection never deletes the item — the negative example is the most valuable label and the easiest to lose. And `accepted` is written at **decision** time rather than apply time, copied verbatim from `proposed` on a plain accept, so a draft reviewed in full and then abandoned (the common outcome) still yields a complete labelled set. Daniel's product calls, 2026-09-05: account deletion **hard-deletes** drafts, and signup **discloses** that reviewed generations may be used to improve the product, with **no opt-out on the free tier**. Hard delete and the disclosure copy are not yet built — they are the open items this entry creates.
- **A total AI allowance per workspace, not a daily cap (decided 2026-09-05)** — Metering is per workspace in **micro-dollars** (integers; float cents drift when decremented on every call). Daniel chose a total trial budget with **no time limit** over a daily rate after cost modelling: measured runs vary ~6x ($0.011–$0.15), so a run cap prices nothing, and the audience works in bursts — a free Saturday with three chapters of notes is the exact session a daily cap blocks, while worst-case exposure is identical either way. Default grant **$3.50** (`AI_TRIAL_GRANT_MICROS`). Generation is a **capped trial**; the non-AI product stays free forever. The allowance covers everything on a provider we pay for — generation, chat, memory extraction — including **self-hosted, which is cheap but not free** (a derived electricity rate, ~85x cheaper on input than Sonnet: Daniel's call, "it's costing me electricity"). It deliberately excludes **MCP**, where Claude.ai runs inference on the user's own subscription. **Consequence:** an exhausted allowance currently blocks self-hosted runs too, so the "trial ends, generation gets slower rather than stopping" fallback needs its own decision — deferred.
- **The human label and the system outcome are separate field groups with separate writers (decided 2026-09-06)** — On a draft item, `decision`/`decisionVia`/`decidedBy`/`decidedAt`/`accepted` are written **only** by the decision routes, and `applyState`/`resultId`/`changeLogId`/`applyError`/`appliedAt` **only** by the applier, which rejects those keys with a 400 if they appear in a request body. So an apply failure can never overwrite the record that a human said yes, and a client cannot forge what happened to a change. This is what makes decisions and Apply safely separable, which in turn is what lets a reviewed-then-abandoned draft still be a complete training example. Related: applied writes log with `actorType: 'generator'` and an `origin` back-reference to the draft item, not as ordinary user edits — a 30-item apply must not be indistinguishable from thirty hand edits.
- **Exports pseudonymise and refuse; the exporter takes no join (decided 2026-09-06)** — A draft exports to one JSONL line in which **no ObjectId survives**: references to things created by a sibling item become `local:<localKey>` (the form a model should learn to emit), everything else a keyed HMAC pseudonym that is deterministic, so a corpus stays joinable without ever holding a real id. `EXPORT_HMAC_SECRET` has **no default** — a shared fallback key would make the mapping reproducible by anyone with the source, and ObjectIds are partly a timestamp and a counter. A raw id surviving the mapping **fails the export**, naming the field, rather than being scrubbed by a blanket regex: a scrub would quietly paper over a field the mapper forgot and surface months later as an unexplained id in the corpus. The load-bearing constraint is that `exportDraft` runs **zero queries** — items are embedded in the draft precisely so this holds. If exporting ever needs a join, the schema is wrong and that is the bug to fix.
- **The Express app is a factory; `index.js` is only a bootstrap (decided 2026-09-08)** — Middleware, session config and every route mount moved to `server/src/app.js` as `createApp({ sessionStore })`; `index.js` keeps only `dotenv`, `mongoose.connect` and `app.listen`. The session store is the one injectable seam, defaulting to the deployed `MongoStore`, so a test can pass an `express-session` MemoryStore and drive the **real** app over HTTP with no database — as `tests/http/oauth.test.js` does for the OAuth PKCE flow. Chosen over exporting a pre-built `app` singleton (which constructs a Mongo-backed store at import time, so importing it in a test already reaches for the database) and over faking routers (which tests the mock, not the mount order that decides whether `requireAuth` actually guards a route). **Consequence:** anything added to the app must be mounted inside `createApp`, and mount order stays load-bearing — `requireAuth` before `resolveWorkspace` is what makes an anonymous request 401 rather than a workspace lookup.
- **Tests run against a real mongod, one per test file (decided 2026-09-08)** — `server/tests/helpers/db.js` starts an in-memory `mongodb-memory-server` rather than mocking Mongoose, so schema enums, defaults, casting and indexes are exercised as they run in production; the alternative (stubbing the model layer) would test the mock and pass through exactly the typo'd `category` the enum exists to stop. The URI comes from `MongoMemoryServer.getUri()` and never from the environment, so no stray `MONGO_URI` can point a run that deletes every document at a real database. `node --test` gives each file its own process, so the module-level server singleton is per-file by construction and files stay isolated. `clear()` drops collections **and resyncs indexes**: a dropped collection takes its indexes with it and Mongoose builds them only once per model, so without the resync a later test of `User.email`'s unique constraint would run against a collection that no longer has the index enforcing it, and pass for the wrong reason.
- **Config-dependent auth gates fail closed in production, open in dev (decided 2026-09-09)** — `/mcp` read an unset `MCP_BEARER_TOKEN` as "dev mode: no token required", which is right on a laptop and catastrophic on a deployed box: `/mcp` is the second front door into tenant content and the only one not behind `requireAuth`, so a forgotten variable published every tool on it unauthenticated. The gate now decides once at module load from `MCP_BEARER_TOKEN` + `NODE_ENV` and, when the token is unset **and** `NODE_ENV=production`, answers `503 {"error": "MCP not configured"}` to everything and logs the reason once at startup. 503 rather than 401 on purpose: this is a misconfigured deployment, not a caller who forgot a credential, and the two need to be distinguishable in a log. Chosen over requiring the token in every environment (breaks local development against `.mcp.json`, which is the only way the endpoint gets exercised by hand) and over refusing to boot (one unset variable would take the whole API down with it, including the REST routes that are correctly configured). `requireAuth` needed no equivalent change — its token is compared strictly against a parsed string, so an unset variable is a value no request can produce — and `server/tests/unit/requireAuth.test.js` now pins that, including the `BEARER_TOKEN=` (empty string) case that a half-filled `.env` produces.
- **Account deletion is ordered, not transactional, and refuses shared memberships (decided 2026-09-10)** — `deleteAccount(userId)` in `server/src/lib/accountDeleter.js` implements Daniel's 2026-09-05 hard-delete call as a library function; the route, confirmation UI and signup disclosure copy are still open. It **refuses on any membership the user does not solely own**, co-owner included, not just editor/viewer: deleting would leave that workspace pointing at a user who no longer exists, and ownership transfer is a product decision nobody has made. A refusal deletes nothing and returns the memberships. A solely-owned workspace is deleted even when others are members of it, as the queue item specifies. It is **ordered rather than transactional**: transactions need a replica set, the test mongod is standalone, and an Atlas-only code path would ship untested. Content goes first, then the workspace documents, then the user, so a failure part-way leaves the user and their workspaces findable and a re-run finishes the job (the test pins this by failing one model's `deleteMany` mid-run). Content is swept again once the workspace documents are gone, catching writes from requests that resolved the workspace while the first pass ran. The workspace-scoped model list is explicit, and a test fails if a model with a `workspaceId` path is missing from it. User-keyed data goes too: `UserMemory`, and `Conversation` by `userId`, which also catches pre-tenancy rows. `Settings.mcpUserId` is cleared if it points at the user. Log lines carry ids, never the email, because logs outlive the account.
- **Account deletion re-authenticates, checks the typed email on the server, and is session-only (decided 2026-09-10)** — `DELETE /auth/account` is the one caller of `deleteAccount()`. A live session does not reach it alone: the body must carry the current password, or a passkey assertion against a single-use challenge from `POST /auth/account/passkey-challenge` (its own session key, so a sign-in challenge cannot be spent on deletion), plus the account's email. The **email check is server-side**: the client never learns the address (`GET /auth/me` returns only `{ authenticated }`), and enforcing it in the API means a script or a forged request has to repeat it too. It is **session-only**: `requireActor` also admits the MCP bearer token, a single secret shared with an AI connector, and ending an account is not something a connector gets to do on a user's behalf, password or not. A failed re-authentication is **403, not 401**, because the session is still good and a 401 reads to a client as "signed out". Success destroys the session in the store, not just the cookie, and clears the cookie with the attributes it was set with, since a bare `clearCookie` does not match the domain-scoped production cookie. Known gaps: the user's *other* sessions cannot be found by user in the store, so they outlive the account holding a dangling id (every tenant route refuses them, but `GET /auth/me`, which reads only the session, still answers 200); and, as with `/auth/login`, the password check is not rate-limited.
- **`EntityType` registry ahead of the enum, with in-use types frozen (decided 2026-09-10, KOL-020)** — Phase 6 step 1 adds the per-workspace `EntityType` registry and `/entity-types` CRUD, seeded with the six current categories at registration (and by `scripts/seed-entity-types.js` for older workspaces), while `Entity.category` keeps its enum and nothing reads the registry yet. Because entities reference a type by *name*, two choices differ from the `RelationshipType` it mirrors: names are **unique per workspace, case-insensitively, by index** (not only by the route's pre-check, which a concurrent create could slip past), and a type that any entity in the workspace uses **cannot be renamed or deleted (409)** for now. The build plan's rename answer is a cascade to `Entity.category`, but with the enum still in force a cascade could only write names the schema rejects on those entities' next save; refusing keeps registry and data consistent until step 2 drops the enum and brings the cascade. Colours are stored as the client's `{ bg, text }` pill pair rather than the plan's single `color`, so the six defaults carry over unchanged.
- **The registry gates category writes alongside the enum (decided 2026-09-12, KOL-022)**: The KOL-020 freeze did not deliver "cannot drift apart". It only guarded renames and deletes, so a deleted or renamed-away type could still be written to an entity, and a type whose name was not an enum value could never be used. The fix has four parts:
  - **Write-time check.** `Entity.category` and `RelationshipType.sourceCategory`/`targetCategory` must name a type in the writer's workspace. A mongoose validator (`lib/entityTypeRegistry.js`) does the check, so it covers every write path the enum covers: REST, MCP, draft apply and rollback. An update whose filter names no workspace is refused rather than let through.
  - **Enum names only.** While the enum stands, a type's name must be one of its values, matched case-insensitively and stored in its spelling.
  - **Relationship types count as uses.** They now block a rename or delete, alongside entities.
  - **Pre-registry fallback.** A workspace with no types at all predates the registry, or its seeding failed. It is checked against the enum alone until backfilled, so a workspace that was never backfilled keeps working. Deleting a workspace's last type is refused, so a user cannot switch the gate off by emptying their registry.
  
  **Rejected alternative:** dropping the enum now, which would make custom names usable. That is Phase 6 step 2. The client, the MCP tools and the generator still list the six built-ins, so custom types would be writable only through REST and invisible in the UI. Phase 6 timing is also Daniel's call.
  
  **Known gap:** an entity write and a type delete that interleave can still slip past both checks. There is no transaction around the pair.
- **Late writes to a deleted account's user-keyed data delete themselves (decided 2026-09-12, KOL-023)**: The second sweep narrowed the concurrent-write window but did not close it. A write that landed after the last sweep stayed for good, because a re-run finds nothing left to sweep. Memory extraction is the clearest case. It runs after the chat reply, makes a model call that takes seconds, and then inserts `UserMemory`, which can happen after the account is gone. The fix has two halves:
  - **The writer writes, then checks.** `UserMemory` and `Conversation` have a schema plugin (`lib/ownerGuard.js`) that looks up the `User` *after* each insert and deletes the rows if the user is gone. The discarded write rejects with `OwnerGoneError`. Checking before the write cannot work, because the model call sits between the check and the write. A plugin rather than a helper means every insert path is covered, including ones not written yet.
  - **The deleter deletes, then sweeps.** After deleting the `User`, the deleter sweeps both collections by `userId` again. Since the writer checks after writing, whichever side reads second sees the other's write, and no ordering leaves a row behind.

  **Rejected alternatives:** a check before each write (still a race, and each new writer has to remember it); a periodic reaper for orphans (closes the gap only eventually, and this app has no scheduler); transactions (these need a replica set, as before).

  **Known gap (closed 2026-09-16 by KOL-026, below):** the workspace-scoped models do not have the guard yet. A content insert that lands after the workspace's final sweep is still left behind. The fix is the same plugin with `{ path: 'workspaceId', owner: Workspace }`. It is deferred because it adds a read to every content insert, and the tests that create content under made-up workspace ids would need real workspaces first.
- **Passkey ids are stored as the browser sends them, and old double-encoded ones are repaired on use (decided 2026-09-13, KOL-024)**: `@simplewebauthn/server` 13 returns `registrationInfo.credential.id` as a base64url string, and registration base64url-encoded it a second time. Every lookup compares against the browser's id, so no passkey was ever recognized. The id is now stored as-is, and `lib/passkeyIds.js` is the one place that matches stored ids and offers them to the browser:
  - **Both forms match.** Sign-in and account deletion's passkey confirmation accept a stored id in the correct form or the legacy one. The legacy match is exact (`stored === base64url(browserId)`). A match only picks which public key to verify with, and the signature check still decides.
  - **Lazy migration.** A verified assertion against a legacy value rewrites it to the correct form. A failed one changes nothing, so knowing an id is not enough to trigger the rewrite.
  - **Corrected ids in `allowCredentials` and `excludeCredentials`.** There is no browser id to compare with there. A stored value counts as legacy when it decodes to base64url text that re-encodes to itself. A correct id passes that test only if every raw byte is a base64url character, a chance of (1/4)^n for an n-byte id, which is under 2^-32 at the spec's 16-byte minimum.

  **Rejected alternative:** a one-off script to rewrite every stored id. Someone would have to run it by hand against production, and deployed code and data would disagree until they did. The lazy path needs neither. A passkey that is never used again stays in the legacy form, which still matches.

  **Known gaps:** passkeys added before this fix have no `deviceType` or `backedUp`. An assertion carries the backup flags, so KOL-025 can record them at sign-in alongside `lastUsedAt`. Registration also does not refuse a credential id already registered to another account, which the WebAuthn spec says it should (§7.1). `login/begin` lists an account's ids to anyone who knows its email, so a crafted authenticator could register a copy and make the lookup ambiguous. That is a denial of service, not a takeover, because the signature check still decides.
- **Passkeys are managed from Settings, session-only, and an account keeps one way in (decided 2026-09-13, KOL-025)**: A passkey lives on the device or password manager that made it, and the only way to add one was the prompt right after signup, so an account made on a desktop could never get one on a phone. Settings → Passkeys now lists them (`GET /auth/webauthn/passkeys`), adds one on the current device (the existing register routes), and removes them (`DELETE /auth/webauthn/passkeys/:credentialID`). Passwordless "Sign in with passkey" without an email is unchanged.
  - **Session only.** Both routes sit behind `requireAuth`, which also admits the MCP bearer token. That token carries no user of its own, and a connector does not get to change how an account signs in, so it gets a 403, as with account deletion.
  - **No public key in any answer.** Responses are built from a list of fields (`passkeySummary`), not from the stored document minus some, so a field added later stays on the server unless someone lists it.
  - **The last way in stays.** Removing a passkey is refused (409) when it is the last one on an account with no password. The rule is a condition on the `$pull` itself, so two concurrent removals cannot both land. Every account has a password today (`passwordHash` is required), so this protects the passwordless accounts to come. The `$pull` also bumps `__v`. A sign-in that loaded the array before it then fails its save, instead of writing its counter to whichever passkey moved into that position. That failure is now caught and answered 500. Before, an uncaught rejection there would have ended the process.
  - **Each sign-in records `lastUsedAt` and the sync status.** An assertion carries the backup flags, so each sign-in, and each passkey confirmation of an account deletion, refreshes `deviceType` and `backedUp`. That fills them in for passkeys registered before KOL-024.

  **Not done:** re-authenticating before a removal, as account deletion does. A session can already add a passkey without re-authenticating, and adding is the stronger capability for someone holding a stolen session. Gating removal alone would add friction without raising that bar. If re-authentication for credential changes comes, it should cover both.

  **Known gaps:** the list cannot say which passkey is on the device viewing it, because the browser does not reveal that. A removed passkey stays in its authenticator or password manager, which keeps offering it and gets "Passkey not recognized". WebAuthn's Signal API (`PublicKeyCredential.signalUnknownCredential`) could tell the authenticator, and is not used yet.
- **Late content writes to a deleted workspace delete themselves too (decided 2026-09-16, KOL-026)**: KOL-023 closed the race for `UserMemory` and `Conversation` and left workspace content open. A request that resolved its workspace before an account deletion could insert an entity, relationship group, open question or any other scoped row after the final content sweep. That row stayed forever, because a re-run finds no workspaces left to sweep. Every model in `WORKSPACE_SCOPED_MODELS` now carries `ownerGuard` with `{ path: 'workspaceId', owner: Workspace }`, and nothing else changes. The deleter already deletes the workspaces before its content sweep, so the argument from KOL-023 carries over: whichever side reads second sees the other's write.
  - **Conversation carries both guards.** An editor's chat in the deleted owner's workspace has a user who still exists, so the user guard passes it. Only the workspace guard catches it.
  - **The cost KOL-023 deferred on is accepted.** Each content insert now does one extra `_id` lookup on `workspaces`, and `insertMany` does one per batch, not one per document. A draft apply of 30 items adds about 60 of these point reads, one per row and one per changelog entry. That was judged small next to the model call that produced the draft, but it was not measured.
  - **An id with no workspace behind it is refused.** A content insert under a `workspaceId` that never existed is discarded with `OwnerGoneError`. No production path writes one, since every writer gets its workspace from `resolveWorkspace`, the MCP user's membership, or registration after `Workspace.create`. Tests that made up workspace ids now create real workspaces. Rows with `workspaceId: null` are still not checked.
  - **Tested per model, per insert path.** For each scoped model, `create` and `insertMany` run the whole deletion between validation and the driver insert, and must reject and leave nothing behind. A model added to the list without the guard fails its own test.

  **Rejected alternative:** applying the plugin from the deleter by looping over `WORKSPACE_SCOPED_MODELS`. Mongoose compiles hooks when the model is built, so a plugin applied after `mongoose.model()` is not reliable. The per-model line matches how `UserMemory` and `Conversation` already declare theirs.
- **Foreign ids in populated arrays are dropped on write and unmatched on read (decided 2026-09-17, KOL-032)**: `Entity.open_questions` and `OpenQuestion.entry_ids` are id arrays that `populate()` resolves with no notion of workspace, so a caller who planted another tenant's id in either read back its question text or entity title. Both sides are now closed, and each is tested on its own:
  - **Read side.** Every populate of either array takes `match: { workspaceId }` from `lib/scopedPopulate.js`, the one place those options are built. The helper does not stop a new call site from calling `populate()` directly, though. Mongoose drops unmatched ids from a populated array by default rather than leaving `null`, so the routes need no extra filtering. The tests pin that no `null` reaches a response. This also covers ids already stored, and ones written by a path that does not filter, such as the draft applier.
  - **Write side.** `stripTenancy` in `routes/entities.js` also strips `open_questions` and `relationships`. Both are back-references that only the open-question and relationship-group routes, the draft applier and the seeder write, and the client never sends them. Rollback restores a snapshot and is unchanged. `POST`/`PUT /open-questions` keep only `entry_ids` that name entities in the caller's workspace, and so does the MCP `add_open_question` tool, which is the same write.
  - **Dropped, not refused.** An `entry_ids` value that names no entity in the caller's workspace is removed rather than answered with 400. A 400 would be just as safe, provided foreign and non-existent ids got the same answer. Dropping was chosen so a stale id, such as an entity deleted since the client loaded it, does not fail the whole write. The response shows the ids that were kept. `POST /relationship-groups` still refuses unknown members with 400, because a group without its members means nothing, while a question still stands without one of its links.
- **The registry is the only gate on category names; renames cascade (decided 2026-09-17, KOL-027)**: Phase 6 step 2 drops `enum: CATEGORIES` from `Entity.category`. The `categoryValidator` KOL-022 added is now the only check, with the same 400 message, so any name a workspace gives a type is usable at once. Four parts:
  - **Free names.** `POST`/`PUT /entity-types` accept any non-blank name, trimmed and stored as sent. `canonicalCategory` is gone. Names stay unique per workspace case-insensitively, and `Entity.category` matches exactly, so a change of case alone is a rename.
  - **Rename cascades instead of 409.** The route renames the type first, which opens the new name to writes, then `updateMany`s the workspace's `Entity.category` and `RelationshipType.sourceCategory`/`targetCategory` from the old name to the new, and reports the counts as `relabelled`. Delete keeps both 409s: in use, and last type.
  - **Pre-registry fallback made explicit.** A workspace with no types used to be waved through by the registry and held by the enum. It is now checked against `CATEGORIES` directly, so an unseeded workspace behaves exactly as before. `CATEGORIES` stays exported as the seed list and that fallback.
  - **`getCategories(workspaceId)` reads the registry.** It is now async, returns the workspace's names sorted by `order`, and falls back to `CATEGORIES`. The generator's prompt and draft-edit validation (`validateItemPayload`, now async) follow it. The MCP and chat lists (KOL-028) and the client (KOL-029) do not yet.

  **Rejected alternative:** keeping renames of in-use types frozen, as KOL-020 did. That was only ever a stand-in for this cascade while the enum could not accept the new name.

  **Known gaps:** the cascade is ordered, not transactional (transactions need a replica set, as before). If it fails part-way, the type keeps its new name and the route answers 500; renaming it back runs the cascade the other way and restores consistency. An entity write that validated the old name just before the rename can land after the `updateMany` and keep the old name, the same interleaving KOL-022 left open for deletes. The cascade writes no `ChangeLog` entries, so rolling an entity back to a snapshot taken before a rename restores the old name, which the validator refuses. Pending draft items that name the old category fail at apply the same way; their `proposed` payloads are training records and are deliberately not rewritten.
- **MCP category parameters are free strings plus a `list_entity_types` tool; chat builds its enum per request (decided 2026-09-17, KOL-028)**: Phase 6 step 3 moves the AI surfaces off the built-in `CATEGORIES` list.
  - **MCP: no enum, a list tool instead.** `search_entities`, `create_entity` and `update_entity` take `category` as `z.string()`, described as "call `list_entity_types` for the valid names". The new tool returns the acting workspace's types (`name`, `icon`, `color`, `order`), sorted as `GET /entity-types` sorts them. A tool's input schema is fixed when the MCP session is created, but the workspace is resolved on every call (`mcpWorkspaceId()`), and the identity behind it can change mid-session. An enum built at session start could therefore be wrong for later calls. The write stays the gate: `categoryValidator` refuses an unregistered name, and the tool returns that message to the model.
  - **Empty registry lists the built-ins.** When a workspace has no types (it predates the registry), `list_entity_types` returns the six built-in names from `getCategories()`, with null icon and colour. Those are the names its writes accept, so the list never disagrees with the write.
  - **Chat: enum per request.** The in-app assistant's function tools are built for each `POST /chat` from `getCategories(req.workspaceId)`. That schema is sent fresh with every provider call, so an enum costs nothing and keeps the model from guessing names.

  **Rejected alternative:** building a per-workspace enum into the MCP schemas when the session is created. It would go stale when types are added or renamed, or when the MCP identity changes during a live session.
