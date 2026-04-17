import mongoose from 'mongoose';

const memberSchema = new mongoose.Schema({
  refId:    { type: mongoose.Schema.Types.ObjectId, required: true },
  refModel: { type: String, enum: ['Entity', 'RelationshipGroup'], required: true },
  label:    { type: String, default: null },
  notes:    { type: String, default: null },
}, { _id: false });

const relationshipGroupSchema = new mongoose.Schema({
  label:    { type: String, default: null },
  members:  { type: [memberSchema], default: [] },
  entityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Entity', default: null }, // legacy field, unused
  createdAt: { type: Date, default: Date.now },
}, { timestamps: false });

relationshipGroupSchema.index({ 'members.refId': 1 });

export default mongoose.model('RelationshipGroup', relationshipGroupSchema);
