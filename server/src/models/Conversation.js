import mongoose from 'mongoose';
import User from './User.js';
import Workspace from './Workspace.js';
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

// Account deletion removes conversations by userId, and by workspaceId for the
// workspaces it deletes. One created after either owner is gone deletes itself
// (lib/ownerGuard.js). Both guards are needed: an editor's chat in a deleted
// workspace has a user who still exists.
conversationSchema.plugin(ownerGuard, { path: 'userId', owner: User });
conversationSchema.plugin(ownerGuard, { path: 'workspaceId', owner: Workspace });

export default mongoose.model('Conversation', conversationSchema);
