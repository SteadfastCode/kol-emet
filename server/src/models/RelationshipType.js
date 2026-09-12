import mongoose from 'mongoose';
import { categoryValidator } from '../lib/entityTypeRegistry.js';

const relationshipTypeSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },

  /**
   * Which of the two label positions this vocabulary entry belongs to.
   *
   * A relationship carries labels in two places, and they are different
   * vocabularies: the GROUP has a label ("Marriage", "Home World",
   * "affiliation") and each MEMBER of that group has its own ("Wife", "Son",
   * "Planet", "Recruiter"). Without this discriminator the registry is a flat
   * list that cannot be offered in the right place, and the generator cannot
   * tell which position a term belongs in.
   *
   * 'member' is the default because that is the larger vocabulary and the one
   * pre-discriminator rows were mostly being used for.
   */
  scope: { type: String, enum: ['group', 'member'], default: 'member', index: true },

  // Entity type names, like Entity.category, so held to the same registry
  // check; null means any type.
  sourceCategory: { type: String, default: null, validate: categoryValidator('RelationshipType') },
  targetCategory: { type: String, default: null, validate: categoryValidator('RelationshipType') },
  workspaceId: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { timestamps: true });

// Compound index: names are meant to be unique per workspace (not enforced here).
relationshipTypeSchema.index({ name: 1, workspaceId: 1 });

export default mongoose.model('RelationshipType', relationshipTypeSchema);
