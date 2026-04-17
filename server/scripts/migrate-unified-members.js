/**
 * Migration: unified members array
 *
 * Merges each RelationshipGroup's separate `members` (entityId) and
 * `relationships` (groupId sub-group links) arrays into a single `members`
 * array with { refId, refModel, label, notes } entries.
 *
 * Safe to run multiple times — already-migrated documents (no `relationships`
 * field, members already have `refModel`) are skipped.
 *
 * Run: node --env-file=.env scripts/migrate-unified-members.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI not set in environment');
  process.exit(1);
}

await mongoose.connect(MONGO_URI);
console.log('Connected to MongoDB');

const col = mongoose.connection.db.collection('relationshipgroups');

const groups = await col.find({}).toArray();
console.log(`Found ${groups.length} relationship group(s)`);

let migrated = 0;
let skipped  = 0;

for (const group of groups) {
  // Skip if already migrated (no legacy relationships field, members already use refId/refModel)
  const alreadyMigrated =
    !group.relationships?.length &&
    (group.members ?? []).every(m => m.refModel !== undefined);

  if (alreadyMigrated) {
    skipped++;
    continue;
  }

  const entityMembers = (group.members ?? []).map(m => ({
    refId:    m.entityId,
    refModel: 'Entity',
    label:    m.label  ?? null,
    notes:    m.notes  ?? null,
  }));

  const groupMembers = (group.relationships ?? []).map(r => ({
    refId:    r.groupId,
    refModel: 'RelationshipGroup',
    label:    r.label  ?? null,
    notes:    r.notes  ?? null,
  }));

  await col.updateOne(
    { _id: group._id },
    {
      $set:   { members: [...entityMembers, ...groupMembers] },
      $unset: { relationships: '' },
    }
  );

  migrated++;
  console.log(`  Migrated group ${group._id} (${group.label ?? '(unlabeled)'}): ${entityMembers.length} entity member(s), ${groupMembers.length} sub-group link(s)`);
}

console.log(`\nDone. Migrated: ${migrated}, already up-to-date: ${skipped}`);
await mongoose.disconnect();
