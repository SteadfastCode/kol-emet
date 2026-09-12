import mongoose from 'mongoose';
import User from './User.js';
import { ownerGuard } from '../lib/ownerGuard.js';

const messageSchema = new mongoose.Schema(
  {
    role:    { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
  },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } }
);

const conversationSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null, index: true },
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    provider:  { type: String, required: true },
    model:     { type: String, required: true },
    title:     { type: String, default: '' },
    autoTitle: { type: Boolean, default: true },   // false once user manually renames
    messages:  [messageSchema],
  },
  { timestamps: true }
);

// Account deletion removes conversations by userId. One created after that
// deletes itself (lib/ownerGuard.js).
conversationSchema.plugin(ownerGuard, { path: 'userId', owner: User });

export default mongoose.model('Conversation', conversationSchema);
