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
