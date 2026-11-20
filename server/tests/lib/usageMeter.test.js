/**
 * The AI allowance is one pot per ACCOUNT, not one per workspace (KOL-132).
 *
 * `aiBudget` used to be a field on `Workspace` with a schema default of
 * `AI_TRIAL_GRANT_MICROS`, and for as long as `POST /auth/register` was the
 * only thing in the product that had ever created a workspace that was a
 * perfectly good way to say "one allowance per account": every account had
 * exactly one workspace, for life, and the signup ceiling (KOL-050, KOL-081)
 * bounded how many of those an address could mint.
 *
 * `POST /workspaces` (KOL-123) ended that silently. It is an authenticated
 * create loop capped at `WORKSPACE_MAX_PER_OWNER` (10), the cap was reasoned
 * about as the cost of a template *seed*, and nothing in it zeroed the pot — so
 * any logged-in user could mint ten full allowances with ten cheap
 * `template: null` creates and spend ten times the real provider money the
 * trial exists to cap. That is the thing this file is here to keep closed, and
 * it is stated below in the shape it actually mattered in: not "the field is
 * absent" but **ten workspaces still read one $3.50**.
 *
 * No per-workspace pot can be made safe, which is why the fix was a move and
 * not a guard: whatever a new workspace is granted, a user may have ten of it,
 * and copying the owner's *remaining* balance into each new workspace
 * multiplies it just as well. So it lives on `User`, the one document an
 * account has exactly one of, and `lib/usageMeter.js` does an `ownerId` hop so
 * that every call site still passes the `workspaceId` a request actually has.
 *
 * What is asserted here, beyond the pooling:
 *
 *   - **The owner pays, not the caller.** A collaborator invited into someone
 *     else's workspace (KOL-124) spends the owner's allowance — charging the
 *     caller would hand anybody who accepts ten invitations ten allowances,
 *     the same hole wearing a different hat.
 *   - **A missing grant reads as the trial, not as zero.** Two real documents
 *     have `aiBudget` with no `grantedMicros` in it: an account registered
 *     before this change, and any account whose subdocument was created by
 *     `recordSpend`'s `$inc`. Both are read with `.lean()`, which does not
 *     apply schema defaults, so reading a missing grant as zero would lock
 *     every existing account out of the product the moment this shipped.
 *   - **An unresolvable account reads as exhausted.** No workspace, no
 *     `ownerId`, or a deleted owner — all refuse, none spend.
 *   - **The generation lock is per account too**, because the pot is. A lock
 *     held per workspace caps the overshoot at one run per workspace, which
 *     against a shared pot is ten runs for a user with ten workspaces.
 *   - **Charges are atomic.** `$inc`, so concurrent calls cannot lose spend
 *     against each other.
 *
 * Falsification: put `aiBudget` back on `Workspace` and the ten-workspace case
 * reports ten allowances; charge `recordSpend` to the acting member instead of
 * `ownerId` and the collaborator case double-grants; drop the
 * `Number.isFinite` fallback in `getAccountBudget` and the two
 * no-stored-grant cases come back exhausted; move the lock back onto the
 * workspace and the second-workspace claim succeeds; swap the `$inc` for a
 * read-then-set and the concurrent-charge total comes up short.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_USAGE_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture and per budget read, naming the account the
 *             workspace resolved to (the hop is the thing that can break)
 *   normal  — light, plus every charge and lock claim
 *   verbose — normal, plus the stored aiBudget after each write
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import * as db from '../helpers/db.js';

// Set before the models are imported, and read per call by `trialGrantMicros()`
// in both the schema default and usageMeter's fallback. A distinctive number,
// so an assertion cannot pass against the $3.50 literal by coincidence.
const TRIAL = 1_000_000;
process.env.AI_TRIAL_GRANT_MICROS = String(TRIAL);

const { default: User } = await import('../../src/models/User.js');
const { default: Workspace } = await import('../../src/models/Workspace.js');
const {
  getBudget, getAccountBudget, checkBudget, recordSpend,
  ownerOf, reserveGeneration, releaseGeneration,
} = await import('../../src/lib/usageMeter.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };
function log(level, msg) {
  const active = LEVELS[process.env.TEST_USAGE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/usageMeter:${level}] ${msg}`);
}

const oid = () => new mongoose.Types.ObjectId();

/** An account. No bcrypt: nothing here verifies a password. */
async function account(email) {
  const user = await User.create({ email, passwordHash: `not-a-hash-${email}` });
  log('light', `account ${user._id} (${email}) granted ${user.aiBudget.grantedMicros} micros (source: User schema default, AI_TRIAL_GRANT_MICROS=${TRIAL})`);
  return user;
}

/** A workspace owned by `user`, exactly as `createWorkspace()` writes one. */
async function workspaceOf(user, name = 'ws') {
  const ws = await Workspace.create({
    name,
    ownerId: user._id,
    members: [{ userId: user._id, role: 'owner' }],
  });
  log('light', `workspace ${ws._id} "${name}" owned by account ${user._id}; stored aiBudget: ${JSON.stringify(ws.toObject().aiBudget ?? null)}`);
  return ws;
}

/** The stored budget subdocument, as the database holds it. */
async function stored(userId) {
  const raw = await User.collection.findOne({ _id: userId }, { projection: { aiBudget: 1 } });
  log('verbose', `stored aiBudget for ${userId}: ${JSON.stringify(raw?.aiBudget ?? null)}`);
  return raw?.aiBudget ?? null;
}

/**
 * A charge of a known size. `steadfast` is priced from electricity and is the
 * cheapest thing in the table, so the token counts are picked to land a
 * recognisable number of micros rather than to be realistic.
 */
async function charge(workspaceId, { promptTokens = 0, completionTokens = 1_000_000, reason = 'test' } = {}) {
  const result = await recordSpend(workspaceId, {
    provider: 'steadfast', model: 'local', promptTokens, completionTokens, reason,
  });
  log('normal', `charged ${result.micros} micros to workspace ${workspaceId} (charged: ${result.charged})`);
  return result;
}

before(async () => { await db.connect(); });
beforeEach(async () => { await db.clear(); });
after(async () => { await db.disconnect(); });

describe('where the allowance lives', () => {
  test('a new account holds the trial grant, spent nothing, unlocked', async () => {
    const user = await account('fresh@example.test');
    const budget = await getAccountBudget(user._id, 'this test');

    assert.equal(budget.grantedMicros, TRIAL);
    assert.equal(budget.spentMicros, 0);
    assert.equal(budget.remainingMicros, TRIAL);
    assert.equal(budget.exhausted, false);
    assert.equal((await stored(user._id)).generatingSince, null);
  });

  test('a new workspace is granted nothing of its own', async () => {
    const user = await account('nothing@example.test');
    const ws = await workspaceOf(user);

    const raw = await Workspace.collection.findOne({ _id: ws._id });
    assert.equal(raw.aiBudget, undefined, 'a workspace that carries a pot is a pot that can be minted again');
  });

  test('a forged aiBudget on a create is not stored', async () => {
    // What `POST /workspaces` would be handed by a caller who had read the old
    // schema. Mongoose strips an undeclared path; this asserts it stays
    // undeclared, which is the only reason the route can stop worrying about it.
    const user = await account('forged@example.test');
    const ws = await Workspace.create({
      name: 'forged', ownerId: user._id, members: [{ userId: user._id, role: 'owner' }],
      aiBudget: { grantedMicros: 999_000_000, spentMicros: 0 },
    });

    const raw = await Workspace.collection.findOne({ _id: ws._id });
    assert.equal(raw.aiBudget, undefined);
    assert.equal((await getBudget(ws._id)).grantedMicros, TRIAL, 'the allowance is not the caller\'s to set');
  });
});

describe('one pot, read through any of an account\'s workspaces', () => {
  test('two workspaces of one owner read the same allowance', async () => {
    const user = await account('two@example.test');
    const first = await workspaceOf(user, 'first');
    const second = await workspaceOf(user, 'second');

    const a = await getBudget(first._id);
    const b = await getBudget(second._id);
    assert.deepEqual(a, b);
    assert.equal(a.grantedMicros, TRIAL);
  });

  test('spend through one workspace is spend in the other', async () => {
    const user = await account('shared@example.test');
    const first = await workspaceOf(user, 'first');
    const second = await workspaceOf(user, 'second');

    const { micros } = await charge(first._id);
    assert.ok(micros > 0, 'the fixture must actually cost something');

    const seenFromSecond = await getBudget(second._id);
    assert.equal(seenFromSecond.spentMicros, micros);
    assert.equal(seenFromSecond.remainingMicros, TRIAL - micros);
  });

  test('ten workspaces — the cap — still read one allowance', async () => {
    // The regression, in the units it mattered in. Before KOL-132 this read
    // 10 * TRIAL of grant, which is ~10x the intended paid-provider spend per
    // account for the price of ten cheap `template: null` creates.
    const user = await account('cap@example.test');
    const workspaces = [];
    for (let i = 0; i < 10; i += 1) workspaces.push(await workspaceOf(user, `ws-${i}`));

    const budgets = await Promise.all(workspaces.map(ws => getBudget(ws._id)));
    const totalGranted = budgets.reduce((sum, b) => sum + b.grantedMicros, 0);

    for (const b of budgets) assert.equal(b.grantedMicros, TRIAL);
    assert.equal(
      totalGranted, 10 * TRIAL,
      'ten reads of one pot report it ten times — the sum is only here to name the number that used to be ten DIFFERENT pots'
    );

    // And the pot itself: one grant, in one place, however many workspaces.
    assert.equal((await stored(user._id)).grantedMicros, TRIAL);
    assert.equal(await Workspace.collection.countDocuments({ aiBudget: { $exists: true } }), 0);
  });

  test('exhausting the allowance in one workspace exhausts it in all of them', async () => {
    const user = await account('exhaust@example.test');
    const first = await workspaceOf(user, 'first');
    const second = await workspaceOf(user, 'second');

    await User.updateOne({ _id: user._id }, { $set: { 'aiBudget.spentMicros': TRIAL } });

    for (const ws of [first, second]) {
      const check = await checkBudget(ws._id);
      assert.equal(check.exhausted, true);
      assert.equal(check.allowed, false, 'a new workspace must not be a way around an exhausted allowance');
    }
  });

  test('another account\'s allowance is untouched by this one\'s spend', async () => {
    const mine = await account('mine@example.test');
    const theirs = await account('theirs@example.test');
    const myWs = await workspaceOf(mine, 'mine');
    const theirWs = await workspaceOf(theirs, 'theirs');

    await charge(myWs._id);

    assert.equal((await getBudget(theirWs._id)).spentMicros, 0);
    assert.ok((await getBudget(myWs._id)).spentMicros > 0);
  });
});

describe('who pays', () => {
  test('the owner pays, not the member doing the spending', async () => {
    const owner = await account('owner@example.test');
    const collaborator = await account('collaborator@example.test');
    const ws = await Workspace.create({
      name: 'shared', ownerId: owner._id,
      members: [{ userId: owner._id, role: 'owner' }, { userId: collaborator._id, role: 'editor' }],
    });

    await charge(ws._id, { reason: 'the editor generating' });

    assert.ok((await getAccountBudget(owner._id)).spentMicros > 0, 'the owner agreed to this spend by inviting them');
    assert.equal(
      (await getAccountBudget(collaborator._id)).spentMicros, 0,
      'charging the caller would make ten accepted invitations into ten allowances'
    );
  });

  test('ownerOf names the owning account, and nothing when it cannot', async () => {
    const user = await account('resolve@example.test');
    const ws = await workspaceOf(user);

    assert.equal(String(await ownerOf(ws._id)), String(user._id));
    assert.equal(await ownerOf(oid()), null, 'no such workspace');
  });
});

describe('a missing stored grant reads as the trial', () => {
  test('an account whose aiBudget was created by a charge still has its allowance', async () => {
    // Exactly the document `recordSpend`'s `$inc` leaves behind on an account
    // that predates the field: an `aiBudget` holding `spentMicros` and nothing
    // else. `.lean()` applies no schema default, so reading this as a zero
    // grant would lock the account out of the product on deploy.
    const user = await account('incremented@example.test');
    const ws = await workspaceOf(user);
    await User.collection.updateOne({ _id: user._id }, { $unset: { aiBudget: '' } });
    await User.collection.updateOne({ _id: user._id }, { $inc: { 'aiBudget.spentMicros': 250 } });

    const raw = await stored(user._id);
    assert.equal(raw.grantedMicros, undefined, 'the fixture must actually lack a stored grant');

    const budget = await getBudget(ws._id);
    assert.equal(budget.grantedMicros, TRIAL);
    assert.equal(budget.spentMicros, 250);
    assert.equal(budget.exhausted, false);
    assert.equal((await checkBudget(ws._id)).allowed, true);
  });

  test('an account with no aiBudget at all still has its allowance', async () => {
    const user = await account('pre-field@example.test');
    const ws = await workspaceOf(user);
    await User.collection.updateOne({ _id: user._id }, { $unset: { aiBudget: '' } });

    const budget = await getBudget(ws._id);
    assert.equal(budget.grantedMicros, TRIAL);
    assert.equal(budget.spentMicros, 0);
    assert.equal((await checkBudget(ws._id)).allowed, true);
  });
});

describe('an unresolvable account is exhausted, never unlimited', () => {
  test('a workspace that does not exist', async () => {
    const check = await checkBudget(oid());
    assert.equal(check.grantedMicros, 0);
    assert.equal(check.exhausted, true);
    assert.equal(check.allowed, false);
  });

  test('a workspace whose owner account is gone', async () => {
    const user = await account('deleted@example.test');
    const ws = await workspaceOf(user);
    await User.deleteOne({ _id: user._id });

    const check = await checkBudget(ws._id);
    assert.equal(check.exhausted, true);
    assert.equal(check.allowed, false);
  });

  test('a charge against one is reported unattributed rather than swallowed', async () => {
    const result = await charge(oid());
    assert.ok(result.micros > 0, 'the money was still spent');
    assert.equal(result.charged, false);
    assert.equal(result.unattributed, true);
  });

  test('a free call is not charged and needs no account', async () => {
    const result = await recordSpend(oid(), {
      provider: 'steadfast', model: 'local', promptTokens: 0, completionTokens: 0, reason: 'nothing',
    });
    assert.equal(result.micros, 0);
    assert.equal(result.charged, false);
  });
});

describe('charges are atomic', () => {
  test('concurrent charges all land', async () => {
    const user = await account('concurrent@example.test');
    const ws = await workspaceOf(user);

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => charge(ws._id, { completionTokens: 100_000, reason: `parallel ${i}` }))
    );
    const expected = results.reduce((sum, r) => sum + r.micros, 0);

    assert.ok(expected > 0);
    assert.equal(
      (await getBudget(ws._id)).spentMicros, expected,
      'a read-modify-write would lose charges against itself here'
    );
  });
});

describe('checkBudget\'s minimum floor', () => {
  test('refuses a run that certainly costs more than what is left', async () => {
    const user = await account('floor@example.test');
    const ws = await workspaceOf(user);
    await User.updateOne({ _id: user._id }, { $set: { 'aiBudget.spentMicros': TRIAL - 10 } });

    assert.equal((await checkBudget(ws._id, 1_000)).allowed, false, '10 micros left, a 1000-micro floor');
    assert.equal((await checkBudget(ws._id, 0)).allowed, true, 'but it is not exhausted');
  });
});

describe('the generation lock is per account', () => {
  test('a second workspace of the same owner cannot claim it', async () => {
    const user = await account('lock@example.test');
    const first = await workspaceOf(user, 'first');
    const second = await workspaceOf(user, 'second');

    assert.equal(await reserveGeneration(first._id), true);
    assert.equal(
      await reserveGeneration(second._id), false,
      'one run at a time per pot; a per-workspace lock would allow ten overshoots of one allowance'
    );

    await releaseGeneration(second._id);
    assert.equal(await reserveGeneration(first._id), true, 'released from either workspace, since it is one lock');
  });

  test('another account is not blocked by it', async () => {
    const mine = await account('lock-mine@example.test');
    const theirs = await account('lock-theirs@example.test');
    const myWs = await workspaceOf(mine);
    const theirWs = await workspaceOf(theirs);

    assert.equal(await reserveGeneration(myWs._id), true);
    assert.equal(await reserveGeneration(theirWs._id), true);
  });

  test('a lock left behind by a crash goes stale after ten minutes', async () => {
    const user = await account('stale@example.test');
    const ws = await workspaceOf(user);

    await User.updateOne(
      { _id: user._id },
      { $set: { 'aiBudget.generatingSince': new Date(Date.now() - 11 * 60 * 1000) } }
    );
    assert.equal(await reserveGeneration(ws._id), true, 'a crash must not lock an account out permanently');

    // And a fresh one does not.
    assert.equal(await reserveGeneration(ws._id), false);
  });

  test('a workspace with no account cannot claim it', async () => {
    assert.equal(await reserveGeneration(oid()), false);
  });
});
