# Kol Emet — Hosted Wiki App

## Naming & Identity

- **Kol Emet** (Hebrew: *Voice of Truth*) is the personal instance name and the repository/code name for this project
- The repo will be named `kol-emet` — this serves as the internal codename
- A separate, marketable product name will be developed later under the **Steadfast Code** brand
- Daniel's personal instance will be hosted at **danielecker.dev**

---

## Concept

A privately hosted Vue 3 app serving as the living source of truth for the World Train series bible. Accessible from any device, persistent, and connected to Claude via MCP so the wiki can be read and updated directly from any project chat. Built for personal use first; architected with future productization in mind.

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
- `workspaceId` — multi-tenancy key (stored, not yet enforced in queries)
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
