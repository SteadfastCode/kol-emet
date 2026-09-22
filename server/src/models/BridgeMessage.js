import mongoose from 'mongoose';
import Workspace from './Workspace.js';
import { ownerGuard } from '../lib/ownerGuard.js';

/**
 * One message across the Steadfast bridge: a claude.ai chat on one side, a
 * Claude Code session on the steadfast-ai box on the other, both reaching this
 * server over MCP because neither can reach the other directly.
 *
 * Deliberately its own collection with no reference to Entity, RelationshipGroup,
 * OpenQuestion or ChangeLog. The bridge is an unrelated feature that happens to
 * live in this server; operational chatter must not land in the knowledge graph
 * or in the changelog corpus that is kept fine-tune-ready. If the knowledge base
 * ever grows a per-repo view, that is where a link would go — not here, not now.
 */
const bridgeMessageSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null, index: true },
    // Which side reads it. 'box' = a Claude Code session on the box; 'chat' = the claude.ai chat.
    to: { type: String, enum: ['box', 'chat'], required: true },
    // Session name the message is for (to: box) or came from (to: chat), e.g. "steadfast-ai".
    session: { type: String, default: null },
    kind: { type: String, enum: ['message', 'command'], default: 'message' },
    text: { type: String, required: true },
    // Only for kind: 'command' — something the box-side poller executes rather than relays.
    command: {
      name: { type: String, default: null },
      args: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'BridgeMessage', default: null },
    // pending → delivered (a poll returned it) → acked (the reader finished with it).
    status: { type: String, enum: ['pending', 'delivered', 'acked'], default: 'pending' },
    deliveredAt: { type: Date, default: null },
    ackedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// The poll query: this side's pending messages, oldest first.
bridgeMessageSchema.index({ workspaceId: 1, to: 1, status: 1, createdAt: 1 });
// A relay log, not a record — 30 days, same as ChangeLog.
bridgeMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// Account deletion sweeps content by workspaceId once the workspace is gone.
// One inserted after that deletes itself (lib/ownerGuard.js).
bridgeMessageSchema.plugin(ownerGuard, { path: 'workspaceId', owner: Workspace });

export default mongoose.model('BridgeMessage', bridgeMessageSchema);
