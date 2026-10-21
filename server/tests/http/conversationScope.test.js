/**
 * A chat, and what the assistant remembers from it, belong to one workspace
 * (KOL-091).
 *
 * `GET /conversations` listed by `userId` alone, every by-id lookup matched on
 * `userId` alone, and `POST /chat` loaded a conversation by `{ _id, userId }`
 * and then answered it out of the caller's *current* `req.workspaceId` — the
 * graph tools reading that workspace and the spend billed to it. `UserMemory`
 * had no workspace at all, so a fact extracted from one wiki's chat went into
 * another's system prompt. None of it showed while every user had exactly one
 * workspace; KOL-090's switcher is what made two of them ordinary, which is why
 * this ships beside it.
 *
 * What this file pins, for **one user who owns two workspaces** — one user,
 * because this is not an isolation bug (`tests/http/tenancy.test.js` owns that,
 * and must keep passing unchanged) but a scoping one, and the user is allowed
 * in both places:
 *
 *   - **a conversation is reachable only from the workspace it was created
 *     in**: absent from `GET /conversations` in the other one, and 404 to
 *     `GET`, `PATCH`, `DELETE` and `POST /chat` there — and still intact
 *     afterwards, so the refused `DELETE` really refused;
 *   - **a memory is scoped the same way**: a fact extracted from a ws1 turn is
 *     stamped with ws1 and does not reach a ws2 turn's system prompt, while it
 *     does reach ws1's;
 *   - **rows written before this item still work**: a `workspaceId: null`
 *     conversation is listed and readable from either workspace, and a
 *     `workspaceId: null` memory reaches either prompt — the rule that replaces
 *     a migration which would have to guess which workspace a row meant;
 *   - **account deletion still sweeps both models**, including those null rows,
 *     which only the `userId` pass can reach now that both models are
 *     workspace-scoped (the per-model half of that is
 *     `tests/lib/accountDeleter.test.js`).
 *
 * Everything goes through the real stack — `createApp()` over supertest, real
 * `POST /auth/register`, real mongod — because the subject is a set of query
 * filters behind HTTP routes, which a unit test cannot see. The second
 * workspace is seeded directly (`Workspace.create` plus a membership), as
 * `tests/http/workspaceSelect.test.js` does it: creating one from the UI is
 * still nobody's item.
 *
 * The provider is a fake OpenAI-compatible server on an ephemeral port
 * (`steadfast`, whose base URL is read from `STEADFAST_AI_BASE_URL` at call
 * time), as in `tests/http/chat.test.js`. It answers a streaming request with
 * one chunk and an extraction request — the one memoryExtractor.js makes, which
 * is not streamed — with a JSON array of facts. The system prompt it is handed
 * is the only place the loaded memories are observable.
 *
 * Falsification checks: drop the workspace half of the filter in
 * `routes/conversations.js` and the list and 404 groups fail; drop it from the
 * `POST /chat` lookup and the chat 404 fails; stop stamping `workspaceId` in
 * `extractAndSaveMemories` or stop filtering it in `loadMemories` and the
 * memory group fails; replace `$in: [workspaceId, null]` with a bare
 * `workspaceId` and every legacy assertion fails.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_CONVERSATION_SCOPE_LOG_LEVEL = off | light | normal | verbose (default light)
 * When one of these fails, the missing information is always which workspace
 * the request acted in and which one the row belongs to.
 *   off     — nothing
 *   light   — one line per fixture, naming what created it and its workspace,
 *             and every workspace switch
 *   normal  — light, plus each request with its status, and each provider call
 *   verbose — normal, plus system prompts and response bodies
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import session from 'express-session';

// Every session write is checked against CLIENT_ORIGIN (src/middleware/originGuard.js),
// so this suite names one below and its agents send a matching Origin.
import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';

import * as db from '../helpers/db.js';
// Registration is throttled per client address, and this suite registers its
// fixtures through the real endpoint from one address. See the helper.
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import Conversation from '../../src/models/Conversation.js';
import UserMemory from '../../src/models/UserMemory.js';

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
process.env.CONVERSATION_LOG_LEVEL ??= 'off';
process.env.MEMORY_LOG_LEVEL ??= 'off';
process.env.ACCOUNT_DELETE_LOG_LEVEL ??= 'off';
// The Responses API path hands the provider the MCP endpoint instead of a
// system prompt, and the prompt is what this file reads. Make sure a
// developer's shell cannot switch the path out from under it.
delete process.env.MCP_SERVER_URL;
// Extraction prefers the self-hosted route when this is set (memoryExtractor.js,
// pickExtractionRoute), which is the fake below — so extraction is observable
// and never reaches a real provider.
process.env.STEADFAST_AI_API_KEY = 'test-provider-key';
delete process.env.OPENROUTER_API_KEY;

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_CONVERSATION_SCOPE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/conversationScope:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';
const FIRST  = "Alice's Bible";       // created by registration; the default
const SECOND = 'The Second Compendium'; // created below, also hers

/** The fact the fake provider "extracts" from the ws1 exchange. */
const WS1_FACT = 'The night train runs on Tuesdays in the first wiki';
/** A fact stored directly with no workspace, as rows written before KOL-091 are. */
const LEGACY_FACT = 'Alice prefers short answers';

let app;
let provider;
/** Every request the fake provider received: `{ stream, system }`. */
const calls = [];

let alice;
let second;

/**
 * A stand-in for an OpenAI-compatible `/chat/completions` endpoint.
 *
 * Two shapes, because two callers reach it: `POST /chat` streams, and
 * memoryExtractor.js does not. The streaming answer is one content chunk; the
 * extraction answer is the JSON array of facts the extractor parses.
 */
function startFakeProvider() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const system = body.messages?.find(m => m.role === 'system')?.content ?? '';
      calls.push({ stream: body.stream === true, system });
      log('normal', `fake provider got a ${body.stream === true ? 'streaming chat' : 'non-streamed extraction'} request for model ${body.model}`);
      log('verbose', `system prompt: ${system}`);

      const usage = { prompt_tokens: 10, completion_tokens: 5 };

      if (body.stream !== true) {
        // The extraction call. Its usage is billed to the workspace the turn
        // resolved, so it is reported here as a real provider would.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-extract',
          object: 'chat.completion',
          created: 0,
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify([WS1_FACT]) }, finish_reason: 'stop' }],
          usage,
        }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage,
      })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Registers through the real endpoint and reads back the ids it created. */
async function registerUser(email, workspaceName) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD, workspaceName });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id name').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  log('light', `registered ${email} (source: POST /auth/register) → user ${user._id}, workspace ${workspace._id} "${workspace.name}"`);
  return { agent, email, userId: String(user._id), workspaceId: String(workspace._id) };
}

/**
 * A second workspace `owner` also owns, created directly — see the file comment.
 * Created *after* the registered one, so it is the newer of the two and the
 * resolved default stays the registered one until something selects this.
 */
async function createSecondWorkspace(owner, name) {
  const doc = await Workspace.create({
    name,
    ownerId: owner.userId,
    members: [{ userId: owner.userId, role: 'owner' }],
  });
  log('light', `created workspace ${doc._id} "${name}" owned by ${owner.email} (source: direct Workspace.create)`);
  return { workspaceId: String(doc._id), name };
}

/** Switches `who`'s session to `workspaceId` and asserts the server agreed. */
async function act(who, workspaceId, label) {
  const res = await who.agent.post(`/workspaces/${workspaceId}/select`).send({});
  assert.equal(res.status, 200, `selecting ${workspaceId} failed: ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(String(res.body._id), workspaceId);
  log('light', `${who.email} now acts in ${res.body.name} (${workspaceId})${label ? ` — ${label}` : ''}`);
  return res.body;
}

/** One chat turn, returning the system prompt the provider was handed. */
async function chatTurn(who, { conversationId, content = 'What is on the wiki?' } = {}) {
  const before = calls.length;
  const res = await who.agent.post('/chat').send({
    provider: 'steadfast',
    messages: [{ role: 'user', content }],
    ...(conversationId ? { conversationId } : {}),
  });
  log('normal', `POST /chat as ${who.email}${conversationId ? ` on ${conversationId}` : ' (unsaved)'} → ${res.status}`);
  if (res.status !== 200) return { res, system: null };

  assert.match(res.text, /"type":"done"/, `the turn should have completed: ${res.text}`);
  const streamed = calls.slice(before).find(c => c.stream);
  assert.ok(streamed, 'the turn should have made one streaming provider request');
  return { res, system: streamed.system };
}

/** Waits for the fire-and-forget extraction to land, or fails saying so. */
async function waitForMemory(fact, { workspaceId } = {}) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const row = await UserMemory.findOne({ fact }).select('_id fact workspaceId userId').lean();
    if (row) {
      log('light', `memory ${row._id} "${row.fact}" landed in workspace ${row.workspaceId ?? 'none'} (source: extractAndSaveMemories after a POST /chat turn)`);
      if (workspaceId) assert.equal(String(row.workspaceId), workspaceId, 'the fact must be stamped with the workspace the turn was answered from');
      return row;
    }
    assert.ok(Date.now() < deadline, `extraction never saved "${fact}"; provider calls: ${calls.length}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });

  provider = await startFakeProvider();
  process.env.STEADFAST_AI_BASE_URL = `http://127.0.0.1:${provider.address().port}/v1`;
  log('light', `fake provider on ${process.env.STEADFAST_AI_BASE_URL} (source: port requested as 0)`);

  alice = await registerUser('scope-alice@example.test', FIRST);
  second = await createSecondWorkspace(alice, SECOND);

  const memberships = await Workspace.find({ 'members.userId': alice.userId }).select('_id').lean();
  assert.equal(memberships.length, 2, 'the fixture must leave alice owning exactly two workspaces');
});

after(async () => {
  if (provider) {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
  await db.disconnect();
});

describe('a conversation is reachable only from the workspace it was created in', () => {
  /** Created in the first workspace, in the first test; read by the rest. */
  let convId;

  test('POST /conversations stamps the workspace the request acted in', async () => {
    await act(alice, alice.workspaceId, 'the workspace the chat is created in');

    const res = await alice.agent.post('/conversations').send({ provider: 'steadfast', model: 'llama3.2:3b' });
    assert.equal(res.status, 201, `POST /conversations failed: ${res.status} ${JSON.stringify(res.body)}`);
    convId = String(res.body._id);
    assert.equal(String(res.body.workspaceId), alice.workspaceId);
    log('light', `created conversation ${convId} (source: POST /conversations) in workspace ${res.body.workspaceId}`);
  });

  test('the list holds it in the workspace it was created in, and not in the other', async () => {
    const here = await alice.agent.get('/conversations');
    assert.equal(here.status, 200);
    assert.ok(here.body.map(c => String(c._id)).includes(convId), `the chat should be listed in ${FIRST}: ${JSON.stringify(here.body)}`);
    // The list shape is unchanged by this item: the workspace is a filter, not
    // a field a client has to read.
    assert.equal(here.body[0].workspaceId, undefined, 'the list must not have grown a workspaceId');

    await act(alice, second.workspaceId, 'the other workspace');
    const there = await alice.agent.get('/conversations');
    assert.equal(there.status, 200, `GET /conversations in ${SECOND} failed: ${there.status}`);
    assert.deepEqual(there.body.map(c => String(c._id)), [], `${SECOND} must list none of ${FIRST}'s chats`);
  });

  test('GET, PATCH and POST /chat on it are 404 from the other workspace', async () => {
    const read = await alice.agent.get(`/conversations/${convId}`);
    assert.equal(read.status, 404, `GET from ${SECOND} should be 404: ${read.status} ${JSON.stringify(read.body)}`);
    assert.equal(read.body.error, 'Conversation not found');
    assert.equal(read.body.messages, undefined, 'no field of the other workspace\'s chat may appear');

    const renamed = await alice.agent.patch(`/conversations/${convId}`).send({ title: 'Renamed from the wrong workspace' });
    assert.equal(renamed.status, 404);

    const titled = await alice.agent.post(`/conversations/${convId}/title`).send({});
    assert.equal(titled.status, 404, 'the title route is a by-id lookup too');

    const before = calls.length;
    const { res } = await chatTurn(alice, { conversationId: convId });
    assert.equal(res.status, 404, `POST /chat from ${SECOND} should be 404: ${res.status} ${res.text}`);
    assert.equal(res.body.error, 'Conversation not found');
    assert.equal(calls.length, before, 'the refusal must come before the provider is called, so nothing is billed');
  });

  test('DELETE from the other workspace is 404 and leaves the chat intact', async () => {
    const refused = await alice.agent.delete(`/conversations/${convId}`);
    assert.equal(refused.status, 404);

    assert.ok(await Conversation.exists({ _id: convId }), 'the refused DELETE must not have deleted it');

    await act(alice, alice.workspaceId, 'back where the chat lives');
    const read = await alice.agent.get(`/conversations/${convId}`);
    assert.equal(read.status, 200, 'and it is still readable from its own workspace');
    assert.equal(read.body.title, '', 'nor renamed by the refused PATCH');
  });
});

describe('a memory belongs to the workspace it was extracted in', () => {
  test('a turn in the first workspace stamps its facts with that workspace', async () => {
    await act(alice, alice.workspaceId);

    const created = await alice.agent.post('/conversations').send({ provider: 'steadfast', model: 'llama3.2:3b' });
    assert.equal(created.status, 201);

    const { res } = await chatTurn(alice, { conversationId: String(created.body._id), content: 'When does the night train run?' });
    assert.equal(res.status, 200);

    await waitForMemory(WS1_FACT, { workspaceId: alice.workspaceId });
  });

  test("it reaches that workspace's system prompt", async () => {
    await act(alice, alice.workspaceId);
    const { system } = await chatTurn(alice);

    assert.ok(system.includes(WS1_FACT), `the fact should be in its own workspace's prompt: ${system}`);
  });

  test("it does not reach the other workspace's system prompt", async () => {
    await act(alice, second.workspaceId);
    // No conversationId: this turn only has to build a prompt, and a saved one
    // would start an extraction of its own.
    const { system } = await chatTurn(alice);

    assert.ok(!system.includes(WS1_FACT), `a fact from ${FIRST} leaked into ${SECOND}'s prompt: ${system}`);
    assert.ok(system.includes('REMEMBERED CONTEXT') === false, `${SECOND} has no memories of its own yet: ${system}`);
  });
});

/**
 * The rule that replaces a migration: a row written before this item carries
 * `workspaceId: null`, and a null reads as the caller's *current* workspace, so
 * nobody loses their history and nothing has to guess which workspace a row
 * meant. See lib/personalScope.js and the Decision Log entry for KOL-091.
 */
describe('rows written before this item (workspaceId: null)', () => {
  let legacyConvId;

  before(async () => {
    const conv = await Conversation.create({
      workspaceId: null, userId: alice.userId, provider: 'steadfast', model: 'llama3.2:3b',
      title: 'From before the switcher',
    });
    legacyConvId = String(conv._id);
    await UserMemory.create({ workspaceId: null, userId: alice.userId, fact: LEGACY_FACT });
    log('light', `seeded a legacy conversation ${legacyConvId} and memory, both with workspaceId: null (source: direct create, as pre-KOL-091 rows look)`);
  });

  for (const where of ['first', 'second']) {
    test(`the legacy chat is listed and readable from the ${where} workspace`, async () => {
      const workspaceId = where === 'first' ? alice.workspaceId : second.workspaceId;
      await act(alice, workspaceId);

      const list = await alice.agent.get('/conversations');
      assert.equal(list.status, 200);
      assert.ok(list.body.map(c => String(c._id)).includes(legacyConvId), `the legacy chat should be listed in the ${where} workspace: ${JSON.stringify(list.body)}`);

      const read = await alice.agent.get(`/conversations/${legacyConvId}`);
      assert.equal(read.status, 200, `GET the legacy chat from the ${where} workspace failed: ${read.status}`);
      assert.equal(read.body.title, 'From before the switcher');
      assert.equal(read.body.workspaceId, null, 'and it is still not adopted into a workspace by being read');
    });

    test(`the legacy memory reaches the ${where} workspace's prompt`, async () => {
      const workspaceId = where === 'first' ? alice.workspaceId : second.workspaceId;
      await act(alice, workspaceId);

      const { system } = await chatTurn(alice);
      assert.ok(system.includes(LEGACY_FACT), `the legacy fact should be in the ${where} workspace's prompt: ${system}`);
    });
  }

  test('POST /chat can continue the legacy chat from either workspace', async () => {
    for (const workspaceId of [alice.workspaceId, second.workspaceId]) {
      await act(alice, workspaceId);
      const { res } = await chatTurn(alice, { conversationId: legacyConvId, content: 'Still here?' });
      assert.equal(res.status, 200, `continuing the legacy chat from ${workspaceId} failed: ${res.status} ${res.text}`);
    }
  });
});

/**
 * Both models are workspace-scoped now, so account deletion deletes them twice
 * over — by workspace with the rest of the content, and by user, which is the
 * only pass that reaches a `workspaceId: null` row. The per-model assertions
 * live in tests/lib/accountDeleter.test.js; this is the same promise seen from
 * the route, with a user of its own so it cannot disturb the fixture above.
 */
describe('account deletion still sweeps both models', () => {
  test('DELETE /auth/account leaves no conversation and no memory behind', async () => {
    const carol = await registerUser('scope-carol@example.test', "Carol's Bible");
    const theirs = await createSecondWorkspace(carol, "Carol's Second");

    // One of each in each workspace, plus one of each with no workspace at all.
    for (const workspaceId of [carol.workspaceId, theirs.workspaceId, null]) {
      await Conversation.create({ workspaceId, userId: carol.userId, provider: 'steadfast', model: 'llama3.2:3b' });
      await UserMemory.create({ workspaceId, userId: carol.userId, fact: `carol in ${workspaceId ?? 'no workspace'}` });
    }
    assert.equal(await Conversation.countDocuments({ userId: carol.userId }), 3);
    assert.equal(await UserMemory.countDocuments({ userId: carol.userId }), 3);

    const res = await carol.agent.delete('/auth/account').send({ email: carol.email, password: PASSWORD });
    assert.equal(res.status, 204, `DELETE /auth/account failed: ${res.status} ${JSON.stringify(res.body)}`);
    log('light', `deleted ${carol.email} (source: DELETE /auth/account) → ${res.status}`);

    assert.equal(await Conversation.countDocuments({ userId: carol.userId }), 0, 'a conversation survived, including the workspaceId: null one');
    assert.equal(await UserMemory.countDocuments({ userId: carol.userId }), 0, 'a memory survived, including the workspaceId: null one');
    assert.equal(await User.exists({ _id: carol.userId }), null);

    // And alice is untouched: deletion is per account, and this suite's whole
    // point is that scoping did not become sharing.
    assert.ok(await Conversation.countDocuments({ userId: alice.userId }) > 0, "alice's chats must survive carol's deletion");
    assert.ok(await UserMemory.countDocuments({ userId: alice.userId }) > 0, "and so must her memories");
  });
});
