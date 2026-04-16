import mongoose from 'mongoose';

const changeLogSchema = new mongoose.Schema(
  {
    entityId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Entity', required: true, index: true },
    entityTitle: { type: String, required: true },
    changeType: { type: String, enum: ['created', 'updated', 'deleted'], required: true },
    actorId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorType:  { type: String, enum: ['user', 'mcp'], required: true },
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
