import mongoose from 'mongoose';

const passkeySchema = new mongoose.Schema({
  credentialID: { type: String, required: true },   // base64url string for querying
  publicKey: { type: Buffer, required: true },
  counter: { type: Number, required: true, default: 0 },
  transports: [String],
  createdAt: { type: Date, default: Date.now },
});

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  passkeys: [passkeySchema],
}, { timestamps: true });

export default mongoose.model('User', userSchema);
