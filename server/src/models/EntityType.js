import mongoose from 'mongoose';

/**
 * The per-workspace registry of entity types — Phase 6 step 1.
 *
 * Mirrors RelationshipType: a workspace-scoped vocabulary a picker reads, while
 * the data keeps a plain string. `Entity.category` holds a type's *name*, not
 * its id, so renaming or deleting a type is a question about entities too —
 * see routes/entityTypes.js for how that is handled while the Entity enum
 * still stands.
 *
 * Seeded per workspace from the template's `entityTypes` (config/templates.js)
 * at registration; scripts/seed-entity-types.js backfills workspaces that
 * predate the registry. Nothing reads it yet: the client's pills and picker and
 * the MCP/chat category lists move onto it in later Phase 6 steps.
 */
const entityTypeSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },

  // Free-form: an emoji or an icon key. Null means the client's default.
  icon: { type: String, default: null },

  /**
   * The pill colours as the client paints them: `bg` behind, `text` on top.
   * A pair rather than one accent colour because the six defaults are pairs
   * (CAT_COLORS in client/src/config/categories.js) and must survive the move.
   */
  color: {
    bg:   { type: String, default: null },
    text: { type: String, default: null },
  },

  // Display order of pills and picker entries, ascending. Ties sort by name.
  order: { type: Number, default: 0 },

  workspaceId: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { timestamps: true });

// Unlike RelationshipType's, this index is unique: entities point at a type by
// name, so two "Characters" in one workspace would make every such entity
// ambiguous. Case-insensitive (strength 2) to match the route's 409 check, which
// it backs up against two concurrent creates.
entityTypeSchema.index(
  { workspaceId: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

export default mongoose.model('EntityType', entityTypeSchema);
