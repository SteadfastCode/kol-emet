import mongoose from 'mongoose';

const BLOCK_TYPES = ['text', 'relationship', 'timeline_event', 'attribute', 'quote', 'gallery'];

const blockSchema = new mongoose.Schema({
  type: { type: String, required: true, enum: BLOCK_TYPES },
  order: { type: Number, required: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
}, { _id: true });

const entrySchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    category: {
      type: String,
      required: true,
      enum: ['Characters', 'Worlds', 'Organizations', 'Lore & Mechanics', 'Timeline', 'Open Questions'],
    },
    summary: { type: String, required: true },
    body: { type: String, default: '' },   // kept for migration bridge; removed in Phase 3
    tags: { type: [String], default: [] },
    blocks: { type: [blockSchema], default: [] },
    open_questions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'OpenQuestion' }],
    workspaceId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

export { BLOCK_TYPES };
export default mongoose.model('Entry', entrySchema);
