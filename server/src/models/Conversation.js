import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    role:    { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
  },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } }
);

const conversationSchema = new mongoose.Schema(
  {
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    provider:  { type: String, required: true },
    model:     { type: String, required: true },
    title:     { type: String, default: '' },
    autoTitle: { type: Boolean, default: true },   // false once user manually renames
    messages:  [messageSchema],
  },
  { timestamps: true }
);

export default mongoose.model('Conversation', conversationSchema);
