import mongoose from 'mongoose';

const entrySchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    category: {
      type: String,
      required: true,
      enum: ['Characters', 'Worlds', 'Organizations', 'Lore & Mechanics', 'Timeline'],
    },
    summary: { type: String, required: true },
    body: { type: String, default: '' },
    tags: { type: [String], default: [] },
    open_questions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'OpenQuestion' }],
  },
  { timestamps: true }
);

export default mongoose.model('Entry', entrySchema);
