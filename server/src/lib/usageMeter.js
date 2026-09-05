/**
 * Charges AI spend against a workspace's budget.
 *
 * Two properties matter more than precision here:
 *
 *  1. Spend is recorded ATOMICALLY ($inc), never read-modify-write, so
 *     concurrent calls cannot lose charges against each other.
 *  2. Cost is only knowable AFTER a call returns, so the budget can always be
 *     overshot by at most the calls already in flight. Callers that can spend a
 *     lot in one go (generation) must therefore also hold a concurrency lock —
 *     see reserveGeneration below. Cheap per-message callers (chat, memory
 *     extraction) can overshoot by a fraction of a cent and are left unlocked.
 */

import Workspace from '../models/Workspace.js';
import { costMicros, isEstimatedPrice, formatMicros } from '../config/pricing.js';

const LEVELS = { off: 0, light: 1, normal: 2 };
function log(level, msg) {
  const active = LEVELS[process.env.USAGE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[usage:${level}] ${msg}`);
}

/** Current budget state for a workspace. */
export async function getBudget(workspaceId) {
  const ws = await Workspace.findById(workspaceId).select('aiBudget').lean();
  const granted = ws?.aiBudget?.grantedMicros ?? 0;
  const spent = ws?.aiBudget?.spentMicros ?? 0;
  return {
    grantedMicros: granted,
    spentMicros: spent,
    remainingMicros: Math.max(0, granted - spent),
    exhausted: spent >= granted,
    granted: formatMicros(granted),
    spent: formatMicros(spent),
    remaining: formatMicros(Math.max(0, granted - spent)),
  };
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

  await Workspace.updateOne({ _id: workspaceId }, { $inc: { 'aiBudget.spentMicros': micros } });

  const estimated = isEstimatedPrice(provider, model) ? ' (estimated — model not in price table)' : '';
  log('light', `${reason}: ${formatMicros(micros)} charged to ${workspaceId} via ${provider}/${model}${estimated}`);
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
 * the workspace so the check and the claim are one atomic operation — a
 * findOne-then-write would reintroduce the race it exists to close.
 */
export async function reserveGeneration(workspaceId) {
  const STALE_MS = 10 * 60 * 1000; // matches the stuck-generation sweep
  const cutoff = new Date(Date.now() - STALE_MS);

  const claimed = await Workspace.findOneAndUpdate(
    {
      _id: workspaceId,
      $or: [
        { 'aiBudget.generatingSince': null },
        { 'aiBudget.generatingSince': { $exists: false } },
        { 'aiBudget.generatingSince': { $lt: cutoff } }, // crashed mid-run
      ],
    },
    { $set: { 'aiBudget.generatingSince': new Date() } },
    { new: true }
  ).select('_id').lean();

  return Boolean(claimed);
}

export async function releaseGeneration(workspaceId) {
  await Workspace.updateOne({ _id: workspaceId }, { $set: { 'aiBudget.generatingSince': null } });
}
