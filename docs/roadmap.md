# Kol Emet — Roadmap

## Phase 1 — Local Foundation ✅
- Project scaffold (Express API, Vue 3 frontend, MCP stub)
- MongoDB Atlas setup and seed data (18 World Train entries)
- Full CRUD API
- Frontend UI — dark mode, filtering, search, expandable cards, add/edit/delete

## Phase 2 — Deployment ✅
- Session cookie auth with bcrypt (12 rounds), open registration, WebAuthn/passkeys
- Deployed frontend to Netlify (kol-emet.danielecker.dev)
- Deployed API to Railway (api.kol-emet.danielecker.dev)
- Block-based entity model (text, timeline_event, attribute, quote, gallery)
- Body→block migration script run against Atlas
- Full frontend rebuild: virtual list, sliding detail panel, breadcrumb navigation,
  inline wiki links, RelationshipTypeInput with Fuse.js, vuedraggable reordering,
  right-edge minimized-panel taskbar (auto-hide on hover)

## Phase 3 — Relationships, History & AI ✅
- Relationship system: `RelationshipGroup` model with a unified member array
  (`refModel` discriminator) supporting entity + subgroup nesting; dedicated
  relationship-group and relationship-type endpoints
- Migration to the unified `members` array (`migrate-unified-members.js`)
- Change history: `ChangeLog` model (30-day TTL), per-entity history view, and
  snapshot-based rollback; writes attributed to `user` vs. `mcp` actors
- Live multi-client sync over SSE (`/events` + broadcaster)
- In-app AI chat: `/chat` streaming, multi-provider (xAI, OpenAI, Gemini via an
  OpenAI-compatible client), saved `Conversation` history
- **Relationship graph view** (`GraphView.vue`) — force-directed network with
  hover highlighting and drag anchoring

## Phase 4 — MCP over HTTP + OAuth ✅
- MCP served as a Streamable-HTTP endpoint at `/mcp` inside the Express app
  (replaced the standalone stdio stub)
- OAuth authorization-code + PKCE flow for the Claude.ai connector
- 13 tools: entity CRUD, open questions, and the full relationship toolset
  (see [architecture.md](architecture.md#mcp-integration))
- Legacy `body` field dropped from the Entity schema
- Repointed `.mcp.json` at the HTTP `/mcp` endpoint; pruned the dead `mcp/` stub
  directory and the leftover `body` clause in the entities search filter

## Phase 5 — Polish (current)
- Entity detail panel UI polish
- Gallery block image hosting (currently placeholder)

## Phase 6 — Productization (future)
- Separate product name and branding under Steadfast Code
- Multi-tenant enforcement (`workspaceId` stored, not yet filtered in queries)
- Billing / workspace management, collaborator invites
- Public-facing marketing site
- Local AI support via Ollama (MCP/chat layer already provider-agnostic)
