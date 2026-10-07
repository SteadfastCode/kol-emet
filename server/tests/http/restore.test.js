/**
 * Putting a deleted entity back from its snapshot (KOL-060).
 *
 * `DELETE /entities/:id` removes the document and `logDelete` keeps the whole
 * thing in the `deleted` change log entry's snapshot for the TTL's 30 days — but
 * the rollback route read the live entity first and answered 404 when it was
 * gone, so that snapshot could be looked at (the delete broadcast opens a
 * read-only `[DELETED]` panel in another tab) and never put back. For a wiki
 * whose history view is its whole safety net, an accidental delete was
 * unrecoverable with the data still sitting in the database.
 *
 * What is pinned here is the way back: `POST .../rollback/:logId` on a `deleted`
 * entry recreates the document at its original `_id` — blocks (with their own
 * ids), tags and open-question back-links included — under the *caller's*
 * workspace rather than the snapshot's own `workspaceId`, writes a `created`
 * entry naming the actor, and refuses with **409** when that id is live again so
 * a restore never silently overwrites one. `GET /deleted` is the entry point
 * that outlives the toast: this workspace's deleted entities, newest first,
 * dropping any id that is live again. Tenancy both ways: another workspace's
 * deleted entity is neither listed nor restorable. A snapshot naming an entity
 * type the registry no longer has is refused the way KOL-059 decided — 409, then
 * 201 for the same call carrying `{ category }`.
 *
 * Harness as rollback.test.js: `createApp()` over supertest, real
 * `POST /auth/register` so the six default types arrive through the real seeder,
 * real mongod, one account per test. Entity writes log fire-and-forget
 * (routes/entities.js), so the fixtures wait for the entry rather than assuming
 * it landed — see `waitForLogs`.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_RESTORE_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture: the request that made it and what it holds
 *   normal  — light, plus every restore attempt and the status it got back
 *   verbose — normal, plus each GET /deleted page and its rows
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import session from 'express-session';

// Every session write is checked against CLIENT_ORIGIN (src/middleware/originGuard.js),
// so this suite names one below and its agents send a matching Origin.
import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';

import * as db from '../helpers/db.js';
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import Entity from '../../src/models/Entity.js';
import ChangeLog from '../../src/models/ChangeLog.js';

// Environment before src/app.js is imported, for the reasons in tenancy.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
process.env.ENTITY_TYPE_LOG_LEVEL ??= 'off';
process.env.CHANGELOG_LOG_LEVEL ??= 'off';
process.env.SEED_LOG_LEVEL ??= 'off';
delete process.env.BEARER_TOKEN;

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_RESTORE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/restore:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

let app;
let accounts = 0;

/** A fresh account, through the real endpoint, so its registry is the real seed. */
async function freshWorkspace() {
  const email = `restore-${++accounts}@example.test`;
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);
  log('light', `registered ${email} → workspace ${workspace._id} (source: POST /auth/register)`);
  return { agent, email, workspaceId: String(workspace._id) };
}

async function createEntity(who, body) {
  const res = await who.agent.post('/entities').send(body);
  assert.equal(res.status, 201, `POST /entities failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('light', `created entity ${res.body._id} "${res.body.title}" in "${res.body.category}" (source: POST /entities as ${who.email})`);
  return res.body;
}

/**
 * Waits until `entityId` has `count` change log entries. The entity routes log
 * fire-and-forget, so a test that read the list straight after a DELETE would
 * race the write that is the whole point of it.
 */
async function waitForLogs(entityId, count) {
  for (let i = 0; i < 100; i++) {
    if (await ChangeLog.countDocuments({ entityId }) >= count) return;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.fail(`entity ${entityId} never reached ${count} change log entr${count === 1 ? 'y' : 'ies'}`);
}

async function listDeleted(who) {
  const res = await who.agent.get('/deleted');
  assert.equal(res.status, 200, `GET /deleted failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('verbose', `GET /deleted as ${who.email} → ${res.body.map(d => `"${d.entityTitle}" (${d.category}${d.snapshotCategoryMissing ? ', stale' : ''})`).join(', ') || 'nothing'}`);
  return res.body;
}

async function restore(who, entityId, logId, body = undefined) {
  const res = await who.agent.post(`/entities/${entityId}/rollback/${logId}`).send(body ?? {});
  log('normal', `POST rollback ${entityId}/${logId} ${body ? JSON.stringify(body) : '(no body)'} → ${res.status} ${res.status === 201 ? `restored "${res.body.title}" in "${res.body.category}"` : JSON.stringify(res.body)}`);
  return res;
}

/** Renames one of `who`'s types by name, through the real cascade. */
async function renameType(who, from, to) {
  const type = (await who.agent.get('/entity-types')).body.find(t => t.name === from);
  assert.ok(type, `${who.email} should have a "${from}" type`);
  const res = await who.agent.put(`/entity-types/${type._id}`).send({ name: to });
  assert.equal(res.status, 200, `PUT /entity-types (${from} → ${to}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('light', `renamed "${from}" → "${to}" (source: PUT /entity-types as ${who.email})`);
  return res.body;
}

/**
 * An account with one deleted entity that had blocks, tags and an open
 * question — the shape every assertion below is about. Returns the entity as it
 * was, and the `deleted` log entry's id.
 */
async function deletedEntity({ who, category = 'Characters' } = {}) {
  who ??= await freshWorkspace();
  const entity = await createEntity(who, {
    title: 'The Brakeman',
    category,
    summary: 'Rides the last car',
    tags: ['train', 'crew'],
    blocks: [
      { type: 'text', order: 0, data: { text: 'He keeps the couplings honest.' } },
      { type: 'attribute', order: 1, data: { label: 'Rank', value: 'Second' } },
    ],
  });

  // An open question back-links onto the entity, so a restore has to bring the
  // link back and not just the document's own fields.
  const asked = await who.agent.post('/open-questions').send({
    question: 'Who taught him the couplings?',
    entry_ids: [entity._id],
  });
  assert.equal(asked.status, 201, `POST /open-questions failed: ${asked.status} ${JSON.stringify(asked.body)}`);
  const linked = await Entity.findById(entity._id).lean();
  assert.equal(linked.open_questions.length, 1, 'the fixture needs the back-link in place before the delete');
  log('light', `linked open question ${asked.body._id} to ${entity._id} (source: POST /open-questions as ${who.email})`);

  const gone = await who.agent.delete(`/entities/${entity._id}`);
  assert.equal(gone.status, 204, `DELETE /entities failed: ${gone.status} ${JSON.stringify(gone.body)}`);
  await waitForLogs(entity._id, 2); // 'created' (no snapshot) + 'deleted' (the whole document)
  assert.equal(await Entity.countDocuments({ _id: entity._id }), 0, 'the delete must really remove it');
  log('light', `deleted entity ${entity._id} (source: DELETE /entities as ${who.email})`);

  const deleted = await listDeleted(who);
  const row = deleted.find(d => d.entityId === entity._id);
  assert.ok(row, `GET /deleted should offer the entity it just deleted, got ${JSON.stringify(deleted)}`);
  return { who, entity, question: asked.body, row, logId: row._id, linked };
}

before(async () => {
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });
  await db.connect();
});

beforeEach(async () => { await db.clear(); });

after(async () => { await db.disconnect(); });

describe('restoring a deleted entity', () => {
  test('recreates it at the same _id with its blocks, tags and open questions', async () => {
    const { who, entity, question, logId, linked } = await deletedEntity();

    const res = await restore(who, entity._id, logId);

    assert.equal(res.status, 201, `a restore creates the document: ${JSON.stringify(res.body)}`);
    assert.equal(res.body._id, entity._id, 'the entity must come back at its original id');
    assert.equal(res.body.title, 'The Brakeman');
    assert.equal(res.body.summary, 'Rides the last car');
    assert.equal(res.body.category, 'Characters');
    assert.deepEqual(res.body.tags, ['train', 'crew']);
    assert.equal(res.body.blocks.length, 2, 'both blocks come back');
    assert.deepEqual(res.body.blocks.map(b => b._id), linked.blocks.map(b => String(b._id)), 'with their own ids, so a later history entry still lines up');
    assert.deepEqual(res.body.blocks[0].data, { text: 'He keeps the couplings honest.' });
    assert.equal(res.body.open_questions.length, 1, 'the open-question back-link comes back');
    assert.equal(res.body.open_questions[0]._id, question._id);

    const stored = await Entity.findById(entity._id).lean();
    assert.equal(String(stored.workspaceId), who.workspaceId, "the restored entity belongs to the caller's workspace");
    assert.deepEqual(stored.relationships, [], 'the delete pruned its relationship groups and a restore does not rebuild them');
  });

  test('records a `created` entry naming the actor, so the restore is itself in the trail', async () => {
    const { who, entity, logId } = await deletedEntity();

    const res = await restore(who, entity._id, logId);
    assert.equal(res.status, 201, JSON.stringify(res.body));

    await waitForLogs(entity._id, 3); // created, deleted, created-by-the-restore
    const created = await ChangeLog.find({ entityId: entity._id, changeType: 'created' }).sort({ createdAt: 1 }).lean();
    assert.equal(created.length, 2, 'the original create and the restore');
    const byRestore = created.at(-1);
    assert.equal(byRestore.actorLabel, who.email, 'attributed to whoever restored it, not to whoever created it');
    assert.equal(byRestore.actorType, 'user');
    assert.equal(byRestore.entityTitle, 'The Brakeman');
    assert.equal(String(byRestore.workspaceId), who.workspaceId);
  });

  test('a second restore is 409, so it never silently overwrites the live entity', async () => {
    const { who, entity, logId } = await deletedEntity();

    assert.equal((await restore(who, entity._id, logId)).status, 201);
    const edited = await who.agent.put(`/entities/${entity._id}`).send({ title: 'The Brakeman, edited' });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));

    const again = await restore(who, entity._id, logId);

    assert.equal(again.status, 409, `the id is live again: ${JSON.stringify(again.body)}`);
    assert.equal(again.body.entityId, entity._id);
    assert.equal(
      (await Entity.findById(entity._id).lean()).title,
      'The Brakeman, edited',
      'the refusal must leave the live entity exactly as it was'
    );
  });

  test('GET /deleted lists the entry and stops listing it once it is restored', async () => {
    const { who, entity, row, logId } = await deletedEntity();

    assert.equal(row.entityTitle, 'The Brakeman');
    assert.equal(row.actorLabel, who.email);
    assert.equal(row.category, 'Characters');
    assert.ok(Date.parse(row.createdAt), `the row carries when it was deleted, got ${row.createdAt}`);
    assert.ok(!('snapshotCategoryMissing' in row), 'a type that is still there must not be flagged');
    assert.equal(row._id, logId, 'and the log id the restore is made with');
    assert.ok(!row.snapshot, 'a page of rows must not carry 50 whole snapshots');

    assert.equal((await restore(who, entity._id, logId)).status, 201);

    const after = await listDeleted(who);
    assert.ok(!after.some(d => d.entityId === entity._id), `a restored entity is not deleted any more: ${JSON.stringify(after)}`);
  });

  test("another workspace's deleted entity is neither listed nor restorable", async () => {
    const { entity, logId } = await deletedEntity();
    const stranger = await freshWorkspace();

    assert.deepEqual(await listDeleted(stranger), [], 'a fresh workspace has deleted nothing, whatever anyone else deleted');

    const res = await restore(stranger, entity._id, logId);
    assert.equal(res.status, 404, `404 rather than 403 — don't confirm the entry exists elsewhere: ${JSON.stringify(res.body)}`);
    assert.equal(await Entity.countDocuments({ _id: entity._id }), 0, 'and nothing may be written');
  });

  test('a snapshot naming a type the registry no longer has is refused, then restores under a chosen one (KOL-059)', async () => {
    const { who, entity, logId } = await deletedEntity();
    await renameType(who, 'Characters', 'People');

    const flagged = (await listDeleted(who)).find(d => d.entityId === entity._id);
    assert.equal(flagged.snapshotCategoryMissing, true, 'the list marks what needs a choice ahead of the click');
    assert.equal(flagged.category, 'Characters', 'a rename does not rewrite the snapshot');

    const refused = await restore(who, entity._id, logId);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.snapshotCategory, 'Characters');
    assert.ok(refused.body.availableCategories.includes('People'), 'the refusal offers the type that replaced it');
    assert.ok(!refused.body.availableCategories.includes('Characters'));
    assert.equal(await Entity.countDocuments({ _id: entity._id }), 0, 'a refused restore writes nothing');

    const chosen = await restore(who, entity._id, logId, { category: 'People' });
    assert.equal(chosen.status, 201, JSON.stringify(chosen.body));
    assert.equal(chosen.body.category, 'People', 'the one field of a snapshot a restore overrides');
    assert.equal(chosen.body.title, 'The Brakeman', 'everything else as recorded');

    const bogus = await deletedEntity({ who: await freshWorkspace() });
    const unknown = await restore(bogus.who, bogus.entity._id, bogus.logId, { category: 'Nonexistent' });
    assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
    assert.equal(await Entity.countDocuments({ _id: bogus.entity._id }), 0, 'nor may a bad choice write');
  });

  test("an 'updated' entry is still 404 when the entity is gone — a delete comes back through its own entry", async () => {
    const who = await freshWorkspace();
    const entity = await createEntity(who, { title: 'v1', category: 'Characters', summary: 'fixture' });
    const edited = await who.agent.put(`/entities/${entity._id}`).send({ title: 'v2' });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    await waitForLogs(entity._id, 2);
    assert.equal((await who.agent.delete(`/entities/${entity._id}`)).status, 204);
    await waitForLogs(entity._id, 3);

    const update = await ChangeLog.findOne({ entityId: entity._id, changeType: 'updated' }).lean();
    const res = await restore(who, entity._id, String(update._id));

    assert.equal(res.status, 404, `an update's snapshot is one version of a live entity, not the whole document: ${JSON.stringify(res.body)}`);
    assert.equal(await Entity.countDocuments({ _id: entity._id }), 0);

    // The 'deleted' entry is the one that brings it back, and it brings back
    // the newest state, not the version the update's snapshot holds.
    const row = (await listDeleted(who)).find(d => d.entityId === entity._id);
    assert.ok(row, 'and it is the one the list offers');
    const back = await restore(who, entity._id, row._id);
    assert.equal(back.status, 201, JSON.stringify(back.body));
    assert.equal(back.body.title, 'v2');
  });
});
