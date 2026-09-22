/**
 * HTTP tests for the Steadfast bridge (`/bridge/mcp`, routes/bridge.js).
 *
 * Driven the way tests/http/mcp.test.js drives `/mcp`, and for the same reason:
 * the endpoint has its own gate and its own workspace resolution, so the bug
 * shapes — a tool that forgot the workspace clause, a token that opens the
 * wrong door — only show up when a real client speaks the real transport
 * against a real database.
 *
 * What each group defends:
 *
 *   The gate. The box executes what it receives over this endpoint, so the gate
 *   is the line between "can edit Daniel's wiki" and "can run code on his box".
 *   The load-bearing assertion is that MCP_BEARER_TOKEN — valid for `/mcp` —
 *   is refused here. A refusal also names the bridge's protected-resource
 *   metadata in WWW-Authenticate, which is how an OAuth-capable client finds
 *   the bridge's own issuer instead of the wiki's.
 *
 *   Discovery + token issuance. Two paths must both end with BRIDGE_TOKEN: the
 *   path-based issuer under /bridge (RFC 9728 → 8414), and the origin's
 *   existing authorization server when the client says `resource=…/bridge/mcp`
 *   (RFC 8707). The latter must still hand the wiki connector MCP_BEARER_TOKEN
 *   when no resource is named — that is a regression guard on routes/oauth.js.
 *
 *   The mailbox. send → poll (delivered, once) → ack, replies linked by id,
 *   commands carrying their payload, and long-poll returning early.
 *
 *   Tenancy. The bridge acts as the MCP-associated user; switching that user
 *   must switch the visible mailbox entirely, and a foreign reply_to is refused.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';

import session from 'express-session';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import * as db from '../helpers/db.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import BridgeMessage from '../../src/models/BridgeMessage.js';
import BridgePresence from '../../src/models/BridgePresence.js';
import { setMcpUser } from '../../src/lib/mcpUserStore.js';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
// Both tokens set, and different: the gate group asserts the wiki token does
// not open the bridge, which is meaningless if either is unset or they match.
const MCP_TOKEN = 'test-mcp-bearer-token';
const BRIDGE_TOKEN = 'test-bridge-token-distinct';
process.env.MCP_BEARER_TOKEN = MCP_TOKEN;
process.env.BRIDGE_TOKEN = BRIDGE_TOKEN;
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.MCP_LOG_LEVEL ??= 'off';
process.env.BRIDGE_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const PASSWORD = 'correct-horse-battery-staple';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

/** The contract with the connector, per docs/architecture.md — a literal, so docs and code change together. */
const DOCUMENTED_TOOLS = ['bridge_send', 'bridge_poll', 'bridge_ack', 'bridge_announce', 'bridge_status', 'bridge_history'];

let app, httpServer, base, bridgeUrl, bridge, alice, bob;

async function registerUser(email) {
  const agent = request.agent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `register ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  return { agent, email, userId: String(user._id), workspaceId: String(workspace._id) };
}

async function connectClient(token) {
  const transport = new StreamableHTTPClientTransport(bridgeUrl, {
    requestInit: token === undefined ? undefined : { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'bridge-tests', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function callTool(name, args = {}) {
  const res = await bridge.callTool({ name, arguments: args });
  const text = (res.content ?? []).map((p) => p.text ?? '').join('');
  return { isError: Boolean(res.isError), text };
}
function parsed(name, res) {
  assert.equal(res.isError, false, `${name} should have succeeded: ${res.text}`);
  return JSON.parse(res.text);
}
const actAs = (who) => setMcpUser(who.userId);

const pkce = (verifier) => createHash('sha256').update(verifier).digest('base64url');
const codeFrom = (res) => {
  assert.equal(res.status, 302, `authorize should redirect: ${res.status} ${res.text}`);
  const url = new URL(res.headers.location);
  assert.equal(url.origin + url.pathname, REDIRECT);
  return url.searchParams.get('code');
};

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore() });
  httpServer = http.createServer(app);
  await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${httpServer.address().port}`;
  bridgeUrl = new URL(`${base}/bridge/mcp`);
  alice = await registerUser('bridge-alice@example.test');
  bob = await registerUser('bridge-bob@example.test');
  assert.notEqual(alice.workspaceId, bob.workspaceId);
  await actAs(alice);
  bridge = await connectClient(BRIDGE_TOKEN);
});

after(async () => {
  await bridge?.close();
  if (httpServer) { httpServer.closeAllConnections(); await new Promise((r) => httpServer.close(r)); }
  await db.disconnect();
});

describe('gate', () => {
  async function assertRefused(token, label) {
    await assert.rejects(() => connectClient(token), (err) => {
      assert.equal(err.code, 401, `${label} should be refused with 401, got: ${err.message}`);
      return true;
    });
  }
  test('no token is refused', () => assertRefused(undefined, 'no-token'));
  test('a wrong token is refused', () => assertRefused('nope', 'wrong-token'));
  test('the WIKI token (valid for /mcp) is refused here — the two doors are separate', () => assertRefused(MCP_TOKEN, 'mcp-token'));
  test('the bridge token initializes and sees tools', async () => {
    const c = await connectClient(BRIDGE_TOKEN);
    try { assert.ok((await c.listTools()).tools.length > 0); } finally { await c.close(); }
  });
  test('a refusal names the bridge\'s protected-resource metadata', async () => {
    const res = await request(app).post('/bridge/mcp')
      .set('Authorization', `Bearer ${MCP_TOKEN}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    assert.equal(res.status, 401);
    assert.match(res.headers['www-authenticate'] ?? '', /^Bearer resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/bridge\/mcp"$/);
  });
});

describe('discovery and token issuance', () => {
  test('protected-resource metadata points at the path-based issuer', async () => {
    const res = await request(app).get('/.well-known/oauth-protected-resource/bridge/mcp');
    assert.equal(res.status, 200);
    assert.match(res.body.resource, /\/bridge\/mcp$/);
    assert.equal(res.body.authorization_servers.length, 1);
    assert.match(res.body.authorization_servers[0], /\/bridge$/);
  });
  test('the issuer document names the bridge endpoints', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server/bridge');
    assert.equal(res.status, 200);
    assert.match(res.body.issuer, /\/bridge$/);
    assert.match(res.body.authorization_endpoint, /\/bridge\/authorize$/);
    assert.match(res.body.token_endpoint, /\/bridge\/oauth\/token$/);
    assert.deepEqual(res.body.code_challenge_methods_supported, ['S256']);
  });
  test('the path-based flow issues BRIDGE_TOKEN, and only for the right verifier', async () => {
    const page = await request(app).get('/bridge/authorize').query({ response_type: 'code', client_id: 'claude', redirect_uri: REDIRECT, code_challenge: pkce('v1'), code_challenge_method: 'S256', state: 's' });
    assert.equal(page.status, 200);
    assert.match(page.text, /remote-execution channel/);
    const code = codeFrom(await alice.agent.post('/bridge/authorize').type('form').send({ redirect_uri: REDIRECT, code_challenge: pkce('v1'), state: 's' }));
    const bad = await request(app).post('/bridge/oauth/token').type('form').send({ grant_type: 'authorization_code', code, code_verifier: 'wrong' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.detail, 'pkce mismatch');
    const ok = await request(app).post('/bridge/oauth/token').type('form').send({ grant_type: 'authorization_code', code, code_verifier: 'v1' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.access_token, BRIDGE_TOKEN);
    assert.equal(ok.body.scope, 'bridge');
    const replay = await request(app).post('/bridge/oauth/token').type('form').send({ grant_type: 'authorization_code', code, code_verifier: 'v1' });
    assert.equal(replay.status, 400, 'a code is single-use');
  });
  test('the origin issuer hands out BRIDGE_TOKEN when resource names the bridge, MCP_BEARER_TOKEN otherwise', async () => {
    const forBridge = codeFrom(await alice.agent.post('/authorize').type('form').send({ redirect_uri: REDIRECT, code_challenge: pkce('v2'), resource: `${base}/bridge/mcp` }));
    const b = await request(app).post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code: forBridge, code_verifier: 'v2' });
    assert.equal(b.status, 200, b.text);
    assert.equal(b.body.access_token, BRIDGE_TOKEN);
    const forWiki = codeFrom(await alice.agent.post('/authorize').type('form').send({ redirect_uri: REDIRECT, code_challenge: pkce('v3') }));
    const w = await request(app).post('/oauth/token').type('form').send({ grant_type: 'authorization_code', code: forWiki, code_verifier: 'v3' });
    assert.equal(w.status, 200, w.text);
    assert.equal(w.body.access_token, MCP_TOKEN, 'the wiki connector must still get its own token');
    assert.equal(w.body.scope, undefined);
  });
});

describe('tools/list', () => {
  test('advertises exactly the documented bridge tools', async () => {
    const { tools } = await bridge.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...DOCUMENTED_TOOLS].sort());
    for (const t of tools) {
      assert.ok(t.description?.length > 0, `${t.name} has no description`);
      assert.equal(t.inputSchema?.type, 'object');
    }
  });
});

describe('mailbox', () => {
  let toBox;
  test('send → pending, addressed to a session', async () => {
    toBox = parsed('bridge_send', await callTool('bridge_send', { to: 'box', session: 'steadfast-ai', text: 'What is the grading backlog?' }));
    assert.equal(toBox.status, 'pending');
    assert.equal(toBox.to, 'box');
    assert.equal(toBox.session, 'steadfast-ai');
    assert.equal(toBox.command, undefined, 'plain messages carry no command payload');
    const status = parsed('bridge_status', await callTool('bridge_status'));
    assert.deepEqual(status.pending, { box: 1, chat: 0 });
  });
  test('poll delivers once, filtered by session', async () => {
    const other = parsed('bridge_poll', await callTool('bridge_poll', { for: 'box', session: 'plumb' }));
    assert.equal(other.messages.length, 0, 'a different session sees nothing');
    const first = parsed('bridge_poll', await callTool('bridge_poll', { for: 'box', session: 'steadfast-ai' }));
    assert.equal(first.messages.length, 1);
    assert.equal(first.messages[0].id, toBox.id);
    assert.equal(first.messages[0].status, 'delivered');
    assert.ok(first.messages[0].delivered_at);
    const again = parsed('bridge_poll', await callTool('bridge_poll', { for: 'box' }));
    assert.equal(again.messages.length, 0, 'delivered messages are not delivered twice');
  });
  test('a reply links to the message it answers; ack finishes the exchange', async () => {
    const reply = parsed('bridge_send', await callTool('bridge_send', { to: 'chat', session: 'steadfast-ai', text: '94 ungraded, 19 draining.', reply_to: toBox.id }));
    assert.equal(reply.reply_to, toBox.id);
    const ack = parsed('bridge_ack', await callTool('bridge_ack', { ids: [toBox.id, 'not-an-id', '000000000000000000000000'] }));
    assert.deepEqual(ack, { acked: 1, ignored: 2 });
    const inbox = parsed('bridge_poll', await callTool('bridge_poll', { for: 'chat' }));
    assert.equal(inbox.messages.length, 1);
    assert.equal(inbox.messages[0].id, reply.id);
    const history = parsed('bridge_history', await callTool('bridge_history', { session: 'steadfast-ai' }));
    assert.deepEqual(history.messages.map((m) => [m.to, m.status]), [['box', 'acked'], ['chat', 'delivered']], 'oldest first, with final statuses');
  });
  test('commands carry their payload and need a name', async () => {
    const bad = await callTool('bridge_send', { to: 'box', text: 'restart', kind: 'command' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /command\.name/);
    const cmd = parsed('bridge_send', await callTool('bridge_send', { to: 'box', session: 'steadfast-ai', text: 'Roll the session', kind: 'command', command: { name: 'sessions.roll', args: { repo: 'steadfast-ai', force: true } } }));
    assert.equal(cmd.kind, 'command');
    assert.deepEqual(cmd.command, { name: 'sessions.roll', args: { repo: 'steadfast-ai', force: true } });
    parsed('bridge_ack', await callTool('bridge_ack', { ids: [cmd.id] }));
  });
  test('reply_to must be a real id in this workspace', async () => {
    assert.equal((await callTool('bridge_send', { to: 'chat', text: 'x', reply_to: 'garbage' })).isError, true);
    assert.equal((await callTool('bridge_send', { to: 'chat', text: 'x', reply_to: '000000000000000000000000' })).isError, true);
  });
  test('long-poll returns as soon as a message lands', async () => {
    const started = Date.now();
    const waiting = callTool('bridge_poll', { for: 'box', session: 'longpoll', wait_seconds: 8 });
    await new Promise((r) => setTimeout(r, 400));
    parsed('bridge_send', await callTool('bridge_send', { to: 'box', session: 'longpoll', text: 'wake up' }));
    const got = parsed('bridge_poll', await waiting);
    assert.equal(got.messages.length, 1);
    assert.ok(Date.now() - started < 6000, 'should have returned well before the 8 s wait ended');
  });
});

describe('presence', () => {
  test('announce replaces a host\'s sessions; status lists it', async () => {
    parsed('bridge_announce', await callTool('bridge_announce', { host: 'steadfast-ai', sessions: [{ name: 'steadfast-ai-59', repo: 'steadfast-ai', status: 'idle' }, { name: 'plumb-6f', repo: 'plumb' }] }));
    let status = parsed('bridge_status', await callTool('bridge_status'));
    assert.equal(status.presence.length, 1);
    assert.equal(status.presence[0].sessions.length, 2);
    parsed('bridge_announce', await callTool('bridge_announce', { host: 'steadfast-ai', sessions: [{ name: 'steadfast-ai-60' }] }));
    status = parsed('bridge_status', await callTool('bridge_status'));
    assert.deepEqual(status.presence[0].sessions.map((s) => s.name), ['steadfast-ai-60']);
    assert.equal(await BridgePresence.countDocuments({ host: 'steadfast-ai' }), 1, 'one document per host, replaced not appended');
  });
});

describe('tenancy', () => {
  test('switching the MCP user switches the whole mailbox', async () => {
    const aliceCount = await BridgeMessage.countDocuments({ workspaceId: alice.workspaceId });
    assert.ok(aliceCount >= 4, 'fixture: alice should have messages by now');
    await actAs(bob);
    try {
      assert.deepEqual(parsed('bridge_status', await callTool('bridge_status')), { presence: [], pending: { box: 0, chat: 0 } });
      assert.equal(parsed('bridge_history', await callTool('bridge_history')).messages.length, 0);
      assert.equal(parsed('bridge_poll', await callTool('bridge_poll', { for: 'chat' })).messages.length, 0, 'alice\'s pending reply must not reach bob');
      const mine = parsed('bridge_send', await callTool('bridge_send', { to: 'box', text: 'bob here' }));
      assert.equal(String((await BridgeMessage.findById(mine.id).lean()).workspaceId), bob.workspaceId);
      const aliceMsg = await BridgeMessage.findOne({ workspaceId: alice.workspaceId }).lean();
      assert.equal((await callTool('bridge_send', { to: 'chat', text: 'x', reply_to: String(aliceMsg._id) })).isError, true, 'a foreign reply_to is refused');
    } finally {
      await actAs(alice);
    }
    assert.equal(await BridgeMessage.countDocuments({ workspaceId: alice.workspaceId }), aliceCount, 'bob\'s activity left alice\'s mailbox untouched');
  });
  test('with no MCP user configured every tool refuses', async () => {
    await setMcpUser(null);
    try {
      const res = await callTool('bridge_status');
      assert.equal(res.isError, true);
      assert.match(res.text, /not authorized/);
    } finally {
      await actAs(alice);
    }
  });
});
