# Kol Emet — Wishlist

Unordered backlog of ideas and nice-to-haves. Not committed to, just captured.

## Frontend — UX
- ✅ Keyboard shortcuts (`/` to focus search, `Esc` to close the topmost layer, `n` for a new entity) — shipped 2026-10-07 (KOL-063)
- ✅ `?` cheatsheet overlay for the shortcuts, derived from the binding map — shipped 2026-10-10 (KOL-072); user-configurable bindings are still open
- Mobile-optimized layout
- Drag-to-reorder blocks in EntryDetail (currently only in EntryEditor)
- Resize handle on the list/panel split boundary
- Entry detail panel — full styling polish pass (in progress)

## Frontend — Features
- Gallery block — image hosting (currently placeholder)
- Entry linking from sidebar — clicking a [[link]] from search results
- ✅ Tag autocomplete on entry editor — shipped 2026-09-18 (KOL-041)
- ✅ Bulk tag operations — workspace-wide tag rename, merge and delete, shipped 2026-10-06 (KOL-053);
  tagging several entities at once in one action is still open
- Soft delete (archive instead of hard delete)
- ✅ Entry revision history — the `ChangeLog` API shipped with Phase 3; the per-entity history list
  with snapshot rollback in the detail panel shipped 2026-10-07 (KOL-059), as did restoring a
  deleted entity (KOL-060)

## Data & API
- ✅ workspaceId enforcement in all queries (multi-tenancy) — shipped 2026-09-03; see roadmap Phase 8
- Bulk import endpoint
- Full-text search index on blocks data

## MCP / AI
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
