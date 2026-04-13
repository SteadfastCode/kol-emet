/**
 * Migration: body string → text block
 *
 * Safe to re-run — only processes entries where body is non-empty AND blocks is empty.
 * Does NOT remove the body field (that happens in Phase 3 after client is stable).
 *
 * Usage: node scripts/migrate-blocks.js
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import Entry from '../src/models/Entry.js';

async function migrate() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const entries = await Entry.find({
    body: { $exists: true, $ne: '' },
    $or: [{ blocks: { $exists: false } }, { blocks: { $size: 0 } }],
  });

  console.log(`Found ${entries.length} entries to migrate`);

  let migrated = 0;
  for (const entry of entries) {
    await Entry.updateOne(
      { _id: entry._id },
      { $set: { blocks: [{ type: 'text', order: 0, data: { markdown: entry.body } }] } }
    );
    migrated++;
    process.stdout.write(`\rMigrated ${migrated}/${entries.length}`);
  }

  console.log(`\nDone. ${migrated} entries migrated.`);
  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error(err);
  process.exit(1);
});
