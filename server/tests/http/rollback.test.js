/**
 * Rolling an entity back to a snapshot whose entity type is gone (KOL-059).
 *
 * `Entity.category` names a type by name and snapshots record the name as it
 * was spelled then. Renaming a type cascades to the entities using it but
 * writes no `ChangeLog`, so every earlier snapshot keeps the old name — and the
 * registry, which is the only gate on category names, no longer has it. The
 * restore used to die in the `categoryValidator` and come back as a 500: a
 * permanent failure reported as a server fault, with the version unreachable.
 *
 * What is pinned here is the answer instead: a **409** naming the stale type and
 * the workspace's current ones, writing nothing, and a 200 for the same call
 * carrying `{ category }` — the caller's decision — with the entity ending up
 * under the chosen type and the rest of the snapshot restored as recorded. A
 * deleted type is the same condition and gets the same answer. `GET
 * /entities/:id/history` marks exactly the entries that need a choice, from one
 * registry read for the page however many entries it holds (asserted by
 * counting `EntityType.find` calls — the per-entry version was the obvious
 * wrong implementation).
 *
 * Harness as tenancy.test.js and entityTypes.test.js: `createApp()` over
 * supertest, real `POST /auth/register` so the six default types arrive through
 * the real seeder, real mongod. Each test registers its own account, so no test
 * inherits another's renames. Entity writes log fire-and-forget
 * (routes/entities.js), so the fixtures wait for the entry rather than assuming
 * it landed — see `waitForLogs`.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_ROLLBACK_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture: the request that made it and what it holds
 *   normal  — light, plus every rollback attempt and the status it got back
 *   verbose — normal, plus each history page's entries and their flags
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
import EntityType from '../../src/models/EntityType.js';
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
  const active = LEVELS[process.env.TEST_ROLLBACK_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/rollback:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

let app;
let accounts = 0;

/** A fresh account, through the real endpoint, so its registry is the real seed. */
async function freshWorkspace() {
  const email = `rollback-${++accounts}@example.test`;
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

async function updateEntity(who, id, body) {
  const res = await who.agent.put(`/entities/${id}`).send(body);
  assert.equal(res.status, 200, `PUT /entities/${id} failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('light', `updated entity ${id} → ${JSON.stringify(body)} (source: PUT /entities as ${who.email})`);
  return res.body;
}

/**
 * Waits until `entityId` has `count` change log entries. The entity routes log
 * fire-and-forget, so a test that read the history straight after a PUT would
 * race the write that is the whole point of it.
 */
async function waitForLogs(entityId, count) {
  for (let i = 0; i < 100; i++) {
    if (await ChangeLog.countDocuments({ entityId }) >= count) return;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.fail(`entity ${entityId} never reached ${count} change log entr${count === 1 ? 'y' : 'ies'}`);
}

/** Renames one of `who`'s types by name, through the real cascade. */
async function renameType(who, from, to) {
  const type = (await who.agent.get('/entity-types')).body.find(t => t.name === from);
  assert.ok(type, `${who.email} should have a "${from}" type`);
  const res = await who.agent.put(`/entity-types/${type._id}`).send({ name: to });
  assert.equal(res.status, 200, `PUT /entity-types (${from} → ${to}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('light', `renamed "${from}" → "${to}", relabelling ${JSON.stringify(res.body.relabelled)} (source: PUT /entity-types as ${who.email})`);
  return res.body;
}

async function deleteType(who, name) {
  const type = (await who.agent.get('/entity-types')).body.find(t => t.name === name);
  assert.ok(type, `${who.email} should have a "${name}" type`);
  const res = await who.agent.delete(`/entity-types/${type._id}`);
  assert.equal(res.status, 204, `DELETE "${name}" failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('light', `deleted entity type "${name}" (source: DELETE /entity-types as ${who.email})`);
}

async function history(who, entityId) {
  const res = await who.agent.get(`/entities/${entityId}/history`);
  assert.equal(res.status, 200, `GET history failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('verbose', `history of ${entityId}: ${res.body.map(e => `${e.changeType}/${e.snapshot?.category ?? '—'}${e.snapshotCategoryMissing ? ' [stale]' : ''}`).join(', ')}`);
  return res.body;
}

async function rollback(who, entityId, logId, body = undefined) {
  const res = await who.agent.post(`/entities/${entityId}/rollback/${logId}`).send(body ?? {});
  log('normal', `POST rollback ${entityId}/${logId} ${body ? JSON.stringify(body) : '(no body)'} → ${res.status} ${res.status === 200 ? `category "${res.body.category}", title "${res.body.title}"` : JSON.stringify(res.body)}`);
  return res;
}

/**
 * A workspace with one entity renamed once, then its type renamed — the shape
 * every assertion below is about. Returns the ids and the two names.
 */
async function staleSnapshot({ from = 'Characters', to = 'People' } = {}) {
  const who = await freshWorkspace();
  const entity = await createEntity(who, { title: 'Original', category: from, summary: 'fixture' });
  await updateEntity(who, entity._id, { title: 'Current' });
  await waitForLogs(entity._id, 2); // 'created' (no snapshot) + 'updated' (snapshot)
  await renameType(who, from, to);

  const entries = await history(who, entity._id);
  const update = entries.find(e => e.changeType === 'updated');
  assert.ok(update, 'the update should be in the history');
  assert.equal(update.snapshot.category, from, 'the snapshot must still hold the pre-rename name — that is the bug being handled');
  return { who, entity, update, entries, from, to };
}

before(async () => {
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });
  await db.connect();
});

beforeEach(async () => { await db.clear(); });

after(async () => { await db.disconnect(); });

describe('rollback to a snapshot whose entity type was renamed', () => {
  test('answers 409 naming the stale category and the workspace\'s types, and changes nothing', async () => {
    const { who, entity, update, from, to } = await staleSnapshot();

    const res = await rollback(who, entity._id, update._id);

    assert.equal(res.status, 409, `a stale snapshot category is the caller's decision, not a server fault: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.snapshotCategory, from, 'the refusal must name the type the version was saved under');
    assert.ok(Array.isArray(res.body.availableCategories), 'the refusal must offer the types to choose from');
    assert.ok(res.body.availableCategories.includes(to), `"${to}" — the type that replaced it — must be among them`);
    assert.ok(!res.body.availableCategories.includes(from), `"${from}" is gone and must not be offered`);
    assert.match(res.body.error, new RegExp(from), 'the message must name the stale type');

    const unchanged = await Entity.findById(entity._id).lean();
    assert.equal(unchanged.title, 'Current', 'a refused rollback must not restore anything');
    assert.equal(unchanged.category, to, 'and must not move the entity off the type the rename gave it');
    assert.equal(await ChangeLog.countDocuments({ entityId: entity._id }), 2, 'and must not record a change of its own');
  });

  test('restores under the type the caller names, with the rest of the snapshot as recorded', async () => {
    const { who, entity, update, to } = await staleSnapshot();

    const res = await rollback(who, entity._id, update._id, { category: to });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.category, to, 'the entity must hold the type the caller chose');
    assert.equal(res.body.title, 'Original', 'and the version must actually be restored');

    const stored = await Entity.findById(entity._id).lean();
    assert.equal(stored.title, 'Original');
    assert.equal(stored.category, to);
    await waitForLogs(entity._id, 3);
    log('normal', `the restore recorded its own entry, so it is itself reversible`);
  });

  test('refuses a chosen category the workspace does not have, and a blank one', async () => {
    const { who, entity, update, from } = await staleSnapshot();

    const unknown = await rollback(who, entity._id, update._id, { category: 'Nonexistent' });
    assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
    assert.match(unknown.body.error, /Nonexistent/, 'the message must name what the caller sent, not the snapshot');
    assert.equal(unknown.body.snapshotCategory, from);
    assert.ok(unknown.body.availableCategories.length, 'and still offer the real types');

    const blank = await rollback(who, entity._id, update._id, { category: '   ' });
    assert.equal(blank.status, 400, JSON.stringify(blank.body));

    assert.equal((await Entity.findById(entity._id).lean()).title, 'Current', 'neither may write');
  });

  test('a deleted type behaves exactly as a renamed one does', async () => {
    const who = await freshWorkspace();
    // A type of its own, not a seeded one: the seeded six are each named by
    // the example entities and the relationship vocabulary registration
    // creates, and a type anything still uses cannot be deleted at all.
    const made = await who.agent.post('/entity-types').send({ name: 'Vehicles' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    log('light', `created entity type "Vehicles" (source: POST /entity-types as ${who.email})`);

    const entity = await createEntity(who, { title: 'Original', category: 'Vehicles', summary: 'fixture' });
    await updateEntity(who, entity._id, { title: 'Current' });
    await waitForLogs(entity._id, 2);
    // Nothing may still use the type when it is deleted, so the entity moves
    // off it first. Its snapshots still name it.
    await updateEntity(who, entity._id, { category: 'Characters' });
    await waitForLogs(entity._id, 3);
    await deleteType(who, 'Vehicles');

    const entries = await history(who, entity._id);
    const stale = entries.filter(e => e.snapshot?.category === 'Vehicles');
    assert.equal(stale.length, 2, 'both snapshots taken while it was in "Vehicles" hold that name');
    for (const entry of stale) assert.equal(entry.snapshotCategoryMissing, true, 'a deleted type is as missing as a renamed one');

    const refused = await rollback(who, entity._id, stale[0]._id);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.snapshotCategory, 'Vehicles');
    assert.ok(!refused.body.availableCategories.includes('Vehicles'), 'a deleted type must not be offered back');

    const chosen = await rollback(who, entity._id, stale[0]._id, { category: 'Characters' });
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    assert.equal(chosen.body.category, 'Characters');
    assert.equal(chosen.body.title, 'Current', 'the newest stale snapshot is the one that was restored');
  });

  test('a rollback needing no choice is unchanged — no body, and the snapshot\'s own category', async () => {
    const who = await freshWorkspace();
    const entity = await createEntity(who, { title: 'Original', category: 'Characters', summary: 'fixture' });
    await updateEntity(who, entity._id, { title: 'Current', summary: 'edited' });
    await waitForLogs(entity._id, 2);

    const entries = await history(who, entity._id);
    const update = entries.find(e => e.changeType === 'updated');
    assert.ok(!('snapshotCategoryMissing' in update), 'a type that is still there must not be flagged');

    const res = await rollback(who, entity._id, update._id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.title, 'Original');
    assert.equal(res.body.summary, 'fixture');
    assert.equal(res.body.category, 'Characters', "the snapshot's own category restores when it is still a type");
  });
});

describe('GET /entities/:id/history flags what needs a choice', () => {
  test('marks exactly the entries whose snapshot category is gone, and no others', async () => {
    const who = await freshWorkspace();
    const entity = await createEntity(who, { title: 'v1', category: 'Characters', summary: 'fixture' });
    await updateEntity(who, entity._id, { title: 'v2' });                        // snapshot: Characters
    await updateEntity(who, entity._id, { category: 'Worlds' });                 // snapshot: Characters
    await updateEntity(who, entity._id, { title: 'v3' });                        // snapshot: Worlds
    await waitForLogs(entity._id, 4);
    await renameType(who, 'Characters', 'People');

    const entries = await history(who, entity._id);
    assert.equal(entries.length, 4);

    const flagged = entries.filter(e => e.snapshotCategoryMissing);
    assert.equal(flagged.length, 2, 'exactly the two snapshots taken while the entity was in "Characters"');
    for (const entry of flagged) assert.equal(entry.snapshot.category, 'Characters');

    for (const entry of entries.filter(e => !e.snapshotCategoryMissing)) {
      assert.ok(
        entry.snapshot === null || entry.snapshot.category === 'Worlds',
        `only the 'created' entry (no snapshot) and the "Worlds" snapshot may go unflagged, not ${JSON.stringify(entry.snapshot?.category)}`
      );
      assert.ok(!('snapshotCategoryMissing' in entry), 'an unaffected entry carries no flag at all');
    }
  });

  test('reads the registry once for the whole page, not once per entry', async () => {
    const who = await freshWorkspace();
    const entity = await createEntity(who, { title: 'v1', category: 'Characters', summary: 'fixture' });
    for (let i = 2; i <= 6; i++) await updateEntity(who, entity._id, { title: `v${i}` });
    await waitForLogs(entity._id, 6);

    // Counted at the model, so it covers the route and the registry helper
    // both: a per-entry check would be six reads for this page.
    const real = EntityType.find;
    let reads = 0;
    EntityType.find = function (...args) { reads++; return real.apply(this, args); };
    try {
      const entries = await history(who, entity._id);
      assert.equal(entries.length, 6, 'six entries to check');
    } finally {
      EntityType.find = real;
    }
    assert.equal(reads, 1, `the page must cost one registry read however many entries it holds, got ${reads}`);
  });
});
