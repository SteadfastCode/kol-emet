# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Kol Emet** (Hebrew: *Voice of Truth*) is a wiki/CMS platform being built for public release under the **Steadfast Code** brand (product name TBD). Daniel's personal instance (hosted at danielecker.dev, used for his World Train creative writing series bible) is the first deployment — but it is not the target. The target is a multi-tenant SaaS product that any user can sign up for and use.

**Every implementation decision should be made with the public product in mind.** The fact that Daniel is the only current user is a deployment detail, not a design constraint.

## Commands

```bash
# Backend (server/)
yarn dev          # dev server with --watch (Node 18+)
yarn start        # production
yarn seed         # seed MongoDB with the 18 initial entries

# Frontend (client/)
yarn dev          # Vite dev server (proxies API to localhost:3004)
yarn build        # production build to client/dist/
```

The MCP server is not a separate process — it is served as a Streamable-HTTP endpoint at `/mcp`
inside the Express app (with OAuth for the Claude.ai connector). The root `.mcp.json` points Claude
Code at `http://localhost:3004/mcp` for local dev. Copy `.env.example` to `.env` in `server/` before
running.

## Stack

- **Frontend:** Vue 3 + Vite
- **Backend:** Node.js + Express
- **Database:** MongoDB (tags stored as string arrays, not comma-separated strings)
- **MCP server:** Streamable-HTTP endpoint at `/mcp` inside the Express app (OAuth for the Claude.ai connector); wraps the same data layer as the REST API
- **Auth:** Session cookies with bcrypt password hashing. Users stored in MongoDB with email + passwordHash. Open registration — anyone can create an account.

## Architecture

Four-layer architecture:

```
Vue 3 Frontend → Express REST API → MongoDB
Claude AI ↔ MCP Server ↔ Express REST API
```

The MCP server is a thin wrapper around the same REST API the frontend uses — it does not bypass the API layer.

### Key Design Principles

- **Multi-tenant SaaS product** — this is a public product, not a personal tool. Never design for single-user scenarios. Open registration, per-user data isolation, and scalability to many users are baseline requirements, not future features.
- **Daniel's instance is not the template** — the fact that the first deployment is personal does not mean auth should be simplified, registration should be gated, or features should be scoped to one user's needs. Always build the real thing.
- **Auth UX must be modern and frictionless** — login and registration forms must be compatible with password managers (proper `autocomplete` attributes on all inputs) and passkeys (WebAuthn) should be supported. Never build auth flows that block or frustrate standard credential tooling.
- **Model-agnostic MCP layer** — must work with both cloud APIs (Anthropic, OpenAI) and local models (Ollama). Do not tie the MCP layer to a specific provider.
- **Decision logging** — add significant technical decisions to the Decision Log in `kol_emet_spec.md` with reasoning.

## Data Model

Full schemas in [docs/data-model.md](docs/data-model.md). The central document is `Entity`
(collection `entities`) — content lives in an ordered `blocks` array; there is **no `body` field**,
and open questions / relationships are their own collections, not inline fields.

```js
// Entity (collection: entities)
{
  _id: ObjectId,
  title: string,
  category: "Characters" | "Worlds" | "Organizations" | "Lore & Mechanics" | "Timeline" | "Open Questions",
  summary: string,             // one-line description
  tags: string[],              // queryable array
  blocks: Block[],             // ordered { _id, type, order, data }; type ∈
                               //   text | timeline_event | attribute | quote | gallery
  relationships: ObjectId[],   // refs → RelationshipGroup (back-reference cache)
  open_questions: ObjectId[],  // refs → OpenQuestion
  workspaceId: ObjectId|null,  // multi-tenancy key; enforced per request (resolveWorkspace)
  createdAt: Date,
  updatedAt: Date
}
```

Other collections: `RelationshipGroup` (unified member array with `refModel` discriminator, supports
subgroup nesting), `RelationshipType`, `OpenQuestion`, `ChangeLog` (30-day TTL audit trail),
`Conversation` (saved AI chats), `User`, `Settings` (singleton). See
[docs/data-model.md](docs/data-model.md).

## API Endpoints

Full reference in [docs/api.md](docs/api.md). The primary resource route is `/entities` (not the
original `/entries`):

| Method | Route | Notes |
|--------|-------|-------|
| GET | `/entities` | Supports `?category=`, `?tag=`, `?q=`; populates open questions |
| GET | `/entities/:id` | Single entity with live-resolved relationships |
| POST/PUT/DELETE | `/entities[/:id]` | Create/update/delete (validates blocks, writes ChangeLog) |
| GET | `/tags` | All unique tags |
| GET/POST/PUT/DELETE | `/open-questions[/:id]` | Open-question CRUD (`?status=`) |
| — | `/relationship-groups`, `/relationship-types` | Relationship CRUD (see api.md) |
| GET/POST | `/entities/:id/history`, `/entities/:id/rollback/:logId` | Change history + rollback |
| — | `/drafts` | Generated changes awaiting review (SSE generation, per-item decisions, apply, JSONL export) |
| GET/POST | `/chat`, `/conversations` | AI chat (SSE) + saved conversations |
| GET | `/events` | SSE live-sync stream |
| — | `/auth/*`, `/oauth`, `/mcp` | Auth (session + passkey), OAuth, MCP transport |

## MCP Tools

Served as a Streamable-HTTP endpoint at `/mcp` with OAuth (not a stdio process). Tools:

| Tool | Description |
|------|-------------|
| `search_entities` | Search by keyword, tag, or category |
| `get_entity` | Retrieve a single entity (with relationships) |
| `create_entity` | Add a new entity (blocks-aware) |
| `update_entity` | Edit an existing entity |
| `add_open_question` | Attach/update an open question |
| `list_open_questions` | List open questions (filter by status) |
| `add_relationship`, `add_member_to_relationship`, `update_group_label`, `remove_relationship`, `update_relationship_label`, `add_subgroup_to_relationship`, `remove_subgroup_from_relationship` | Relationship-group management |

## Frontend UX Requirements

Match the `world_train_wiki.html` artifact UX: category pills, tag filtering, search bar, expandable entries, open question badges, dark mode preferred.

## Seed Data

18 initial entries from the World Train brainstorming session live in a `world_train_wiki.html` artifact in the World Train Claude project. Locate and export this file before writing the seed script.

## Build Workflow

All implementation happens in **Claude Code** on Daniel's local machine. The Claude web project (`kol-emet` project in claude.ai) is reserved for higher-level architecture and planning decisions only.
