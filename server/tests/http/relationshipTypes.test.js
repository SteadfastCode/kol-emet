/**
 * The relationship-label vocabulary (`/relationship-types`) across real accounts.
 *
 * Same harness and reasoning as tenancy.test.js and entityTypes.test.js:
 * `createApp()` over supertest, real `POST /auth/register` — so the seeded
 * vocabulary arrives through the real `seedWorkspace` — and real mongod. The
 * vocabulary is tenant content like any other: a foreign id is 404, never 403,
 * and every type the fixture creates is checked for its owner's workspace id.
 * That write-side check is what goes red if the mount loses `resolveWorkspace`
 * (reads fail closed; creates would stamp null).
 *
 * What this file defends is the gap KOL-159 closed. `scope` has been on the
 * model since the discriminator was added — 'group' for a label on the whole
 * relationship ("Marriage", "Depends on"), 'member' for a label on one end of
 * it ("Wife", "Dependency") — and the generator has split the two to name its
 * edges ever since (`lib/generator.js`). Both writes ignored it: `POST`
 * destructured `{ name, sourceCategory, targetCategory }` and `PUT` the same
 * three, so **every type any client created took the model's 'member' default
 * whatever it sent**, and a `group`-scoped type was reachable only by seeding.
 * With the vocabulary now offered on every label field in
 * `client/src/components/RelationshipsSection.vue`, a type in the wrong scope
 * is a type offered in the wrong place.
 *
 * KOL-165 then closed the half of that gap the same diff opened: `PUT` had
 * **no exact-name check at all**, so the new settings screen's Rename could put
 * a second "owned by" into a workspace that already had one — the `owns`/`Owns`
 * drift the vocabulary exists to prevent, arriving through the one screen built
 * to manage it, while `POST` refused the same name with a 409 and `docs/api.md`
 * claimed `PUT` applied the "same checks as `POST`".
 *
 * Six properties:
 *
 *   - `POST` **stores** the scope it was given, in the response *and* in the
 *     collection, and a body with no scope still gets the 'member' default.
 *   - A scope outside the enum is **400 and writes nothing at all** — not the
 *     type on a create, and on an update not the scope, the name or a category
 *     sent in the same body. Checked before the query rather than left to
 *     `runValidators`, which would answer 500 for a caller's mistake.
 *   - `PUT` **moves a type between scopes**, which is the write that repairs
 *     everything created before KOL-159.
 *   - The two rules KOL-159 deliberately left alone still hold: the exact-name
 *     409 is **across scopes** (a workspace cannot hold "Owner" as both a group
 *     label and a member role) and carries `existing`, and a near-duplicate
 *     name still **creates** with a `warning` beside it.
 *   - A **rename** is refused by that same exact-name 409 (KOL-165), across
 *     scopes and case-insensitively, writing nothing — not the name, and not a
 *     scope sent in the same body. It excludes the row being renamed, so a
 *     change of case alone on its own name still saves; it is exact, so a
 *     near-duplicate rename still saves; a blank or non-string name is the same
 *     `400 Name is required` `POST` gives; and a foreign id is still 404 even
 *     when the name sent with it clashes in the caller's *own* workspace.
 *   - Another workspace's type is **404 on PUT and on DELETE**, and is still
 *     there afterwards.
 *
 * Falsification: drop `readScope` from `POST` and the first group fails with
 * every type on 'member'; drop it from `PUT` and the scope never moves; return
 * the 400 after the write and the "nothing written" assertions fail; make the
 * 409 per-scope and the cross-scope cases fail; drop the clash check from `PUT`
 * and the whole KOL-165 group answers 200; compare the whole workspace instead
 * of excluding the row being renamed and the case-only rename fails; use
 * `findSimilar` for it and the near-duplicate rename fails; read the row after
 * the clash check instead of before and the foreign-id case answers 409.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_RELATIONSHIP_TYPES_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture document: the request that created it, the
 *             scope it landed with and the workspace it landed in
 *   normal  — light, plus each cross-tenant probe and refused write, with the
 *             status it got back
 *   verbose — normal, plus the names and scopes returned by every list read
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import session from 'express-session';

// Every session write is checked against CLIENT_ORIGIN (src/middleware/originGuard.js),
// so this suite names one below and its agents send a matching Origin.
import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';

import * as db from '../helpers/db.js';
// Registration is throttled per client address, and these suites register
// their fixtures through the real endpoint from one address. See the helper.
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import RelationshipType from '../../src/models/RelationshipType.js';

// Environment before src/app.js is imported, for the reasons in tenancy.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.CHANGELOG_LOG_LEVEL ??= 'off';
process.env.SSE_LOG_LEVEL ??= 'off';
// The route logs every write and refusal at the light tier by default (KOL-159);
// what is asserted here is the collection, not the console.
process.env.RELATIONSHIP_TYPE_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');
const { SCOPES } = await import('../../src/routes/relationshipTypes.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_RELATIONSHIP_TYPES_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/relationshipTypes:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

let app;
let alice;
let bob;

/** One of alice's types, marked in before(), for bob to probe. */
let aliceSecret;

/** Registers `email`, naming `template` in the body when one is given. */
async function registerUser(email, template) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD, ...(template && { template }) });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  log('light', `registered ${email} (source: POST /auth/register, template ${template ? `"${template}"` : 'not named'}) → workspace ${workspace._id}`);
  return { agent, email, workspaceId: String(workspace._id) };
}

/** POSTs a type as `who`, asserts it landed in their workspace, returns it. */
async function createType(who, body) {
  const res = await who.agent.post('/relationship-types').send(body);
  assert.equal(res.status, 201, `POST /relationship-types as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(String(res.body.workspaceId), who.workspaceId, `${who.email}'s type must land in their own workspace`);
  log('light', `created relationship type ${res.body._id} "${res.body.name}" scope ${res.body.scope} (source: POST /relationship-types as ${who.email}) in workspace ${res.body.workspaceId}`);
  return res.body;
}

/** GETs `who`'s vocabulary, logging the names and scopes at the 'verbose' tier. */
async function listTypes(who, query = {}) {
  const res = await who.agent.get('/relationship-types').query(query);
  assert.equal(res.status, 200, `GET /relationship-types as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  assert.ok(Array.isArray(res.body), 'GET /relationship-types should return an array');
  log('verbose', `GET /relationship-types${query.q ? `?q=${query.q}` : ''} as ${who.email} → ${res.body.map(t => `${t.name} (${t.scope})`).join(', ') || '(none)'}`);
  return res.body;
}

async function typeNamed(who, name) {
  const type = (await listTypes(who)).find(t => t.name === name);
  assert.ok(type, `${who.email} should have a "${name}" type`);
  return type;
}

/** The stored row, straight from the collection — never the route's answer. */
async function stored(id) {
  return RelationshipType.findById(id).lean();
}

/** Logs a probe or refused write and its answer at the 'normal' tier. */
function probed(who, what, res) {
  log('normal', `${who.email} ${what} → ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });

  alice = await registerUser('alice@example.test');
  bob   = await registerUser('bob@example.test');
  assert.notEqual(alice.workspaceId, bob.workspaceId, 'two registrations must yield two distinct workspaces');

  aliceSecret = await createType(alice, { name: 'Sworn enemy of', scope: 'member' });
});

after(async () => { await db.disconnect(); });

describe('scope on the way in', () => {
  test('the enum the route validates against is the model\'s own', () => {
    assert.deepEqual([...SCOPES].sort(), ['group', 'member'], 'the two label positions, and no third');
  });

  test('POST stores a group scope, in the response and in the collection', async () => {
    const created = await createType(alice, { name: '  Chain of command  ', scope: 'group' });

    assert.equal(created.name, 'Chain of command', 'the name is trimmed');
    assert.equal(created.scope, 'group', 'the scope the body asked for is the scope answered');
    assert.equal((await stored(created._id)).scope, 'group', 'and the scope stored');

    // The half of the vocabulary that was unreachable from any client before
    // KOL-159 — a group label — is now in the list the suggestions read.
    const listed = await typeNamed(alice, 'Chain of command');
    assert.equal(listed.scope, 'group');
  });

  test('POST with no scope still takes the model\'s member default', async () => {
    const created = await createType(alice, { name: 'Quartermaster of' });

    assert.equal(created.scope, 'member', "'member' is the larger vocabulary and the default");
    assert.equal((await stored(created._id)).scope, 'member');
  });

  test('a scope outside the enum is 400, and writes nothing', async () => {
    const before = await RelationshipType.countDocuments({ workspaceId: alice.workspaceId });

    const refused = probed(alice, 'POST /relationship-types scope "entity"',
      await alice.agent.post('/relationship-types').send({ name: 'Flagship of', scope: 'entity' }));

    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /scope must be one of: group, member/);
    assert.equal(await RelationshipType.countDocuments({ workspaceId: alice.workspaceId }), before,
      'a refused create writes no type at all');
    assert.ok(!(await listTypes(alice)).some(t => t.name === 'Flagship of'), 'and nothing is listed');
  });

  test('a scope outside the enum on PUT is 400, and the name in the same body is not written either', async () => {
    const type = await createType(alice, { name: 'Harbourmaster of', scope: 'member' });

    const refused = probed(alice, `PUT /relationship-types/${type._id} scope null, name "Harbour authority"`,
      await alice.agent.put(`/relationship-types/${type._id}`).send({ name: 'Harbour authority', scope: null }));

    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /scope must be one of: group, member/);
    const after = await stored(type._id);
    assert.equal(after.name, 'Harbourmaster of', 'the name in the refused body is not written');
    assert.equal(after.scope, 'member', 'nor the scope');
  });

  test('PUT moves a type between scopes, and the move is what repairs a pre-KOL-159 row', async () => {
    // The shape every create made before the route read `scope`: a group label
    // that the model's default filed as a member role.
    const wrong = await RelationshipType.create({ name: 'Blood feud', workspaceId: alice.workspaceId });
    assert.equal(wrong.scope, 'member', 'the default is what put it in the wrong vocabulary');

    const moved = probed(alice, `PUT /relationship-types/${wrong._id} scope group`,
      await alice.agent.put(`/relationship-types/${wrong._id}`).send({ scope: 'group' }));

    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.scope, 'group');
    assert.equal(moved.body.name, 'Blood feud', 'a scope-only patch leaves the name alone');
    assert.equal((await stored(wrong._id)).scope, 'group');

    // And back again, with a rename in the same body.
    const back = await alice.agent.put(`/relationship-types/${wrong._id}`).send({ name: 'Feuding with', scope: 'member' });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.deepEqual([back.body.name, back.body.scope], ['Feuding with', 'member']);
  });
});

describe('what KOL-159 left exactly as it was', () => {
  test('an exact name is 409 across scopes, and carries the type that holds it', async () => {
    const member = await createType(alice, { name: 'Shipwright of', scope: 'member' });

    // Not a per-scope check: one workspace cannot hold the name twice, in
    // either position. The settings screen's only account of a refused rename
    // is this sentence, so the body has to name the row that holds the name.
    const dup = probed(alice, 'POST /relationship-types "shipwright of" as a group label',
      await alice.agent.post('/relationship-types').send({ name: 'shipwright of', scope: 'group' }));

    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'Relationship type already exists');
    assert.equal(dup.body.existing.name, 'Shipwright of');
    assert.equal(String(dup.body.existing._id), String(member._id));
    assert.equal((await stored(member._id)).scope, 'member', 'the refused create did not move the existing row');
  });

  test('a near-duplicate name still creates, with a warning beside it', async () => {
    await createType(alice, { name: 'Navigator of', scope: 'member' });

    const near = await alice.agent.post('/relationship-types').send({ name: 'Navigater of', scope: 'group' });
    assert.equal(near.status, 201, JSON.stringify(near.body));
    log('normal', `near-duplicate create → ${near.status} warning ${JSON.stringify(near.body.warning)}`);

    assert.match(near.body.warning, /Similar types exist: .*Navigator of/);
    assert.equal(near.body.scope, 'group', 'the warning does not cost it the scope it asked for');
    assert.ok(await stored(near.body._id), 'the type was created — the warning is a warning');
  });
});

describe('a rename into a name the workspace already holds (KOL-165)', () => {
  test('is 409 with the row that holds it, and writes nothing', async () => {
    const held = await createType(alice, { name: 'Cartographer of', scope: 'member' });
    const renaming = await createType(alice, { name: 'Dockmaster of', scope: 'member' });

    // Case-insensitive, like POST's: "owns" and "Owns" are the same word to a
    // vocabulary whose whole job is to stop a workspace collecting both.
    const refused = probed(alice, `PUT /relationship-types/${renaming._id} name "cartographer of"`,
      await alice.agent.put(`/relationship-types/${renaming._id}`).send({ name: 'cartographer of' }));

    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'Relationship type already exists');
    assert.equal(refused.body.existing.name, 'Cartographer of', 'the 409 names the row that holds the name');
    assert.equal(String(refused.body.existing._id), String(held._id));

    const after = await stored(renaming._id);
    assert.equal(after.name, 'Dockmaster of', 'the refused rename is not written');
    assert.equal((await stored(held._id)).name, 'Cartographer of', 'and the row that holds the name is untouched');
  });

  test('is across scopes, and the scope in the same body is not written either', async () => {
    await createType(alice, { name: 'Guild charter', scope: 'group' });
    const member = await createType(alice, { name: 'Cooper of', scope: 'member' });

    // One workspace cannot hold a name as both a group label and a member role,
    // so a rename cannot reach a name by changing scope in the same breath.
    const refused = probed(alice, `PUT /relationship-types/${member._id} name "guild charter" scope group`,
      await alice.agent.put(`/relationship-types/${member._id}`).send({ name: 'guild charter', scope: 'group' }));

    assert.equal(refused.status, 409);
    assert.equal(refused.body.existing.scope, 'group');

    const after = await stored(member._id);
    assert.deepEqual([after.name, after.scope], ['Cooper of', 'member'],
      'a refused rename writes neither the name nor the scope sent with it');
  });

  test('excludes the row being renamed, so a change of case alone on its own name saves', async () => {
    const own = await createType(alice, { name: 'Lamplighter of', scope: 'member' });

    const saved = probed(alice, `PUT /relationship-types/${own._id} name "lamplighter OF"`,
      await alice.agent.put(`/relationship-types/${own._id}`).send({ name: 'lamplighter OF' }));

    assert.equal(saved.status, 200, 'a row may not clash with itself');
    assert.equal(saved.body.name, 'lamplighter OF');
    assert.equal((await stored(own._id)).name, 'lamplighter OF');
  });

  test('is exact, so a near-duplicate rename still saves', async () => {
    await createType(alice, { name: 'Beekeeper of', scope: 'member' });
    const renaming = await createType(alice, { name: 'Apiarist of', scope: 'member' });

    // The near-duplicate rule is a warning on POST and the check here is the
    // exact one: a vocabulary that refused every similar rename could not be
    // corrected a letter at a time.
    const saved = await alice.agent.put(`/relationship-types/${renaming._id}`).send({ name: 'Beekeper of' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await stored(renaming._id)).name, 'Beekeper of');
  });

  test('a blank or non-string name is 400, and writes nothing', async () => {
    const type = await createType(alice, { name: 'Ropemaker of', scope: 'group' });

    for (const name of ['   ', '', null, 42]) {
      const refused = probed(alice, `PUT /relationship-types/${type._id} name ${JSON.stringify(name)}`,
        await alice.agent.put(`/relationship-types/${type._id}`).send({ name, scope: 'member' }));

      assert.equal(refused.status, 400, `name ${JSON.stringify(name)} must be a 400, never a 500`);
      assert.equal(refused.body.error, 'Name is required');
      const after = await stored(type._id);
      assert.deepEqual([after.name, after.scope], ['Ropemaker of', 'group'],
        'the refused body writes neither the name nor the scope sent with it');
    }
  });

  test("a foreign id is still 404, even when the name clashes in the caller's own workspace", async () => {
    // The row is read before any name is compared: a 409 for an id bob does not
    // own would answer a rename of a row that is not there to rename.
    await createType(bob, { name: 'Shared word', scope: 'member' });

    const refused = probed(bob, `PUT /relationship-types/${aliceSecret._id} name "Shared word"`,
      await bob.agent.put(`/relationship-types/${aliceSecret._id}`).send({ name: 'Shared word' }));

    assert.equal(refused.status, 404);
    assert.equal(refused.body.error, 'Not found');
    assert.equal((await stored(aliceSecret._id)).name, 'Sworn enemy of');
  });
});

describe('another workspace', () => {
  test("alice's type is 404 on PUT and on DELETE for bob, and is still there afterwards", async () => {
    const put = probed(bob, `PUT /relationship-types/${aliceSecret._id}`,
      await bob.agent.put(`/relationship-types/${aliceSecret._id}`).send({ name: 'Taken over', scope: 'group' }));
    assert.equal(put.status, 404, 'a foreign id is 404, never 403: nothing may confirm it exists elsewhere');
    assert.equal(put.body.error, 'Not found');

    const del = probed(bob, `DELETE /relationship-types/${aliceSecret._id}`,
      await bob.agent.delete(`/relationship-types/${aliceSecret._id}`));
    assert.equal(del.status, 404);

    const survivor = await stored(aliceSecret._id);
    assert.ok(survivor, "alice's type survived both");
    assert.deepEqual([survivor.name, survivor.scope], ['Sworn enemy of', 'member']);
    assert.ok(!(await listTypes(bob)).some(t => String(t._id) === String(aliceSecret._id)),
      "and never appears in bob's vocabulary");
  });

  test("bob's own create lands in bob's workspace, not alice's", async () => {
    const mine = await createType(bob, { name: 'Rival of', scope: 'group' });
    assert.equal(String((await stored(mine._id)).workspaceId), bob.workspaceId);
    assert.ok(!(await listTypes(alice)).some(t => String(t._id) === String(mine._id)));
  });
});
