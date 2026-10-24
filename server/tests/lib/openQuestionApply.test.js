/**
 * Applying an `open_question` item (src/lib/draftApplier.js, applyOpenQuestion).
 *
 * The applier has handled this kind since the generator shipped, but until
 * KOL-016 nothing emitted one, so the shape it is handed here is new in
 * production: `entry_ids` is a flat array of strings holding EITHER an existing
 * entity's id OR the localKey of a sibling item in the same draft, which has an
 * id only once that item has landed. Three things follow from that, and each is
 * the kind of failure that is invisible until someone goes looking:
 *
 *   - a localKey must be resolved, not stored. 'e1' reaching
 *     `OpenQuestion.entry_ids` is a Mongoose cast error, which the applier
 *     would record as `failed` with a code and a log ref — a reviewer cannot
 *     act on that.
 *   - a localKey whose entity was REJECTED must block, not fail. Nothing went
 *     wrong; the entity the question is about simply is not in the graph. The
 *     review UI already greys the item out for the same reason, from
 *     `dependsOn`, so the apply has to agree with what it was told.
 *   - an id outside the workspace must be dropped rather than stored. These ids
 *     travel in a payload a human can edit, and `POST /open-questions` drops
 *     out-of-workspace `entry_ids` rather than storing them; an apply that
 *     stored one would leave a question in one tenant pointing into another.
 *
 * Run against a real mongod rather than a stub precisely because two of the
 * three are casting and query-scoping behaviour, which a stub would invent.
 *
 * Falsification check: run against the pre-KOL-016 applier
 * (`entry_ids.map(k => localKeys.get(k) ?? k)` with no resolution check and no
 * workspace scope) the blocked test fails on `applyState` ('failed', with a
 * cast error) and the foreign-id test fails on the stored `entry_ids`; the
 * happy-path test passes there, which is what makes the other two meaningful.
 */

import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../helpers/db.js';
import { applyDraft } from '../../src/lib/draftApplier.js';
import Draft from '../../src/models/Draft.js';
import Entity from '../../src/models/Entity.js';
import EntityType from '../../src/models/EntityType.js';
import OpenQuestion from '../../src/models/OpenQuestion.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';

// The applier logs at 'light' by default; silenced unless a failure needs the trail.
process.env.APPLY_LOG_LEVEL ??= 'off';

let ws;      // the workspace everything below belongs to
let actor;   // the person who clicked Apply

async function makeWorkspace(email, name) {
  const user = await User.create({ email, passwordHash: 'not-a-real-hash' });
  const workspace = await Workspace.create({
    name,
    ownerId: user._id,
    members: [{ userId: user._id, role: 'owner' }],
  });
  await EntityType.create({ name: 'Characters', workspaceId: workspace._id });
  return { user, workspace };
}

const makeEntity = (title, workspaceId = ws._id) =>
  Entity.create({ title, category: 'Characters', summary: `${title}, a fixture`, workspaceId });

/**
 * A reviewed draft: one entity create the question depends on, then the
 * question itself. `accepted` is copied from `proposed` on a plain accept, the
 * way the decision routes write it.
 */
function questionDraft({ entryIds, entityDecision = 'accepted', questionDecision = 'accepted' }) {
  const entity = { title: 'Mira', category: 'Characters', summary: 'Keeps the gate.', tags: [], blocks: [] };
  const question = { question: 'Who built the Iron Gate?', entry_ids: entryIds };
  const item = (fields, proposed, decision) => ({
    ...fields,
    proposed,
    accepted: decision === 'accepted' ? proposed : null,
    decision,
  });

  return Draft.create({
    workspaceId: ws._id,
    createdBy: actor.userId,
    title: 'open-question fixture',
    status: 'ready',
    source: { producer: 'braindump', text: 'fixture' },
    items: [
      item({ localKey: 'e1', seq: 0, kind: 'entity', op: 'create' }, entity, entityDecision),
      item({ localKey: 'q1', seq: 1, kind: 'open_question', op: 'create', dependsOn: ['e1'] }, question, questionDecision),
    ],
  });
}

const itemByKey = (draft, key) => draft.items.find(i => i.localKey === key);

before(async () => { await db.connect(); });
beforeEach(async () => {
  await db.clear();
  const { user, workspace } = await makeWorkspace('oq-applier@example.test', 'Open question workspace');
  ws = workspace;
  actor = { userId: user._id, type: 'user', label: user.email };
});
after(async () => { await db.disconnect(); });

describe('applyDraft: an open question', () => {
  test('resolves a localKey to the entity this same apply created, and links both sides', async () => {
    const gate = await makeEntity('The Iron Gate');
    const draft = await questionDraft({ entryIds: ['e1', String(gate._id)] });

    const summary = await applyDraft(draft, { workspaceId: ws._id, actor });
    assert.deepEqual(summary, { applied: 2, failed: 0, blocked: 0, skipped: 0 });

    const mira = await Entity.findOne({ title: 'Mira', workspaceId: ws._id }).lean();
    const oq = await OpenQuestion.findOne({ workspaceId: ws._id }).lean();
    assert.ok(oq, 'no question was written');
    assert.equal(oq.question, 'Who built the Iron Gate?');
    assert.equal(oq.status, 'open');
    assert.deepEqual(oq.entry_ids.map(String).sort(), [String(mira._id), String(gate._id)].sort());

    // The link exists on both sides, as POST /open-questions leaves it.
    for (const id of [mira._id, gate._id]) {
      const entity = await Entity.findById(id).lean();
      assert.deepEqual(entity.open_questions.map(String), [String(oq._id)]);
    }

    const item = itemByKey(draft, 'q1');
    assert.equal(item.applyState, 'applied');
    assert.equal(String(item.resultId), String(oq._id));
    assert.equal(item.applyError, null);
  });

  test('blocks, rather than failing, when the entity it is about was rejected', async () => {
    const draft = await questionDraft({ entryIds: ['e1'], entityDecision: 'rejected' });

    const summary = await applyDraft(draft, { workspaceId: ws._id, actor });
    assert.deepEqual(summary, { applied: 0, failed: 0, blocked: 1, skipped: 1 });

    const item = itemByKey(draft, 'q1');
    assert.equal(item.applyState, 'blocked');
    // A reviewer can act on this sentence; a cast error on 'e1' is not one.
    assert.match(item.applyError, /depends on "e1"/);
    assert.equal(await OpenQuestion.countDocuments({}), 0, 'nothing may be written for a blocked item');
  });

  test('drops an entry_id from another workspace instead of storing it', async () => {
    const other = await makeWorkspace('oq-other@example.test', 'Another tenant');
    const foreign = await makeEntity('Someone else\'s entity', other.workspace._id);
    const draft = await questionDraft({ entryIds: ['e1', String(foreign._id)] });

    const summary = await applyDraft(draft, { workspaceId: ws._id, actor });
    assert.deepEqual(summary, { applied: 2, failed: 0, blocked: 0, skipped: 0 });

    const mira = await Entity.findOne({ title: 'Mira', workspaceId: ws._id }).lean();
    const oq = await OpenQuestion.findOne({ workspaceId: ws._id }).lean();
    assert.deepEqual(oq.entry_ids.map(String), [String(mira._id)], 'the foreign id was stored');

    // And the other tenant's entity is untouched.
    const after = await Entity.findById(foreign._id).lean();
    assert.deepEqual(after.open_questions, []);
  });
});
