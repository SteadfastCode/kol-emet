# Kol Emet — Architecture

A multi-tenant wiki/CMS platform. Daniel's World Train instance is the first deployment; every
decision targets the public SaaS product, not the single-user case.

```
┌─────────────┐     REST + SSE      ┌──────────────┐     Mongoose      ┌──────────┐
│  Vue 3 SPA  │ ◄─────────────────► │  Express API │ ◄───────────────► │ MongoDB  │
│  (client/)  │                     │  (server/)   │                   │  Atlas   │
└─────────────┘                     └──────┬───────┘                   └──────────┘
                                           │  HTTP MCP + OAuth
                                    ┌──────┴───────┐
                                    │  Claude / AI │
                                    │   clients    │
                                    └──────────────┘
```

The MCP integration and the in-app AI chat both go **through the same REST/data layer** the frontend
uses — no path bypasses validation, changelog, or auth.

## Components

### Frontend — `client/` (Vue 3 + Vite)
Single-page app. `LoginView` gates an authenticated `WikiLayout` shell. Key pieces:

- **Entity browsing/editing** — `EntitySidebar`, `EntityCard`, `EntityDetail`, `EntityEditor`,
  `EntityHeader`, `BlockList` and the `blocks/` renderers (`TextBlock`, `TimelineEventBlock`,
  `AttributeBlock`, `QuoteBlock`, `GalleryBlock`). Blocks are drag-reorderable (vuedraggable).
- **Relationships** — `RelationshipsSection`, with type autocomplete backed by Fuse.js.
- **Graph** — `GraphView` renders the relationship network (force-directed).
- **AI** — `ChatPanel` streams from `/chat` over SSE.
- **Chrome** — `BreadcrumbBar`, `WikiLayout`, `VirtualList` (windowed list for large wikis),
  `ToastNotification`.
- **Composables** — `useEntities`, `useEvents` (SSE sync), `useFilters`, `useNavigation`, `useToasts`.
- Dev server proxies the API to `localhost:3004`.

### Backend — `server/` (Node + Express)
REST API over MongoDB (Mongoose). Cross-cutting libs in [`server/src/lib/`](../server/src/lib):

- `changeLogger.js` — writes `ChangeLog` entries on entity create/update/delete.
- `broadcaster.js` — fans out live updates to connected SSE clients (`/events`).
- `relationshipResolver.js` — resolves group member labels for an entity's relationship view.
- `aiProviders.js` — provider registry + OpenAI-compatible client factory.
- `mcpUserStore.js` — reads/writes `Settings.mcpUserId` (the account MCP writes are attributed to).

See [api.md](api.md) for the full route list and [data-model.md](data-model.md) for the schemas.

### MCP integration
The MCP server is **not** a standalone stdio process — it is a Streamable-HTTP MCP endpoint mounted at
`/mcp` inside the Express app, with an OAuth authorization-code (PKCE) flow so the Claude.ai connector
can authorize. Writes are attributed to `Settings.mcpUserId` and recorded in the changelog with
`actorType: 'mcp'`.

The endpoint has its own bearer gate (`MCP_BEARER_TOKEN`), read once at process start:
configured → the token is required; unset outside production → open, so a local Claude Code session
needs no secret; unset **in** production → the endpoint is disabled and every request answers
`503 {"error": "MCP not configured"}`, with the reason logged once at startup. An unset token in a
deployed process is a misconfiguration, not an invitation — treating it as "no auth needed" would
publish every tool above to the internet unauthenticated.

The root [`.mcp.json`](../.mcp.json) points Claude Code at the local dev endpoint
(`http://localhost:3004/mcp`) via the HTTP transport. (The old standalone stdio package and its
config were removed.)

MCP tools exposed (defined in [`routes/mcp.js`](../server/src/routes/mcp.js)):

| Tool | Purpose |
|------|---------|
| `search_entities` | Search by keyword, tag, or category |
| `get_entity` | Fetch one entity (with resolved relationships) |
| `create_entity` | Create an entity (blocks-aware) |
| `update_entity` | Update an entity |
| `add_open_question` | Attach/update an open question |
| `list_open_questions` | List open questions (filter by status) |
| `add_relationship` | Create a relationship group between entities |
| `add_member_to_relationship` | Add an entity to an existing group |
| `update_group_label` | Rename a relationship group |
| `remove_relationship` | Remove a relationship (deletes orphaned groups) |
| `update_relationship_label` | Change a member's role label |
| `add_subgroup_to_relationship` | Nest a subgroup under a group |
| `remove_subgroup_from_relationship` | Un-nest a subgroup |

Tool descriptions instruct AI clients to use gender/role-specific member labels ("brother"/"sister",
not "sibling") and to model relationships via these tools, not via blocks.

## Auth
Session cookies (bcrypt, 12 rounds) for browsers plus WebAuthn passkeys; bearer token for MCP.
Registration is open. Details in [api.md](api.md#authentication).

## Live sync
`/events` is an SSE channel. On connect the server sends the client a `clientId`; clients tag their
writes with `x-sse-client-id` so the broadcaster can echo changes to every *other* tab/device without
bouncing them back to the originator.

## AI chat
`/chat` streams completions over SSE from whichever provider's key is configured
(`aiProviders.js`: xAI/Grok, OpenAI, Gemini — all via an OpenAI-compatible client). The layer is
provider-agnostic by design; a local Ollama provider is a known future addition. Conversations persist
per user (`Conversation`).

## Data migrations
One-off scripts in [`server/scripts/`](../server/scripts): `seed.js` (18 initial World Train
entries), `migrate-blocks.js` (body → blocks), `migrate-entries-to-entities.js`, and
`migrate-unified-members.js` (dual relationship arrays → unified `members` array).
