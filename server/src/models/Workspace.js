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

    /**
     * The template key this workspace was seeded from (`config/templates.js`),
     * or null for one created before it was recorded.
     *
     * Kept because the key is otherwise thrown away the moment seeding ends:
     * `POST /auth/register` receives it, hands it to `seedWorkspace` and
     * forgets it. The template's own one-line `description` is the only
     * sentence anywhere that says what a workspace is *about*, and the
     * assistant's system prompt needs exactly that — without it every
     * workspace was told it was a world-building wiki, including one whose
     * entities are Services and Data Stores (KOL-105, routes/chat.js).
     *
     * **No backfill.** Nothing in an existing workspace records which template
     * its types came from, and inferring one from the type names would be
     * wrong for anyone who has since renamed or deleted one. A null is read as
     * "unknown" and the prompt falls back to the workspace's own entity type
     * names, which are a fact rather than a guess.
     *
     * Not an enum: templates are code and a key can be retired, and a stored
     * key that no longer names one must read as unknown rather than make the
     * document unsaveable.
     */
    template: { type: String, default: null },

    /**
     * **There is deliberately no `aiBudget` here** (KOL-132). The AI allowance
     * lives on `User` and every workspace meters against its owner's pot —
     * see models/User.js for the whole argument, and `lib/usageMeter.js` for
     * the `ownerId` hop that does it.
     *
     * The short version: a pot attached to this document is minted again by
     * every `POST /workspaces`, so one account could hold
     * `WORKSPACE_MAX_PER_OWNER` full allowances and spend ten times the real
     * provider money the trial is meant to cover. Nothing a new workspace can
     * be *given* fixes that, since a user may have ten of whatever it is.
     *
     * Adding a per-workspace allowance back is therefore a pricing decision
     * (a per-workspace *sub-limit* drawn from the account's pot would be one),
     * never a default.
     */
  },
  { timestamps: true }
);

// Membership lookups drive every scoped request, so index the nested user id.
workspaceSchema.index({ 'members.userId': 1 });

export default mongoose.model('Workspace', workspaceSchema);
