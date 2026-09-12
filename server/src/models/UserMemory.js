import mongoose from 'mongoose';
import User from './User.js';
import { ownerGuard } from '../lib/ownerGuard.js';

const userMemorySchema = new mongoose.Schema(
  {
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fact:     { type: String, required: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },
  },
  { timestamps: true }
);

// Personal data about the user. Memory extraction writes it in the background,
// after a slow model call, so an insert can land once the account is gone. It
// then deletes itself (lib/ownerGuard.js).
userMemorySchema.plugin(ownerGuard, { path: 'userId', owner: User });

export default mongoose.model('UserMemory', userMemorySchema);
