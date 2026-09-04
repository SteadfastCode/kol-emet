/**
 * Migration: workspaces
 *
 * 1. Gives every existing user a personal workspace (if they lack one).
 * 2. Adopts pre-workspace content (workspaceId null/missing) into a workspace.
 *
 * Step 2 is the dangerous half: existing content predates tenancy and carries
 * no ownership marker, so it cannot be attributed automatically when several
 * users exist. The script therefore refuses to guess — it adopts orphaned
 * content only into an explicitly named target, and otherwise reports and stops.
 *
 * Dry-run by default; pass --apply to write. Safe to re-run.
 *
 * Run: node --env-file=.env scripts/migrate-workspaces.js [--apply] [--owner <email>]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('MONGO_URI not set in environment');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const ownerFlagIdx = process.argv.indexOf('--owner');
const OWNER_EMAIL = ownerFlagIdx !== -1 ? process.argv[ownerFlagIdx + 1] : null;

await mongoose.connect(MONGO_URI);
console.log(`Connected to MongoDB${APPLY ? '' : '  (DRY RUN — pass --apply to write)'}\n`);

const { default: User }      = await import('../src/models/User.js');
const { default: Workspace } = await import('../src/models/Workspace.js');

// Collections that carry tenant content. Settings is deliberately excluded —
// it is a singleton of instance config, not per-tenant data.
// Imported (not just named) so their schemas are registered before use.
const COLLECTIONS = [];
for (const name of [
  'Entity',
  'RelationshipGroup',
  'RelationshipType',
  'OpenQuestion',
  'ChangeLog',
  'Conversation',
]) {
  const { default: model } = await import(`../src/models/${name}.js`);
  COLLECTIONS.push({ name, model });
}

// ─── Step 1: a workspace per user ────────────────────────────────────────────

const users = await User.find().select('email createdAt').sort({ createdAt: 1 }).lean();
console.log(`Found ${users.length} user(s)\n--- step 1: personal workspaces ---`);

const workspaceByUser = new Map();

for (const user of users) {
  const existing = await Workspace.findOne({ 'members.userId': user._id }).lean();
  if (existing) {
    workspaceByUser.set(String(user._id), existing._id);
    console.log(`  = ${user.email} already in workspace ${existing._id}`);
    continue;
  }

  if (!APPLY) {
    console.log(`  + ${user.email} would get a new workspace`);
    continue;
  }

  const ws = await Workspace.create({
    name:    'My Workspace',
    ownerId: user._id,
    members: [{ userId: user._id, role: 'owner' }],
  });
  workspaceByUser.set(String(user._id), ws._id);
  console.log(`  + ${user.email} → workspace ${ws._id}`);
}

// ─── Step 2: adopt pre-workspace content ─────────────────────────────────────

console.log('\n--- step 2: orphaned content ---');

const orphanFilter = { $or: [{ workspaceId: null }, { workspaceId: { $exists: false } }] };
const counts = {};
let totalOrphans = 0;

for (const { name, model } of COLLECTIONS) {
  const n = await model.collection.countDocuments(orphanFilter);
  counts[name] = n;
  totalOrphans += n;
  console.log(`  ${name}: ${n} orphaned document(s)`);
}

if (totalOrphans === 0) {
  console.log('\nNothing to adopt. Done.');
  await mongoose.disconnect();
  process.exit(0);
}

// Pick the target workspace, refusing to guess when it is ambiguous.
let targetUser = null;
if (OWNER_EMAIL) {
  targetUser = users.find(u => u.email.toLowerCase() === OWNER_EMAIL.toLowerCase());
  if (!targetUser) {
    console.error(`\nNo user with email ${OWNER_EMAIL}. Aborting.`);
    await mongoose.disconnect();
    process.exit(1);
  }
} else if (users.length === 1) {
  targetUser = users[0];
  console.log(`\nSingle user (${targetUser.email}) — unambiguous adoption target.`);
} else {
  console.error(
    `\n${users.length} users exist and this content predates tenancy, so its owner ` +
    `cannot be determined from the data.\nRe-run with --owner <email> to name the ` +
    `workspace that should adopt it. Refusing to guess.`
  );
  await mongoose.disconnect();
  process.exit(1);
}

const targetWorkspaceId = workspaceByUser.get(String(targetUser._id));

if (!APPLY) {
  // In a dry run step 1 created nothing, so there may be no id to name yet.
  const target = targetWorkspaceId ?? `the workspace step 1 will create for ${targetUser.email}`;
  console.log(`\nWould adopt ${totalOrphans} document(s) into ${target}`);
  console.log('DRY RUN — nothing written. Re-run with --apply.');
  await mongoose.disconnect();
  process.exit(0);
}

if (!targetWorkspaceId) {
  console.error(`\n${targetUser.email} has no workspace and step 1 did not create one. Aborting.`);
  await mongoose.disconnect();
  process.exit(1);
}

console.log(`\nAdopting ${totalOrphans} document(s) into workspace ${targetWorkspaceId} (${targetUser.email})`);

for (const { name, model } of COLLECTIONS) {
  if (counts[name] === 0) continue;
  const { modifiedCount } = await model.collection.updateMany(orphanFilter, {
    $set: { workspaceId: targetWorkspaceId },
  });
  console.log(`  ${name}: ${modifiedCount} updated`);
}

console.log('\nDone.');
await mongoose.disconnect();
