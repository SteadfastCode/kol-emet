import mongoose from 'mongoose';

const openQuestionSchema = new mongoose.Schema(
  {
    question: { type: String, required: true },
    status: { type: String, enum: ['open', 'resolved'], default: 'open' },
    entry_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Entity' }],
  },
  { timestamps: true }
);

export default mongoose.model('OpenQuestion', openQuestionSchema);
