import mongoose from 'mongoose';
import Workspace from './Workspace.js';
import { ownerGuard } from '../lib/ownerGuard.js';

const openQuestionSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null, index: true },
    question: { type: String, required: true },
    status: { type: String, enum: ['open', 'resolved'], default: 'open' },
    entry_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Entity' }],
  },
  { timestamps: true }
);

// Account deletion sweeps content by workspaceId once the workspace is gone.
// One inserted after that deletes itself (lib/ownerGuard.js).
openQuestionSchema.plugin(ownerGuard, { path: 'workspaceId', owner: Workspace });

export default mongoose.model('OpenQuestion', openQuestionSchema);
