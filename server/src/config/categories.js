/**
 * Single source of truth for entity categories on the server.
 *
 * The same list was duplicated in the Entity schema enum, the chat route's
 * tool definition and the MCP route's zod enum. The generator needs it too,
 * and a fifth copy would guarantee they drift.
 *
 * getCategories() takes a workspaceId and ignores it today. That is the Phase 6
 * seam: when categories become user-defined per workspace, this becomes a
 * registry lookup and every caller already passes the right argument. The
 * registry exists (models/EntityType.js, seeded per workspace from this list)
 * but is not authoritative yet — the Entity enum still is, so this stays a
 * constant until that enum goes.
 */

export const CATEGORIES = [
  'Characters',
  'Worlds',
  'Organizations',
  'Lore & Mechanics',
  'Timeline',
  'Open Questions',
];

// eslint-disable-next-line no-unused-vars
export function getCategories(workspaceId) {
  return CATEGORIES;
}
