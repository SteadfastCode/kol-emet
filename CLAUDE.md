# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Kol Emet** (Hebrew: *Voice of Truth*) is a privately hosted wiki/CMS app serving as the living source of truth for the World Train creative writing series bible. The internal codename is `kol-emet`; it will be marketed under the **Steadfast Code** brand with a separate product name TBD. Personal instance hosted at danielecker.dev.

## Commands

```bash
# Backend (server/)
yarn dev          # dev server with --watch (Node 18+)
yarn start        # production
yarn seed         # seed MongoDB with the 18 initial entries

# Frontend (client/)
yarn dev          # Vite dev server (proxies API to localhost:3001)
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
- **Auth:** Simple bearer token (private instance, no complex auth needed)

## Architecture

Four-layer architecture:

```
Vue 3 Frontend → Express REST API → MongoDB
Claude AI ↔ MCP Server ↔ Express REST API
```

The MCP server is a thin wrapper around the same REST API the frontend uses — it does not bypass the API layer.

### Key Design Principles

- **Multi-tenancy from the start** — never hardcode single-user assumptions, even in the personal instance. This keeps productization costs low.
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
