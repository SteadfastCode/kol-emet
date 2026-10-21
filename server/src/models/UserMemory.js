import mongoose from 'mongoose';
import User from './User.js';
import Workspace from './Workspace.js';
import { ownerGuard } from '../lib/ownerGuard.js';

const userMemorySchema = new mongoose.Schema(
  {
    // The workspace the fact was extracted in (KOL-091). A memory is personal
    // data, but it is also *about* the content of one workspace's chats — "the
    // night train runs on Tuesdays" is lore from one wiki, and putting it in
    // another's system prompt is the assistant inventing from the wrong world.
    // `null` on rows written before this item; lib/personalScope.js reads a
    // null as the caller's current workspace, so nobody loses their history.
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null, index: true },
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fact:     { type: String, required: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },
  },
  { timestamps: true }
);

// Personal data about the user. Memory extraction writes it in the background,
// after a slow model call, so an insert can land once the account — or the
// workspace it was extracted in — is gone. It then deletes itself
// (lib/ownerGuard.js). Both guards, for the reason Conversation carries both:
// an editor's memory from a deleted workspace has a user who still exists.
userMemorySchema.plugin(ownerGuard, { path: 'userId', owner: User });
userMemorySchema.plugin(ownerGuard, { path: 'workspaceId', owner: Workspace });

export default mongoose.model('UserMemory', userMemorySchema);
