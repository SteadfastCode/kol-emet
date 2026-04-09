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

# MCP server (mcp/)
yarn start        # stdio transport
```

Copy `.env.example` to `.env` in both `server/` and `mcp/` before running.

## Stack

- **Frontend:** Vue 3 + Vite
- **Backend:** Node.js + Express
- **Database:** MongoDB (tags stored as string arrays, not comma-separated strings)
- **MCP server:** Lightweight REST API wrapper for Claude integration
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

```js
{
  _id: ObjectId,
  title: string,
  category: "Characters" | "Worlds" | "Organizations" | "Lore & Mechanics" | "Timeline" | "Open Questions",
  summary: string,          // one-line description
  body: string,             // full notes, markdown-friendly
  tags: string[],           // queryable array
  open_question?: string,   // optional unresolved question
  createdAt: Date,
  updatedAt: Date
}
```

## API Endpoints

| Method | Route | Notes |
|--------|-------|-------|
| GET | `/entries` | Supports `?category=`, `?tag=`, `?q=` query params |
| GET | `/entries/:id` | Single entry |
| POST | `/entries` | Create entry |
| PUT | `/entries/:id` | Update entry |
| DELETE | `/entries/:id` | Delete entry |
| GET | `/tags` | All unique tags |
| GET | `/open-questions` | Entries where `open_question` is non-empty |

## MCP Tools

| Tool | Description |
|------|-------------|
| `search_entries` | Search by keyword, tag, or category |
| `get_entry` | Retrieve single entry by id or title |
| `create_entry` | Add new entry |
| `update_entry` | Edit existing entry |
| `add_open_question` | Attach/update open question on entry |
| `list_open_questions` | Return all unresolved open questions |

## Frontend UX Requirements

Match the `world_train_wiki.html` artifact UX: category pills, tag filtering, search bar, expandable entries, open question badges, dark mode preferred.

## Seed Data

18 initial entries from the World Train brainstorming session live in a `world_train_wiki.html` artifact in the World Train Claude project. Locate and export this file before writing the seed script.

## Build Workflow

All implementation happens in **Claude Code** on Daniel's local machine. The Claude web project (`kol-emet` project in claude.ai) is reserved for higher-level architecture and planning decisions only.
