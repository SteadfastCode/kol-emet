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

---

> **Direction (from here on).** Kol Emet is repositioning from a worldbuilding wiki to an
> **AI-maintained knowledge graph for interconnected systems** (see the Product Direction section of
> [`../kol_emet_spec.md`](../kol_emet_spec.md)). Worldbuilding is the *beachhead* — it already works
> and proves the graph+agent loop cheaply; **software/system architecture** is the commercial
> expansion, and the generalization work below is what carries the engine from one to the other.

## Phase 6 — Generalize the engine (next)
- **User-defined entity types per workspace** — replace the hardcoded `category` enum (in the Entity
  schema, MCP tools, and client config) with per-workspace types. A type = name + icon/color now; an
  optional light field-schema later. This single change unblocks every vertical.
- **Templates** — a workspace is seeded from a template = a bundle of entity types + relationship
  types (+ starter structure). `RelationshipType` is already data-driven, so this is mostly config.
  Ship two: **Worldbuilding** (today's defaults) and **Software Architecture** (Services, Data
  Stores, APIs, Teams; relationships like *depends-on*, *owned-by*, *calls*).

## Phase 7 — Assistant → Generator + continuous sync (the hook)
- ✅ **Graph generation from unstructured input** — paste text / upload a `.txt`/`.md`/`.docx` →
  the agent proposes entities + relationships → the user reviews and accepts. **Never silent bulk
  writes** — always a reviewable diff (see approval model below). **Shipped 2026-09-06 as Generator
  v1**; design and remaining stretch items in [generator-v1-plan.md](generator-v1-plan.md).
- **Vertical ingestion** — for architecture: repo / OpenAPI / docker-compose / k8s / DB-schema →
  proposed system graph. ("Point it at your repo and watch it map your services.")
- **Continuous sync / drift detection** — the graph is derived from connected sources; when a source
  changes, the system finds the delta and *proposes* an update. The promise: **the model never goes
  stale.** This is the generator pointed at *changes* rather than a one-time import.

## Versioning & Git-native (cross-cutting track, feeds Phases 7–8)
The approval model, drift detection, and version control are **one mechanism**: a proposed change is
a *pull request against the graph*. Build order:
- Grow `ChangeLog` (snapshots + rollback, today) into whole-graph, diffable, **permanent** history —
  the 30-day TTL must be lifted for versioned workspaces (can't expire the product).
- ✅ Add a **"proposed / draft" change state** — the reviewable diff that every generated or drift
  update lands in before a human merges it. Built as the `Draft` collection; `source.producer` is
  the seam where drift and repo ingestion become new producers rather than new collections.
- **Repo-resident graph (dual-mode, DB-canonical first):** give the graph a canonical serializable
  form; a Git connector round-trips it into the customer's repo so it is versioned by *their* Git,
  reviewed in *their* PRs, and updated by *their* CI. For software teams this is the positioning:
  "it lives in your repo and versions itself." (Revisit repo-canonical for pure-dev customers later.)

## Phase 8 — Commercialize (architecture unlock)
- ✅ **Enforce `workspaceId` in every query** — the multi-tenancy gate. **Shipped 2026-09-03**:
  `resolveWorkspace` scopes every tenant-content route, the MCP tools scope themselves, and
  `server/tests/http/tenancy.test.js` pins isolation between two registered users. One known gap:
  two unscoped `populate()` calls (`open_questions`, `entry_ids`) — see
  [data-model.md](data-model.md#workspace).
- Workspace management, collaborator invites, billing
- Separate product name and branding under Steadfast Code
- Public-facing marketing site
- Local AI support via Ollama (MCP/chat layer already provider-agnostic)
