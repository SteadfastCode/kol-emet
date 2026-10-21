/**
 * Both halves of what the in-app assistant is told follow the requesting
 * workspace: its tool schema, and its system prompt.
 *
 * **The tool schema.** On the Chat Completions path `POST /chat` hands the
 * model a `search_entities` function whose `category` parameter is an enum.
 * Entity types are per workspace (the EntityType registry), so that enum has
 * to be built for the request from `getCategories(req.workspaceId)`: a fixed
 * list would hide a user's own types from the model and offer ones their
 * workspace has deleted, and a list read from the wrong workspace would show
 * one tenant another's type names.
 *
 * **The system prompt (KOL-105).** The prose was the half KOL-028 left behind.
 * It opened "You are an AI assistant integrated into Kol Emet, a world-building
 * wiki" and warned the model off inventing "places, or lore" — for every
 * tenant, including a workspace seeded from Software Architecture whose
 * entities are Services and Data Stores, and whose own name the prompt never
 * mentioned at all. It is now built from the request: the workspace's name,
 * the description of the template it was seeded from (`Workspace.template`,
 * stored at registration and null with no backfill for anything older), and
 * the same `getCategories()` type names the enum is built from.
 *
 * The only place either is observable is the request the server sends the
 * provider, so this points the self-hosted provider (`steadfast`, whose base URL
 * is read from STEADFAST_AI_BASE_URL at call time) at a fake OpenAI-compatible
 * server on an ephemeral port. The fake records each request body and answers
 * with a one-chunk stream and no tool calls, so each turn ends after the tool
 * phase and nothing else is exercised. Everything else is real: `createApp()`
 * over supertest, `POST /auth/register`, `POST /entity-types`,
 * `PATCH /workspace`, and mongod.
 *
 * Falsification: build the enum from the old `CATEGORIES` constant and the
 * custom-type assertions fail; read `getCategories()` for a fixed or foreign
 * workspace and the per-tenant assertions fail; restore the hardcoded opening
 * sentence and every prompt case fails; fall back to the default template's
 * description for a workspace that recorded none and the legacy-workspace case
 * fails.
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
 *   normal  — light, plus the category enum and system prompt each request
 *             carried
 *   verbose — normal, plus every request body the fake provider received
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import session from 'express-session';
import request from 'supertest';

// Every session write is checked against CLIENT_ORIGIN (src/middleware/originGuard.js),
// so this suite names one below and its agents send a matching Origin.
import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';

import * as db from '../helpers/db.js';
// Registration is throttled per client address, and these suites register
// their fixtures through the real endpoint from one address. See the helper.
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import EntityType from '../../src/models/EntityType.js';
import { CATEGORIES } from '../../src/config/categories.js';
import { TEMPLATES } from '../../src/config/templates.js';

// Environment before src/app.js is imported, for the reasons in tenancy.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
// The origin the guard compares a session write's Origin header against;
// originAgent() above sends it. See tests/helpers/origin.js.
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
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
// Seeded from the Software Architecture template: the workspace the old prompt
// was most plainly wrong about.
let arch;
// Renamed mid-suite, so the prompt has to follow `PATCH /workspace`.
let renamed;
// Stripped back to what a workspace created before KOL-105 looks like: no
// `template`, and — to exercise the far end of the fallback — no entity types
// of its own either.
let legacy;

const ALICE_TYPE = 'Starships';
const BOB_TYPE = 'Bob Guilds';
const RENAMED_TO = 'Ledger of Rivers';
const ARCH_TYPES = TEMPLATES['software-architecture'].entityTypes.map(t => t.name);

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

async function registerUser(email, body = {}) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD, ...body });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  log('light', `registered ${email} (source: POST /auth/register) → workspace ${workspace._id}`);
  return { agent, email, workspaceId: String(workspace._id) };
}

/** Runs one chat turn as `who` and returns the body the provider was sent. */
async function turnBody(who) {
  const before = received.length;
  const res = await who.agent.post('/chat').send({
    provider: 'steadfast',
    messages: [{ role: 'user', content: 'What is in this wiki?' }],
  });

  assert.equal(res.status, 200, `POST /chat as ${who.email} failed: ${res.status} ${res.text}`);
  assert.match(res.text, /"type":"done"/, `the turn should have completed: ${res.text}`);
  assert.equal(received.length, before + 1, 'a turn with no tool calls should make exactly one provider request');
  return received.at(-1);
}

/** The category enum the provider was offered on one turn as `who`. */
async function offeredCategories(who) {
  const body = await turnBody(who);
  const search = body.tools?.find(t => t.function?.name === 'search_entities');
  assert.ok(search, `search_entities should be offered: ${JSON.stringify(body.tools)}`);
  const categories = search.function.parameters.properties.category.enum;
  log('normal', `${who.email}'s turn offered categories: ${JSON.stringify(categories)}`);
  return categories;
}

/**
 * The system prompt one turn as `who` carried — the first message, which
 * `streamViaCompletions` always sends with role `system`. Asserted rather than
 * assumed, since reading the wrong message would make every case below vacuous.
 */
async function systemPrompt(who) {
  const body = await turnBody(who);
  const first = body.messages?.[0];
  assert.equal(first?.role, 'system', `the first message should be the system prompt: ${JSON.stringify(body.messages?.slice(0, 2))}`);
  log('normal', `${who.email}'s turn carried system prompt: ${first.content}`);
  return first.content;
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });

  provider = await startFakeProvider();
  process.env.STEADFAST_AI_BASE_URL = `http://127.0.0.1:${provider.address().port}/v1`;
  log('light', `fake provider on ${process.env.STEADFAST_AI_BASE_URL} (source: port requested as 0)`);

  alice = await registerUser('chat-alice@example.test');
  bob = await registerUser('chat-bob@example.test');
  arch = await registerUser('chat-arch@example.test', { template: 'software-architecture' });
  renamed = await registerUser('chat-renamed@example.test');
  legacy = await registerUser('chat-legacy@example.test');

  for (const [who, name] of [[alice, ALICE_TYPE], [bob, BOB_TYPE]]) {
    const res = await who.agent.post('/entity-types').send({ name });
    assert.equal(res.status, 201, `POST /entity-types as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
    log('light', `created entity type "${name}" (source: POST /entity-types as ${who.email}) in workspace ${res.body.workspaceId}`);
  }

  // What a workspace registered before KOL-105 looks like: the key was never
  // stored, so there is nothing to read. `$unset` rather than `null` on
  // purpose — an absent field and a null one are different documents, and the
  // old ones are absent. Its entity types go too, so the last fallback (no
  // template *and* no registry) is exercised rather than argued about.
  const unset = await Workspace.updateOne({ _id: legacy.workspaceId }, { $unset: { template: '' } });
  assert.equal(unset.modifiedCount, 1, 'registration should have stored a template to unset');
  const dropped = await EntityType.deleteMany({ workspaceId: legacy.workspaceId });
  assert.ok(dropped.deletedCount > 0, 'registration should have seeded entity types to delete');
  log('light', `stripped workspace ${legacy.workspaceId} to a pre-KOL-105 shape (source: fixture setup): template unset, ${dropped.deletedCount} entity type(s) deleted`);
});

after(async () => {
  if (provider) {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
  await db.disconnect();
});

describe('POST /chat system prompt', () => {
  test('describes a Software Architecture workspace by its own subject and types', async () => {
    const prompt = await systemPrompt(arch);

    assert.ok(
      !/world.?building/i.test(prompt),
      `a service catalogue must not be called a world-building wiki: ${prompt}`,
    );
    assert.ok(!/\blore\b/i.test(prompt), `the fiction-only wording should be gone: ${prompt}`);
    assert.ok(
      prompt.includes(TEMPLATES['software-architecture'].description),
      `the stored template's own description should be the subject sentence: ${prompt}`,
    );
    for (const name of ARCH_TYPES) {
      assert.ok(prompt.includes(name), `its own type "${name}" is missing: ${prompt}`);
    }
    for (const name of CATEGORIES) {
      assert.ok(!prompt.includes(name), `a worldbuilding type name leaked in: "${name}" in ${prompt}`);
    }
  });

  test('still reads as a worldbuilding wiki when that is what the workspace is', async () => {
    const prompt = await systemPrompt(alice);

    assert.ok(
      prompt.includes(TEMPLATES.worldbuilding.description),
      `the worldbuilding subject sentence is missing: ${prompt}`,
    );
    for (const name of [...CATEGORIES, ALICE_TYPE]) {
      assert.ok(prompt.includes(name), `type "${name}" is missing: ${prompt}`);
    }
  });

  test('names the workspace, and follows PATCH /workspace when it is renamed', async () => {
    const before = await systemPrompt(renamed);
    assert.ok(before.includes('My Workspace'), `the default name should be in the prompt: ${before}`);

    const res = await renamed.agent.patch('/workspace').send({ name: RENAMED_TO });
    assert.equal(res.status, 200, `PATCH /workspace failed: ${res.status} ${JSON.stringify(res.body)}`);

    const after = await systemPrompt(renamed);
    assert.ok(after.includes(RENAMED_TO), `the new name should be in the prompt: ${after}`);
    assert.ok(!after.includes('My Workspace'), `the old name should be gone: ${after}`);
  });

  test('falls back to type names for a workspace with no template, and lists nothing empty', async () => {
    const prompt = await systemPrompt(legacy);

    // No template was recorded, so there is no subject sentence to write —
    // and emphatically not the default template's, which would state the
    // worldbuilding subject as fact for a workspace nobody seeded that way.
    assert.ok(!prompt.includes('Its subject:'), `an unseeded subject should be omitted, not guessed: ${prompt}`);
    assert.ok(
      !prompt.includes(TEMPLATES.worldbuilding.description),
      `the default template's description must not stand in for a missing one: ${prompt}`,
    );

    // The workspace has no entity types either, so the only names available
    // are getCategories()' own fallback — never an empty list.
    assert.ok(prompt.includes('My Workspace'), `the workspace should still be named: ${prompt}`);
    for (const name of CATEGORIES) {
      assert.ok(prompt.includes(name), `the fallback type "${name}" is missing: ${prompt}`);
    }
    assert.ok(!/types:\s*[.]/.test(prompt), `an empty type list was rendered: ${prompt}`);
    assert.ok(!/:\s*$/.test(prompt.trim()), `the prompt ends on a dangling label: ${prompt}`);

    assert.deepEqual(await offeredCategories(legacy), CATEGORIES, 'the enum should take the same fallback as the prose');
  });

  for (const [label, who, own, foreign] of [
    ['alice', () => alice, ALICE_TYPE, BOB_TYPE],
    ['bob', () => bob, BOB_TYPE, ALICE_TYPE],
  ]) {
    test(`carries ${label}'s own type names and none of the other tenant's`, async () => {
      const prompt = await systemPrompt(who());
      assert.ok(prompt.includes(own), `${label}'s own type is missing: ${prompt}`);
      assert.ok(!prompt.includes(foreign), `another tenant's type leaked in: ${prompt}`);
      assert.ok(!ARCH_TYPES.some(t => prompt.includes(t)), `a third tenant's types leaked in: ${prompt}`);
    });
  }
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
