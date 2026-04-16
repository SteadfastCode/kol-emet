import mongoose from 'mongoose';

const memberSchema = new mongoose.Schema({
  entityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Entity', required: true },
  label:    { type: String, default: null },
  notes:    { type: String, default: null },
}, { _id: false });

const groupLinkSchema = new mongoose.Schema({
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'RelationshipGroup', required: true },
  label:   { type: String, default: null },
  notes:   { type: String, default: null },
}, { _id: false });

const relationshipGroupSchema = new mongoose.Schema({
  label:         { type: String, default: null },
  members:       { type: [memberSchema], default: [] },
  relationships: { type: [groupLinkSchema], default: [] },  // group-to-group (future)
  entityId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Entity', default: null },
  createdAt:     { type: Date, default: Date.now },
}, { timestamps: false });

relationshipGroupSchema.index({ 'members.entityId': 1 });

export default mongoose.model('RelationshipGroup', relationshipGroupSchema);
