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
 * **And the filter is not applied conditionally on that read** (KOL-141): the
 * routes used to spread it in only when their own read showed the member
 * holding `owner`, which is the same stale count back in front of the write. A
 * member read as an editor, promoted to owner while the request was in flight,
 * was then demoted by a write carrying no floor at all — the ownerless
 * workspace again, by a different door. So the filter reads who holds `owner`
 * itself, and goes in whenever a write could reduce their number: every target
 * role but `owner`, and every removal.
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
 * Falsification: drop the `$ne` on `$$o.userId` from `notTheLastOwner` and the
 * first write stops matching; drop the whole `$expr` and the second write
 * matches too and the workspace is left ownerless; pass `notTheLastOwner` a
 * string id instead of the stored ObjectId and the floor never holds (Mongoose
 * does not cast inside `$expr`); put the floor back behind the caller's
 * `member.role === 'owner'` and the promoted-editor case below matches and
 * empties the workspace of owners; drop the `$size` 0 arm and the ownerless
 * workspace can no longer be repaired; drop `MOVE_OWNER_ID_TO_AN_OWNER` and the
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
import { MOVE_OWNER_ID_TO_AN_OWNER, notTheLastOwner } from '../../src/lib/ownerFloor.js';

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
 * stands when the write runs, not as that read saw it. Which is also why
 * `member.role` decides nothing here: the floor goes in for every target role
 * but `owner`, the one role that cannot reduce the number of owners, and that
 * one comes from the request body rather than from any read (KOL-141).
 */
function demote(workspaceId, member, role) {
  return Workspace.updateOne(
    { _id: workspaceId, 'members.userId': member.userId, ...(role === 'owner' ? {} : notTheLastOwner(member.userId)) },
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

/**
 * The removal, as `DELETE /workspace/members/:userId` performs it: the floor
 * unconditionally, because a removal takes the membership away whatever role it
 * turns out to hold.
 */
function remove(workspaceId, member) {
  return Workspace.updateOne(
    { _id: workspaceId, 'members.userId': member.userId, ...notTheLastOwner(member.userId) },
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

describe('the floor does not trust the role the caller read (KOL-141)', () => {
  test('a member read as an editor, who is the only owner by the time the write runs, cannot be demoted', async () => {
    const { id, members: [a, b] } = await workspaceWith('owner', 'editor');

    // The read this request will write on: b is an editor, so the old code put
    // no floor in the filter at all.
    const stale = (await read(id)).members.find(m => String(m.userId) === String(b.userId));
    assert.equal(stale.role, 'editor');

    // In between, b is promoted and a steps down. Both legitimate, both land.
    const fresh = await read(id);
    assert.equal((await demote(id, fresh.members.find(m => String(m.userId) === String(b.userId)), 'owner')).matchedCount, 1);
    const promoted = await read(id);
    assert.equal((await demote(id, promoted.members.find(m => String(m.userId) === String(a.userId)), 'editor')).matchedCount, 1);
    assert.equal(owners(await stored(id)).length, 1, 'b is now the workspace\'s only owner');

    const stales = await demote(id, stale, 'viewer');
    log('light', `the demotion of a member read as ${stale.role} matched ${stales.matchedCount} (source: a read taken before the promotion that made them the last owner)`);
    assert.equal(stales.matchedCount, 0,
      'the floor is judged at the write, not from the role the request read: this write would have left no owner');

    const doc = await stored(id);
    assert.equal(roleOf(doc, b.userId), 'owner');
    assert.equal(owners(doc).length, 1, 'a workspace with no owner can never be managed again, by anyone');
    assert.equal(String(doc.ownerId), String(b.userId));
  });

  test('and cannot be removed either', async () => {
    const { id, members: [a, b] } = await workspaceWith('owner', 'editor');

    const stale = (await read(id)).members.find(m => String(m.userId) === String(b.userId));

    const fresh = await read(id);
    assert.equal((await demote(id, fresh.members.find(m => String(m.userId) === String(b.userId)), 'owner')).matchedCount, 1);
    const promoted = await read(id);
    assert.equal((await demote(id, promoted.members.find(m => String(m.userId) === String(a.userId)), 'editor')).matchedCount, 1);

    assert.equal((await remove(id, stale)).matchedCount, 0,
      'a removal cannot be guarded by the role its caller read — it takes the membership away whatever role it holds now');

    const doc = await stored(id);
    assert.equal(doc.members.length, 2, 'the refused removal pulled nobody');
    assert.equal(owners(doc).length, 1);
  });

  test('a promotion to owner is still never refused, whatever the read saw', async () => {
    // The one target role that cannot reduce the number of owners, so the one
    // that carries no floor — including when the member turns out to hold
    // `owner` already by the time the write runs, which is a no-op and must not
    // be answered as a breach.
    const { id, members: [, b] } = await workspaceWith('owner', 'editor');
    const stale = (await read(id)).members.find(m => String(m.userId) === String(b.userId));

    const fresh = await read(id);
    assert.equal((await demote(id, fresh.members.find(m => String(m.userId) === String(b.userId)), 'owner')).matchedCount, 1);

    assert.equal((await demote(id, stale, 'owner')).matchedCount, 1, 'a promotion that has already happened is not a refusal');
    assert.equal(roleOf(await stored(id), b.userId), 'owner');
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

  test('a workspace that already holds no owner keeps the ownerId it has, and can still be repaired', async () => {
    // Not a state these routes can produce — the floor is what makes that so —
    // but clearing `ownerId` in one would only make it less repairable, and an
    // unrelated role change must not be what does it. The floor is in the
    // filter of that role change now (KOL-141), so its second arm — no owner to
    // lose — is what keeps a workspace in this state workable at all.
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

    // And the repair itself: a promotion lands, after which the floor guards
    // the owner it just created like any other.
    const repaired = after.members.find(m => String(m.userId) === String(a));
    assert.equal((await demote(insertedId, repaired, 'owner')).matchedCount, 1);
    assert.equal(roleOf(await stored(insertedId), a), 'owner');
    assert.equal((await remove(insertedId, (await read(insertedId)).members.find(m => String(m.userId) === String(a)))).matchedCount, 0,
      'the repaired owner is the last one, and the floor holds them in place');
  });
});
