/**
 * The in-app assistant's MCP relay is read-only (KOL-113).
 *
 * `POST /chat` has two tool-calling strategies. On the Chat Completions path it
 * executes three tools itself, against `req.workspaceId` — that path is
 * `tests/http/chat.test.js`. On the **Responses API** path (a provider with
 * `responsesApi: true` plus `MCP_SERVER_URL` set) it executes nothing: it hands
 * the provider this deployment's own `/mcp` endpoint, with `MCP_BEARER_TOKEN`
 * and `require_approval: 'never'`, and the model calls the tools directly.
 *
 * That token is the **connector's** identity, not the caller's: every tool
 * behind it resolves its workspace and its role from `Settings.mcpUserId`
 * (`lib/mcpWorkspace.js`). So an unrestricted relay was a way straight around
 * the write floor KOL-103 put on every other route — a member marked `viewer`,
 * refused every write by `requireWriteRole` and by `mcpWriteWorkspaceId()`,
 * could say "create this entity" in chat and the write landed, carrying the MCP
 * user's role, in the MCP user's workspace. `/chat` is mounted on the premise
 * that "asking the assistant a question reads the graph and writes nothing to
 * it" (`src/app.js`), and this file is what makes that a fact.
 *
 * What it pins, and the reason the fake provider here is unusually active:
 *
 *   - **The relay offers read tools only.** The tool definition the provider is
 *     sent carries `allowed_tools` equal to `MCP_READ_TOOLS`
 *     (`src/lib/mcpScope.js`) and the scope header, and names no write tool.
 *   - **A provider that ignored `allowed_tools` still could not write.** The
 *     fake provider does what a real one does with that definition: it connects
 *     to the `server_url` it was handed, with the headers it was handed, as a
 *     real MCP client — then asks for the tool list and *tries* the write.
 *     `/mcp` registers no write tools on a read-only session, so the attempt
 *     fails and the graph is untouched. This is the half of the fix that does
 *     not depend on the provider's cooperation.
 *   - **A write through the relay is refused even though the connector may
 *     write.** `Settings.mcpUserId` points at the workspace **owner** here, so
 *     every refusal below is the relay's scope and not the role behind the
 *     token — the same assertion against a viewer connector would pass with the
 *     bug still present.
 *   - **The connector itself is unchanged.** A session opened without the scope
 *     header advertises all fourteen tools and writes, so this is a restriction
 *     on chat's relay rather than a lockout of `/mcp`.
 *   - **A read-scoped request cannot borrow a writable session.** The one
 *     mismatch that would be an escalation is a 403.
 *
 * Falsification: drop `allowed_tools` from `mcpToolDef()` and the first group
 * fails; drop the scope header and the probe advertises fourteen tools and the
 * write lands; register the write tools regardless of scope in
 * `createMcpServer()` and the same two fail; remove the mismatch guard in
 * `routes/mcp.js` and the last test fails.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_CHAT_MCP_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture, naming what created it, plus each provider
 *             request and the scope the probe connected with
 *   normal  — light, plus the tool list and each tool attempt with its result
 *   verbose — normal, plus the whole request body the provider received
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import bcrypt from 'bcrypt';
import session from 'express-session';
import request from 'supertest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Every session write is checked against CLIENT_ORIGIN (src/middleware/originGuard.js).
import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';
import * as db from '../helpers/db.js';
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';

import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import Entity from '../../src/models/Entity.js';
import { setMcpUser } from '../../src/lib/mcpUserStore.js';
import { MCP_READ_SCOPE, MCP_READ_TOOLS, MCP_SCOPE_HEADER } from '../../src/lib/mcpScope.js';

// Environment before src/app.js is imported, for the reasons in mcp.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
// Load-bearing: with no token the MCP router takes its "dev mode" path, and the
// relay's headers would be decorating an open endpoint.
const MCP_TOKEN = 'test-mcp-bearer-token';
process.env.MCP_BEARER_TOKEN = MCP_TOKEN;
// Unset on purpose: with no REST bearer token configured a stray Authorization
// header cannot resolve to the MCP user and quietly satisfy requireAuth.
delete process.env.BEARER_TOKEN;
// `openai` is a provider with responsesApi: true and no baseURL of its own, so
// the SDK reads OPENAI_BASE_URL — which is how the fake provider below gets in
// front of the Responses API path. Both are set once the port is known.
process.env.OPENAI_API_KEY = 'test-provider-key';
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.WORKSPACE_LOG_LEVEL ??= 'off';
process.env.MCP_LOG_LEVEL ??= 'off';
process.env.CHAT_LOG_LEVEL ??= 'off';
process.env.CHANGELOG_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_CHAT_MCP_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/chatMcpRelay:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

/** The ten tools that write. Named here so a relay offering one fails loudly. */
const MCP_WRITE_TOOLS = [
  'create_entity',
  'update_entity',
  'add_open_question',
  'add_relationship',
  'add_member_to_relationship',
  'update_group_label',
  'remove_relationship',
  'update_relationship_label',
  'add_subgroup_to_relationship',
  'remove_subgroup_from_relationship',
];

/** What a write attempted through the relay would be called. */
const RELAYED_TITLE = 'Relayed Write';

let app;
let httpServer;
let mcpUrl;
let provider;

let owner;
let viewer;

/** Every tool definition the fake provider was handed, in order. */
const toolDefs = [];
/** What the fake provider's MCP probe found, one entry per chat turn. */
const probes = [];

/**
 * Connects to the MCP endpoint a tool definition names, with the headers it
 * carries — which is the part of a real provider that matters here: it is the
 * only actor in the system holding the connector's bearer token on behalf of
 * someone who is not the connector.
 */
async function probeMcp(toolDef) {
  const transport = new StreamableHTTPClientTransport(new URL(toolDef.server_url), {
    requestInit: { headers: { ...toolDef.headers } },
  });
  const client = new Client({ name: 'fake-provider-probe', version: '0.0.0' });
  await client.connect(transport);

  const advertised = (await client.listTools()).tools.map(t => t.name).sort();
  log('normal', `probe advertised ${advertised.length} tool(s): ${advertised.join(', ')}`);

  const attempt = async (name, args) => {
    try {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content ?? []).map(part => part.text ?? '').join('');
      log('normal', `probe ${name} → isError=${Boolean(res.isError)}: ${text.slice(0, 120)}`);
      return { refused: Boolean(res.isError), text };
    } catch (err) {
      // An unregistered tool is a protocol error rather than a tool result,
      // which is the shape a read-only session produces: the tool is not there.
      log('normal', `probe ${name} threw: ${err.message}`);
      return { refused: true, text: err.message };
    }
  };

  const write = await attempt('create_entity', {
    title: RELAYED_TITLE,
    category: 'Characters',
    summary: 'A write relayed through chat, which must not land.',
  });
  const read = await attempt('search_entities', {});

  await client.close();
  return { advertised, write, read };
}

/**
 * A stand-in for an OpenAI-compatible `/v1/responses` endpoint: records the
 * body, uses the MCP tool it was handed exactly as the real one would, then
 * streams one text delta and a `response.completed` carrying usage.
 */
function startFakeProvider() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}');
      const toolDef = (body.tools ?? []).find(t => t.type === 'mcp');
      log('light', `fake provider got ${req.method} ${req.url} (source: POST /chat) with ${body.tools?.length ?? 0} tool(s); mcp scope header: ${toolDef?.headers?.[MCP_SCOPE_HEADER] ?? '(none)'}`);
      log('verbose', `fake provider body: ${raw}`);
      if (toolDef) {
        toolDefs.push(toolDef);
        try {
          probes.push(await probeMcp(toolDef));
        } catch (err) {
          probes.push({ error: err.message });
          log('light', `probe failed outright: ${err.message}`);
        }
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`);
      res.end(`data: ${JSON.stringify({
        type: 'response.completed',
        response: { usage: { input_tokens: 11, output_tokens: 7 } },
      })}\n\n`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Registers through the real endpoint and reads back what it created. */
async function registerOwner(email) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  log('light', `registered ${email} as owner (source: POST /auth/register) → workspace ${workspace._id}`);
  return { agent, email, role: 'owner', userId: String(user._id), workspaceId: String(workspace._id) };
}

/** A signed-in user whose only membership is `role` in `workspaceId`. */
async function addMember(email, workspaceId, role) {
  const user = await User.create({ email, passwordHash: await bcrypt.hash(PASSWORD, 10) });
  await Workspace.updateOne({ _id: workspaceId }, { $push: { members: { userId: user._id, role } } });

  const agent = originAgent(app);
  const res = await agent.post('/auth/login').send({ email, password: PASSWORD });
  assert.equal(res.status, 200, `POST /auth/login (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  log('light', `added ${email} to workspace ${workspaceId} as ${role} (source: direct User.create + $push, signed in via POST /auth/login)`);
  return { agent, email, role, userId: String(user._id), workspaceId: String(workspaceId) };
}

/** One chat turn on the Responses API path. Returns what the provider got. */
async function turn(who) {
  const before = toolDefs.length;
  const res = await who.agent.post('/chat').send({
    provider: 'openai',
    messages: [{ role: 'user', content: 'Create an entity called Relayed Write.' }],
  });
  assert.equal(res.status, 200, `POST /chat as ${who.email} failed: ${res.status} ${res.text}`);
  assert.match(res.text, /"type":"done"/, `the turn should have completed: ${res.text}`);
  assert.equal(toolDefs.length, before + 1, 'the turn should have taken the Responses API path exactly once');
  return { toolDef: toolDefs.at(-1), probe: probes.at(-1) };
}

before(async () => {
  await db.connect();

  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });
  httpServer = http.createServer(app);
  // Port 0: the OS picks a free port, so this file can run beside the others.
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  mcpUrl = new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
  // What the relay hands the provider. Read at call time in mcpToolDef(), so
  // setting it here — after the port is known — is what switches `POST /chat`
  // onto the Responses API path.
  process.env.MCP_SERVER_URL = mcpUrl.toString();

  provider = await startFakeProvider();
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${provider.address().port}/v1`;
  log('light', `fake provider on ${process.env.OPENAI_BASE_URL}, relay pointed at ${mcpUrl} (source: ports requested as 0)`);

  owner = await registerOwner('chat-relay-owner@example.test');
  viewer = await addMember('chat-relay-viewer@example.test', owner.workspaceId, 'viewer');

  // The connector is authorized as the **owner**: every refusal in this file is
  // therefore the relay's read-only scope and not the role behind the token.
  await setMcpUser(owner.userId);
  log('light', `MCP identity is the owner ${owner.email} (source: setMcpUser via Settings.mcpUserId)`);
});

after(async () => {
  if (provider) {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
  if (httpServer) {
    httpServer.closeAllConnections();
    await new Promise(resolve => httpServer.close(resolve));
  }
  await db.disconnect();
});

describe("chat's MCP relay offers the read tools only", () => {
  test('a viewer\'s turn hands the provider allowed_tools and the read scope header', async () => {
    const { toolDef } = await turn(viewer);

    assert.equal(toolDef.server_url, mcpUrl.toString());
    assert.deepEqual(
      [...(toolDef.allowed_tools ?? [])].sort(),
      [...MCP_READ_TOOLS].sort(),
      `allowed_tools should be exactly MCP_READ_TOOLS: ${JSON.stringify(toolDef.allowed_tools)}`,
    );
    for (const name of MCP_WRITE_TOOLS) {
      assert.ok(!(toolDef.allowed_tools ?? []).includes(name), `${name} must not be relayed`);
    }
    assert.equal(toolDef.headers?.[MCP_SCOPE_HEADER], MCP_READ_SCOPE,
      `the relay should ask /mcp for a read-only session: ${JSON.stringify(toolDef.headers)}`);
    assert.equal(toolDef.headers?.Authorization, `Bearer ${MCP_TOKEN}`,
      'the relay still reaches /mcp with the connector token, which is why the scope matters');
  });

  test("the relay's own session advertises no write tool, whatever allowed_tools says", async () => {
    const { probe } = await turn(viewer);

    assert.ok(!probe.error, `the probe should have reached /mcp: ${probe.error}`);
    assert.deepEqual(probe.advertised, [...MCP_READ_TOOLS].sort(),
      `a read-only session should advertise exactly the read tools: ${probe.advertised.join(', ')}`);
  });

  test('a write relayed through chat is refused and changes nothing', async () => {
    const before = await Entity.countDocuments({});
    const { probe } = await turn(viewer);

    assert.equal(probe.write.refused, true, `create_entity through the relay answered: ${probe.write.text}`);
    assert.equal(await Entity.countDocuments({}), before, 'a relayed write changed the graph');
    assert.equal(await Entity.countDocuments({ title: RELAYED_TITLE }), 0,
      'the entity the relayed write asked for exists');
  });

  test('the relay still reads, which is what chat is for', async () => {
    const { probe } = await turn(viewer);
    assert.equal(probe.read.refused, false, `search_entities through the relay answered: ${probe.read.text}`);
  });

  test("an owner's turn is relayed exactly as narrowly as a viewer's", async () => {
    // The relay carries the connector's identity either way, so narrowing it
    // per caller would be a role check on a credential that is not theirs.
    const { toolDef, probe } = await turn(owner);
    assert.deepEqual([...(toolDef.allowed_tools ?? [])].sort(), [...MCP_READ_TOOLS].sort());
    assert.deepEqual(probe.advertised, [...MCP_READ_TOOLS].sort());
    assert.equal(probe.write.refused, true, `create_entity through an owner's relay answered: ${probe.write.text}`);
  });
});

describe('/mcp itself is unchanged for the connector', () => {
  test('a session with no scope header advertises every tool and writes', async () => {
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
    });
    const client = new Client({ name: 'kol-emet-tests', version: '0.0.0' });
    await client.connect(transport);
    try {
      const advertised = (await client.listTools()).tools.map(t => t.name).sort();
      assert.deepEqual(advertised, [...MCP_READ_TOOLS, ...MCP_WRITE_TOOLS].sort(),
        `the connector should still see every tool: ${advertised.join(', ')}`);

      const res = await client.callTool({
        name: 'create_entity',
        arguments: { title: 'Connector Wrote This', category: 'Characters', summary: 'Written over /mcp.' },
      });
      assert.equal(Boolean(res.isError), false,
        `create_entity as the connector returned: ${(res.content ?? []).map(p => p.text ?? '').join('')}`);
      const created = JSON.parse((res.content ?? []).map(p => p.text ?? '').join(''));
      assert.equal(String(created.workspaceId), owner.workspaceId);
    } finally {
      await client.close();
    }
  });

  test('a read-scoped request cannot borrow a writable session', async () => {
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
    });
    const client = new Client({ name: 'kol-emet-tests', version: '0.0.0' });
    await client.connect(transport);
    const sessionId = transport.sessionId;
    assert.ok(sessionId, 'the transport should have been given a session id');

    try {
      const res = await request(httpServer)
        .post('/mcp')
        .set('Authorization', `Bearer ${MCP_TOKEN}`)
        .set('Accept', 'application/json, text/event-stream')
        .set('mcp-session-id', sessionId)
        .set(MCP_SCOPE_HEADER, MCP_READ_SCOPE)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

      assert.equal(res.status, 403, `a scope mismatch answered ${res.status}: ${res.text}`);
      log('normal', `scope mismatch answered 403: ${res.text}`);
    } finally {
      await client.close();
    }
  });
});
