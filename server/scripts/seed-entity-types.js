/**
 * Seeds the default entity types into every workspace that lacks them.
 *
 * For workspaces created before the EntityType registry existed (Phase 6 step
 * 1); workspaces registered since are seeded at signup. Adds only the template
 * types a workspace does not already have (exact name, case-insensitive), so a
 * re-run never duplicates — but it does restore a default a user has since
 * deleted, which is why this is a one-off backfill and not a boot step.
 *
 * Dry-run by default; pass --apply to write. Prints workspace ids only.
 *
 * Run: node --env-file=.env scripts/seed-entity-types.js [--apply]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const APPLY = process.argv.includes('--apply');

if (!process.env.MONGO_URI) {
  console.error('MONGO_URI not set');
  process.exit(1);
}

await mongoose.connect(process.env.MONGO_URI);
console.log(`Connected${APPLY ? '' : '  (DRY RUN — pass --apply to write)'}\n`);

const { default: Workspace } = await import('../src/models/Workspace.js');
const { seedEntityTypes }    = await import('../src/lib/workspaceSeeder.js');

const workspaces = await Workspace.find().select('_id').sort({ createdAt: 1 }).lean();
console.log(`Found ${workspaces.length} workspace(s)`);

let total = 0;
for (const ws of workspaces) {
  const names = await seedEntityTypes(ws._id, undefined, { apply: APPLY });
  total += names.length;
  if (names.length) console.log(`  + ${ws._id}: ${APPLY ? 'added' : 'would add'} ${names.join(', ')}`);
  else console.log(`  = ${ws._id}: already has every default`);
}

console.log(`\n${APPLY ? 'Added' : 'Would add'} ${total} entity type(s).`);
if (!APPLY) console.log('DRY RUN — nothing written. Re-run with --apply.');
await mongoose.disconnect();
