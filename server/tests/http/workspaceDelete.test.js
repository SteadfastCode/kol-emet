/**
 * Deleting a workspace, over the real stack (KOL-133).
 *
 * `DELETE /workspaces/:id` is the one tenancy verb the product had never had:
 * a workspace made by a mis-click, from the wrong template or for an import
 * that was abandoned was permanent, counted against `WORKSPACE_MAX_PER_OWNER`
 * for the life of the account, and nothing could clear what was inside it
 * short of deleting the whole account.
 *
 * What this file pins, each case the whole way through the stack:
 *
 *   - **an owner's delete takes everything in that workspace with it** — its
 *     entities, drafts, changelog rows, conversations and pending invites —
 *     and leaves the workspace they kept completely untouched, which is the
 *     assertion that the sweep is scoped and not a `deleteMany({})`;
 *   - **an editor is refused** 403 `NOT_WORKSPACE_OWNER` and the workspace and
 *     its content survive;
 *   - **a well-formed id in another tenant is 404, never 403**, and writes
 *     nothing, so the API cannot be used to learn that another tenant's
 *     workspace exists;
 *   - **the caller's only workspace is 409 `LAST_WORKSPACE`**, because
 *     `resolveWorkspace` answers 403 to an account with no membership and
 *     deleting the last one would lock its owner out of the product;
 *   - **a collaborator's membership goes with the workspace** while their own
 *     workspaces, and their account, stay;
 *   - **an open `/events` stream watching it is closed with a named reason** —
 *     `workspace-deleted`, deliberately not the `session-ended` the client
 *     treats as final (KOL-112), because the credential is fine and the
 *     reconnect is what lands it in the fallback workspace;
 *   - **a session whose selection was the deleted workspace resolves the
 *     fallback on its next request**, rather than 403: the route leaves
 *     `session.workspaceId` alone on purpose and `resolveWorkspace` documents
 *     this exact case.
 *
 * Everything goes through `createApp()` over supertest against a real mongod —
 * real registration, real session cookies, real seeding — plus one listening
 * server of its own for the SSE case, because supertest buffers a response to
 * completion and an `/events` response is never completed.
 *
 * Falsification checks: take the owner check off the route and the editor group
 * passes a delete; answer 403 instead of 404 for another tenant's id and that
 * group fails; drop the `LAST_WORKSPACE` floor and its group deletes the only
 * workspace; read the role from `resolveWorkspace` instead of the named
 * workspace's own members and the "owner of one, editor of another" case lets
 * a delete through; drop `closeStreamsForWorkspace` and the stream stays open;
 * clear `session.workspaceId` in the route and the fallback case sees a
 * selection of nothing rather than the documented fallback.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_WORKSPACE_DELETE_LOG_LEVEL = off | light | normal | verbose (default light)
 * When one of these fails, the missing information is always *which* workspace
 * answered and who was asking.
 *   off     — nothing
 *   light   — one line per fixture, naming what created it, and every delete
 *   normal  — light, plus each request and the status it answered
 *   verbose — normal, plus whole response bodies and per-collection counts
 */

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import session from 'express-session';

import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';
import * as db from '../helpers/db.js';
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import WorkspaceInvite from '../../src/models/WorkspaceInvite.js';
import Entity from '../../src/models/Entity.js';
import EntityType from '../../src/models/EntityType.js';
import RelationshipType from '../../src/models/RelationshipType.js';
import Draft from '../../src/models/Draft.js';
import Conversation from '../../src/models/Conversation.js';
import ChangeLog from '../../src/models/ChangeLog.js';

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
process.env.SSE_LOG_LEVEL ??= 'off';
// The sweep logs at 'light' by default; silenced here unless a failure needs it.
process.env.ACCOUNT_DELETE_LOG_LEVEL ??= 'off';
// Each fixture here owns two or three workspaces, well under the real cap, but
// said out loud so a change to the default cannot make this file fail on
// something it is not asserting.
process.env.WORKSPACE_MAX_PER_OWNER = '50';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  const active = LEVELS[process.env.TEST_WORKSPACE_DELETE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/workspaceDelete:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The session store the app is built with. */
const store = new session.MemoryStore();

let app;
/** A listening server for the SSE case; supertest cannot hold a stream open. */
let server;
let port;

/** Registers through the real endpoint and reads back the ids it created. */
async function registerUser(email, workspaceName) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD, workspaceName });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id name').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  const who = {
    agent,
    email,
    userId: String(user._id),
    cookie: cookieHeader(res.headers['set-cookie']),
    workspaceId: String(workspace._id),
    workspaceName: workspace.name,
  };
  log('light', `registered ${email} (source: POST /auth/register) → user ${who.userId}, workspace ${who.workspaceId} "${who.workspaceName}"`);
  return who;
}

/** `Set-Cookie` as a `Cookie` request header: names and values only. */
const cookieHeader = (setCookie) => (setCookie ?? []).map((c) => c.split(';')[0]).join('; ');

/** A second workspace for `who`, through the real create route. Empty by default. */
async function createWorkspace(who, name, template = null) {
  const res = await who.agent.post('/workspaces').send({ name, template });
  assert.equal(res.status, 201, `POST /workspaces (${name}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('light', `${who.email} created workspace ${res.body._id} "${name}" (source: POST /workspaces, template ${JSON.stringify(template)})`);
  return String(res.body._id);
}

/** Makes `workspaceId` the one `who`'s session acts in. */
async function select(who, workspaceId) {
  const res = await who.agent.post(`/workspaces/${workspaceId}/select`).send({});
  assert.equal(res.status, 200, `POST /workspaces/${workspaceId}/select failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('normal', `${who.email} now acts in ${workspaceId} (source: POST /workspaces/:id/select)`);
  return res.body;
}

async function del(who, workspaceId, label) {
  const res = await who.agent.delete(`/workspaces/${workspaceId}`).send({});
  log('light', `${label ?? `DELETE /workspaces/${workspaceId}`} as ${who.email} → ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

/**
 * A row in each of the collections this item's description names, written
 * straight through the models: what is being asserted is the sweep, not the
 * routes that would otherwise have to exist for drafts and changelog rows.
 */
async function seedContent(workspaceId, userId, label) {
  // A category of this fixture's own: the workspace registration seeded already
  // has the template's types, and the registry is unique per workspace.
  const category = `${label}-worlds`;
  await EntityType.create({ name: category, workspaceId });
  const entity = await Entity.create({ title: `${label} entity`, category, summary: 'fixture', workspaceId });
  await RelationshipType.create({ name: `${label} ally`, workspaceId });
  await Draft.create({ workspaceId, createdBy: userId, title: `${label} draft` });
  await Conversation.create({ workspaceId, userId, provider: 'test', model: 'test' });
  await ChangeLog.create({
    workspaceId,
    entityId: entity._id,
    entityTitle: entity.title,
    changeType: 'created',
    actorId: userId,
    actorType: 'user',
    actorLabel: label,
  });
  await WorkspaceInvite.create({
    workspaceId,
    email: `${label}-invitee@example.test`,
    role: 'editor',
    invitedBy: userId,
  });
  log('light', `seeded content into workspace ${workspaceId} (source: this test's models, for the ${label} fixture)`);
  return { entityId: String(entity._id) };
}

/** How many documents each scoped collection holds for one workspace. */
async function countsFor(workspaceId) {
  const models = { Entity, EntityType, RelationshipType, Draft, Conversation, ChangeLog, WorkspaceInvite };
  const out = {};
  for (const [name, model] of Object.entries(models)) {
    out[name] = await model.countDocuments({ workspaceId });
  }
  log('verbose', `workspace ${workspaceId}: ${JSON.stringify(out)}`);
  return out;
}

const total = (counts) => Object.values(counts).reduce((sum, n) => sum + n, 0);

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: store, authLimits: SUITE_AUTH_LIMITS });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  port = server.address().port;
  log('light', `app listening on 127.0.0.1:${port} (source: app.listen(0), for the /events case)`);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.disconnect();
});

/**
 * The ordinary case: an owner deletes the second of their two workspaces.
 *
 * Deliberately not a `db.clear()` suite — every group here registers its own
 * accounts, so each one's "the other workspace is untouched" assertion is made
 * against a database that really does hold other tenants' rows.
 */
describe('an owner deleting a second workspace', () => {
  let alice;
  let keptId;
  let goneId;
  let keptBefore;

  before(async () => {
    alice = await registerUser('alice@example.test', "Alice's Bible");
    keptId = alice.workspaceId;
    goneId = await createWorkspace(alice, 'The Abandoned Import');
    await seedContent(keptId, alice.userId, 'kept');
    await seedContent(goneId, alice.userId, 'gone');
    keptBefore = await countsFor(keptId);
    assert.ok(total(keptBefore) > 0, 'the fixture put nothing in the workspace that must survive');
    assert.ok(total(await countsFor(goneId)) > 0, 'the fixture put nothing in the workspace being deleted');
  });

  test('answers 204 and the workspace row is gone', async () => {
    const res = await del(alice, goneId, 'alice deletes her second workspace');

    assert.equal(res.status, 204);
    assert.deepEqual(res.body, {}, 'a delete has nothing left to describe');
    assert.equal(await Workspace.countDocuments({ _id: goneId }), 0);
  });

  test('its entities, drafts, changelog rows and pending invites went with it', async () => {
    const after = await countsFor(goneId);

    assert.equal(total(after), 0, `documents survived the deletion: ${JSON.stringify(after)}`);
    // Named one by one as well, so a sweep that quietly stopped covering one
    // collection fails on the collection rather than on an arithmetic total.
    assert.equal(after.Entity, 0);
    assert.equal(after.Draft, 0, 'a draft is hard-deleted here, as it is by an account deletion');
    assert.equal(after.ChangeLog, 0);
    assert.equal(after.WorkspaceInvite, 0, 'a pending invite into a workspace that no longer exists');
    assert.equal(after.Conversation, 0);
    assert.equal(after.EntityType, 0);
    assert.equal(after.RelationshipType, 0);
  });

  test('the workspace she kept is untouched, down to the document counts', async () => {
    assert.deepEqual(await countsFor(keptId), keptBefore);
    assert.equal(await Workspace.countDocuments({ _id: keptId }), 1);
    // And her account is still there: this deletes a workspace, not a user.
    assert.equal(await User.countDocuments({ _id: alice.userId }), 1);
  });

  test('it is gone from GET /workspaces, and deleting it again is 404', async () => {
    const list = await alice.agent.get('/workspaces');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map((w) => String(w._id)), [keptId]);

    const again = await del(alice, goneId, 'alice deletes it twice');
    assert.equal(again.status, 404, 'a second delete must not find a membership to authorize');
  });
});

/** The refusals. Each one must write nothing. */
describe('the three refusals', () => {
  let owner;
  let editor;
  let stranger;
  /** The workspace `editor` is an editor of, and `owner` owns. */
  let sharedId;

  before(async () => {
    owner = await registerUser('owner@example.test', "Owner's First");
    editor = await registerUser('editor@example.test', "Editor's Own");
    stranger = await registerUser('stranger@example.test', "Stranger's Own");

    sharedId = await createWorkspace(owner, 'The Shared Compendium');
    await seedContent(sharedId, owner.userId, 'shared');

    // A real invite, accepted through the real route, so the membership under
    // test is the one the product actually writes.
    await select(owner, sharedId);
    const invited = await owner.agent.post('/workspace/invites').send({ email: editor.email, role: 'editor' });
    assert.equal(invited.status, 201, `POST /workspace/invites failed: ${invited.status} ${JSON.stringify(invited.body)}`);
    const mine = await editor.agent.get('/invites');
    assert.equal(mine.status, 200);
    const accepted = await editor.agent.post(`/invites/${mine.body[0]._id}/accept`).send({});
    assert.equal(accepted.status, 200, `POST /invites/:id/accept failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
    log('light', `${editor.email} is an editor of ${sharedId} (source: the real invite/accept pair)`);
  });

  test('an editor is 403 NOT_WORKSPACE_OWNER and the workspace survives', async () => {
    const before = await countsFor(sharedId);
    const res = await del(editor, sharedId, 'the editor tries to delete the workspace they joined');

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'NOT_WORKSPACE_OWNER', 'the refusal names the role, so the client can hide the control');
    assert.equal(await Workspace.countDocuments({ _id: sharedId }), 1);
    assert.deepEqual(await countsFor(sharedId), before, 'a refused delete removed content anyway');
  });

  test('the role is read from the named workspace, not from the session\'s', async () => {
    // The trap this route exists to avoid: the editor is an *owner* of their
    // own workspace. If the role came from resolveWorkspace rather than from
    // the members array of the workspace in the URL, acting in their own would
    // let them delete someone else's.
    await select(editor, editor.workspaceId);
    const res = await del(editor, sharedId, 'the editor asks while acting in a workspace they own');

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'NOT_WORKSPACE_OWNER');
    assert.equal(await Workspace.countDocuments({ _id: sharedId }), 1);
  });

  test('a well-formed id in another tenant is 404, never 403, and writes nothing', async () => {
    const before = await countsFor(sharedId);
    const res = await del(stranger, sharedId, 'a stranger names a workspace they are not in');

    assert.equal(res.status, 404, 'a 403 here would confirm that another tenant\'s workspace exists');
    assert.notEqual(res.body.error, 'NOT_WORKSPACE_OWNER');
    assert.equal(await Workspace.countDocuments({ _id: sharedId }), 1);
    assert.deepEqual(await countsFor(sharedId), before);
  });

  test('a malformed id is 400 INVALID_ID, before the route runs', async () => {
    const res = await del(stranger, 'not-an-object-id', 'a stranger sends a malformed id');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'INVALID_ID');
  });

  test('the caller\'s only workspace is 409 LAST_WORKSPACE', async () => {
    const alone = await registerUser('alone@example.test', 'The Only One');
    const res = await del(alone, alone.workspaceId, 'the owner of one workspace deletes it');

    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'LAST_WORKSPACE');
    assert.equal(await Workspace.countDocuments({ _id: alone.workspaceId }), 1,
      'deleting the last workspace would leave resolveWorkspace nothing to resolve');

    // And the floor lifts the moment there is a second one: the same delete,
    // now that they have somewhere to fall back to.
    const second = await createWorkspace(alone, 'Somewhere To Fall Back To');
    const now = await del(alone, alone.workspaceId, 'the same delete, with a second workspace to fall back to');
    assert.equal(now.status, 204);
    assert.deepEqual(
      (await Workspace.find({ 'members.userId': alone.userId }).select('_id').lean()).map((w) => String(w._id)),
      [second],
    );
  });

  test('an unauthenticated caller is 401 and nothing is read', async () => {
    const res = await originAgent(app).delete(`/workspaces/${sharedId}`).send({});
    assert.equal(res.status, 401);
    assert.equal(await Workspace.countDocuments({ _id: sharedId }), 1);
  });
});

/** The collaborator's side: their membership goes, their own workspaces stay. */
describe('a workspace with collaborators in it', () => {
  let owner;
  let collaborator;
  let sharedId;

  before(async () => {
    owner = await registerUser('hosts@example.test', 'The Host Workspace');
    collaborator = await registerUser('joins@example.test', 'Their Own Bible');
    sharedId = await createWorkspace(owner, 'The Shared One');

    await select(owner, sharedId);
    const invited = await owner.agent.post('/workspace/invites').send({ email: collaborator.email, role: 'editor' });
    assert.equal(invited.status, 201);
    const mine = await collaborator.agent.get('/invites');
    const accepted = await collaborator.agent.post(`/invites/${mine.body[0]._id}/accept`).send({});
    assert.equal(accepted.status, 200);
    await seedContent(sharedId, owner.userId, 'collab');
  });

  test('deleting it takes the collaborator\'s membership and leaves their own workspace', async () => {
    const res = await del(owner, sharedId, 'the owner deletes a workspace someone else is in');
    assert.equal(res.status, 204);

    const theirs = await Workspace.find({ 'members.userId': collaborator.userId }).select('_id').lean();
    assert.deepEqual(theirs.map((w) => String(w._id)), [collaborator.workspaceId],
      'the membership in the deleted workspace should have gone with the row it lived in');
    assert.equal(await User.countDocuments({ _id: collaborator.userId }), 1, 'their account is not the owner\'s to delete');

    // And they can still work: their own workspace resolves on their next request.
    const workspace = await collaborator.agent.get('/workspace');
    assert.equal(workspace.status, 200);
    assert.equal(String(workspace.body._id), collaborator.workspaceId);
  });
});

/**
 * The session that was acting in the deleted workspace.
 *
 * The route leaves `req.session.workspaceId` exactly as it was — `POST
 * /workspaces/:id/select` stays the only writer of it — because
 * `resolveWorkspace` documents the fallback for precisely this case. A 403
 * here would be an account locked out of workspaces it still has.
 */
describe('the session whose selection was the deleted workspace', () => {
  test('falls back on the next request instead of 403', async () => {
    const who = await registerUser('selects@example.test', 'The Fallback Home');
    const doomedId = await createWorkspace(who, 'The One About To Go');
    await select(who, doomedId);

    const acting = await who.agent.get('/workspace');
    assert.equal(String(acting.body._id), doomedId, 'the fixture is only meaningful if the session really acts there');

    const res = await del(who, doomedId, 'the owner deletes the workspace their session is acting in');
    assert.equal(res.status, 204);

    const next = await who.agent.get('/workspace');
    assert.equal(next.status, 200, 'resolveWorkspace refused a user who still has a workspace');
    assert.equal(String(next.body._id), who.workspaceId, 'the fallback is the oldest workspace they own');

    // A write lands there too, so the fallback is the whole resolution and not
    // just what one read reported.
    const created = await who.agent.post('/entities').send({ title: 'After the deletion', category: 'Characters', summary: 'x' });
    assert.equal(created.status, 201, `POST /entities after the deletion failed: ${created.status} ${JSON.stringify(created.body)}`);
    const stored = await Entity.findById(created.body._id).select('workspaceId').lean();
    assert.equal(String(stored.workspaceId), who.workspaceId);
  });
});

/**
 * The live stream watching the workspace that was deleted.
 *
 * Nothing else would ever close it: a stream is tagged with its workspace when
 * it connects, the keep-alive sweep only asks after *sessions*, and every
 * session here is still perfectly alive.
 */
describe('an open /events stream on the deleted workspace', () => {
  /** Every stream opened by the current test, destroyed afterwards. */
  let opened = [];

  afterEach(async () => {
    for (const stream of opened) stream.req.destroy();
    opened = [];
    await delay(20);
  });

  /** Opens `GET /events` and keeps it open, collecting frames. */
  function openStream(label, cookie) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/events',
        method: 'GET',
        headers: { Cookie: cookie, Accept: 'text/event-stream' },
      });
      req.on('error', reject);
      req.on('response', (res) => {
        const stream = { label, req, res, status: res.statusCode, chunks: [], endedByServer: false };
        res.setEncoding('utf8');
        res.on('data', (chunk) => { stream.chunks.push(chunk); log('verbose', `${label} received ${JSON.stringify(chunk)}`); });
        res.on('end', () => { stream.endedByServer = true; log('light', `${label} was ended by the server`); });
        opened.push(stream);
        log('normal', `${label} opened (status ${res.statusCode})`);
        resolve(stream);
      });
      req.end();
    });
  }

  /** Every complete SSE frame a stream has received, as `{ event, data }`. */
  function frames(stream) {
    return stream.chunks.join('').split('\n\n').filter((b) => b.trim() !== '').map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? null;
      const raw = /^data: (.*)$/m.exec(block)?.[1] ?? null;
      if (event === null && raw === 'ping') return { event: 'ping', data: null };
      let data = null;
      try { data = raw === null ? null : JSON.parse(raw); } catch { data = raw; }
      return { event, data };
    });
  }

  const framesNamed = (stream, event) => frames(stream).filter((f) => f.event === event);

  async function waitFor(check, label, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (check()) return;
      if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs}ms waiting for ${label}`);
      await delay(10);
    }
  }

  test('is closed with workspace-deleted, and another workspace\'s stream is not', async () => {
    const who = await registerUser('streams@example.test', 'The Streaming Home');
    const doomedId = await createWorkspace(who, 'The Streamed One');
    await select(who, doomedId);

    // Two browsers of the same account: one watching the workspace about to be
    // deleted, one still watching the workspace it keeps. Same user, same
    // credential — so only the workspace can tell them apart.
    const doomed = await openStream('watching/the-doomed-one', who.cookie);
    assert.equal(doomed.status, 200);
    await waitFor(() => framesNamed(doomed, 'client:id').length === 1, 'the stream to be assigned a client id');

    const elsewhere = await registerUser('elsewhere@example.test', 'Another Tenant');
    const other = await openStream('watching/another-tenant', elsewhere.cookie);
    await waitFor(() => framesNamed(other, 'client:id').length === 1, 'the other stream to be assigned a client id');

    const res = await del(who, doomedId, 'the owner deletes the workspace a stream is watching');
    assert.equal(res.status, 204);

    await waitFor(() => doomed.endedByServer, 'the stream watching the deleted workspace to be closed');
    assert.deepEqual(framesNamed(doomed, 'error').map((f) => f.data), [{ error: 'workspace-deleted' }],
      'the closed stream was told why, and in a code the client retries rather than the final session-ended');
    assert.equal(other.endedByServer, false, 'a stream on a workspace that was not deleted was closed too');
  });
});
