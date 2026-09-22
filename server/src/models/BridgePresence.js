import mongoose from 'mongoose';
import Workspace from './Workspace.js';
import { ownerGuard } from '../lib/ownerGuard.js';

/**
 * What the box last said about itself: which Claude Code sessions exist, so the
 * chat side can address one by name. One document per host; the box-side
 * poller replaces it whole each time it announces.
 */
const bridgePresenceSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null, index: true },
    host: { type: String, required: true },
    sessions: [
      {
        _id: false,
        name: { type: String, required: true },
        uuid: { type: String, default: null },
        repo: { type: String, default: null },
        cwd: { type: String, default: null },
        status: { type: String, default: null },
        kind: { type: String, default: null },
      },
    ],
    announcedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

bridgePresenceSchema.index({ workspaceId: 1, host: 1 }, { unique: true });

// Account deletion sweeps content by workspaceId once the workspace is gone.
// One inserted after that deletes itself (lib/ownerGuard.js).
bridgePresenceSchema.plugin(ownerGuard, { path: 'workspaceId', owner: Workspace });

export default mongoose.model('BridgePresence', bridgePresenceSchema);
