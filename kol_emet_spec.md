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

Each entry has:
- `_id` — MongoDB ObjectId (primary key)
- `title` — string
- `category` — one of: Characters, Worlds, Organizations, Lore & Mechanics, Timeline, Open Questions
- `summary` — one-line description
- `body` — full notes (markdown-friendly)
- `tags` — array of strings (queryable)
- `open_question` — optional string for linked unresolved question
- `createdAt` / `updatedAt` — timestamps (via Mongoose or manual)

---

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | /entries | All entries. Optional query params: `category`, `tag`, `q` (search) |
| GET | /entries/:id | Single entry |
| POST | /entries | Create new entry |
| PUT | /entries/:id | Update entry |
| DELETE | /entries/:id | Delete entry |
| GET | /tags | All unique tags across entries |
| GET | /open-questions | All entries where open_question is non-empty |

---

## MCP Tools (for Claude access)

| Tool | Description |
|------|-------------|
| `search_entries` | Search by keyword, tag, or category |
| `get_entry` | Retrieve a single entry by id or title |
| `create_entry` | Add a new entry |
| `update_entry` | Edit an existing entry |
| `add_open_question` | Attach or update an open question on an entry |
| `list_open_questions` | Return all unresolved open questions |

---

## Seed Data

Import from the `world_train_wiki.html` artifact — 18 entries built and categorized during the origins brainstorming session. This file lives in the World Train Claude project and will need to be exported/located before the seed script is written.

---

## Notes

- Claude needs read AND write access via MCP to be useful as a collaborator
- Authentication on the API should be simple bearer token — no need for anything complex since it's private
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
