import mongoose from 'mongoose';
import Workspace from './Workspace.js';
import { ownerGuard } from '../lib/ownerGuard.js';

/**
 * One FEATURES.md item of one repository, with what the routine's ledger and review files say
 * about it — synced whole from the box (see RoutineRepo). The chat answers "what needs review,
 * what is blocked, what did SAI-038 do" from these. Titles and ids only: the item body, the diff
 * and the review text stay on the box, where the bridge responder reads them on demand.
 */
export const ROUTINE_ITEM_STATES = ['pending', 'claimed', 'blocked', 'done'];

const routineItemSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null, index: true },
    repo: { type: String, required: true },
    itemId: { type: String, required: true },
    title: { type: String, required: true },
    state: { type: String, enum: ROUTINE_ITEM_STATES, required: true },
    // Markers from FEATURES.md, as the routine reads them.
    needsHuman: { type: Boolean, default: false },
    proposed: { type: Boolean, default: false },
    notBefore: { type: String, default: null },
    dependsOn: { type: [String], default: [] },
    attempts: { type: Number, default: 0 },
    // From the ledger.
    claimedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    mergeSha: { type: String, default: null },
    blockedAt: { type: Date, default: null },
    blockedDetail: { type: String, default: null },
    acked: { type: Boolean, default: false },
    lastRunId: { type: String, default: null },
    // From ops/routine/reviews/<item>.{local,graded}.json.
    review: {
      localFindings: { type: Number, default: null },
      localModel: { type: String, default: null },
      reviewedAt: { type: Date, default: null },
      gradedAt: { type: Date, default: null },
      confirmed: { type: Number, default: null },
      falsePositive: { type: Number, default: null },
      duplicate: { type: Number, default: null },
    },
    // Set when a sync no longer lists the item: it left FEATURES.md entirely.
    missingSince: { type: Date, default: null },
    syncedAt: { type: Date, required: true },
  },
  { timestamps: true }
);

routineItemSchema.index({ workspaceId: 1, repo: 1, itemId: 1 }, { unique: true });
routineItemSchema.index({ workspaceId: 1, state: 1, needsHuman: 1, proposed: 1 });

// Account deletion sweeps content by workspaceId once the workspace is gone.
// One inserted after that deletes itself (lib/ownerGuard.js).
routineItemSchema.plugin(ownerGuard, { path: 'workspaceId', owner: Workspace });

export default mongoose.model('RoutineItem', routineItemSchema);
