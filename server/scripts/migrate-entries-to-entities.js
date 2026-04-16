/**
 * One-time migration: rename MongoDB collection 'entries' → 'entities'
 * Run once after deploying the Entry → Entity model rename.
 *
 * Usage: node server/scripts/migrate-entries-to-entities.js
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI not set — copy .env.example to .env');
  process.exit(1);
}

await mongoose.connect(MONGO_URI);
console.log('Connected to MongoDB');

const db = mongoose.connection.db;
const collections = await db.listCollections({ name: 'entries' }).toArray();

if (collections.length === 0) {
  console.log("Collection 'entries' not found — nothing to migrate (may already be 'entities')");
} else {
  await db.collection('entries').rename('entities');
  console.log("Renamed 'entries' → 'entities'");
}

await mongoose.disconnect();
console.log('Done.');
