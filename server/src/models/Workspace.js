import mongoose from 'mongoose';

/**
 * A workspace is the tenancy boundary: every piece of graph content belongs to
 * exactly one, and a request may only touch content in a workspace the caller
 * is a member of.
 *
 * Members are modelled from the start (rather than a bare ownerId) so shared
 * workspaces don't require reshaping the schema later. Registration creates a
 * personal workspace with the new user as the sole owner.
 */
const memberSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role:   { type: String, enum: ['owner', 'editor', 'viewer'], default: 'owner' },
  },
  { _id: false }
);

const workspaceSchema = new mongoose.Schema(
  {
    name:    { type: String, required: true, trim: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    members: { type: [memberSchema], default: [] },
  },
  { timestamps: true }
);

// Membership lookups drive every scoped request, so index the nested user id.
workspaceSchema.index({ 'members.userId': 1 });

export default mongoose.model('Workspace', workspaceSchema);
