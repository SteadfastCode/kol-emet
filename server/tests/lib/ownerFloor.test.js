/**
 * The last-owner floor, at the level it is enforced: the write (KOL-134).
 *
 * The floor used to be a check in front of the write — read the members array,
 * count the owners, refuse at one, then update. Read-then-write, so with two
 * owners **two** concurrent demotions each read two owners, each passed the
 * count, and both landed, leaving a workspace with nobody holding `owner`. That
 * state is permanent: every write on a membership is
 * `requireWorkspaceRole('owner')`, so nothing in the product could mint an
 * owner there again and the workspace could never be renamed, invited into or
 * managed.
 *
 * `src/lib/ownerFloor.js` is where the invariant moved to, and this file is the
 * race itself. There is no sleep and no concurrency here, because neither is
 * what the race is made of: **both reads happening before either write** is the
 * race, and two awaits in that order express it exactly. What is asserted is
 * `matchedCount` — one document for the first write, none for the second —
 * because no match is precisely what the routes answer 409 `LAST_OWNER` to.
 *
 * The second half is `MOVE_OWNER_ID_TO_AN_OWNER`: `Workspace.ownerId` must keep
 * naming a member who holds the role, because `lib/accountDeleter.js` judges
 * *sole* ownership by it. As a pipeline stage it reads the members array the
 * write just produced, which is the three-owner case below — two demotions that
 * both legitimately land, where a value computed from either request's own read
 * would leave `ownerId` on a member it had just demoted.
 *
 * Falsification: drop the `$ne` on `$$m.userId` from `anotherOwnerThan` and the
 * first write stops matching; drop the whole `$expr` and the second write
 * matches too and the workspace is left ownerless; pass `anotherOwnerThan` a
 * string id instead of the stored ObjectId and the floor never holds (Mongoose
 * does not cast inside `$expr`); drop `MOVE_OWNER_ID_TO_AN_OWNER` and the
 * three-owner case leaves `ownerId` naming an editor.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_OWNER_FLOOR_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per write, naming what it matched and why
 *   normal  — light, plus the fixture each test built
 *   verbose — normal, plus the stored members and ownerId after every write
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import * as db from '../helpers/db.js';
import Workspace from '../../src/models/Workspace.js';
import { MOVE_OWNER_ID_TO_AN_OWNER, anotherOwnerThan } from '../../src/lib/ownerFloor.js';

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  const active = LEVELS[process.env.TEST_OWNER_FLOOR_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/ownerFloor:${level}] ${msg}`);
}

const oid = () => new mongoose.Types.ObjectId();

/** A workspace whose members hold exactly the roles given, `ownerId` on the first. */
async function workspaceWith(...roles) {
  const members = roles.map(role => ({ userId: oid(), role }));
  const doc = await Workspace.create({ name: 'floor', ownerId: members[0].userId, members });
  log('normal', `built workspace ${doc._id} with ${members.map(m => `${m.userId}:${m.role}`).join(', ')}; ownerId ${doc.ownerId} (source: Workspace.create)`);
  return { id: doc._id, members };
}

/** What `routes/workspace.js` reads before it writes: the whole document. */
const read = (id) => Workspace.findById(id).select('_id ownerId members').lean();

/**
 * The demotion exactly as `PATCH /workspace/members/:userId` performs it: the
 * floor in the filter, the role and `ownerId` in one update pipeline.
 *
 * `member` comes from a *read* — the caller's, taken whenever they took it —
 * which is the point: the filter is evaluated against the document as it
 * stands when the write runs, not as that read saw it.
 */
function demote(workspaceId, member, role) {
  return Workspace.updateOne(
    { _id: workspaceId, 'members.userId': member.userId, ...(member.role === 'owner' ? anotherOwnerThan(member.userId) : {}) },
    [
      {
        $set: {
          members: {
            $map: {
              input: { $ifNull: ['$members', []] },
              as: 'm',
              in: { $cond: [{ $eq: ['$$m.userId', member.userId] }, { $mergeObjects: ['$$m', { role }] }, '$$m'] },
            },
          },
        },
      },
      MOVE_OWNER_ID_TO_AN_OWNER,
    ],
  );
}

/** The removal, as `DELETE /workspace/members/:userId` performs it. */
function remove(workspaceId, member) {
  return Workspace.updateOne(
    { _id: workspaceId, 'members.userId': member.userId, ...(member.role === 'owner' ? anotherOwnerThan(member.userId) : {}) },
    [
      { $set: { members: { $filter: { input: { $ifNull: ['$members', []] }, as: 'm', cond: { $ne: ['$$m.userId', member.userId] } } } } },
      MOVE_OWNER_ID_TO_AN_OWNER,
    ],
  );
}

/** The roles held in a workspace now, and who `ownerId` names. */
async function stored(workspaceId) {
  const doc = await read(workspaceId);
  log('verbose', `workspace ${workspaceId}: ${JSON.stringify(doc.members)}, ownerId ${doc.ownerId}`);
  return doc;
}

const owners = (doc) => doc.members.filter(m => m.role === 'owner');
const roleOf = (doc, userId) => doc.members.find(m => String(m.userId) === String(userId))?.role ?? null;

before(async () => { await db.connect(); });
beforeEach(async () => { await db.clear(); });
after(async () => { await db.disconnect(); });

describe('two owners, two demotions', () => {
  test('both reads happen before either write, and the second write matches nothing', async () => {
    const { id, members: [a, b] } = await workspaceWith('owner', 'owner');

    // Both reads first. This is the race: each request is about to demote an
    // owner on the strength of an array that showed two of them.
    const readByFirst = await read(id);
    const readBySecond = await read(id);
    assert.equal(owners(readByFirst).length, 2);
    assert.equal(owners(readBySecond).length, 2, 'both reads saw two owners — neither would be refused by a count');

    const first = await demote(id, readByFirst.members.find(m => String(m.userId) === String(a.userId)), 'editor');
    const second = await demote(id, readBySecond.members.find(m => String(m.userId) === String(b.userId)), 'editor');
    log('light', `first demotion matched ${first.matchedCount}, second matched ${second.matchedCount} (source: two guarded updates, both reads taken before either)`);

    assert.equal(first.matchedCount, 1, 'the first demotion is legitimate: another owner remains');
    assert.equal(second.matchedCount, 0, 'the second demotion must find the floor already at one owner — no match is the 409');

    const doc = await stored(id);
    assert.equal(owners(doc).length, 1, 'the workspace must still hold an owner; with none it could never be managed again');
    assert.equal(roleOf(doc, a.userId), 'editor');
    assert.equal(roleOf(doc, b.userId), 'owner', 'the second of the two is the one refused');
    assert.equal(String(doc.ownerId), String(b.userId), 'ownerId followed the role off the demoted owner');
  });

  test('a removal racing a demotion is refused the same way', async () => {
    const { id, members: [a, b] } = await workspaceWith('owner', 'owner');

    const readByFirst = await read(id);
    const readBySecond = await read(id);

    const first = await demote(id, readByFirst.members.find(m => String(m.userId) === String(a.userId)), 'viewer');
    const second = await remove(id, readBySecond.members.find(m => String(m.userId) === String(b.userId)));
    log('light', `demotion matched ${first.matchedCount}, racing removal matched ${second.matchedCount} (source: the same floor in both filters)`);

    assert.equal(first.matchedCount, 1);
    assert.equal(second.matchedCount, 0, 'removing the only remaining owner must match nothing');

    const doc = await stored(id);
    assert.equal(doc.members.length, 2, 'the refused removal pulled nobody');
    assert.equal(owners(doc).length, 1);
    assert.equal(String(doc.ownerId), String(b.userId));
  });

  test('two removals: the first is legitimate, the second matches nothing', async () => {
    const { id, members: [a, b] } = await workspaceWith('owner', 'owner');

    const readByFirst = await read(id);
    const readBySecond = await read(id);

    const first = await remove(id, readByFirst.members.find(m => String(m.userId) === String(a.userId)));
    const second = await remove(id, readBySecond.members.find(m => String(m.userId) === String(b.userId)));

    assert.equal(first.matchedCount, 1);
    assert.equal(second.matchedCount, 0);

    const doc = await stored(id);
    assert.deepEqual(doc.members.map(m => [String(m.userId), m.role]), [[String(b.userId), 'owner']]);
    assert.equal(String(doc.ownerId), String(b.userId));
  });
});

describe('the floor only guards what could breach it', () => {
  test('the sole owner cannot be demoted or removed even without a race', async () => {
    const { id, members: [a, b] } = await workspaceWith('owner', 'editor');
    const doc = await read(id);
    const sole = doc.members.find(m => String(m.userId) === String(a.userId));

    assert.equal((await demote(id, sole, 'editor')).matchedCount, 0);
    assert.equal((await remove(id, sole)).matchedCount, 0);
    assert.equal(roleOf(await stored(id), a.userId), 'owner');

    // And the editor beside them is guarded by nothing, because nothing they
    // can be changed to reduces the number of owners.
    assert.equal((await demote(id, doc.members.find(m => String(m.userId) === String(b.userId)), 'viewer')).matchedCount, 1);
    assert.equal(roleOf(await stored(id), b.userId), 'viewer');
  });

  test('promoting a second owner is never refused, and leaves ownerId where it is', async () => {
    const { id, members: [a, b] } = await workspaceWith('owner', 'viewer');
    const doc = await read(id);

    assert.equal((await demote(id, doc.members.find(m => String(m.userId) === String(b.userId)), 'owner')).matchedCount, 1);

    const after = await stored(id);
    assert.equal(owners(after).length, 2);
    assert.equal(String(after.ownerId), String(a.userId), 'ownerId still names an owner, so it does not move');
  });
});

describe('ownerId after a write that is not the one that read the array', () => {
  test('three owners, two demotions that both land, and ownerId still names an owner', async () => {
    const { id, members: [a, b, c] } = await workspaceWith('owner', 'owner', 'owner');

    const readByFirst = await read(id);
    const readBySecond = await read(id);

    // The first demotes the owner `ownerId` names, so `ownerId` moves to the
    // next owner in the array — b. The second then demotes b, on the strength
    // of an array in which a was still an owner: a value computed from that
    // read would have left `ownerId` naming b, who is now an editor.
    assert.equal((await demote(id, readByFirst.members.find(m => String(m.userId) === String(a.userId)), 'editor')).matchedCount, 1);
    assert.equal(String((await stored(id)).ownerId), String(b.userId));

    assert.equal((await demote(id, readBySecond.members.find(m => String(m.userId) === String(b.userId)), 'editor')).matchedCount, 1,
      'with c still an owner this demotion is legitimate, and must not be refused');

    const doc = await stored(id);
    assert.equal(owners(doc).length, 1);
    assert.equal(String(doc.ownerId), String(c.userId), 'ownerId must name a member who holds the role — accountDeleter judges sole ownership by it');
    assert.equal(roleOf(doc, String(doc.ownerId)), 'owner');
  });

  test('a workspace that already holds no owner keeps the ownerId it has', async () => {
    // Not a state these routes can produce — the floor is what makes that so —
    // but clearing `ownerId` in one would only make it less repairable, and an
    // unrelated role change must not be what does it.
    const a = oid();
    const b = oid();
    const { insertedId } = await Workspace.collection.insertOne({
      name: 'ownerless', ownerId: a, members: [{ userId: a, role: 'editor' }, { userId: b, role: 'viewer' }],
      createdAt: new Date(), updatedAt: new Date(),
    });

    const doc = await read(insertedId);
    assert.equal((await demote(insertedId, doc.members.find(m => String(m.userId) === String(b)), 'editor')).matchedCount, 1);

    const after = await stored(insertedId);
    assert.equal(String(after.ownerId), String(a), 'ownerId was neither moved nor removed');
    assert.equal(roleOf(after, b), 'editor');
  });
});
