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

const hasEntries  = (await db.listCollections({ name: 'entries'  }).toArray()).length > 0;
const hasEntities = (await db.listCollections({ name: 'entities' }).toArray()).length > 0;

if (!hasEntries) {
  console.log("Collection 'entries' not found — nothing to migrate.");
} else {
  const entriesCount  = await db.collection('entries').countDocuments();
  const entitiesCount = hasEntities ? await db.collection('entities').countDocuments() : 0;

  console.log(`entries: ${entriesCount} docs  |  entities: ${entitiesCount} docs`);

  if (entitiesCount > 0 && entriesCount === 0) {
    console.log("'entities' already has data and 'entries' is empty — nothing to do.");
  } else if (hasEntities && entitiesCount === 0) {
    // Empty entities shell created by Mongoose on startup — drop it, then rename
    console.log("Dropping empty 'entities' collection created by Mongoose...");
    await db.collection('entities').drop();
    await db.collection('entries').rename('entities');
    console.log("Renamed 'entries' → 'entities'");
  } else if (!hasEntities) {
    await db.collection('entries').rename('entities');
    console.log("Renamed 'entries' → 'entities'");
  } else {
    console.error(
      `Both collections have data (entries: ${entriesCount}, entities: ${entitiesCount}). ` +
      'Manual intervention required — inspect both collections before proceeding.'
    );
    process.exit(1);
  }
}

await mongoose.disconnect();
console.log('Done.');
