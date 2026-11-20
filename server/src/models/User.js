import mongoose from 'mongoose';
import { newUserHandle } from '../lib/passkeyIds.js';
import { trialGrantMicros } from '../config/pricing.js';

const passkeySchema = new mongoose.Schema({
  credentialID: { type: String, required: true },   // base64url, exactly the id the browser sends (see lib/passkeyIds.js)
  publicKey: { type: Buffer, required: true },
  counter: { type: Number, required: true, default: 0 },
  transports: [String],
  deviceType: String,   // 'singleDevice' | 'multiDevice' from registration; unset on passkeys added before KOL-024
  backedUp: Boolean,    // from registration, refreshed by each sign-in; likewise
  createdAt: { type: Date, default: Date.now },
  lastUsedAt: Date,     // the last verified assertion; unset until the first one after KOL-025
});

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  passkeys: [passkeySchema],
  // The account's WebAuthn `user.id`: one handle shared by every passkey on it,
  // 32 random bytes base64url. Unset on accounts registered before KOL-052,
  // which the first register/begin fills in. See lib/passkeyIds.js.
  webauthnUserHandle: { type: String },
  // When the account last said "everything signed in before now is no longer
  // signed in" (KOL-076). `POST /auth/sessions/revoke-all` writes it; the two
  // auth middlewares compare it against the `issuedAt` every sign-in stamps
  // into the session, and end a session that predates it. Unset on accounts
  // registered before KOL-076, which means *nothing has been revoked* and every
  // session of theirs stands — see the middleware for why that direction is the
  // safe one.
  credentialsChangedAt: { type: Date },

  /**
   * AI spending allowance, in micro-dollars (1_000_000 = one dollar).
   *
   * **The account is the pot** (KOL-132). This was a field on `Workspace`, and
   * for as long as registration was the only thing that had ever created one
   * that was the same statement: one workspace per account, for life. Once
   * `POST /workspaces` existed (KOL-123) it stopped being true — the schema
   * default minted a full fresh allowance per create, so any logged-in user
   * could mint `WORKSPACE_MAX_PER_OWNER` of them with cheap `template: null`
   * creates and spend ten times the intended amount of real provider money.
   * The signup ceiling that is supposed to bound that exposure (KOL-050,
   * KOL-081) guards registration, which was no longer the only door.
   *
   * No per-workspace pot can be made safe: whatever a new workspace is granted,
   * a user may have ten of it, and copying the *remaining* balance into each
   * new workspace multiplies it just as well. So the allowance is held on the
   * one document an account has exactly one of, and every workspace meters
   * against its **owner's** pot — the owner, not the caller, because a
   * collaborator invited into someone else's workspace (KOL-124) is spending
   * money that workspace's owner agreed to spend, and being invited into ten
   * workspaces must not hand anybody ten allowances either.
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
   *
   * `grantedMicros` defaults from `trialGrantMicros()` rather than a literal
   * so `lib/usageMeter.js` can read a *missing* grant as the trial too — an
   * account that predates this field, and one whose subdocument was created by
   * the `$inc` in `recordSpend`, both have `spentMicros` and no grant.
   */
  aiBudget: {
    grantedMicros: { type: Number, default: trialGrantMicros },
    spentMicros:   { type: Number, default: 0 },
    // Concurrency lock for generation. Cost is unknown until a run finishes,
    // so simultaneous runs would each pass the same budget check; this caps
    // the overshoot at one run. On the account for the same reason the pot is:
    // a lock held per workspace bounds the overshoot at one run *per
    // workspace*, which against a shared pot is one run per workspace the
    // owner has. Cleared on completion, and treated as stale after 10 minutes
    // so a crash cannot lock an account out permanently.
    generatingSince: { type: Date, default: null },
  },
}, { timestamps: true });

/**
 * Every account created gets a handle — and `default:` cannot be how, because
 * mongoose applies a default when it *hydrates* a document whose path is
 * missing too. A pre-KOL-052 account would then read back a fresh random handle
 * that nothing ever stored, every time it was loaded: the backfill in
 * routes/auth.js would see a handle and store nothing, and two registrations
 * would be two WebAuthn users again. `isNew` is the distinction the default
 * does not make.
 *
 * `credentialsChangedAt` is set here for the same reason, and the hydration
 * hazard is worse for it than for the handle: `default: Date.now` would give a
 * pre-KOL-076 account a fresh "credentials changed just now" on every load, and
 * one `save()` of such a document would persist it — signing out every session
 * that account holds, on a write that was about something else entirely. Set on
 * creation only, so the field means what it says.
 */
userSchema.pre('validate', function setUserHandle() {
  if (this.isNew && !this.webauthnUserHandle) this.webauthnUserHandle = newUserHandle();
  if (this.isNew && !this.credentialsChangedAt) this.credentialsChangedAt = new Date();
});

export default mongoose.model('User', userSchema);
