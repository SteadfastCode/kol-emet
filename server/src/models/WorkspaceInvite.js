import mongoose from 'mongoose';
import Workspace from './Workspace.js';
import { ownerGuard } from '../lib/ownerGuard.js';

/**
 * A pending invitation to join a workspace (KOL-124).
 *
 * `Workspace.members[].role` has carried `owner | editor | viewer` since
 * KOL-071 and every content write has been gated on it since KOL-103, but
 * nothing in the product could produce a member who was not the owner:
 * registration writes the single owner and no route added, re-roled or removed
 * a membership. So `editor` and `viewer` were unreachable on a real deployment
 * and the write floor was exercised only by tests. This is the row that makes
 * them reachable.
 *
 * **An invite names an email address, and delivers nothing.** There is no
 * token, no link and no mail: an outbound mail credential is out of scope, so
 * minting a link nobody could receive would be a secret with no delivery
 * channel and a second way into a workspace to secure. The invitee sees the
 * invite when they ask for their own (`GET /invites`), matched on the address
 * their account is keyed by — the identifier registration already keeps unique
 * (`User.email`, lowercased and trimmed by its schema).
 *
 * Consequences of that choice, each deliberate:
 *   - **An address with no account simply waits.** The row is valid, nothing
 *     resolves it, and it becomes visible the moment someone registers that
 *     address. There is no expiry: a pending invite is not a credential, so
 *     time does not make it dangerous, and an owner can withdraw it.
 *   - **Nothing tells the inviter whether the address is registered.** The
 *     create answers the same way either way, which is also the privacy
 *     answer: an invite form must not be a way to enumerate who has an account
 *     here.
 *
 * `email` is stored lowercased and trimmed — the same normalization `User`
 * applies — so the match against an account is an equality test on a stored
 * primitive rather than a case-insensitive regex built from a request.
 *
 * One pending invite per address per workspace, enforced by the unique index
 * below: re-inviting an address updates the role of the invite that is already
 * waiting (see routes/workspace.js), so an owner who changes their mind does
 * not leave two rows that disagree.
 *
 * `invitedBy` is kept for the audit trail the invitee reads — "who asked me" is
 * the one thing that makes an unexpected invite legible — and is deliberately
 * not required to still exist: an invite whose inviter deleted their account
 * is stale, not invalid, and the workspace it points at is the authority.
 */
const workspaceInviteSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },

    // The invited address, normalized exactly as User.email is stored.
    email: { type: String, required: true, lowercase: true, trim: true },

    // The role the membership gets on accept. Same set as Workspace.members.
    role: { type: String, enum: ['owner', 'editor', 'viewer'], default: 'editor' },

    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// One pending invite per address per workspace. Plain equality rather than a
// collation, because `email` is already stored in one case — the route and this
// index therefore agree about what a duplicate is.
workspaceInviteSchema.index({ workspaceId: 1, email: 1 }, { unique: true });

// An invitee asks for their own invites by address, across every workspace.
workspaceInviteSchema.index({ email: 1 });

// Account deletion sweeps workspace-scoped data once the workspace is gone, and
// an invite written after that deletes itself (lib/ownerGuard.js). It is in
// WORKSPACE_SCOPED_MODELS for the same reason.
workspaceInviteSchema.plugin(ownerGuard, { path: 'workspaceId', owner: Workspace });

export default mongoose.model('WorkspaceInvite', workspaceInviteSchema);
