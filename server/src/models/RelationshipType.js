import mongoose from 'mongoose';

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

  sourceCategory: { type: String, default: null },
  targetCategory: { type: String, default: null },
  workspaceId: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { timestamps: true });

// Compound index: name unique per workspace (null workspaceId = global for now)
relationshipTypeSchema.index({ name: 1, workspaceId: 1 });

export default mongoose.model('RelationshipType', relationshipTypeSchema);
