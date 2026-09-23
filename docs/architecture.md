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

- **Entity browsing/editing** — `EntitySidebar`, `SidebarCard`, `EntityDetail`, `EntityEditor`,
  `EntityHeader`, `BlockList` and the `blocks/` renderers (`TextBlock`, `TimelineEventBlock`,
  `AttributeBlock`, `QuoteBlock`, `GalleryBlock`). Blocks are drag-reorderable (vuedraggable).
- **Relationships** — `RelationshipsSection`, with type autocomplete backed by Fuse.js.
- **Graph** — `GraphView` renders the relationship network (force-directed).
- **AI** — `ChatPanel` streams from `/chat` over SSE.
- **Chrome** — `BreadcrumbBar`, `WikiLayout`, `VirtualList` (windowed list for large wikis),
  `ToastNotification`.
- **Composables** — `useEntities`, `useEntityTypes` (the workspace's entity types: category pills,
  pickers and colours), `useEvents` (SSE sync), `useFilters`, `useNavigation`, `useToasts`.
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
| `list_entity_types` | List the workspace's entity types — the valid category names |
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

### Steadfast bridge — `/bridge/mcp`
A second, unrelated MCP endpoint that relays messages between a claude.ai chat and the Claude Code
sessions on Daniel's steadfast-ai box (defined in [`routes/bridge.js`](../server/src/routes/bridge.js)).
Neither end can reach the other — the box is tailnet-only, a chat has no filesystem — but both
already reach this server, so it holds the mailbox. Its own collections (`BridgeMessage`,
`BridgePresence`) reference nothing in the knowledge graph and write nothing to the changelog.

Its own token, `BRIDGE_TOKEN`, on purpose: the box executes what it receives, so whoever can write a
bridge message can run code there. `MCP_BEARER_TOKEN` guards wiki content and must never double as
that credential. Unset → every request answers 503 in every environment (no dev-mode open door).
Identity is shared: the bridge acts as `Settings.mcpUserId` and scopes to that workspace like `/mcp`.

Claude.ai authorizes it with the same authorization-code + PKCE shape as the wiki connector, issuing
`BRIDGE_TOKEN`, reachable two ways: a 401 names `/.well-known/oauth-protected-resource/bridge/mcp`,
which points at the path-based issuer `/bridge` (own RFC 8414 document, `/bridge/authorize`,
`/bridge/oauth/token`); or the origin's `/authorize` with `resource=…/bridge/mcp` (RFC 8707).

| Tool | Purpose |
|------|---------|
| `bridge_send` | Send to `box` (a named session) or `chat`; `kind: command` carries a payload the box executes |
| `bridge_poll` | One side's pending messages, marked delivered once; `wait_seconds` long-polls |
| `bridge_ack` | Mark delivered messages handled |
| `bridge_announce` | Box side: publish the host's live sessions (replaces the previous announcement) |
| `bridge_status` | Every host's last announcement plus pending counts per side |
| `bridge_history` | Recent messages both ways, oldest first, optionally for one session |
| `bridge_sync_routine` | Box side: replace one repo's routine facts (counts, last completed/blocked/fire, every item's ledger + review status). Applied directly — no Draft |
| `bridge_kb_status` | Chat side, answer from here first: where each repo's routine stands as last synced |
| `bridge_kb_items` | Chat side: items filtered by state, needs-human, proposed, unreviewed, ungraded, or keyword |
| `bridge_kb_item` | Chat side: one item's state, merge sha, blocked detail, review/grade counts |

The `bridge_kb_*` tools read the **routine knowledge base** — `RoutineRepo` and `RoutineItem`, filled by
the steadfast-ai box every few minutes from each repo's `ops/routine` ledger and review files. The box
is the source of truth; this is its cache, so a chat answers "where does the routine stand" without a
round trip to the box and reaches for `bridge_send` only for what the cache cannot hold (an item's
body, a diff, review text, a live session). Nothing in it is a Draft: a machine transcribing a
machine's ledger is not a model's guess, so it applies directly (decision log, 2026-09-22).

## Auth
Session cookies (bcrypt, 12 rounds) for browsers plus WebAuthn passkeys; bearer token for MCP.
Registration is open. Details in [api.md](api.md#authentication).

## Live sync
`/events` is an SSE channel. On connect the server sends the client a `clientId`; clients tag their
writes with `x-sse-client-id` so the broadcaster can echo changes to every *other* tab/device without
bouncing them back to the originator.

## AI chat
`/chat` streams completions over SSE from whichever provider's key is configured, all through one
OpenAI-compatible client ([`aiProviders.js`](../server/src/lib/aiProviders.js)):

- **OpenRouter** — the primary SaaS path: one key, every model, per-request cost data.
- **Native** — Claude (Anthropic), xAI (Grok), OpenAI and Google Gemini, each on its own key, for
  power users and self-hosted deployments.
- **`steadfast`** — self-hosted Ollama models on the steadfast-ai box, behind an OpenAI-compatible
  gateway. Reachable only over the tailnet, so it is a local-dev / self-hosted option rather than a
  production default; `STEADFAST_AI_BASE_URL` overrides the gateway address.

The layer is provider-agnostic by design — any OpenAI-compatible endpoint is one more registry
entry. Conversations persist per user (`Conversation`).

## Data migrations
One-off scripts in [`server/scripts/`](../server/scripts): `seed.js` (18 initial World Train
entries), `migrate-blocks.js` (body → blocks), `migrate-entries-to-entities.js`, and
`migrate-unified-members.js` (dual relationship arrays → unified `members` array).
