/**
 * Bring a workspace's relationship vocabulary in line with the template.
 *
 *   - adds template entries the workspace is missing (with their scope)
 *   - fixes casing on entries that differ from the template only by case
 *   - never touches an entry the template does not know about
 *
 * Recasing is safe even for labels in active use: groups store labels as plain
 * strings, not references, so nothing points at a registry entry. The registry
 * is vocabulary, not a foreign key. Entries are matched case-insensitively, so
 * every rename here is a pure case change that aligns the vocabulary with the
 * casing the real group data already uses.
 *
 * Dry-run by default; pass --apply to write. Safe to re-run.
 *
 * Run: node --env-file=.env scripts/sync-relationship-vocabulary.js [--apply] [--owner <email>]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const APPLY = process.argv.includes('--apply');
const ownerIdx = process.argv.indexOf('--owner');
const OWNER_EMAIL = ownerIdx !== -1 ? process.argv[ownerIdx + 1] : null;

if (!process.env.MONGO_URI) { console.error('MONGO_URI not set'); process.exit(1); }

await mongoose.connect(process.env.MONGO_URI);
console.log(`Connected${APPLY ? '' : '  (DRY RUN — pass --apply to write)'}\n`);

const { default: User }              = await import('../src/models/User.js');
const { default: Workspace }         = await import('../src/models/Workspace.js');
const { default: RelationshipType }  = await import('../src/models/RelationshipType.js');
const { default: RelationshipGroup } = await import('../src/models/RelationshipGroup.js');
const { TEMPLATES }                  = await import('../src/config/templates.js');

const users = await User.find().select('email').sort({ createdAt: 1 }).lean();
let target;
if (OWNER_EMAIL) {
  target = users.find(u => u.email.toLowerCase() === OWNER_EMAIL.toLowerCase());
  if (!target) { console.error(`No user ${OWNER_EMAIL}`); await mongoose.disconnect(); process.exit(1); }
} else if (users.length === 1) {
  target = users[0];
  console.log(`Single user (${target.email}).`);
} else {
  console.error(`${users.length} users — pass --owner <email>. Refusing to guess.`);
  await mongoose.disconnect(); process.exit(1);
}

const ws = await Workspace.findOne({ 'members.userId': target._id }).lean();
if (!ws) { console.error('No workspace'); await mongoose.disconnect(); process.exit(1); }

// Labels genuinely in use — reported, so a recase of a live label is visible.
const groups = await RelationshipGroup.find({ workspaceId: ws._id }).select('label members').lean();
const inUse = new Set();
for (const g of groups) {
  if (g.label) inUse.add(g.label.toLowerCase());
  for (const m of g.members ?? []) if (m.label) inUse.add(m.label.toLowerCase());
}

const existing = await RelationshipType.find({ workspaceId: ws._id }).lean();
const byLower = new Map(existing.map(t => [t.name.toLowerCase(), t]));

const toAdd = [], toRecase = [], untouched = [];

for (const t of TEMPLATES.worldbuilding.relationshipTypes) {
  const hit = byLower.get(t.name.toLowerCase());
  if (!hit) { toAdd.push(t); continue; }
  // Entries are matched case-insensitively, so any difference here is a pure
  // case difference. Recasing is always safe and always an improvement: groups
  // store labels as plain strings, so nothing points at the registry entry, and
  // the template casing is the one the real group data already uses.
  if (hit.name !== t.name) {
    toRecase.push({ _id: hit._id, from: hit.name, to: t.name, scope: t.scope });
    if (inUse.has(hit.name.toLowerCase())) {
      untouched.push(`${hit.name} -> ${t.name} (this label is live in groups; recasing the vocabulary entry to match)`);
    }
  } else if (hit.scope !== t.scope) {
    toRecase.push({ _id: hit._id, from: hit.name, to: t.name, scope: t.scope });
  }
}

const templateLower = new Set(TEMPLATES.worldbuilding.relationshipTypes.map(t => t.name.toLowerCase()));
const custom = existing.filter(t => !templateLower.has(t.name.toLowerCase()));

console.log(`Workspace ${ws._id}: ${existing.length} existing, ${inUse.size} label(s) in active use\n`);

if (toAdd.length) {
  console.log(`ADD (${toAdd.length}):`);
  for (const t of toAdd) console.log(`  ${t.scope.padEnd(6)} ${t.name}`);
  console.log('');
}
if (toRecase.length) {
  console.log(`RENAME/RESCOPE (${toRecase.length}):`);
  for (const t of toRecase) console.log(`  ${t.from} -> ${t.to}  (${t.scope})`);
  console.log('');
}
if (untouched.length) {
  console.log(`NOTE — live labels being recased (${untouched.length}):`);
  for (const u of untouched) console.log(`  ${u}`);
  console.log('');
}
if (custom.length) {
  console.log(`YOUR OWN, not in the template — never modified (${custom.length}):`);
  console.log(`  ${custom.map(c => `${c.name} [${c.scope}]`).join(', ')}\n`);
}

if (!APPLY) {
  console.log('DRY RUN — nothing written. Re-run with --apply.');
  await mongoose.disconnect();
  process.exit(0);
}

if (toAdd.length) {
  await RelationshipType.insertMany(toAdd.map(t => ({ ...t, workspaceId: ws._id })));
  console.log(`Added ${toAdd.length}.`);
}
for (const t of toRecase) {
  await RelationshipType.updateOne({ _id: t._id }, { $set: { name: t.to, scope: t.scope } });
}
if (toRecase.length) console.log(`Renamed/rescoped ${toRecase.length}.`);

const finalAll = await RelationshipType.find({ workspaceId: ws._id }).select('scope').lean();
console.log(`\nWorkspace now has ${finalAll.length}: ` +
  `${finalAll.filter(t => t.scope === 'group').length} group, ` +
  `${finalAll.filter(t => t.scope === 'member').length} member.`);
await mongoose.disconnect();
