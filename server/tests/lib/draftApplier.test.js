/**
 * Applying a relationship item whose recorded target group has moved since the
 * draft was generated (src/lib/draftApplier.js, findOrCreateGroup).
 *
 * A relationship item carries `targetGroupId` — the group the normalizer or a
 * producer recognised the proposal as already being. That id is matched at
 * GENERATION time, and both sides can change before anyone clicks Apply: a
 * person can remove a member from the group (DELETE
 * /relationship-groups/:id/members/:entityId leaves a 3+-member group alive),
 * and a reviewer can re-point `members` in an edit while the id they were
 * matched from stays in the payload (`relationshipPayloadSchema` accepts that
 * pair). The apply-time members search cannot reach either state — it only
 * considers groups that hold every member — so the one rule that makes the
 * silent-skip in the member write loop a no-op has to be asked on the
 * id-targeted path too.
 *
 * What a missing check costs is not a crash but a quietly wrong graph, which is
 * why these run against a real mongod rather than a stub: the back-reference is
 * an `$addToSet` over every member, so an entity the group does not list still
 * gets a `relationships` entry pointing at it (inflating the link count the
 * list view renders from that array), the accepted edit writes nothing, and the
 * item is recorded `applied` either way. Hence `assertBackRefsSound` below,
 * asserted after every apply: no entity may reference a group that does not
 * list it.
 *
 * Falsification check: this suite was run against the pre-fix applier (the
 * id-targeted path trusting `targetGroupId` as found). Both 'moved target'
 * tests fail there, each on the first of the three things that path loses —
 * `resultId` naming the old group rather than a restored edge, with the missing
 * flag and the stray back-reference asserted behind it — while the two controls
 * below (a target that still holds everyone; a target that has been deleted)
 * pass, so the suite fails for the stated reason rather than by construction.
 */

import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';

import * as db from '../helpers/db.js';
import { applyDraft } from '../../src/lib/draftApplier.js';
import Draft from '../../src/models/Draft.js';
import Entity from '../../src/models/Entity.js';
import EntityType from '../../src/models/EntityType.js';
import RelationshipGroup from '../../src/models/RelationshipGroup.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';

// The applier logs at 'light' by default; silenced unless a failure needs the trail.
process.env.APPLY_LOG_LEVEL ??= 'off';

let ws;      // the workspace everything below belongs to
let actor;   // the person who clicked Apply

async function seedWorkspace() {
  const user = await User.create({ email: 'applier@example.test', passwordHash: 'not-a-real-hash' });
  const workspace = await Workspace.create({
    name: 'Applier workspace',
    ownerId: user._id,
    members: [{ userId: user._id, role: 'owner' }],
  });
  await EntityType.create({ name: 'Characters', workspaceId: workspace._id });
  ws = workspace;
  actor = { userId: user._id, type: 'user', label: 'applier@example.test' };
  return { user, workspace };
}

const makeEntity = title =>
  Entity.create({ title, category: 'Characters', summary: `${title}, a fixture`, workspaceId: ws._id });

/** A group over these entities, with the back-references a real write leaves. */
async function linkGroup(label, entities, memberLabels = {}) {
  const group = await RelationshipGroup.create({
    label,
    members: entities.map(e => ({ refId: e._id, refModel: 'Entity', label: memberLabels[e.title] ?? null, notes: null })),
    workspaceId: ws._id,
  });
  await Entity.updateMany(
    { _id: { $in: entities.map(e => e._id) }, workspaceId: ws._id },
    { $addToSet: { relationships: group._id } }
  );
  return group;
}

/** Exactly what DELETE /relationship-groups/:id/members/:entityId does to a
 *  group that keeps two entity members: drop the member, pull its back-ref. */
async function removeMemberByHand(group, entity) {
  const fresh = await RelationshipGroup.findById(group._id);
  fresh.members = fresh.members.filter(m => !(m.refModel === 'Entity' && String(m.refId) === String(entity._id)));
  assert.ok(fresh.members.filter(m => m.refModel === 'Entity').length >= 2, 'fixture must leave the group alive');
  await fresh.save();
  await Entity.findOneAndUpdate(
    { _id: entity._id, workspaceId: ws._id },
    { $pull: { relationships: group._id } }
  );
  return fresh;
}

const member = entity => ({ refId: String(entity._id), refModel: 'Entity', name: entity.title, label: null, notes: null });

/** A one-item, already-reviewed draft holding a relationship proposal. */
function relationshipDraft({ proposed, accepted = null, decision = 'accepted' }) {
  return Draft.create({
    workspaceId: ws._id,
    createdBy: actor.userId,
    title: 'applier fixture',
    status: 'ready',
    source: { producer: 'braindump', text: 'fixture' },
    items: [{
      localKey: 'r1',
      seq: 1,
      kind: 'relationship',
      op: 'update',
      matchedBy: 'same-members-and-label',
      // The decision routes copy `proposed` verbatim on a plain accept.
      proposed,
      accepted: accepted ?? (decision === 'accepted' ? proposed : null),
      decision,
    }],
  });
}

const refIds = group => group.members.filter(m => m.refModel === 'Entity').map(m => String(m.refId));
const relIds = entity => (entity.relationships ?? []).map(String);

/**
 * The invariant the untrusted id broke: a `relationships` entry is a
 * back-reference, so every group an entity points at must list that entity.
 */
async function assertBackRefsSound() {
  const groups = new Map((await RelationshipGroup.find({}).lean()).map(g => [String(g._id), g]));
  for (const entity of await Entity.find({}).lean()) {
    for (const id of relIds(entity)) {
      const group = groups.get(id);
      assert.ok(group, `entity ${entity.title} references group ${id}, which does not exist`);
      assert.ok(
        (group.members ?? []).some(m => m.refModel === 'Entity' && String(m.refId) === String(entity._id)),
        `entity ${entity.title} references group ${id}, which does not list it as a member`
      );
    }
  }
}

before(async () => { await db.connect(); });
beforeEach(async () => { await db.clear(); await seedWorkspace(); });
after(async () => { await db.disconnect(); });

describe('applyDraft: a relationship whose recorded target group has moved', () => {
  test('a member removed by hand means the target is no longer the match, and the edge is restored', async () => {
    const [ami, bo, cyr] = [await makeEntity('Ami'), await makeEntity('Bo'), await makeEntity('Cyr')];
    const original = await linkGroup('Crew', [ami, bo, cyr]);
    await removeMemberByHand(original, cyr);

    const draft = await relationshipDraft({
      proposed: { label: 'Crew', members: [member(ami), member(bo), member(cyr)], targetGroupId: String(original._id) },
    });
    const summary = await applyDraft(draft, { workspaceId: ws._id, actor });

    assert.deepEqual(summary, { applied: 1, failed: 0, blocked: 0, skipped: 0 });

    // The group a person edited is left exactly as they left it: this applier
    // never shrinks a group, and it does not quietly re-grow one either.
    const kept = await RelationshipGroup.findById(original._id);
    assert.deepEqual(refIds(kept).sort(), [ami, bo].map(e => String(e._id)).sort());

    // The edge the source describes is in the graph, as its own group.
    const written = await RelationshipGroup.findById(draft.items[0].resultId);
    assert.notEqual(String(written._id), String(original._id));
    assert.equal(written.label, 'Crew');
    assert.deepEqual(refIds(written).sort(), [ami, bo, cyr].map(e => String(e._id)).sort());

    // And the apply says the recorded target was dropped rather than reporting
    // a clean match.
    assert.equal(draft.items[0].applyState, 'applied');
    assert.deepEqual([...draft.items[0].flags], ['target_group_changed']);

    // The back-reference the bug wrote: Cyr pointing at a group without Cyr.
    const cyrAfter = await Entity.findById(cyr._id).lean();
    assert.deepEqual(relIds(cyrAfter), [String(written._id)]);
    const amiAfter = await Entity.findById(ami._id).lean();
    assert.deepEqual(relIds(amiAfter).sort(), [String(original._id), String(written._id)].sort());

    await assertBackRefsSound();
  });

  test('an edit that re-points members while keeping the recorded id writes the edit, not the old group', async () => {
    const [ami, bo, cyr] = [await makeEntity('Ami'), await makeEntity('Bo'), await makeEntity('Cyr')];
    const original = await linkGroup('Crew', [ami, bo]);

    const draft = await relationshipDraft({
      proposed: { label: 'Crew', members: [member(ami), member(bo)], targetGroupId: String(original._id) },
      // The reviewer swapped Bo for Cyr; `targetGroupId` is what it was matched
      // from, and the schema does not require an edit to clear it.
      accepted: { label: 'Crew', members: [member(ami), member(cyr)], targetGroupId: String(original._id) },
      decision: 'edited',
    });
    await applyDraft(draft, { workspaceId: ws._id, actor });

    const kept = await RelationshipGroup.findById(original._id);
    assert.deepEqual(refIds(kept).sort(), [ami, bo].map(e => String(e._id)).sort());

    const written = await RelationshipGroup.findById(draft.items[0].resultId);
    assert.notEqual(String(written._id), String(original._id));
    assert.deepEqual(refIds(written).sort(), [ami, cyr].map(e => String(e._id)).sort());
    assert.deepEqual([...draft.items[0].flags], ['target_group_changed']);

    // Cyr is linked because the edit said so; Bo is not, because it did not.
    const cyrAfter = await Entity.findById(cyr._id).lean();
    assert.deepEqual(relIds(cyrAfter), [String(written._id)]);
    const boAfter = await Entity.findById(bo._id).lean();
    assert.deepEqual(relIds(boAfter), [String(original._id)]);

    await assertBackRefsSound();
  });

  test('control: a target that still holds every member is updated in place', async () => {
    const [ami, bo, cyr] = [await makeEntity('Ami'), await makeEntity('Bo'), await makeEntity('Cyr')];
    const original = await linkGroup('Crew', [ami, bo, cyr], { Bo: 'quartermaster' });

    const draft = await relationshipDraft({
      proposed: {
        label: 'Crew',
        members: [{ ...member(ami), label: 'captain' }, member(bo), member(cyr)],
        targetGroupId: String(original._id),
      },
    });
    await applyDraft(draft, { workspaceId: ws._id, actor });

    assert.equal(await RelationshipGroup.countDocuments({}), 1, 're-importing an unchanged edge must not fork the group');
    assert.equal(String(draft.items[0].resultId), String(original._id));
    assert.deepEqual([...draft.items[0].flags], []);

    const after = await RelationshipGroup.findById(original._id).lean();
    const byId = new Map(after.members.map(m => [String(m.refId), m]));
    assert.equal(byId.get(String(ami._id)).label, 'captain');
    // A role a person wrote is not cleared by a producer that emits none.
    assert.equal(byId.get(String(bo._id)).label, 'quartermaster');
    assert.equal(byId.get(String(cyr._id)).label, null);

    await assertBackRefsSound();
  });

  test('control: a target that has since been deleted falls through to the members search', async () => {
    const [ami, bo] = [await makeEntity('Ami'), await makeEntity('Bo')];
    const original = await linkGroup('Crew', [ami, bo]);

    const draft = await relationshipDraft({
      proposed: {
        label: 'Crew',
        members: [member(ami), member(bo)],
        targetGroupId: String(new mongoose.Types.ObjectId()),
      },
    });
    await applyDraft(draft, { workspaceId: ws._id, actor });

    assert.equal(await RelationshipGroup.countDocuments({}), 1);
    assert.equal(String(draft.items[0].resultId), String(original._id));
    // Nothing moved under the draft — the id simply named a group that is gone.
    assert.deepEqual([...draft.items[0].flags], []);

    await assertBackRefsSound();
  });
});
