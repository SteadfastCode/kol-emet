import mongoose from 'mongoose';

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
}, { timestamps: true });

export default mongoose.model('User', userSchema);
