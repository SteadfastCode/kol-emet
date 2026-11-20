/**
 * Charges AI spend against the budget of the **account that owns** a workspace.
 *
 * Every function here still takes a `workspaceId`, because that is what a
 * request has, and resolves the owning account itself — the pot moved to
 * `User.aiBudget` in KOL-132 (see models/User.js: a pot on the workspace is
 * minted again by every `POST /workspaces`), and doing the hop in one place
 * kept the four call sites — routes/chat.js, routes/drafts.js and
 * lib/memoryExtractor.js — unchanged.
 *
 * Three properties matter more than precision here:
 *
 *  1. Spend is recorded ATOMICALLY ($inc), never read-modify-write, so
 *     concurrent calls cannot lose charges against each other.
 *  2. Cost is only knowable AFTER a call returns, so the budget can always be
 *     overshot by at most the calls already in flight. Callers that can spend a
 *     lot in one go (generation) must therefore also hold a concurrency lock —
 *     see reserveGeneration below. Cheap per-message callers (chat, memory
 *     extraction) can overshoot by a fraction of a cent and are left unlocked.
 *  3. Every failure to resolve an account reads as EXHAUSTED, not as unlimited.
 *     A workspace with no document, or one whose owner's account is gone, gets
 *     a zero budget and is refused — the direction that cannot spend money on
 *     behalf of nobody.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * USAGE_LOG_LEVEL = off | light | normal (default light)
 *   light  — every charge and every refusal, each naming the workspace it came
 *            from AND the account it landed on, since those are now two
 *            different ids and "the budget moved" is the bug class to catch.
 *   normal — light, plus free-at-point-of-use calls and lock traffic.
 */

import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import { costMicros, isEstimatedPrice, formatMicros, trialGrantMicros } from '../config/pricing.js';

const LEVELS = { off: 0, light: 1, normal: 2 };
function log(level, msg) {
  const active = LEVELS[process.env.USAGE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[usage:${level}] ${msg}`);
}

/**
 * The account a workspace's AI spend is charged to: its `ownerId`.
 *
 * The owner rather than the caller, deliberately. A collaborator invited into
 * someone else's workspace (KOL-124) spends money that workspace's owner
 * agreed to spend — and charging the caller would hand anybody who accepts ten
 * invitations ten allowances, which is the same hole in a different shape.
 *
 * `ownerId` rather than the `owner` role in `members`, because it is the single
 * field a workspace has exactly one of; `lib/ownerFloor.js` is what keeps the
 * two in step when ownership moves.
 *
 * @returns {Promise<import('mongoose').Types.ObjectId|null>} null when there is
 *   no such workspace, or it carries no owner
 */
export async function ownerOf(workspaceId) {
  const ws = await Workspace.findById(workspaceId).select('ownerId').lean();
  if (!ws) {
    log('light', `no account for workspace ${workspaceId}: no such workspace (source: ownerOf)`);
    return null;
  }
  if (!ws.ownerId) {
    log('light', `no account for workspace ${workspaceId}: it carries no ownerId (source: ownerOf)`);
    return null;
  }
  return ws.ownerId;
}

/** The read shape every budget function answers in. Unchanged since KOL-098. */
function budgetBody(grantedMicros, spentMicros) {
  const remainingMicros = Math.max(0, grantedMicros - spentMicros);
  return {
    grantedMicros,
    spentMicros,
    remainingMicros,
    exhausted: spentMicros >= grantedMicros,
    granted: formatMicros(grantedMicros),
    spent: formatMicros(spentMicros),
    remaining: formatMicros(remainingMicros),
  };
}

/**
 * Current budget state for an account.
 *
 * A missing `grantedMicros` reads as the trial grant, not as zero: accounts
 * registered before KOL-132 have no `aiBudget` at all, and `recordSpend`'s
 * `$inc` creates the subdocument holding nothing but `spentMicros`. Both are
 * read with `.lean()`, which does not apply schema defaults, so the fallback
 * here is load-bearing rather than belt-and-braces.
 *
 * A missing *account* is a different thing and reads as exhausted.
 */
export async function getAccountBudget(ownerId, source = 'unspecified caller') {
  const user = ownerId ? await User.findById(ownerId).select('aiBudget').lean() : null;
  if (!user) {
    log('light', `account ${ownerId ?? 'unresolved'} has no budget — treating as exhausted (source: ${source}; an account that does not exist cannot be spent on)`);
    return budgetBody(0, 0);
  }

  const stored = user.aiBudget?.grantedMicros;
  const granted = Number.isFinite(stored) ? stored : trialGrantMicros();
  if (!Number.isFinite(stored)) {
    log('light', `account ${ownerId} has no stored grant — reading it as the trial ${formatMicros(granted)} (source: ${source}; AI_TRIAL_GRANT_MICROS, for an account that predates the field or whose subdocument was made by a spend)`);
  }
  return budgetBody(granted, user.aiBudget?.spentMicros ?? 0);
}

/**
 * Current budget state for the account owning `workspaceId`.
 *
 * Shared across every workspace that account owns, which is the point: this is
 * one pot, read through whichever workspace the caller happens to be acting in.
 */
export async function getBudget(workspaceId) {
  const ownerId = await ownerOf(workspaceId);
  return getAccountBudget(ownerId, `workspace ${workspaceId}`);
}

/**
 * Records spend. Always charges, even past the limit — the call already
 * happened and the money is already gone; hiding that would make the ledger
 * lie. Enforcement is the caller's job, before the call.
 */
export async function recordSpend(workspaceId, { provider, model, promptTokens, completionTokens, reason }) {
  const micros = costMicros({ provider, model, promptTokens, completionTokens });
  if (micros <= 0) {
    log('normal', `${reason}: ${provider}/${model} is free at point of use — not charged`);
    return { micros: 0, charged: false };
  }

  const ownerId = await ownerOf(workspaceId);
  if (!ownerId) {
    // Nothing to charge and nothing to be done about it — but it must be
    // visible, because it means real money was spent against no ledger.
    log('light', `${reason}: ${formatMicros(micros)} NOT charged — workspace ${workspaceId} resolves to no account (source: ${provider}/${model}; the spend happened and is unrecorded)`);
    return { micros, charged: false, unattributed: true };
  }

  await User.updateOne({ _id: ownerId }, { $inc: { 'aiBudget.spentMicros': micros } });

  const estimated = isEstimatedPrice(provider, model) ? ' (estimated — model not in price table)' : '';
  log('light', `${reason}: ${formatMicros(micros)} charged to account ${ownerId} (source: workspace ${workspaceId} via ${provider}/${model})${estimated}`);
  return { micros, charged: true, estimated: isEstimatedPrice(provider, model) };
}

/**
 * Gate before a paid call. `minimumMicros` is a floor, not a prediction: a
 * workspace with a fraction of a cent left should not be allowed to start a
 * run that certainly costs more.
 */
export async function checkBudget(workspaceId, minimumMicros = 0) {
  const budget = await getBudget(workspaceId);
  return {
    ...budget,
    allowed: budget.remainingMicros > 0 && budget.remainingMicros >= minimumMicros,
  };
}

/**
 * Concurrency lock for generation.
 *
 * Cost is unknown until a run finishes, so N simultaneous requests would all
 * pass the same budget check and spend N times the allowance. Holding a lock
 * caps the overshoot at a single run. Implemented as a conditional update on
 * the owning **account** so the check and the claim are one atomic operation —
 * a findOne-then-write would reintroduce the race it exists to close.
 *
 * On the account rather than the workspace (KOL-132) because the pot is: a
 * per-workspace lock against a shared pot caps the overshoot at one run per
 * workspace the owner has, which for ten workspaces is ten runs. The visible
 * consequence is that one account runs one generation at a time across all of
 * its workspaces, which is what a single allowance means.
 */
export async function reserveGeneration(workspaceId) {
  const STALE_MS = 10 * 60 * 1000; // matches the stuck-generation sweep
  const cutoff = new Date(Date.now() - STALE_MS);

  const ownerId = await ownerOf(workspaceId);
  if (!ownerId) {
    log('light', `refused the generation lock for workspace ${workspaceId}: it resolves to no account (source: reserveGeneration)`);
    return false;
  }

  const claimed = await User.findOneAndUpdate(
    {
      _id: ownerId,
      $or: [
        { 'aiBudget.generatingSince': null },
        { 'aiBudget.generatingSince': { $exists: false } },
        { 'aiBudget.generatingSince': { $lt: cutoff } }, // crashed mid-run
      ],
    },
    { $set: { 'aiBudget.generatingSince': new Date() } },
    { new: true }
  ).select('_id').lean();

  log('normal', `generation lock on account ${ownerId} ${claimed ? 'claimed' : 'already held'} (source: workspace ${workspaceId})`);
  return Boolean(claimed);
}

export async function releaseGeneration(workspaceId) {
  const ownerId = await ownerOf(workspaceId);
  if (!ownerId) {
    log('light', `could not release the generation lock for workspace ${workspaceId}: it resolves to no account (source: releaseGeneration)`);
    return;
  }
  await User.updateOne({ _id: ownerId }, { $set: { 'aiBudget.generatingSince': null } });
  log('normal', `generation lock on account ${ownerId} released (source: workspace ${workspaceId})`);
}
