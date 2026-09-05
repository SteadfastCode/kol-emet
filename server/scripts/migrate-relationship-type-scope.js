/**
 * Migration: give every RelationshipType a `scope` of 'group' or 'member'.
 *
 * Scope is inferred from how each name is ACTUALLY used in the workspace's
 * relationship groups — whether it appears as a group label or as a member
 * label — rather than guessed from the word itself. Names used in neither
 * position fall back to the template's classification, then to 'member',
 * which is the larger vocabulary and the schema default.
 *
 * Dry-run by default; pass --apply to write. Safe to re-run.
 *
 * Run: node --env-file=.env scripts/migrate-relationship-type-scope.js [--apply]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const APPLY = process.argv.includes('--apply');
if (!process.env.MONGO_URI) { console.error('MONGO_URI not set'); process.exit(1); }

await mongoose.connect(process.env.MONGO_URI);
console.log(`Connected${APPLY ? '' : '  (DRY RUN — pass --apply to write)'}\n`);

const { default: RelationshipType } = await import('../src/models/RelationshipType.js');
const { default: RelationshipGroup } = await import('../src/models/RelationshipGroup.js');
const { TEMPLATES } = await import('../src/config/templates.js');

const templateScope = new Map(
  TEMPLATES.worldbuilding.relationshipTypes.map(t => [t.name.toLowerCase(), t.scope])
);

const types = await RelationshipType.find({}).lean();
console.log(`${types.length} relationship type(s) to classify\n`);

// Observed usage, per workspace.
const groups = await RelationshipGroup.find({}).select('workspaceId label members').lean();
const usage = new Map(); // workspaceId -> { groupLabels:Set, memberLabels:Set }
for (const g of groups) {
  const k = String(g.workspaceId);
  if (!usage.has(k)) usage.set(k, { groupLabels: new Set(), memberLabels: new Set() });
  const u = usage.get(k);
  if (g.label) u.groupLabels.add(g.label.toLowerCase());
  for (const m of g.members ?? []) if (m.label) u.memberLabels.add(m.label.toLowerCase());
}

const plan = [];
for (const t of types) {
  const u = usage.get(String(t.workspaceId)) ?? { groupLabels: new Set(), memberLabels: new Set() };
  const n = t.name.toLowerCase();

  let scope, why;
  const asGroup = u.groupLabels.has(n);
  const asMember = u.memberLabels.has(n);

  if (asGroup && !asMember)      { scope = 'group';  why = 'used as a group label'; }
  else if (asMember && !asGroup) { scope = 'member'; why = 'used as a member role'; }
  else if (asGroup && asMember)  { scope = 'group';  why = 'used BOTH ways — defaulting to group, review this'; }
  else if (templateScope.has(n)) { scope = templateScope.get(n); why = 'from template'; }
  else                           { scope = 'member'; why = 'unused and not in template — schema default'; }

  plan.push({ _id: t._id, name: t.name, from: t.scope ?? '(unset)', to: scope, why });
}

for (const p of plan) {
  const changed = p.from !== p.to ? ' *' : '';
  console.log(`  ${p.to.padEnd(6)} ${p.name.padEnd(16)} ${p.why}${changed}`);
}

const needed = plan.filter(p => p.from !== p.to);
console.log(`\n${needed.length} of ${plan.length} need updating.`);

const ambiguous = plan.filter(p => p.why.includes('review this'));
if (ambiguous.length) {
  console.log(`\nUsed in BOTH positions — worth a look: ${ambiguous.map(a => a.name).join(', ')}`);
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply.');
  await mongoose.disconnect();
  process.exit(0);
}

let n = 0;
for (const p of needed) {
  await RelationshipType.updateOne({ _id: p._id }, { $set: { scope: p.to } });
  n++;
}
console.log(`\nUpdated ${n}.`);
await mongoose.disconnect();
