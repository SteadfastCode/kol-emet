# Kol Emet — Wishlist

Unordered backlog of ideas and nice-to-haves. Not committed to, just captured.

## Frontend — UX
- Keyboard shortcuts (e.g. `/` to focus search, `Esc` to close panel)
- Mobile-optimized layout
- Drag-to-reorder blocks in EntryDetail (currently only in EntryEditor)
- Resize handle on the list/panel split boundary
- Entry detail panel — full styling polish pass (in progress)

## Frontend — Features
- Gallery block — image hosting (currently placeholder)
- Entry linking from sidebar — clicking a [[link]] from search results
- Tag autocomplete on entry editor
- Bulk tag operations
- Soft delete (archive instead of hard delete)
- Entry revision history

## Data & API
- workspaceId enforcement in all queries (multi-tenancy — stored, not yet filtered)
- Remove legacy `body` field from Entry schema (Phase 3 cleanup)
- Bulk import endpoint
- Full-text search index on blocks data

## MCP / AI
- Point MCP API_BASE at production Railway URL
- Claude-assisted entry drafting — suggest block content based on title + category
- Cross-entry relationship suggestions ("this entry mentions Zhalek — link to Zhalek Xitren?")
- Open question resolution flow — Claude flags when an open question may have been answered
- Timeline synthesis — Claude reads all timeline_event blocks and writes a narrative summary

## Productization
- Multi-tenant workspace management and billing
- Invite collaborators to a workspace
- Separate product name and brand under Steadfast Code
- Public template gallery (pre-seeded wiki structures)
- Local AI support via Ollama (MCP layer already model-agnostic)
- Public-facing marketing site
