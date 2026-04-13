# Kol Emet — Roadmap

## Phase 1 — Local Foundation ✅
- Project scaffold (Express API, Vue 3 frontend, MCP stub)
- MongoDB Atlas setup and seed data (18 World Train entries)
- Full CRUD API with bearer token auth
- Frontend UI — dark mode, filtering, search, expandable cards, add/edit/delete

## Phase 2 — Deployment ✅
- Session cookie auth with bcrypt (12 rounds), open registration, WebAuthn/passkeys
- Deployed frontend to Netlify (kol-emet.danielecker.dev)
- Deployed API to Railway (api.kol-emet.danielecker.dev)
- Block-based entry model (text, relationship, timeline_event, attribute, quote, gallery)
- Body→block migration script run against Atlas
- Full frontend rebuild: virtual list, sliding detail panel, breadcrumb navigation,
  inline wiki links, RelationshipTypeInput with Fuse.js, vuedraggable reordering,
  right-edge minimized-panel taskbar (auto-hide on hover)

## Phase 3 — MCP Integration ✅
- MCP server wired to live API (blocks-aware tools, Bearer token auth)
- `.mcp.json` at project root for Claude Code auto-discovery
- 6 tools: search_entries, get_entry, create_entry, update_entry, add_open_question, list_open_questions

## Phase 4 — Polish & Cleanup (current)
- Entry detail panel UI polish
- Drag-to-reorder blocks in EntryDetail (currently only in EntryEditor)
- Remove legacy `body` field from Entry schema
- Point MCP `API_BASE` at production Railway URL
- Relationship graph view

## Phase 5 — Productization (future)
- Separate product name and branding under Steadfast Code
- Multi-tenant enforcement (workspaceId stored, not yet enforced in queries)
- Public-facing marketing site
- Billing / workspace management
