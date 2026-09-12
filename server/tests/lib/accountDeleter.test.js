/**
 * Account deletion against a real (in-memory) mongod.
 *
 * deleteAccount() is irreversible and spans every collection, so the central
 * assertion here is a whole-database diff rather than a per-model spot check:
 * after deleting tenant A, the database must equal the database before, minus
 * exactly A's documents. That one comparison proves both halves of the
 * contract — A is gone from every collection, and B is untouched down to the
 * field — and it keeps holding when a model is added, which a list of
 * per-model assertions would not.
 *
 * It is only as strong as the fixture, so the fixture puts a document for each
 * tenant in every collection a tenant can own, and a guard test fails if
 * WORKSPACE_SCOPED_MODELS stops matching the models that carry workspaceId.
 *
 * Deletion logs at 'light' by default; silenced here unless
 * ACCOUNT_DELETE_LOG_LEVEL is set, for when a failure needs the trail.
 */

import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

import mongoose from 'mongoose';

import * as db from '../helpers/db.js';
import { deleteAccount, WORKSPACE_SCOPED_MODELS } from '../../src/lib/accountDeleter.js';
import { OwnerGoneError } from '../../src/lib/ownerGuard.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import UserMemory from '../../src/models/UserMemory.js';
import Settings from '../../src/models/Settings.js';
import Entity from '../../src/models/Entity.js';
import RelationshipGroup from '../../src/models/RelationshipGroup.js';
import RelationshipType from '../../src/models/RelationshipType.js';
import EntityType from '../../src/models/EntityType.js';
import OpenQuestion from '../../src/models/OpenQuestion.js';
import Draft from '../../src/models/Draft.js';
import Conversation from '../../src/models/Conversation.js';
import ChangeLog from '../../src/models/ChangeLog.js';

process.env.ACCOUNT_DELETE_LOG_LEVEL ??= 'off';

/**
 * A tenant with a document in every collection it can own: its User and
 * Workspace, one row in each workspace-scoped model, a UserMemory, and a
 * pre-tenancy Conversation (workspaceId: null) reachable only through userId.
 */
async function seedTenant(label) {
  const user = await User.create({ email: `${label}@example.test`, passwordHash: 'not-a-real-hash' });
  const workspace = await Workspace.create({
    name: `${label}'s workspace`,
    ownerId: user._id,
    members: [{ userId: user._id, role: 'owner' }],
  });
  const workspaceId = workspace._id;

  const entity = await Entity.create({ title: `${label} entity`, category: 'Worlds', summary: 'fixture', workspaceId });
  await RelationshipGroup.create({ workspaceId, members: [{ refId: entity._id, refModel: 'Entity' }] });
  await RelationshipType.create({ name: `${label} ally`, workspaceId });
  await EntityType.create({ name: `${label} vehicles`, workspaceId });
  await OpenQuestion.create({ question: `Who is ${label}?`, entry_ids: [entity._id], workspaceId });
  await Draft.create({ workspaceId, createdBy: user._id, title: `${label} draft` });
  await Conversation.create({ workspaceId, userId: user._id, provider: 'test', model: 'test' });
  await ChangeLog.create({
    workspaceId,
    entityId: entity._id,
    entityTitle: entity.title,
    changeType: 'created',
    actorId: user._id,
    actorType: 'user',
    actorLabel: label,
  });

  await UserMemory.create({ userId: user._id, fact: `${label} rides the night train` });
  await Conversation.create({ workspaceId: null, userId: user._id, provider: 'test', model: 'test' });

  return { user, workspace };
}

/** Every document in every collection, as plain JSON so ObjectIds and Dates compare by value. */
async function snapshot() {
  const out = {};
  for (const collection of await mongoose.connection.db.collections()) {
    const docs = await collection.find().sort({ _id: 1 }).toArray();
    out[collection.collectionName] = JSON.parse(JSON.stringify(docs));
  }
  return out;
}

/** `snap` with every document belonging to `tenant` removed — by its own id, workspace or user. */
function without(snap, tenant) {
  const ids = new Set([String(tenant.user._id), String(tenant.workspace._id)]);
  return Object.fromEntries(
    Object.entries(snap).map(([name, docs]) => [
      name,
      docs.filter((d) => ![d._id, d.workspaceId, d.userId].some((v) => ids.has(v))),
    ])
  );
}

before(async () => { await db.connect(); });
beforeEach(async () => { await db.clear(); });
after(async () => { await db.disconnect(); });

test('WORKSPACE_SCOPED_MODELS lists every model that carries workspaceId', async () => {
  const dir = fileURLToPath(new URL('../../src/models/', import.meta.url));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    await import(pathToFileURL(join(dir, file)).href);
  }
  const carrying = mongoose.modelNames().filter((name) => mongoose.model(name).schema.path('workspaceId'));

  assert.deepEqual(
    WORKSPACE_SCOPED_MODELS.map((m) => m.modelName).sort(),
    carrying.sort(),
    'a model with a workspaceId path is missing from (or extra in) the deletion list'
  );
});

describe('deleting a sole owner', () => {
  let a, b, before, result;

  beforeEach(async () => {
    a = await seedTenant('a');
    b = await seedTenant('b');
    // The connector authorized as the surviving tenant: must not be touched.
    await Settings.create({ _id: 'global', mcpUserId: b.user._id });
    before = await snapshot();
    result = await deleteAccount(a.user._id, { source: 'accountDeleter.test' });
  });

  test('empties every workspace-scoped collection for the deleted tenant', async () => {
    assert.equal(result.ok, true);
    assert.deepEqual(result.workspaceIds, [String(a.workspace._id)]);

    for (const model of WORKSPACE_SCOPED_MODELS) {
      const hadBefore = before[model.collection.collectionName]
        .filter((d) => d.workspaceId === String(a.workspace._id)).length;
      assert.ok(hadBefore > 0, `fixture gap: tenant A had no ${model.modelName} to delete`);
      assert.equal(await model.countDocuments({ workspaceId: a.workspace._id }), 0, `${model.modelName} left behind`);
      assert.equal(await model.countDocuments({ workspaceId: b.workspace._id }), 1, `${model.modelName} of tenant B changed`);
    }
  });

  test('removes the user, their workspace, their memories and their pre-tenancy chats', async () => {
    assert.equal(await User.exists({ _id: a.user._id }), null);
    assert.equal(await Workspace.exists({ _id: a.workspace._id }), null);
    assert.equal(await UserMemory.countDocuments({ userId: a.user._id }), 0);
    assert.equal(await Conversation.countDocuments({ userId: a.user._id }), 0, 'including the workspaceId: null one');
    assert.equal(result.deleted.User, 1);
    assert.equal(result.deleted.Workspace, 1);
    assert.equal(result.deleted.Conversation, 2);
    assert.equal(result.mcpUserCleared, false);
  });

  test('changes nothing else: the database equals the one before, minus tenant A', async () => {
    assert.deepEqual(await snapshot(), without(before, a));
  });
});

test('clears Settings.mcpUserId when the connector was authorized as the deleted user', async () => {
  const a = await seedTenant('a');
  await Settings.create({ _id: 'global', mcpUserId: a.user._id });

  const result = await deleteAccount(a.user._id);

  assert.equal(result.mcpUserCleared, true);
  assert.equal((await Settings.findById('global').lean()).mcpUserId, null);
});

test('deletes a solely-owned workspace even when others are members of it', async () => {
  const a = await seedTenant('a');
  const b = await seedTenant('b');
  await Workspace.updateOne({ _id: a.workspace._id }, { $push: { members: { userId: b.user._id, role: 'editor' } } });
  const before = await snapshot();

  const result = await deleteAccount(a.user._id);

  assert.equal(result.ok, true);
  assert.deepEqual(await snapshot(), without(before, a), 'B keeps their account and workspace');
});

describe('refusing', () => {
  const described = { editor: 'an editor', viewer: 'a viewer', owner: 'a co-owner' };

  for (const role of ['editor', 'viewer', 'owner']) {
    test(`refuses, deleting nothing, when the user is ${described[role]} of someone else's workspace`, async () => {
      const a = await seedTenant('a');
      const b = await seedTenant('b');
      await Workspace.updateOne({ _id: b.workspace._id }, { $push: { members: { userId: a.user._id, role } } });
      const before = await snapshot();

      const result = await deleteAccount(a.user._id);

      assert.deepEqual(result, {
        ok: false,
        reason: 'member-elsewhere',
        memberships: [{ workspaceId: String(b.workspace._id), name: "b's workspace", role }],
      });
      assert.deepEqual(await snapshot(), before);
    });
  }

  test('refuses, deleting nothing, when someone else co-owns the user\'s own workspace', async () => {
    const a = await seedTenant('a');
    const b = await seedTenant('b');
    await Workspace.updateOne({ _id: a.workspace._id }, { $push: { members: { userId: b.user._id, role: 'owner' } } });
    const before = await snapshot();

    const result = await deleteAccount(a.user._id);

    assert.deepEqual(result.memberships, [{ workspaceId: String(a.workspace._id), name: "a's workspace", role: 'owner' }]);
    assert.deepEqual(await snapshot(), before);
  });

  test('reports user-not-found, deleting nothing, for an unknown or malformed id', async () => {
    await seedTenant('b');
    const before = await snapshot();

    for (const id of [new mongoose.Types.ObjectId(), 'not-an-id', null, undefined]) {
      assert.deepEqual(await deleteAccount(id), { ok: false, reason: 'user-not-found' }, `id ${id}`);
    }
    assert.deepEqual(await snapshot(), before);
  });
});

test('a failure part-way leaves the account in place, and a re-run finishes the job', async (t) => {
  const a = await seedTenant('a');
  await seedTenant('b');
  const before = await snapshot();

  // ChangeLog is last in the scoped list, so the first run fails with the other
  // seven models already emptied — the worst partial state the ordering allows.
  const failing = t.mock.method(ChangeLog, 'deleteMany');
  failing.mock.mockImplementationOnce(async () => { throw new Error('simulated outage'); });

  await assert.rejects(deleteAccount(a.user._id), /simulated outage/);
  assert.ok(await User.exists({ _id: a.user._id }), 'the user survives a failed run');
  assert.ok(await Workspace.exists({ _id: a.workspace._id }), 'so does the workspace, so a re-run can find it');

  assert.equal((await deleteAccount(a.user._id)).ok, true);
  assert.deepEqual(await snapshot(), without(before, a));
});

describe('user-keyed writes that race the deletion', () => {
  // The inserts memoryExtractor.js and chat.js's save_memory tool make, and the
  // one POST /conversations makes.
  const lateWrites = (userId) => [
    () => UserMemory.insertMany([{ userId, fact: 'rode the last night train' }]),
    () => UserMemory.create({ userId, fact: 'asked to be remembered' }),
    () => Conversation.create({ workspaceId: null, userId, provider: 'test', model: 'test' }),
  ];

  test('an insert that lands after the account is gone deletes itself', async () => {
    const a = await seedTenant('a');
    const b = await seedTenant('b');
    assert.equal((await deleteAccount(a.user._id)).ok, true);
    const deletedState = await snapshot();

    for (const write of lateWrites(a.user._id)) {
      await assert.rejects(write(), OwnerGoneError);
    }
    assert.deepEqual(await snapshot(), deletedState, 'nothing of A was left behind');

    // A live owner's inserts stand.
    for (const write of lateWrites(b.user._id)) await write();
    assert.equal(await UserMemory.countDocuments({ userId: b.user._id }), 3);
    assert.equal(await Conversation.countDocuments({ userId: b.user._id }), 3);
  });

  test('an insert that passes its check just before the user goes is caught by the final sweep', async (t) => {
    const a = await seedTenant('a');
    await seedTenant('b');
    const before = await snapshot();

    // The inserts land after the user's rows were first deleted but while the
    // User still exists, so the guard's own check passes. That is the window
    // the final sweep has to cover.
    const deleteUser = User.deleteOne.bind(User);
    t.mock.method(User, 'deleteOne', async (...args) => {
      for (const write of lateWrites(a.user._id)) await write();
      return deleteUser(...args);
    });

    const result = await deleteAccount(a.user._id);

    assert.equal(result.deleted.UserMemory, 3, 'the seeded memory and both late ones');
    assert.equal(result.deleted.Conversation, 3, 'both seeded chats and the late one');
    assert.deepEqual(await snapshot(), without(before, a));
  });
});
