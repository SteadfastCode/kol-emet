/**
 * The owner guard's hooks, one write shape at a time (KOL-135).
 *
 * `lib/ownerGuard.js` promises that a document written after its owner is
 * deleted deletes itself. The promise is only as wide as the hooks it is made
 * of, and until KOL-135 those were `save` and `insertMany` — on the argument
 * that "an update to an existing document cannot bring back one that was
 * deleted". True of an update; not true of an *upsert*, which is the one
 * update that inserts. `POST /workspace/invites` upserts, deliberately, so a
 * re-invite is one row and not two — and it is the only path in the product
 * that creates a WorkspaceInvite. So the guard covered every shape except the
 * one a route uses, and tests/lib/accountDeleter.test.js passed because it
 * drove `create` and `insertMany`, the two shapes no route uses.
 *
 * This file asserts the hook at the plugin's own level, where the two halves
 * that are easy to get backwards are visible: an upsert is checked, and a
 * plain `findOneAndUpdate` is *not* — no owner lookup at all, because adding
 * one to every update in the codebase would buy nothing. Both are asserted by
 * counting calls to the owner model's `find`, which is the lookup itself.
 *
 * Falsification: drop the `upsert` test from the hook and every update grows a
 * lookup (two tests below go red); drop the hook and the late invite survives
 * pointing at a deleted workspace; read the row from the hook's result instead
 * of resolving it, and the route's `new: false` makes it null on exactly the
 * insert that needs checking.
 *
 * Logging shares the deleter's knob (ACCOUNT_DELETE_LOG_LEVEL); silenced here
 * unless it is set, for when a failure needs the trail.
 */

import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../helpers/db.js';
import { OwnerGoneError } from '../../src/lib/ownerGuard.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import WorkspaceInvite from '../../src/models/WorkspaceInvite.js';
import Conversation from '../../src/models/Conversation.js';

process.env.ACCOUNT_DELETE_LOG_LEVEL ??= 'off';

before(async () => { await db.connect(); });
beforeEach(async () => { await db.clear(); });
after(async () => { await db.disconnect(); });

/** An owner and a workspace they own, the state every invite below is written against. */
async function seedWorkspace() {
  const user = await User.create({ email: 'owner@example.test', passwordHash: 'not-a-real-hash' });
  const workspace = await Workspace.create({
    name: 'a workspace',
    ownerId: user._id,
    members: [{ userId: user._id, role: 'owner' }],
  });
  return { user, workspace };
}

/**
 * The upsert `POST /workspace/invites` performs, verbatim — same filter, same
 * `$set`, same options, `new: false` included. The options matter: `new: false`
 * is why the hook cannot read the written row out of the result.
 */
const upsertInvite = (workspaceId, email, role, invitedBy) => WorkspaceInvite.findOneAndUpdate(
  { workspaceId, email },
  { $set: { role, invitedBy } },
  { new: false, upsert: true, runValidators: true, setDefaultsOnInsert: true },
);

/** Runs `fn` with `model.find` counted, and returns how many times the guard looked an owner up. */
async function countingLookups(t, model, fn) {
  const spy = t.mock.method(model, 'find');
  try {
    await fn();
  } finally {
    spy.mock.restore();
  }
  return spy.mock.callCount();
}

describe('an upserting findOneAndUpdate is an insert, and is checked', () => {
  test('an invite upserted after its workspace is deleted deletes itself', async () => {
    const { user, workspace } = await seedWorkspace();
    await Workspace.deleteOne({ _id: workspace._id });

    await assert.rejects(
      upsertInvite(workspace._id, 'late-invitee@example.test', 'editor', user._id),
      (err) => {
        assert.ok(err instanceof OwnerGoneError, `expected OwnerGoneError, got ${err.name}: ${err.message}`);
        assert.deepEqual(err.missing, [String(workspace._id)]);
        return true;
      },
    );

    assert.equal(await WorkspaceInvite.countDocuments({}), 0, 'the invite deleted itself');
  });

  test('an invite upserted under a workspaceId that never existed deletes itself too', async () => {
    const { user } = await seedWorkspace();
    const strangerWorkspace = new Workspace({ name: 'never written', ownerId: user._id })._id;

    await assert.rejects(upsertInvite(strangerWorkspace, 'nobody@example.test', 'viewer', user._id), OwnerGoneError);
    assert.equal(await WorkspaceInvite.countDocuments({}), 0);
  });

  test('a first invite in a live workspace stands, after one owner lookup', async (t) => {
    const { user, workspace } = await seedWorkspace();

    const lookups = await countingLookups(t, Workspace, () =>
      upsertInvite(workspace._id, 'invitee@example.test', 'editor', user._id));

    assert.equal(lookups, 1, 'the insert was checked exactly once');
    const invites = await WorkspaceInvite.find({}).lean();
    assert.deepEqual(invites.map(i => [i.email, i.role]), [['invitee@example.test', 'editor']]);
  });

  test('a re-invite in a live workspace updates the waiting row rather than adding a second', async () => {
    const { user, workspace } = await seedWorkspace();

    const first = await upsertInvite(workspace._id, 'invitee@example.test', 'viewer', user._id);
    assert.equal(first, null, 'the first upsert inserted, so its pre-image is null');

    const before = await upsertInvite(workspace._id, 'invitee@example.test', 'owner', user._id);
    assert.ok(before, 'the second upsert matched the waiting invite');
    assert.equal(before.role, 'viewer', 'and its pre-image is the role being replaced');

    const invites = await WorkspaceInvite.find({}).lean();
    assert.equal(invites.length, 1, 'one row, not two');
    assert.equal(invites[0].role, 'owner');
  });

  test('an upsert that lands on a row whose workspace is already gone discards it', async () => {
    const { user, workspace } = await seedWorkspace();
    await upsertInvite(workspace._id, 'invitee@example.test', 'viewer', user._id);
    await Workspace.deleteOne({ _id: workspace._id });

    // Not the race the guard was built for — this row was already orphaned —
    // but the hook cannot tell an upsert that inserted from one that matched
    // (`new: false` makes the result null on exactly the insert), and deleting
    // a row that points at no workspace is the same answer either way.
    await assert.rejects(upsertInvite(workspace._id, 'invitee@example.test', 'owner', user._id), OwnerGoneError);
    assert.equal(await WorkspaceInvite.countDocuments({}), 0);
  });
});

describe('a plain findOneAndUpdate is not an insert, and is not checked', () => {
  test('updating an existing row runs no owner lookup', async (t) => {
    const { user, workspace } = await seedWorkspace();
    const invite = await upsertInvite(workspace._id, 'invitee@example.test', 'viewer', user._id)
      .then(() => WorkspaceInvite.findOne({ email: 'invitee@example.test' }));

    const lookups = await countingLookups(t, Workspace, () =>
      WorkspaceInvite.findOneAndUpdate({ _id: invite._id }, { $set: { role: 'editor' } }, { new: true }));

    assert.equal(lookups, 0, 'an update that cannot insert must not pay for an owner lookup');
    assert.equal((await WorkspaceInvite.findById(invite._id)).role, 'editor', 'and the update still landed');
  });

  test('an update that matches nothing runs no owner lookup and writes nothing', async (t) => {
    const { user, workspace } = await seedWorkspace();

    const lookups = await countingLookups(t, Workspace, () =>
      WorkspaceInvite.findOneAndUpdate(
        { workspaceId: workspace._id, email: 'nobody@example.test' },
        { $set: { role: 'editor', invitedBy: user._id } },
        { new: true },
      ));

    assert.equal(lookups, 0);
    assert.equal(await WorkspaceInvite.countDocuments({}), 0, 'no upsert, so no row');
  });
});

describe('a document with no owner id passes unchecked', () => {
  test('an upserted Conversation with a null workspaceId is checked by its user only', async (t) => {
    const { user } = await seedWorkspace();

    // Conversation carries both guards. A chat from before tenancy holds
    // workspaceId: null, which no workspace can be looked up for — so that
    // guard must skip it while the userId guard still runs.
    const workspaceLookups = await countingLookups(t, Workspace, async () => {
      const userLookups = await countingLookups(t, User, () =>
        Conversation.findOneAndUpdate(
          { userId: user._id, provider: 'test' },
          { $set: { model: 'test' } },
          { new: false, upsert: true, runValidators: true, setDefaultsOnInsert: true },
        ));
      assert.equal(userLookups, 1, 'the userId guard checked the owner that is there');
    });

    assert.equal(workspaceLookups, 0, 'a null workspaceId is nothing to look up');
    const conversations = await Conversation.find({}).lean();
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].workspaceId, null);
  });
});
