import mongoose from 'mongoose';

// Single-document store for global app settings.
// Always upsert with { _id: 'global' } — never create a second document.
const settingsSchema = new mongoose.Schema(
  {
    _id:        { type: String, default: 'global' },
    mcpUserId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: false }
);

export default mongoose.model('Settings', settingsSchema);
