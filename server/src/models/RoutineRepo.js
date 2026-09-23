import mongoose from 'mongoose';
import Workspace from './Workspace.js';
import { ownerGuard } from '../lib/ownerGuard.js';

/**
 * Where one repository's hourly routine stands, as the steadfast-ai box last reported it through
 * the bridge (`bridge_sync_routine`). One document per (workspace, repo), replaced whole on each
 * sync. Part of the bridge's own knowledge base — its own collection, no reference to the entity
 * graph (see BridgeMessage for why) — so a chat can answer "where does the routine stand" from
 * here without asking the box. The box is the source of truth; this is its cache.
 */
const routineRepoSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null, index: true },
    repo: { type: String, required: true },
    github: { type: String, default: null },
    host: { type: String, default: null },
    syncedAt: { type: Date, required: true },
    // Deterministic digest of everything below except syncedAt: the box skips a sync when unchanged.
    factsHash: { type: String, default: null },
    counts: {
      pending: { type: Number, default: 0 },
      needsHuman: { type: Number, default: 0 },
      proposed: { type: Number, default: 0 },
      blocked: { type: Number, default: 0 },
      claimed: { type: Number, default: 0 },
      done: { type: Number, default: 0 },
      unreviewed: { type: Number, default: 0 },
      localReviews: { type: Number, default: 0 },
      graded: { type: Number, default: 0 },
      ungraded: { type: Number, default: 0 },
    },
    lastCompleted: { itemId: String, title: String, mergeSha: String, at: Date },
    lastBlocked: { itemId: String, title: String, detail: String, at: Date },
    lastFire: { runId: String, decision: String, at: Date },
    backpressure: { level: String, count: Number, oldestDays: Number },
  },
  { timestamps: true }
);

routineRepoSchema.index({ workspaceId: 1, repo: 1 }, { unique: true });

// Account deletion sweeps content by workspaceId once the workspace is gone.
// One inserted after that deletes itself (lib/ownerGuard.js).
routineRepoSchema.plugin(ownerGuard, { path: 'workspaceId', owner: Workspace });

export default mongoose.model('RoutineRepo', routineRepoSchema);
