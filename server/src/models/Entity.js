import mongoose from 'mongoose';
import { CATEGORIES } from '../config/categories.js';

const BLOCK_TYPES = ['text', 'timeline_event', 'attribute', 'quote', 'gallery'];

const blockSchema = new mongoose.Schema({
  type: { type: String, required: true, enum: BLOCK_TYPES },
  order: { type: Number, required: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
}, { _id: true });

const entitySchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    category: {
      type: String,
      required: true,
      enum: CATEGORIES,
    },
    summary: { type: String, required: true },
    tags: { type: [String], default: [] },
    blocks: { type: [blockSchema], default: [] },
    relationships: [{ type: mongoose.Schema.Types.ObjectId, ref: 'RelationshipGroup' }],
    open_questions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'OpenQuestion' }],
    workspaceId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

// Every scoped read filters on workspaceId, and the generator's dedup pass
// looks entities up by (workspace, title). This schema declared no indexes at
// all, unlike RelationshipGroup, OpenQuestion and ChangeLog.
entitySchema.index({ workspaceId: 1, title: 1 });

export { BLOCK_TYPES };
export default mongoose.model('Entity', entitySchema, 'entities');
