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
 * and gates entity writes alongside the enum (lib/entityTypeRegistry.js), but
 * while the enum stands a type's name must be one of these — so this stays a
 * constant, and a caller offering it may offer a type the workspace deleted,
 * which the write then refuses.
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
