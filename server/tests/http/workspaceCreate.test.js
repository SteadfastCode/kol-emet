/**
 * Creating a second workspace, over the real stack (KOL-123).
 *
 * `POST /auth/register` was the only thing in the product that had ever created
 * a `Workspace`, so every account had exactly one for life: `GET /workspaces`
 * listed one membership, `POST /workspaces/:id/select` had nothing to choose
 * between, and `POST /import` — which only writes into an *empty* workspace —
 * could never be used at all, because the one workspace an account had was
 * seeded at signup.
 *
 * What this file pins, each case the whole way through the stack:
 *
 *   - **a create seeds the named template and the creator owns it**: the
 *     entity-type and relationship-type registries of that template are in the
 *     new workspace, the `role` answered and the stored `members` entry are
 *     both `owner`, and the stored `template` is the key that was seeded;
 *   - **`template: null` leaves it empty, and `POST /import` then accepts it** —
 *     the round trip this item makes reachable. The same import into the
 *     workspace registration seeded is still 409 `WORKSPACE_NOT_EMPTY`, so the
 *     201 is the emptiness and not a weakened rule;
 *   - **an unknown template is 400** in registration's own words and writes
 *     nothing, and an unusable name is 400 `INVALID_WORKSPACE_NAME`;
 *   - **the cap refuses the n+1-th** with its own code, writing nothing;
 *   - **another user's workspaces stay invisible** to `GET /workspaces`, so a
 *     create cannot be a way into someone else's list;
 *   - **the new workspace is not the session's until selected**: the acting
 *     workspace after a create is the one it was before, a write still lands
 *     there, and the existing select route is what moves the session.
 *
 * Everything goes through `createApp()` over supertest against a real mongod —
 * real `POST /auth/register`, real session cookies, real seeding — because what
 * is being asserted is a route, its mount (no `resolveWorkspace`: the caller is
 * not acting in the new workspace yet) and the seeding it triggers, none of
 * which a unit test can see.
 *
 * Falsification checks: let the route select what it creates and the
 * "not the session's" group fails; drop the cap and its group fails; let the
 * `null` template fall through `resolveTemplateKey` to the default and the
 * import group fails on 409; drop the `members` entry and the ownership
 * assertions fail (as would `PATCH /workspace` on the new workspace).
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_WORKSPACE_CREATE_LOG_LEVEL = off | light | normal | verbose (default light)
 * When one of these fails, the missing information is always *which* workspace
 * answered, who owns it and what it was seeded with.
 *   off     — nothing
 *   light   — one line per fixture, naming what created it, and every create
 *   normal  — light, plus each request and the status it answered
 *   verbose — normal, plus whole response bodies
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import session from 'express-session';
import request from 'supertest';

import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';
import * as db from '../helpers/db.js';
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import Entity from '../../src/models/Entity.js';
import EntityType from '../../src/models/EntityType.js';
import RelationshipType from '../../src/models/RelationshipType.js';

// Environment before src/app.js is imported, for the reasons in tenancy.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
// Unset on purpose: with no bearer token configured a stray Authorization
// header cannot resolve to the MCP user and quietly satisfy requireAuth.
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.WORKSPACE_LOG_LEVEL ??= 'off';
process.env.IMPORT_LOG_LEVEL ??= 'off';
// The cap. The route reads `WORKSPACE_MAX_PER_OWNER` per request
// (routes/workspace.js → ownedLimit), so the cap group below narrows it to
// something it can reach in three creates rather than eleven, and everything
// else in this file runs under a ceiling it cannot bump into — a suite that hit
// the real one partway through would fail on something it is not asserting.
const OWNED_LIMIT = 3;
const SUITE_LIMIT = '50';
process.env.WORKSPACE_MAX_PER_OWNER = SUITE_LIMIT;

const { createApp } = await import('../../src/app.js');
const { DEFAULT_TEMPLATE, getTemplate } = await import('../../src/config/templates.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  const active = LEVELS[process.env.TEST_WORKSPACE_CREATE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/workspaceCreate:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';
/** A template that is not the default, so "the named one" means something. */
const OTHER_TEMPLATE = 'software-architecture';

let app;
/** The main fixture: one registered account, one seeded workspace. */
let alice;
/** A second account, for the "another user's workspaces" case. */
let bob;
/** The user whose creates run into the cap. */
let capped;

/** Registers through the real endpoint and reads back the ids it created. */
async function registerUser(email, workspaceName) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD, workspaceName });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id name template').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  log('light', `registered ${email} (source: POST /auth/register) → user ${user._id}, workspace ${workspace._id} "${workspace.name}" from template "${workspace.template}"`);
  return { agent, email, userId: String(user._id), workspaceId: String(workspace._id), workspaceName: workspace.name };
}

/** POSTs a create and asserts nothing about it; the tests do that. */
async function create(who, body, label) {
  const res = await who.agent.post('/workspaces').send(body);
  log('light', `${label ?? 'POST /workspaces'} as ${who.email} with ${JSON.stringify(body)} → ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

async function get(who, path, label) {
  const res = await who.agent.get(path);
  log('normal', `${label ?? `GET ${path}`} as ${who.email} → ${res.status}`);
  log('verbose', JSON.stringify(res.body));
  return res;
}

/** The workspace id `GET /workspace` reports for `who`. */
async function actingWorkspace(who, label) {
  const res = await get(who, '/workspace', label);
  assert.equal(res.status, 200, `GET /workspace as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return String(res.body._id);
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });

  alice = await registerUser('alice@example.test', "Alice's Bible");
  bob = await registerUser('bob@example.test', "Bob's Compendium");
  capped = await registerUser('capped@example.test', 'The First One');
  assert.notEqual(alice.workspaceId, bob.workspaceId, 'two registrations must yield two distinct workspaces');
});

after(async () => { await db.disconnect(); });

describe('POST /workspaces with a template', () => {
  test('is 201, seeds that template, and the creator is its owner', async () => {
    const res = await create(alice, { name: 'The Signal Archive', template: OTHER_TEMPLATE }, 'alice creates from a named template');

    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body).sort(), ['_id', 'createdAt', 'name', 'role'], 'the same body shape as GET /workspace');
    assert.equal(res.body.name, 'The Signal Archive');
    assert.equal(res.body.role, 'owner', 'the creator is an owner of what they created');
    const newId = String(res.body._id);
    assert.notEqual(newId, alice.workspaceId, 'a create must not answer the workspace she already had');

    // The membership, not just `ownerId`: the role in `members` is what every
    // gate in middleware/workspace.js judges.
    const stored = await Workspace.findById(newId).select('name ownerId members template').lean();
    assert.equal(String(stored.ownerId), alice.userId);
    assert.equal(stored.members.length, 1);
    assert.equal(String(stored.members[0].userId), alice.userId);
    assert.equal(stored.members[0].role, 'owner');
    // The key stored is the key seeded — what the assistant's system prompt
    // reads to know what a workspace is about (KOL-105).
    assert.equal(stored.template, OTHER_TEMPLATE);

    // Seeded, and seeded from *that* template: its entity types are there and
    // the default template's are not.
    const template = getTemplate(OTHER_TEMPLATE);
    const types = (await EntityType.find({ workspaceId: newId }).select('name').lean()).map(t => t.name).sort();
    log('verbose', `workspace ${newId} entity types: ${types.join(', ')}`);
    assert.deepEqual(types, template.entityTypes.map(t => t.name).sort(), 'the named template seeded the registry');
    const defaultNames = getTemplate(DEFAULT_TEMPLATE).entityTypes.map(t => t.name);
    assert.ok(!types.some(name => defaultNames.includes(name)), 'and not the default template, which is a different set');

    const relTypes = await RelationshipType.countDocuments({ workspaceId: newId });
    assert.ok(relTypes > 0, 'the relationship picker must not be empty on first use');
    assert.equal(relTypes, template.relationshipTypes.length);
  });

  test('it joins GET /workspaces, oldest first, with her role in each', async () => {
    const res = await get(alice, '/workspaces');

    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2, 'the workspace she registered with, and the one she created');
    assert.deepEqual(res.body.map(w => String(w._id))[0], alice.workspaceId, 'oldest first: registration came first');
    assert.deepEqual(res.body.map(w => w.role), ['owner', 'owner']);
    assert.deepEqual(res.body.map(w => w.name), [alice.workspaceName, 'The Signal Archive']);
  });

  test('naming no template seeds the default one', async () => {
    const res = await create(alice, { name: 'No Template Named' }, 'alice creates without naming a template');

    assert.equal(res.status, 201);
    const stored = await Workspace.findById(res.body._id).select('template').lean();
    assert.equal(stored.template, DEFAULT_TEMPLATE, 'absent means the default, as it does at registration');
    const types = (await EntityType.find({ workspaceId: res.body._id }).select('name').lean()).map(t => t.name).sort();
    assert.deepEqual(types, getTemplate(DEFAULT_TEMPLATE).entityTypes.map(t => t.name).sort());
  });
});

/**
 * The workspace a create leaves empty, and the import it exists for. Before
 * this item `POST /import` was unreachable in the product: it refuses a
 * non-empty workspace and the only workspace an account had was seeded at
 * signup.
 */
describe('POST /workspaces with template: null', () => {
  /** alice's export document, taken from her seeded workspace. */
  let document;
  let emptyId;

  test('leaves the workspace empty — no types, no entities, nothing', async () => {
    const res = await create(bob, { name: 'Somewhere To Land', template: null }, 'bob creates an empty workspace');

    assert.equal(res.status, 201);
    emptyId = String(res.body._id);

    const stored = await Workspace.findById(emptyId).select('template').lean();
    assert.equal(stored.template, null, 'null is stored as null, not resolved to the default');

    assert.equal(await EntityType.countDocuments({ workspaceId: emptyId }), 0, 'nothing seeded the registry');
    assert.equal(await RelationshipType.countDocuments({ workspaceId: emptyId }), 0);
    assert.equal(await Entity.countDocuments({ workspaceId: emptyId }), 0);
  });

  test('and POST /import then accepts it, where the seeded one is 409', async () => {
    // A real export, as tests/http/import.test.js does it: alice's registered
    // workspace holds the template's starter content.
    const exported = await get(alice, '/export', 'GET /export as alice');
    assert.equal(exported.status, 200, 'the case needs a real export to import');
    document = JSON.parse(exported.text);
    assert.ok(document.entities.length > 0, 'a seeded workspace exports its starter entities, or this proves nothing');

    // Into the workspace registration seeded for bob: refused, which is the
    // rule this route has always had and the reason the empty one is needed.
    const refused = await bob.agent.post('/import').send(document);
    log('light', `POST /import into bob's seeded workspace → ${refused.status} ${JSON.stringify(refused.body)}`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'WORKSPACE_NOT_EMPTY');

    // Then into the empty one, through the select route — the import writes to
    // the workspace the session resolves, which is the whole point of having a
    // second one to select.
    const chosen = await bob.agent.post(`/workspaces/${emptyId}/select`).send({});
    assert.equal(chosen.status, 200, `select failed: ${chosen.status} ${JSON.stringify(chosen.body)}`);
    assert.equal(chosen.body.role, 'owner');

    const imported = await bob.agent.post('/import').send(document);
    log('light', `POST /import into the empty workspace ${emptyId} → ${imported.status} ${JSON.stringify(imported.body)}`);
    assert.equal(imported.status, 201, `import failed: ${imported.status} ${JSON.stringify(imported.body)}`);
    assert.equal(imported.body.imported.entities, document.entities.length);

    // The graph really is in the empty workspace now.
    const listed = (await get(bob, '/entities', 'GET /entities in the imported workspace')).body;
    assert.deepEqual(
      listed.map(e => e.title).sort(),
      document.entities.map(e => e.title).sort(),
      "every title in alice's export must be in the workspace bob created empty",
    );
    // An empty workspace has no registry, so the import had to create one.
    assert.ok(await EntityType.countDocuments({ workspaceId: emptyId }) > 0, 'the import brought the type registry with it');

    // Back to his default, so later cases start where they expect to.
    const back = await bob.agent.post(`/workspaces/${bob.workspaceId}/select`).send({});
    assert.equal(back.status, 200);
  });
});

describe('POST /workspaces refusals', () => {
  test('an unknown template is 400 and writes nothing', async () => {
    const before = await Workspace.countDocuments({});

    const res = await create(alice, { name: 'Never Created', template: 'not-a-template' }, 'alice names a template that does not exist');

    assert.equal(res.status, 400);
    // Registration's own wording, so the two cannot drift (KOL-031).
    assert.equal(res.body.error, 'Unknown template');
    assert.equal(await Workspace.countDocuments({}), before, 'no workspace may be written');
    assert.equal(await Workspace.countDocuments({ name: 'Never Created' }), 0);
  });

  test('an unusable name is 400 INVALID_WORKSPACE_NAME and writes nothing', async () => {
    const before = await Workspace.countDocuments({});

    for (const name of ['', '   ', 'x'.repeat(81), 42, { name: 'nice try' }, null, undefined]) {
      const res = await create(alice, { name }, `alice sends ${JSON.stringify(name) ?? 'no name'}`);
      assert.equal(res.status, 400, `${JSON.stringify(name)} must be refused`);
      assert.equal(res.body.error, 'INVALID_WORKSPACE_NAME');
    }

    // The name rule is PATCH /workspace's, counted in code points: 80 emoji is
    // a name and 81 is not.
    const ok = await create(alice, { name: '🙂'.repeat(80), template: null }, 'alice sends 80 code points');
    assert.equal(ok.status, 201, 'the cap is code points, not UTF-16 units');

    assert.equal(await Workspace.countDocuments({}), before + 1, 'exactly the one accepted create');
  });

  test('only name and template are read: a forged members, ownerId or aiBudget is ignored', async () => {
    const res = await create(alice, {
      name: 'Forged Fields',
      template: null,
      _id: '000000000000000000000000',
      ownerId: bob.userId,
      members: [{ userId: bob.userId, role: 'owner' }],
      aiBudget: { grantedMicros: 999_000_000, spentMicros: 0 },
    }, 'alice forges every other field');

    assert.equal(res.status, 201);
    assert.notEqual(String(res.body._id), '000000000000000000000000');
    const stored = await Workspace.findById(res.body._id).select('ownerId members aiBudget').lean();
    assert.equal(String(stored.ownerId), alice.userId, 'the owner is the caller, not the body');
    assert.deepEqual(stored.members.map(m => String(m.userId)), [alice.userId]);
    assert.notEqual(stored.aiBudget.grantedMicros, 999_000_000, 'the allowance is not the caller\'s to set');
  });

  test('an unauthenticated create is 401 and writes nothing', async () => {
    const before = await Workspace.countDocuments({});

    const res = await request(app)
      .post('/workspaces')
      .set('Origin', CLIENT_ORIGIN)
      .send({ name: 'Anonymous Workspace' });
    log('normal', `POST /workspaces unauthenticated → ${res.status} ${JSON.stringify(res.body)}`);

    assert.equal(res.status, 401);
    assert.equal(await Workspace.countDocuments({}), before);
  });
});

/**
 * The cap (`WORKSPACE_MAX_PER_OWNER`). This is an authenticated create loop on
 * an open-registration product and each create writes a workspace plus a whole
 * template seed, so the ceiling is the signup ceiling's precedent (KOL-050,
 * KOL-081) with its own error code.
 */
describe('the cap on workspaces one account may own', () => {
  // Narrowed for this group only, and restored afterwards: the route reads the
  // variable per request, which is what makes a small cap testable at all.
  before(() => {
    process.env.WORKSPACE_MAX_PER_OWNER = String(OWNED_LIMIT);
    log('light', `narrowed WORKSPACE_MAX_PER_OWNER to ${OWNED_LIMIT} for this group (source: the suite's own before hook)`);
  });
  after(() => { process.env.WORKSPACE_MAX_PER_OWNER = SUITE_LIMIT; });

  test(`refuses the ${OWNED_LIMIT + 1}-th with 409 WORKSPACE_LIMIT_REACHED, and writes nothing`, async () => {
    // One from registration, so OWNED_LIMIT - 1 creates reach the cap.
    const owned = () => Workspace.countDocuments({ members: { $elemMatch: { userId: capped.userId, role: 'owner' } } });
    assert.equal(await owned(), 1, 'registration left exactly one');

    for (let i = 2; i <= OWNED_LIMIT; i++) {
      const res = await create(capped, { name: `Number ${i}`, template: null }, `create ${i} of ${OWNED_LIMIT}`);
      assert.equal(res.status, 201, `create ${i} must be allowed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    assert.equal(await owned(), OWNED_LIMIT, 'at the cap');

    const refused = await create(capped, { name: 'One Too Many', template: null }, 'the one over the cap');
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'WORKSPACE_LIMIT_REACHED');
    assert.equal(refused.body.limit, OWNED_LIMIT, 'the refusal says what the cap is');
    assert.equal(await owned(), OWNED_LIMIT, 'and wrote nothing');
    assert.equal(await Workspace.countDocuments({ name: 'One Too Many' }), 0);
  });

  test('a workspace owned by somebody else does not count against them', async () => {
    // alice is over this suite's cap in her own right by now, so a membership
    // in one of hers must not be what refuses a user who owns fewer. The cap
    // counts the `owner` role, not the membership (KOL-124 brings invites).
    const viewerIn = await Workspace.findOne({ 'members.userId': alice.userId }).select('_id').lean();
    await Workspace.updateOne({ _id: viewerIn._id }, { $push: { members: { userId: bob.userId, role: 'viewer' } } });
    log('light', `added bob as a viewer of alice's workspace ${viewerIn._id} (source: direct $push)`);

    const ownedByBob = await Workspace.countDocuments({ members: { $elemMatch: { userId: bob.userId, role: 'owner' } } });
    assert.ok(ownedByBob < OWNED_LIMIT, `bob must be under the cap for this to mean anything (owns ${ownedByBob})`);

    const res = await create(bob, { name: 'Still Allowed', template: null }, 'bob creates while a viewer elsewhere');
    assert.equal(res.status, 201, `a membership somebody else owns must not count: ${res.status} ${JSON.stringify(res.body)}`);

    await Workspace.updateOne({ _id: viewerIn._id }, { $pull: { members: { userId: bob.userId } } });
  });
});

describe("the created workspace is not the session's until it is selected", () => {
  test('the acting workspace is unchanged, and a write still lands in it', async () => {
    const before = await actingWorkspace(alice, 'GET /workspace before the create');

    const created = await create(alice, { name: 'Not Selected', template: null }, 'alice creates one more');
    assert.equal(created.status, 201);

    assert.equal(
      await actingWorkspace(alice, 'GET /workspace after the create'),
      before,
      'a create must not write the session\'s workspace — POST /workspaces/:id/select is the only writer',
    );

    const entity = await alice.agent.post('/entities').send({
      title: 'Written After Creating',
      category: 'Characters',
      summary: 'Must land in the workspace the session was already in.',
    });
    assert.equal(entity.status, 201, `POST /entities failed: ${entity.status} ${JSON.stringify(entity.body)}`);
    assert.equal(String(entity.body.workspaceId), before, 'and neither may a write');

    // The new one is empty precisely because nothing has acted in it.
    assert.equal(await Entity.countDocuments({ workspaceId: created.body._id }), 0);

    // And the existing route is what moves the session into it.
    const chosen = await alice.agent.post(`/workspaces/${created.body._id}/select`).send({});
    assert.equal(chosen.status, 200);
    assert.equal(await actingWorkspace(alice, 'GET /workspace after selecting the new one'), String(created.body._id));

    const back = await alice.agent.post(`/workspaces/${alice.workspaceId}/select`).send({});
    assert.equal(back.status, 200);
  });

  test("another user's created workspaces stay invisible to GET /workspaces", async () => {
    const mine = (await get(bob, '/workspaces')).body.map(w => String(w._id));
    const hers = (await get(alice, '/workspaces')).body.map(w => String(w._id));

    log('normal', `bob sees ${mine.length} workspace(s), alice ${hers.length}`);
    assert.ok(mine.length > 0 && hers.length > 1, 'both fixtures must have workspaces, or this proves nothing');
    assert.ok(!mine.some(id => hers.includes(id)), 'no workspace may appear in both lists');
    // Every row either of them sees is one they are a member of.
    for (const [who, ids] of [[bob, mine], [alice, hers]]) {
      const theirs = (await Workspace.find({ 'members.userId': who.userId }).select('_id').lean()).map(w => String(w._id));
      assert.deepEqual([...ids].sort(), [...theirs].sort(), `${who.email} sees exactly their own memberships`);
    }
  });
});
