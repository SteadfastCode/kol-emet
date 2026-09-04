import mongoose from 'mongoose';

const userMemorySchema = new mongoose.Schema(
  {
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fact:     { type: String, required: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },
  },
  { timestamps: true }
);

export default mongoose.model('UserMemory', userMemorySchema);
