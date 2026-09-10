/**
 * HTTP tests for the MCP endpoint: the auth gate, the advertised tool list, and
 * workspace scoping of the read tools.
 *
 * `/mcp` is the second front door into tenant content — Claude talks to it
 * directly, and it does not go through `requireAuth`/`resolveWorkspace` like
 * every REST mount does. It has its own bearer check and its own
 * `mcpWorkspaceId()` helper, and every tool has to remember to call it. That
 * makes it exactly the kind of surface a unit test cannot defend: the bug shape
 * is "a tool forgot the workspace clause", which only shows up when a real
 * client drives a real transport against a real database.
 *
 * So these drive the whole stack the way Claude does: `createApp()` on a real
 * listening socket (port 0, so parallel test files never collide), the SDK's
 * own `Client` + `StreamableHTTPClientTransport` over that socket, real
 * registration through `POST /auth/register`, real mongod. Nothing here stubs
 * the transport — a hand-rolled JSON-RPC POST would pass even if session
 * handling or the initialize handshake were broken.
 *
 * What each group defends:
 *
 *   The auth gate is the only thing standing between the public internet and
 *   every tool below it. `MCP_BEARER_TOKEN` is read once at module load in
 *   `src/routes/mcp.js`, and an unset token means "dev mode: no token required"
 *   — an open endpoint. The gate is therefore tested with the token configured,
 *   which is the deployed shape, and both the missing-header and wrong-token
 *   cases must be refused before any session is created.
 *
 *   The tool list is a contract with the Claude.ai connector and with
 *   `docs/architecture.md`. A tool that is registered but undocumented, or
 *   documented but silently dropped from `createMcpServer()`, is a connector
 *   that quietly loses a capability. The assertion is set equality in both
 *   directions, so either mistake fails.
 *
 *   Workspace scoping is the tenancy boundary. The MCP connector acts as one
 *   user (`Settings.mcpUserId`) and must see exactly that user's workspace.
 *   Two failure shapes matter and are both asserted: a tool that omits the
 *   `workspaceId` clause (B's content appears in A's results), and a tool that
 *   runs with no MCP user configured at all (`mcpWorkspaceId()` must throw
 *   rather than return undefined, because Mongoose would cast an undefined
 *   filter value to null and quietly widen the query).
 *
 * Both fixture accounts register through the real endpoint, so both get the
 * default workspace template seeded into them. That is deliberate: every
 * workspace here is non-empty and holds same-titled example content, so the
 * scoping assertions compare *ids* against what the database says lives in that
 * workspace rather than counting titles — a leak shows up as an extra id, and an
 * accidentally-empty response fails rather than passes.
 *
 * Falsification checks for this suite: delete the `if (auth !== ...)` block in
 * `src/routes/mcp.js` and the auth group fails; drop a `server.tool(...)` call
 * and the tool-list test fails; remove `workspaceId` from the `Entity.find`
 * filter in `search_entities`, or from the `Entity.findOne` filter in
 * `get_entity`, and the scoping group fails; make `mcpWorkspaceId()` return
 * `null` instead of throwing and the fail-closed test fails.
 *
 * Deliberately not covered: the identity model behind `Settings.mcpUserId` —
 * a single global "the MCP user" is a single-tenant assumption that KOL-014
 * replaces. This file uses `setMcpUser()` as it exists today and asserts only
 * that the tools follow whatever identity it names. Also not covered: the write
 * tools (create/update/relationships) and the OAuth flow the Claude.ai
 * connector uses to obtain a token, which `tests/http/oauth.test.js` owns.
 *
 * A note on "throws": a tool handler that throws does not surface as a JSON-RPC
 * error. The SDK's `McpServer` catches it and answers with a normal result
 * carrying `isError: true` and the message as text, so `client.callTool()`
 * resolves rather than rejecting. The cross-tenant assertions below therefore
 * check `isError` and the message, which is the same failure the model sees.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_MCP_LOG_LEVEL = off | light | normal | verbose (default light)
 * When one of these fails on an unattended run, the missing information is
 * always which identity the connector was acting as, which workspace that
 * resolved to, and where that id came from — never the assertion itself.
 *   off     — nothing
 *   light   — one line per fixture document and per change of MCP identity,
 *             naming the call that caused it and the workspace it points at
 *   normal  — light, plus every client connection and tool call with its status
 *   verbose — normal, plus the full text payload each tool returned
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import session from 'express-session';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import * as db from '../helpers/db.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import Settings from '../../src/models/Settings.js';
import Entity from '../../src/models/Entity.js';
import { setMcpUser } from '../../src/lib/mcpUserStore.js';

// `src/routes/mcp.js` reads MCP_BEARER_TOKEN at module load, and createApp()
// reads NODE_ENV when called — so the environment has to be in place before
// src/app.js is imported, hence the dynamic import below rather than a static
// one. NODE_ENV must not be 'production' here: that arms secure/none/
// domain-scoped session cookies, which supertest's agent would refuse to send
// back when registering the two fixture accounts.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
// Load-bearing for this file: with no token the MCP router takes its "dev mode:
// no token required" path and the auth group would pass trivially against an
// open endpoint.
const MCP_TOKEN = 'test-mcp-bearer-token';
process.env.MCP_BEARER_TOKEN = MCP_TOKEN;
// A different secret entirely, and unset on purpose. BEARER_TOKEN is the REST
// API's programmatic key; leaving it set would let a stray Authorization header
// satisfy requireAuth on /entities and blur which gate a result came from.
delete process.env.BEARER_TOKEN;
// Registration seeds a workspace per account and seedWorkspace logs at 'light'
// by default. Overridable when a seeding problem is what is being chased.
process.env.SEED_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_MCP_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/mcp:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

/**
 * The tools the connector is promised, per the table in docs/architecture.md.
 * Kept as a literal rather than derived from the router, so that this list and
 * the code have to be changed together — a list read back out of
 * `createMcpServer()` would agree with any mistake.
 */
const DOCUMENTED_TOOLS = [
  'search_entities',
  'get_entity',
  'create_entity',
  'update_entity',
  'add_open_question',
  'list_open_questions',
  'add_relationship',
  'add_member_to_relationship',
  'update_group_label',
  'remove_relationship',
  'update_relationship_label',
  'add_subgroup_to_relationship',
  'remove_subgroup_from_relationship',
];

let app;
let httpServer;
/** URL of the mounted endpoint on the ephemeral port, set in before(). */
let mcpUrl;
/** A connected client holding a valid token, shared by the read-only groups. */
let mcp;

/** The two tenants: a supertest agent plus the ids registration created. */
let alice;
let bob;

const ALICE_ENTITY = { title: 'Alice Alpha', category: 'Characters', summary: 'Alice content, keyword: shibboleth.' };
const ALICE_OTHER  = { title: 'Alice Beta',  category: 'Worlds',     summary: 'More alice content.' };
const BOB_ENTITY   = { title: 'Bob Only',    category: 'Characters', summary: 'Bob content, keyword: shibboleth.' };

/** Ids of the fixture entities, filled in by before(). */
const owned = { aliceEntityId: null, aliceOtherId: null, bobEntityId: null };

/**
 * Registers a user through the real endpoint and reads back the ids
 * registration created, so the fixture asserts on what the API actually did
 * rather than on what it was asked to do.
 */
async function registerUser(email) {
  const agent = request.agent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  assert.ok(user, `registration should have created a User for ${email}`);
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  log('light', `registered ${email} (source: POST /auth/register) → user ${user._id}, workspace ${workspace._id} (source: Workspace.members.userId lookup)`);
  return { agent, email, userId: String(user._id), workspaceId: String(workspace._id) };
}

/** POSTs an entity as `who` over the REST API and returns the created document. */
async function createEntity(who, body) {
  const res = await who.agent.post('/entities').send(body);
  assert.equal(res.status, 201, `POST /entities as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(String(res.body.workspaceId), who.workspaceId, `${who.email}'s entity must land in their own workspace`);
  log('light', `created entity ${res.body._id} "${res.body.title}" (source: POST /entities as ${who.email}) in workspace ${res.body.workspaceId}`);
  return res.body;
}

/**
 * Opens an MCP client against the listening server.
 * `token === undefined` sends no Authorization header at all, which is the
 * unauthenticated case; any string is sent verbatim as a bearer token.
 */
async function connectClient(token, label) {
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: token === undefined ? undefined : { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'kol-emet-tests', version: '0.0.0' });
  await client.connect(transport);
  log('normal', `connected client "${label}" (source: ${token === undefined ? 'no Authorization header' : 'Authorization: Bearer …'}), session ${transport.sessionId ?? 'none'}`);
  return client;
}

/** Calls a tool and returns { isError, text }, logging what came back. */
async function callTool(name, args) {
  const res = await mcp.callTool({ name, arguments: args });
  const text = (res.content ?? []).map(part => part.text ?? '').join('');
  log('normal', `${name}(${JSON.stringify(args)}) → isError=${Boolean(res.isError)}, ${text.length} chars`);
  log('verbose', `${name} payload: ${text}`);
  return { isError: Boolean(res.isError), text };
}

/** Parses a successful tool payload, failing loudly when the tool errored. */
function parsed(name, res) {
  assert.equal(res.isError, false, `${name} should have succeeded but returned isError: ${res.text}`);
  return JSON.parse(res.text);
}

/**
 * Asserts a tool's entity list is exactly the contents of `who`'s workspace.
 *
 * Compared against a direct query rather than a hard-coded list of titles,
 * because registration seeds a template into every workspace: the interesting
 * property is "these ids and no others", which stays true however the template
 * changes. Both directions matter — an extra id is a cross-tenant leak, a
 * missing id is an over-narrow filter that hides a tenant's own content.
 */
async function assertScopedTo(who, entities) {
  const expected = await Entity.find({ workspaceId: who.workspaceId }).select('_id').lean();
  const expectedIds = expected.map(e => String(e._id)).sort();
  const actualIds = entities.map(e => String(e._id)).sort();

  log('verbose', `scoping check for ${who.email}: tool returned ${actualIds.length} id(s), workspace ${who.workspaceId} holds ${expectedIds.length} (source: direct Entity.find)`);
  assert.ok(expectedIds.length > 0, `fixture problem: ${who.email}'s workspace is empty, so this assertion proves nothing`);
  assert.deepEqual(actualIds, expectedIds, `search_entities must return exactly ${who.email}'s workspace`);
  for (const entity of entities) {
    assert.equal(String(entity.workspaceId), who.workspaceId, `${entity.title} is stamped with a foreign workspace`);
  }
}

/** Points Settings.mcpUserId at `who` and logs which workspace that implies. */
async function actAs(who) {
  await setMcpUser(who.userId);
  const stored = await Settings.findById('global').lean();
  assert.equal(String(stored.mcpUserId), who.userId, 'setMcpUser should have persisted the id it was given');
  log('light', `MCP identity is now ${who.email} / user ${who.userId} (source: setMcpUser via Settings.mcpUserId) → workspace ${who.workspaceId}`);
}

before(async () => {
  await db.connect();

  app = createApp({ sessionStore: new session.MemoryStore() });
  httpServer = http.createServer(app);
  // Port 0: the OS picks a free port, so this file can run alongside the other
  // test files without a hard-coded port to collide on.
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  mcpUrl = new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
  log('light', `listening on ${mcpUrl.href} (source: httpServer.address(), port requested as 0)`);

  alice = await registerUser('mcp-alice@example.test');
  bob   = await registerUser('mcp-bob@example.test');
  assert.notEqual(alice.workspaceId, bob.workspaceId, 'two registrations must yield two distinct workspaces');

  owned.aliceEntityId = String((await createEntity(alice, ALICE_ENTITY))._id);
  owned.aliceOtherId  = String((await createEntity(alice, ALICE_OTHER))._id);
  owned.bobEntityId   = String((await createEntity(bob,   BOB_ENTITY))._id);

  mcp = await connectClient(MCP_TOKEN, 'shared/authorized');
});

after(async () => {
  await mcp?.close();
  if (httpServer) {
    // fetch keeps its sockets alive, so close() alone would wait them out.
    httpServer.closeAllConnections();
    await new Promise(resolve => httpServer.close(resolve));
  }
  await db.disconnect();
});

describe('POST /mcp auth gate', () => {
  /** Asserts a connection attempt was refused with 401 before any handshake. */
  async function assertRefused(token, label) {
    await assert.rejects(
      () => connectClient(token, label),
      (err) => {
        log('normal', `${label} was refused with code=${err.code ?? 'none'}: ${err.message}`);
        assert.equal(err.code, 401, `${label} should be refused with 401, got: ${err.message}`);
        return true;
      },
      `${label} should not have been able to initialize a session`
    );
  }

  test('a client with no Authorization header cannot initialize', async () => {
    await assertRefused(undefined, 'no-token');
  });

  test('a client with the wrong bearer token cannot initialize', async () => {
    await assertRefused('not-the-token', 'wrong-token');
  });

  test('a client with the configured bearer token initializes', async () => {
    const client = await connectClient(MCP_TOKEN, 'right-token');
    try {
      // Reaching a tool list at all proves the handshake completed, which the
      // two refusals above never get to.
      const { tools } = await client.listTools();
      assert.ok(tools.length > 0, 'an authorized session should see the tool list');
    } finally {
      await client.close();
    }
  });
});

describe('tools/list', () => {
  test('advertises exactly the tools documented in docs/architecture.md', async () => {
    const { tools } = await mcp.listTools();
    const names = tools.map(t => t.name).sort();
    const expected = [...DOCUMENTED_TOOLS].sort();
    log('normal', `tools/list returned ${names.length} tool(s): ${names.join(', ')}`);

    assert.deepEqual(
      names,
      expected,
      'tools/list must match the table in docs/architecture.md — a tool added to ' +
      'src/routes/mcp.js has to be documented, and a documented tool has to exist'
    );
    assert.equal(names.length, 13, 'the documented contract is 13 tools');
  });

  test('every tool carries a description and an input schema', async () => {
    const { tools } = await mcp.listTools();
    for (const tool of tools) {
      // The descriptions are how the model decides which tool to reach for;
      // an empty one is a tool that exists and never gets called.
      assert.ok(tool.description?.length > 0, `${tool.name} has no description`);
      assert.equal(tool.inputSchema?.type, 'object', `${tool.name} has no object input schema`);
    }
  });
});

describe('workspace scoping', () => {
  test('fails closed when no MCP user is configured', async () => {
    // Runs before actAs(alice) below: at this point Settings has never been
    // written. An unscoped query here would return alice's *and* bob's content.
    const stored = await Settings.findById('global').lean();
    assert.equal(stored?.mcpUserId ?? null, null, 'this test must run before any setMcpUser call');

    const res = await callTool('search_entities', {});
    assert.equal(res.isError, true, 'search_entities must refuse to run without an MCP identity');
    assert.match(res.text, /not authorized/i, `unexpected error text: ${res.text}`);
  });

  describe('acting as alice', () => {
    before(async () => { await actAs(alice); });

    test('search_entities returns exactly the acting user\'s workspace', async () => {
      const entities = parsed('search_entities', await callTool('search_entities', {}));

      await assertScopedTo(alice, entities);
      const titles = entities.map(e => e.title);
      assert.ok(titles.includes(ALICE_ENTITY.title) && titles.includes(ALICE_OTHER.title), `alice's own entities are missing: ${titles.join(', ')}`);
      assert.ok(!titles.includes(BOB_ENTITY.title), `bob's entity leaked into alice's results: ${titles.join(', ')}`);
    });

    test('a keyword both tenants match still returns only alice\'s', async () => {
      // Both fixtures contain "shibboleth", so a missing workspace clause shows
      // up here as an extra result rather than as an empty one.
      const entities = parsed('search_entities', await callTool('search_entities', { q: 'shibboleth' }));

      assert.equal(entities.length, 1, `expected only alice's match, got: ${entities.map(e => e.title).join(', ')}`);
      assert.equal(entities[0].title, ALICE_ENTITY.title);
    });

    test('get_entity reads alice\'s own entity', async () => {
      const entity = parsed('get_entity', await callTool('get_entity', { id: owned.aliceEntityId }));

      assert.equal(entity.title, ALICE_ENTITY.title);
      assert.equal(String(entity.workspaceId), alice.workspaceId);
    });

    test('get_entity on another tenant\'s id errors and leaks nothing', async () => {
      const res = await callTool('get_entity', { id: owned.bobEntityId });

      assert.equal(res.isError, true, "bob's entity must not be readable as alice");
      // "not found", never "forbidden": the same answer a non-existent id gets,
      // so the tool cannot be used to probe which ids exist. See the matching
      // note in src/routes/entities.js.
      assert.match(res.text, /not found/i, `unexpected error text: ${res.text}`);
      assert.doesNotMatch(res.text, new RegExp(BOB_ENTITY.title, 'i'), 'the error must not echo the foreign entity');
    });
  });

  describe('after the MCP identity changes to bob', () => {
    before(async () => { await actAs(bob); });

    test('search_entities follows the new identity, on the live session', async () => {
      // Same client, same MCP session as the alice cases above — the workspace
      // is resolved per call, so this proves the scoping tracks the configured
      // identity rather than something latched at connect time.
      const entities = parsed('search_entities', await callTool('search_entities', {}));

      await assertScopedTo(bob, entities);
      const titles = entities.map(e => e.title);
      assert.ok(titles.includes(BOB_ENTITY.title), `bob's own entity is missing: ${titles.join(', ')}`);
      assert.ok(!titles.includes(ALICE_ENTITY.title), `alice's entity leaked into bob's results: ${titles.join(', ')}`);
    });

    test('alice\'s entity is now the unreachable one', async () => {
      const res = await callTool('get_entity', { id: owned.aliceEntityId });

      assert.equal(res.isError, true, "alice's entity must not be readable as bob");
      assert.match(res.text, /not found/i, `unexpected error text: ${res.text}`);
    });
  });
});
