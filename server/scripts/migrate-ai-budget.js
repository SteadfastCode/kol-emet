/**
 * Migration: the AI allowance moves from the workspace to the account (KOL-132)
 *
 * `aiBudget` used to be a field on `Workspace`, which meant every
 * `POST /workspaces` minted a fresh $3.50 of real provider money. It now lives
 * on `User`, and every workspace meters against its owner's pot
 * (src/lib/usageMeter.js). This folds the old per-workspace state forward:
 *
 *   1. Each owner's `User.aiBudget.spentMicros` gains the spend recorded on the
 *      workspaces they own, so moving the pot does not forgive what was spent.
 *   2. Each owner's `User.aiBudget.grantedMicros` is filled in from
 *      `AI_TRIAL_GRANT_MICROS` where it is missing. One grant per account —
 *      deliberately NOT the sum of their workspaces' grants, which is the very
 *      multiplication this change exists to undo.
 *   3. The now-unread `aiBudget` is `$unset` from the workspace documents,
 *      which is also what makes this **safe to re-run**: a second pass finds
 *      nothing left to fold and adds nothing.
 *
 * Spend is summed over the RAW collection, not through the model — the schema
 * no longer declares `aiBudget` on `Workspace`, so Mongoose would strip it from
 * a hydrated read and every account would migrate as having spent nothing.
 *
 * Workspaces whose `ownerId` names no surviving account are reported and left
 * alone: there is no account to charge, and `usageMeter` already reads such a
 * workspace as exhausted rather than as free.
 *
 * Dry-run by default; pass --apply to write.
 *
 * Run: node --env-file=.env scripts/migrate-ai-budget.js [--apply]
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

await mongoose.connect(MONGO_URI);
console.log(`Connected to MongoDB${APPLY ? '' : '  (DRY RUN — pass --apply to write)'}\n`);

const { default: User }      = await import('../src/models/User.js');
const { default: Workspace } = await import('../src/models/Workspace.js');
const { trialGrantMicros, formatMicros } = await import('../src/config/pricing.js');

const TRIAL = trialGrantMicros();
console.log(`Account grant: ${formatMicros(TRIAL)} (source: AI_TRIAL_GRANT_MICROS)\n`);

// Raw read: the model no longer knows this field exists.
const carriers = await Workspace.collection
  .find({ aiBudget: { $exists: true } }, { projection: { ownerId: 1, name: 1, aiBudget: 1 } })
  .toArray();

console.log(`--- step 1: workspaces still carrying an aiBudget ---`);
console.log(`  ${carriers.length} found`);

/** @type {Map<string, { spentMicros: number, grantedMicros: number, workspaces: string[] }>} */
const byOwner = new Map();
let unowned = 0;

for (const ws of carriers) {
  const spent = Number(ws.aiBudget?.spentMicros) || 0;
  const granted = Number(ws.aiBudget?.grantedMicros) || 0;
  if (!ws.ownerId) {
    unowned += 1;
    console.log(`  ! workspace ${ws._id} "${ws.name ?? '?'}" has no ownerId; ${formatMicros(spent)} of spend cannot be attributed`);
    continue;
  }
  const key = String(ws.ownerId);
  const acc = byOwner.get(key) ?? { spentMicros: 0, grantedMicros: 0, workspaces: [] };
  acc.spentMicros += spent;
  acc.grantedMicros += granted;
  acc.workspaces.push(String(ws._id));
  byOwner.set(key, acc);
}

console.log(`\n--- step 2: fold into the owning accounts ---`);
console.log(`  ${byOwner.size} account(s) to touch${unowned ? `, ${unowned} unowned workspace(s) skipped` : ''}`);

let missingAccounts = 0;

for (const [ownerId, acc] of byOwner) {
  const user = await User.findById(ownerId).select('email aiBudget').lean();
  if (!user) {
    missingAccounts += 1;
    console.log(`  ! account ${ownerId} no longer exists; ${formatMicros(acc.spentMicros)} across ${acc.workspaces.length} workspace(s) left where it is`);
    continue;
  }

  const hasGrant = Number.isFinite(user.aiBudget?.grantedMicros);
  const alreadySpent = Number(user.aiBudget?.spentMicros) || 0;
  const multiplied = acc.grantedMicros > TRIAL
    ? `  (its workspaces held ${formatMicros(acc.grantedMicros)} of grants between them — collapsing to one)`
    : '';

  console.log(
    `  ${APPLY ? '+' : '~'} ${user.email}: spent ${formatMicros(alreadySpent)} + ${formatMicros(acc.spentMicros)} from ${acc.workspaces.length} workspace(s)` +
    `, grant ${hasGrant ? `${formatMicros(user.aiBudget.grantedMicros)} (kept)` : `${formatMicros(TRIAL)} (filled in)`}${multiplied}`
  );

  if (!APPLY) continue;

  const update = { $inc: { 'aiBudget.spentMicros': acc.spentMicros } };
  if (!hasGrant) update.$set = { 'aiBudget.grantedMicros': TRIAL };
  await User.updateOne({ _id: user._id }, update);

  // Only now, so a crash between the two leaves the spend to be folded again
  // rather than dropped. Re-running then double-counts for that one account,
  // which is the recoverable direction: over-charging a trial budget is a
  // support question, under-metering is real money.
  const { modifiedCount } = await Workspace.collection.updateMany(
    { _id: { $in: acc.workspaces.map(id => new mongoose.Types.ObjectId(id)) } },
    { $unset: { aiBudget: '' } }
  );
  console.log(`      cleared aiBudget from ${modifiedCount} workspace document(s)`);
}

console.log(`\n--- step 3: accounts with no budget at all ---`);
const ungranted = await User.collection.countDocuments({ 'aiBudget.grantedMicros': { $exists: false } });
console.log(`  ${ungranted} account(s) have no stored grant`);
if (ungranted) {
  if (APPLY) {
    const { modifiedCount } = await User.collection.updateMany(
      { 'aiBudget.grantedMicros': { $exists: false } },
      { $set: { 'aiBudget.grantedMicros': TRIAL } }
    );
    console.log(`  + filled in ${formatMicros(TRIAL)} for ${modifiedCount} account(s)`);
  } else {
    console.log(`  ~ would be filled in with ${formatMicros(TRIAL)} each`);
  }
  // usageMeter reads a missing grant as the trial anyway, so this is tidiness
  // rather than a fix — it makes the stored state say what the code assumes.
}

if (missingAccounts) {
  console.log(`\n${missingAccounts} account(s) referenced by a workspace no longer exist. Those workspaces still carry an aiBudget and nothing reads it; delete them, or reassign ownerId, before re-running.`);
}

console.log(`\nDone.${APPLY ? '' : ' Nothing was written — pass --apply.'}`);
await mongoose.disconnect();
