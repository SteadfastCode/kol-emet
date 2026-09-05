import mongoose from 'mongoose';

const changeLogSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null, index: true },
    entityId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Entity', required: true, index: true },
    entityTitle: { type: String, required: true },
    changeType: { type: String, enum: ['created', 'updated', 'deleted'], required: true },
    actorId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorType:  { type: String, enum: ['user', 'mcp', 'generator'], required: true },
    // Set when a write came from an accepted draft, so a generated change is
    // traceable back to the draft and item a human approved.
    origin: {
      kind:       { type: String, enum: ['draft'], default: null },
      draftId: { type: mongoose.Schema.Types.ObjectId, ref: 'Draft', default: null },
      itemId:     { type: mongoose.Schema.Types.ObjectId, default: null },
      producer:   { type: String, default: null },
    },
    actorLabel: { type: String, required: true },
    changes: {
      fieldsChanged: [String],
      blocksAdded:   [{ type: { type: String }, order: Number }],
      blocksUpdated: [{ type: { type: String }, order: Number }],
      blocksDeleted: [{ type: { type: String }, order: Number }],
    },
    snapshot:   { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt:  { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// Auto-expire after 30 days
changeLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export default mongoose.model('ChangeLog', changeLogSchema);
