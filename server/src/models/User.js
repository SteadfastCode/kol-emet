import mongoose from 'mongoose';
import { newUserHandle } from '../lib/passkeyIds.js';

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
