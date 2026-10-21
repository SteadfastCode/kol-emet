/**
 * `POST /import` over the real stack: three accounts, one Express app, one
 * database (KOL-077).
 *
 * The importer's own suite proves the document round-trips; this one is about
 * the mount, because an import is the one request that writes a *whole
 * workspace* in one go. What this file pins:
 *
 *   - the **owner of an empty workspace** gets **201** and the imported
 *     entities appear under `GET /entities` — the only end-to-end proof that an
 *     export is a complete description of a graph;
 *   - a workspace that **holds content** is **409 `WORKSPACE_NOT_EMPTY`** and
 *     is left exactly as it was. (Registration seeds starter content, so this
 *     is the state a fresh account is in: an owner clears the workspace, or
 *     imports into a new one. The refusal is deliberate — merging needs an
 *     id-collision policy KOL-077 does not decide.)
 *   - a member whose role is **`editor`** is **403 `NOT_WORKSPACE_OWNER`** and
 *     writes nothing — and is refused before the emptiness check, so the role
 *     is what answers rather than the state of the workspace;
 *   - **unauthenticated** is **401**;
 *   - **malformed JSON** is **400 `MALFORMED_JSON`**, which is the path-scoped
 *     parser in app.js rather than the app-wide one (whose parse failure would
 *     be a 500);
 *   - a successful import sends **one `workspace:imported` frame** down the
 *     live-sync channel (KOL-102) — to the workspace's *other* open streams,
 *     never to another tenant's, and never back to the client that asked. An
 *     import writes a whole graph and broadcasts none of the per-entity events
 *     the normal write path does, so without that frame every other tab in the
 *     workspace showed the pre-import workspace until someone reloaded. That
 *     case needs a real socket held open, so this file also listens on an
 *     ephemeral port (supertest buffers a response to completion, and an SSE
 *     response is never completed).
 *
 * The fixtures register through the real `POST /auth/register`, so each
 * workspace is seeded exactly as a signup's is — which is what makes "carol's
 * workspace had to be emptied first" a real step rather than a convenience.
 * The editor is built directly (a `User` plus a membership in alice's
 * workspace) and signed in through the real `POST /auth/login`: a second
 * *registration* would give them a workspace of their own, and
 * `resolveWorkspace` takes the first membership it finds. See
 * tests/http/workspace.test.js, which has the same trap recorded.
 *
 * Falsification checks: drop `requireWorkspaceRole('owner')` from the route and
 * the editor case must fail; drop `resolveWorkspace` from the mount and the
 * 401 case must fail; move `importJsonBody` behind the app-wide `express.json`
 * in app.js and the malformed-JSON case must fail.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_IMPORT_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture document, naming the request that created it
 *   normal  — light, plus each import request, its status and body
 *   verbose — normal, plus the document posted
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import bcrypt from 'bcrypt';
import session from 'express-session';
import request from 'supertest';

import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';
import * as db from '../helpers/db.js';
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';

// Environment before src/app.js is imported, for the reasons in tenancy.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
// Unset on purpose: with no bearer token configured a stray Authorization
// header cannot resolve to the MCP user and quietly satisfy requireAuth.
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.EXPORT_LOG_LEVEL ??= 'off';
process.env.IMPORT_LOG_LEVEL ??= 'off';
// The broadcaster narrates every connect, drop and broadcast; readable when the
// live-sync case is being chased, noise otherwise.
process.env.SSE_LOG_LEVEL ??= 'off';
process.env.ENTITY_TYPE_LOG_LEVEL ??= 'off';
process.env.WORKSPACE_LOG_LEVEL ??= 'off';
process.env.ERROR_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');
const { EXPORT_VERSION } = await import('../../src/lib/graphExporter.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  const active = LEVELS[process.env.TEST_IMPORT_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/import:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';
const ALICE_TITLE = 'Alice Only';

let app;
let server;   // the live-sync group's own listener (see before())
let port;
let opened = [];   // every SSE stream this file holds open, destroyed in after()
let alice;    // the graph being exported, and the non-empty workspace
let carol;    // empties her workspace, then imports alice's graph into it
let erin;     // same, with two live streams open while she imports
let editor;   // a member of alice's workspace, role editor
let document; // alice's export, the document under test

async function registerUser(email) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id name').lean();
  log('light', `registered ${email} (source: POST /auth/register) → workspace ${workspace._id}`);
  // The cookie as a request header: the live-sync group opens its streams with
  // raw http requests, which carry no agent jar.
  const cookie = (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');
  return { agent, email, cookie, workspaceId: String(workspace._id) };
}

/** A signed-in user whose only membership is `role` in `workspaceId`. */
async function addMember(email, workspaceId, role) {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = await User.create({ email, passwordHash });
  await Workspace.updateOne({ _id: workspaceId }, { $push: { members: { userId: user._id, role } } });

  const agent = originAgent(app);
  const res = await agent.post('/auth/login').send({ email, password: PASSWORD });
  assert.equal(res.status, 200, `POST /auth/login (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('light', `added ${email} to workspace ${workspaceId} as ${role} (source: direct User.create + $push, signed in via POST /auth/login)`);
  return { agent, email, workspaceId: String(workspaceId) };
}

async function createEntity(who, title) {
  const res = await who.agent.post('/entities').send({
    title,
    category: 'Characters',
    summary: `${title} — created for the import suite.`,
    tags: ['import-fixture'],
    blocks: [{ type: 'text', order: 0, data: { markdown: `Written by ${who.email}.` } }],
  });
  assert.equal(res.status, 201, `POST /entities as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/**
 * Deletes everything an import counts as content, through the API.
 *
 * Registration seeds starter entities, a relationship group and an open
 * question (lib/workspaceSeeder.js), so this is the real work an owner has to
 * do before importing — and the reason it is worth a helper rather than a
 * `deleteMany`: the routes are what a user has.
 */
async function emptyWorkspace(who) {
  const deleteAll = async (route, ids) => {
    for (const id of ids) {
      const res = await who.agent.delete(`${route}/${id}`);
      assert.ok(res.status < 300, `DELETE ${route}/${id} as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return ids.length;
  };

  const groups = (await who.agent.get('/relationship-groups')).body;
  const removedGroups = await deleteAll('/relationship-groups', (groups ?? []).map(g => g._id));
  const questions = (await who.agent.get('/open-questions')).body;
  const removedQuestions = await deleteAll('/open-questions', (questions ?? []).map(q => q._id));
  const entities = (await who.agent.get('/entities')).body;
  const removedEntities = await deleteAll('/entities', (entities ?? []).map(e => e._id));

  log('light', `emptied ${who.email}'s workspace: deleted ${removedEntities} entities, ${removedGroups} groups, ${removedQuestions} open questions (source: the DELETE routes)`);
  assert.deepEqual((await who.agent.get('/entities')).body, [], 'the workspace must be empty before an import');
  assert.deepEqual((await who.agent.get('/relationship-groups')).body, []);
  assert.deepEqual((await who.agent.get('/open-questions')).body, []);
}

/**
 * The ids of everything an import writes, as the workspace reads today.
 *
 * An import mints fresh ids for the whole graph (the owner case above pins
 * that), so an unchanged set of ids is the proof that a refused import wrote
 * nothing — and the only one available when the document is an export of the
 * very workspace being checked, where every *title* in it is already present.
 */
async function graphIds(who) {
  const ids = async route => ((await who.agent.get(route)).body ?? []).map(doc => String(doc._id)).sort();
  return {
    entities: await ids('/entities'),
    relationshipGroups: await ids('/relationship-groups'),
    openQuestions: await ids('/open-questions'),
  };
}

/** POSTs a document to /import as `who`, logging the answer. */
async function importAs(who, body, label) {
  const res = await who.agent.post('/import').send(body);
  log('normal', `${label} → ${res.status} ${JSON.stringify(res.body)}`);
  log('verbose', JSON.stringify(body).slice(0, 2000));
  return res;
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });
  // A listening server of this file's own, for the live-sync group only: an SSE
  // response is deliberately never completed, and supertest buffers to
  // completion. Everything else here still goes through its agent.
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  port = server.address().port;
  log('light', `app listening on 127.0.0.1:${port} (source: app.listen(0))`);

  alice = await registerUser('alice@example.test');
  carol = await registerUser('carol@example.test');
  erin = await registerUser('erin@example.test');
  editor = await addMember('editor@example.test', alice.workspaceId, 'editor');
  assert.notEqual(alice.workspaceId, carol.workspaceId);
  assert.notEqual(alice.workspaceId, erin.workspaceId);

  await createEntity(alice, ALICE_TITLE);

  const exported = await alice.agent.get('/export');
  assert.equal(exported.status, 200, 'the suite needs a real export to import');
  document = JSON.parse(exported.text);
  assert.equal(document.version, EXPORT_VERSION);
  log('light', `took alice's export: ${document.entities.length} entities, ${document.relationshipGroups.length} groups (source: GET /export)`);
});

after(async () => {
  for (const stream of opened) stream.req.destroy();
  opened = [];
  server?.closeAllConnections?.();
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.disconnect();
});

describe('POST /import as the owner of an empty workspace', () => {
  test('is 201, and the imported entities appear under GET /entities', async () => {
    await emptyWorkspace(carol);

    const res = await importAs(carol, document, 'POST /import as carol');
    assert.equal(res.status, 201);
    assert.equal(res.body.version, EXPORT_VERSION);
    assert.equal(res.body.imported.entities, document.entities.length);
    assert.equal(res.body.imported.relationshipGroups, document.relationshipGroups.length);
    assert.equal(res.body.imported.openQuestions, document.openQuestions.length);
    // Carol's own registration seeded the registries, so the document's types
    // were already there under those names and were kept rather than doubled.
    assert.ok(res.body.skipped.entityTypes > 0, 'a seeded registry means the document\'s entity types are skipped');
    assert.deepEqual(res.body.dropped, { members: 0, questionEntries: 0 });

    const listed = (await carol.agent.get('/entities')).body;
    assert.equal(listed.length, document.entities.length);
    assert.deepEqual(
      listed.map(e => e.title).sort(),
      document.entities.map(e => e.title).sort(),
      "every title in alice's export must be in carol's workspace",
    );

    const mine = listed.find(e => e.title === ALICE_TITLE);
    assert.ok(mine, 'the entity alice created must have come across');
    // A fresh id in carol's workspace, not the one the file carried.
    assert.notEqual(String(mine._id), document.entities.find(e => e.title === ALICE_TITLE)._id);

    // The list route does not carry blocks, so the content is read from the
    // single-entity route — which is also where relationships resolve.
    const full = (await carol.agent.get(`/entities/${mine._id}`)).body;
    assert.equal(full.blocks[0].data.markdown, `Written by ${alice.email}.`);
    assert.equal(full.tags[0], 'import-fixture');

    // And the graph is wired up: the starter relationship group came across
    // with its members, and the entities point back at it.
    const groups = (await carol.agent.get('/relationship-groups')).body;
    assert.equal(groups.length, document.relationshipGroups.length);
    assert.ok(groups.every(g => g.members.length > 0), 'an imported group must keep its members');
  });

  test('a second import is refused, because the workspace is no longer empty', async () => {
    const res = await importAs(carol, document, 'POST /import as carol, again');
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'WORKSPACE_NOT_EMPTY');
  });
});

describe('POST /import into a workspace that holds content', () => {
  test('is 409 WORKSPACE_NOT_EMPTY and the workspace is unchanged', async () => {
    const before = (await alice.agent.get('/entities')).body;
    assert.ok(before.length > 0, 'alice\'s workspace is seeded and holds her own entity');

    const res = await importAs(alice, document, 'POST /import as alice');
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'WORKSPACE_NOT_EMPTY');
    // The response names no field and no count: the reason is in the log.
    assert.deepEqual(Object.keys(res.body), ['error']);

    const after = (await alice.agent.get('/entities')).body;
    assert.deepEqual(after.map(e => String(e._id)).sort(), before.map(e => String(e._id)).sort());
  });
});

describe('POST /import by someone who may not', () => {
  test('a member whose role is editor is 403, and writes nothing', async () => {
    // The editor's workspace is alice's, which is non-empty — so a role gate
    // that ran *after* the emptiness check would answer 409 here and this test
    // would not be about the role at all. It is 403, before any read.
    //
    // The document is alice's own export, so the workspace the editor reads
    // already holds every title in it: a title the import would have written
    // cannot tell a refusal from a duplicate. The ids can — see graphIds.
    const before = await graphIds(editor);
    assert.ok(before.entities.length > 0, 'the editor reads alice\'s workspace, which holds her entities');

    const res = await importAs(editor, document, 'POST /import as the editor');
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'NOT_WORKSPACE_OWNER');

    assert.deepEqual(await graphIds(editor), before, 'nothing of the document may have been written');
  });

  test('an unauthenticated call is 401', async () => {
    const res = await request(app).post('/import').set('Origin', CLIENT_ORIGIN).send(document);
    log('normal', `POST /import unauthenticated → ${res.status} ${JSON.stringify(res.body)}`);

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Unauthorized');
    assert.equal(res.body.imported, undefined);
  });

  test('a bearer token that is not configured cannot stand in for a session', async () => {
    const res = await request(app).post('/import')
      .set('Origin', CLIENT_ORIGIN)
      .set('Authorization', 'Bearer not-a-token')
      .send(document);

    assert.equal(res.status, 401);
    assert.equal(res.body.imported, undefined);
  });
});

describe('a document the server cannot read', () => {
  test('malformed JSON is 400 MALFORMED_JSON', async () => {
    const res = await alice.agent.post('/import')
      .set('Content-Type', 'application/json')
      .send('{ "version": "kol-emet/workspace-export@1", "entities": [');
    log('normal', `POST /import with broken JSON → ${res.status} ${JSON.stringify(res.body)}`);

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'MALFORMED_JSON');
  });

  test('an unknown version is 400 UNSUPPORTED_VERSION', async () => {
    const res = await importAs(carol, { ...document, version: 'kol-emet/workspace-export@99' }, 'POST /import with a future version');

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'UNSUPPORTED_VERSION');
  });

  test('a body that is not an export document at all is 400', async () => {
    const res = await importAs(carol, { hello: 'world' }, 'POST /import with a stray object');

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'UNSUPPORTED_VERSION', 'no version is an unsupported version, not a shape complaint');
  });
});

// ─── the live-sync frame (KOL-102) ───────────────────────────────────────────
//
// The helpers below are the same shape as the ones in tests/http/events.test.js
// — the suite about the channel itself — kept local rather than shared: that
// file drives the stream lifecycle and instruments it on its own tier, while
// all this group needs is "hold a stream open and read the frames it got".

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Opens a `GET /events` connection and keeps it open, collecting frames.
 * Resolves on the response head: the body never ends, so waiting for it hangs.
 */
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
      const stream = { label, req, res, status: res.statusCode, chunks: [] };
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        stream.chunks.push(chunk);
        log('verbose', `${label} received: ${JSON.stringify(chunk)}`);
      });
      opened.push(stream);
      log('light', `${label} opened (status ${res.statusCode}, source: GET /events)`);
      resolve(stream);
    });
    req.end();
  });
}

/** Every complete SSE frame a stream has received, as `{ event, data }`. */
function frames(stream) {
  return stream.chunks
    .join('')
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? null;
      const raw = /^data: (.*)$/m.exec(block)?.[1] ?? null;
      if (event === null && raw === 'ping') return { event: 'ping', data: null };
      let data = null;
      try { data = raw === null ? null : JSON.parse(raw); } catch { data = raw; }
      return { event, data };
    });
}

const framesNamed = (stream, event) => frames(stream).filter((f) => f.event === event);

/** Polls `check` until it is true, failing with `label` rather than hanging. */
async function waitFor(check, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await delay(10);
  }
}

/** A stream the server has already assigned a client id, with that id. */
async function openReadyStream(label, who) {
  const stream = await openStream(label, who.cookie);
  assert.equal(stream.status, 200, `${label} was not accepted`);
  await waitFor(() => framesNamed(stream, 'client:id').length === 1, `${label} to be assigned a client id`);
  stream.clientId = framesNamed(stream, 'client:id')[0].data.clientId;
  return stream;
}

describe('a successful import tells the workspace\'s other live clients', () => {
  test('one workspace:imported frame: not to the importer, not to another tenant', async () => {
    // Emptied first, then the streams: clearing the seeded content is itself a
    // run of ordinary deletes, and each of those broadcasts its own
    // entity:deleted — which is the write path this import deliberately does
    // not use, and would be noise in the assertions below.
    await emptyWorkspace(erin);

    // Three open streams: two tabs of erin's own (the importer's, and the one
    // that has to find out), and alice's, in another workspace entirely.
    const importerTab = await openReadyStream('erin/tab-importing', erin);
    const otherTab = await openReadyStream('erin/tab-watching', erin);
    const otherTenant = await openReadyStream('alice/tab-1', alice);

    const res = await erin.agent.post('/import')
      .set('X-SSE-Client-Id', importerTab.clientId)
      .send(document);
    log('normal', `POST /import as erin → ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.status, 201);

    // The tab that did not ask learns the whole graph changed — one frame for
    // the lot, carrying the counts the 201 carried and who imported.
    await waitFor(() => framesNamed(otherTab, 'workspace:imported').length === 1,
      'the other tab in the workspace to be told about the import');
    const frame = framesNamed(otherTab, 'workspace:imported')[0].data;
    assert.equal(frame.version, EXPORT_VERSION);
    assert.deepEqual(frame.imported, res.body.imported);
    assert.deepEqual(frame.actor, { label: erin.email, type: 'user' });

    // Exactly one — a bulk write is one frame, not a per-entity burst.
    await delay(50);
    assert.equal(framesNamed(otherTab, 'workspace:imported').length, 1);
    // And nothing else: the per-entity events the normal write path broadcasts
    // are not sent for an import.
    assert.deepEqual(
      frames(otherTab).map((f) => f.event).filter((e) => e !== 'ping'),
      ['client:id', 'workspace:imported'],
      `the watching tab received more than the one frame: ${JSON.stringify(frames(otherTab))}`,
    );

    // The client that asked is excluded by its own X-SSE-Client-Id header, the
    // way every other write excludes it: that tab reloads on its 201.
    assert.deepEqual(framesNamed(importerTab, 'workspace:imported'), [],
      'the importing client was sent its own frame');

    // And the tenancy boundary holds: another workspace's stream is open,
    // authenticated, and told nothing.
    assert.deepEqual(frames(otherTenant).map((f) => f.event).filter((e) => e !== 'ping'), ['client:id'],
      `another workspace's stream received this import: ${JSON.stringify(frames(otherTenant))}`);
  });
});
