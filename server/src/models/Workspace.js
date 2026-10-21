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
     * AI spending allowance, in micro-dollars (1_000_000 = one dollar).
     *
     * Integers because this is compared and decremented on every AI call and
     * float cents drift. A total allowance rather than a daily rate: the
     * audience works in bursts — a free Saturday with three chapters of notes
     * is the exact session a daily cap would block, and the worst-case
     * exposure is identical either way.
     *
     * Covers generation, in-app chat and memory extraction — everything that
     * calls a provider we pay for, self-hosted included: the steadfast-ai box
     * is far cheaper than a cloud model but still burns electricity, so it has
     * a derived rate rather than a zero one. It deliberately does NOT cover
     * MCP: Claude.ai runs that inference on the user's own subscription, so it
     * costs us nothing and stays free forever.
     */
    aiBudget: {
      grantedMicros: { type: Number, default: Number(process.env.AI_TRIAL_GRANT_MICROS ?? 3_500_000) },
      spentMicros:   { type: Number, default: 0 },
      // Concurrency lock for generation. Cost is unknown until a run finishes,
      // so simultaneous runs would each pass the same budget check; this caps
      // the overshoot at one run. Cleared on completion, and treated as stale
      // after 10 minutes so a crash cannot lock a workspace out permanently.
      generatingSince: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

// Membership lookups drive every scoped request, so index the nested user id.
workspaceSchema.index({ 'members.userId': 1 });

export default mongoose.model('Workspace', workspaceSchema);
