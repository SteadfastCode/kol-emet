/**
 * The in-app assistant's tool schema follows the requesting workspace's entity
 * types.
 *
 * On the Chat Completions path `POST /chat` hands the model a `search_entities`
 * function whose `category` parameter is an enum. Entity types are per
 * workspace (the EntityType registry), so that enum has to be built for the
 * request from `getCategories(req.workspaceId)`: a fixed list would hide a
 * user's own types from the model and offer ones their workspace has deleted,
 * and a list read from the wrong workspace would show one tenant another's type
 * names.
 *
 * The only place that schema is observable is the request the server sends the
 * provider, so this points the self-hosted provider (`steadfast`, whose base URL
 * is read from STEADFAST_AI_BASE_URL at call time) at a fake OpenAI-compatible
 * server on an ephemeral port. The fake records each request body and answers
 * with a one-chunk stream and no tool calls, so each turn ends after the tool
 * phase and nothing else is exercised. Everything else is real: `createApp()`
 * over supertest, `POST /auth/register`, `POST /entity-types`, and mongod.
 *
 * Falsification: build the enum from the old `CATEGORIES` constant and the
 * custom-type assertions fail; read `getCategories()` for a fixed or foreign
 * workspace and the per-tenant assertions fail.
 *
 * Deliberately not covered: the Responses API path, which hands the provider
 * the MCP endpoint rather than a schema (see tests/http/mcp.test.js), and tool
 * execution, which needs a model that calls a tool.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_CHAT_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture document and per provider request, naming
 *             the call that caused it and the workspace it belongs to
 *   normal  — light, plus the category enum each request carried
 *   verbose — normal, plus every request body the fake provider received
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import session from 'express-session';
import request from 'supertest';

import * as db from '../helpers/db.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';

// Environment before src/app.js is imported, for the reasons in tenancy.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
// The Responses API path is taken only with MCP_SERVER_URL set; this file is
// about the Completions path, so make sure a developer's shell cannot switch it.
delete process.env.MCP_SERVER_URL;
process.env.STEADFAST_AI_API_KEY = 'test-provider-key';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_CHAT_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/chat:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

let app;
let provider;
/** Every request body the fake provider received, in order. */
const received = [];

let alice;
let bob;

const ALICE_TYPE = 'Starships';
const BOB_TYPE = 'Bob Guilds';

/**
 * A stand-in for an OpenAI-compatible `/chat/completions` endpoint: records the
 * body, then streams one content chunk and `[DONE]`.
 */
function startFakeProvider() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      received.push(body);
      log('light', `fake provider got ${req.method} ${req.url} (source: POST /chat), ${body.tools?.length ?? 0} tool(s)`);
      log('verbose', `fake provider body: ${raw}`);

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function registerUser(email) {
  const agent = request.agent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  log('light', `registered ${email} (source: POST /auth/register) → workspace ${workspace._id}`);
  return { agent, email, workspaceId: String(workspace._id) };
}

/** Runs one chat turn as `who` and returns the category enum the provider was offered. */
async function offeredCategories(who) {
  const before = received.length;
  const res = await who.agent.post('/chat').send({
    provider: 'steadfast',
    messages: [{ role: 'user', content: 'What starships are there?' }],
  });

  assert.equal(res.status, 200, `POST /chat as ${who.email} failed: ${res.status} ${res.text}`);
  assert.match(res.text, /"type":"done"/, `the turn should have completed: ${res.text}`);
  assert.equal(received.length, before + 1, 'a turn with no tool calls should make exactly one provider request');

  const search = received.at(-1).tools?.find(t => t.function?.name === 'search_entities');
  assert.ok(search, `search_entities should be offered: ${JSON.stringify(received.at(-1).tools)}`);
  const categories = search.function.parameters.properties.category.enum;
  log('normal', `${who.email}'s turn offered categories: ${JSON.stringify(categories)}`);
  return categories;
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore() });

  provider = await startFakeProvider();
  process.env.STEADFAST_AI_BASE_URL = `http://127.0.0.1:${provider.address().port}/v1`;
  log('light', `fake provider on ${process.env.STEADFAST_AI_BASE_URL} (source: port requested as 0)`);

  alice = await registerUser('chat-alice@example.test');
  bob = await registerUser('chat-bob@example.test');

  for (const [who, name] of [[alice, ALICE_TYPE], [bob, BOB_TYPE]]) {
    const res = await who.agent.post('/entity-types').send({ name });
    assert.equal(res.status, 201, `POST /entity-types as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
    log('light', `created entity type "${name}" (source: POST /entity-types as ${who.email}) in workspace ${res.body.workspaceId}`);
  }
});

after(async () => {
  if (provider) {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
  await db.disconnect();
});

describe('POST /chat search_entities category enum', () => {
  for (const [label, who, own, foreign] of [
    ['alice', () => alice, ALICE_TYPE, BOB_TYPE],
    ['bob', () => bob, BOB_TYPE, ALICE_TYPE],
  ]) {
    test(`lists exactly ${label}'s entity types, in registry order`, async () => {
      const categories = await offeredCategories(who());

      const registry = await who().agent.get('/entity-types');
      assert.equal(registry.status, 200);
      assert.deepEqual(categories, registry.body.map(t => t.name), 'the enum must be the workspace registry, in GET /entity-types order');
      assert.ok(categories.includes(own), `${label}'s own type is missing: ${categories.join(', ')}`);
      assert.ok(!categories.includes(foreign), `another tenant's type leaked in: ${categories.join(', ')}`);
    });
  }
});
