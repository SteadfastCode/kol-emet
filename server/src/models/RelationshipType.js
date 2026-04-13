import mongoose from 'mongoose';

const relationshipTypeSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  sourceCategory: { type: String, default: null },
  targetCategory: { type: String, default: null },
  workspaceId: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { timestamps: true });

// Compound index: name unique per workspace (null workspaceId = global for now)
relationshipTypeSchema.index({ name: 1, workspaceId: 1 });

export default mongoose.model('RelationshipType', relationshipTypeSchema);
