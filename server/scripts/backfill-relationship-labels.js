/**
 * Adds the worldbuilding template's role labels to an existing workspace.
 *
 * For workspaces created before templates existed. Skips any label that
 * already exists (exact, case-insensitive) and REPORTS near-duplicates without
 * adding them, so an existing "Marriage" is never quietly shadowed by a
 * template "wife".
 *
 * Dry-run by default; pass --apply to write. Safe to re-run.
 *
 * Run: node --env-file=.env scripts/backfill-relationship-labels.js [--apply] [--owner <email>]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const APPLY = process.argv.includes('--apply');
const ownerIdx = process.argv.indexOf('--owner');
const OWNER_EMAIL = ownerIdx !== -1 ? process.argv[ownerIdx + 1] : null;

if (!process.env.MONGO_URI) {
  console.error('MONGO_URI not set');
  process.exit(1);
}

await mongoose.connect(process.env.MONGO_URI);
console.log(`Connected${APPLY ? '' : '  (DRY RUN — pass --apply to write)'}\n`);

const { default: User }             = await import('../src/models/User.js');
const { default: Workspace }        = await import('../src/models/Workspace.js');
const { default: RelationshipType } = await import('../src/models/RelationshipType.js');
const { TEMPLATES }                 = await import('../src/config/templates.js');
const { similarity }                = await import('../src/lib/similarity.js');

const NEAR_DUPLICATE = 0.5;

const users = await User.find().select('email').sort({ createdAt: 1 }).lean();
let target;
if (OWNER_EMAIL) {
  target = users.find(u => u.email.toLowerCase() === OWNER_EMAIL.toLowerCase());
  if (!target) { console.error(`No user ${OWNER_EMAIL}`); await mongoose.disconnect(); process.exit(1); }
} else if (users.length === 1) {
  target = users[0];
  console.log(`Single user (${target.email}).`);
} else {
  console.error(`${users.length} users exist — pass --owner <email>. Refusing to guess.`);
  await mongoose.disconnect();
  process.exit(1);
}

const ws = await Workspace.findOne({ 'members.userId': target._id }).lean();
if (!ws) { console.error(`${target.email} has no workspace`); await mongoose.disconnect(); process.exit(1); }

const existing = await RelationshipType.find({ workspaceId: ws._id }).select('name').lean();
const existingNames = existing.map(t => t.name);
const lower = new Set(existingNames.map(n => n.toLowerCase()));

console.log(`Workspace ${ws._id} currently has ${existing.length}: ${existingNames.join(', ') || '(none)'}\n`);

const toAdd = [];
const skippedExact = [];
const flaggedNear = [];

for (const t of TEMPLATES.worldbuilding.relationshipTypes) {
  if (lower.has(t.name.toLowerCase())) { skippedExact.push(t.name); continue; }
  const near = existingNames.filter(n => similarity(t.name, n) >= NEAR_DUPLICATE);
  if (near.length) flaggedNear.push({ name: t.name, near });
  toAdd.push(t);
}

if (skippedExact.length) console.log(`Already present, skipping: ${skippedExact.join(', ')}\n`);

if (flaggedNear.length) {
  console.log('Near-duplicates of labels you already have — added anyway, listed so you can prune:');
  for (const f of flaggedNear) console.log(`  ${f.name}  ~  ${f.near.join(', ')}`);
  console.log('');
}

console.log(`Would add ${toAdd.length}: ${toAdd.map(t => t.name).join(', ')}\n`);

if (!APPLY) {
  console.log('DRY RUN — nothing written. Re-run with --apply.');
  await mongoose.disconnect();
  process.exit(0);
}

if (toAdd.length) {
  const created = await RelationshipType.insertMany(toAdd.map(t => ({ ...t, workspaceId: ws._id })));
  console.log(`Added ${created.length}.`);
} else {
  console.log('Nothing to add.');
}

const total = await RelationshipType.countDocuments({ workspaceId: ws._id });
console.log(`Workspace now has ${total}.`);
await mongoose.disconnect();
