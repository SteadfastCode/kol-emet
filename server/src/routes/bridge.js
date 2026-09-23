/**
 * The Steadfast bridge: a second MCP endpoint, `/bridge/mcp`, that relays
 * messages between a claude.ai chat and Claude Code sessions on the
 * steadfast-ai box. Neither end can reach the other — the box is tailnet-only
 * and a chat session has no filesystem — but both already reach this server,
 * so it holds the mailbox.
 *
 * Why a separate endpoint and a separate token rather than six more tools on
 * `/mcp`: the box side of the bridge executes what it receives. Whoever can
 * write a bridge message can run code on the box. `MCP_BEARER_TOKEN` is held by
 * the Claude.ai connector, sits in the chat endpoint's config, and guards wiki
 * content; making it also a remote-execution credential would turn every place
 * it lives into an RCE surface. `BRIDGE_TOKEN` is held by exactly two parties —
 * the box's poller and the one connector Daniel authorizes for the bridge — and
 * a leak of one token never becomes the other's capability.
 *
 * Identity, on the other hand, is shared on purpose: the bridge acts as the
 * MCP-associated user (`Settings.mcpUserId`) and scopes every query to that
 * workspace, exactly as `/mcp` does. One identity, two tokens.
 *
 * Auth for the two clients:
 *   - the box: a static `Authorization: Bearer <BRIDGE_TOKEN>`.
 *   - Claude.ai: an OAuth authorization-code + PKCE flow, the same shape
 *     `routes/oauth.js` runs for the wiki connector, but issuing BRIDGE_TOKEN.
 *     Two discovery paths lead here, because it is not certain which the
 *     connector follows: (1) a 401 from `/bridge/mcp` names its protected-
 *     resource metadata (RFC 9728), which points at the path-based issuer
 *     `<origin>/bridge` with its own RFC 8414 document and endpoints below;
 *     (2) a client that goes straight to the origin's authorization server
 *     still ends up with BRIDGE_TOKEN if it carried `resource=…/bridge/mcp`
 *     (RFC 8707), which `routes/oauth.js` now honours.
 *
 * The endpoint is stateless (see the Transport section): a deploy strands no one.
 *
 * The gate fails closed everywhere: with no BRIDGE_TOKEN every request answers
 * 503, in development too. `/mcp` stays open in dev so a local Claude Code
 * session needs no secret; there is no such use for an unauthenticated
 * remote-execution mailbox, so the bridge does not inherit that convenience.
 */

import { Router } from 'express';
import { randomUUID, createHash } from 'crypto';
import mongoose from 'mongoose';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import BridgeMessage from '../models/BridgeMessage.js';
import BridgePresence from '../models/BridgePresence.js';
import RoutineRepo from '../models/RoutineRepo.js';
import RoutineItem, { ROUTINE_ITEM_STATES } from '../models/RoutineItem.js';
import { mcpWorkspaceId } from '../lib/mcpWorkspace.js';
import { setMcpUser } from '../lib/mcpUserStore.js';

const router = Router();

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };
function log(level, msg) {
  const active = LEVELS[process.env.BRIDGE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[bridge:${level}] ${msg}`);
}

// Read once at module load, like /mcp: the gate's answer is a property of how the
// process was started.
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
if (!BRIDGE_TOKEN) {
  log('light', 'gate is DISABLED: BRIDGE_TOKEN unset (source: process.env at module load) — every /bridge/mcp request answers 503 until the token is set and the process restarts');
} else {
  log('light', 'gate is ENFORCED: bearer token required (source: BRIDGE_TOKEN at module load)');
}

export const MCP_PATH = '/bridge/mcp';
const ISSUER_PATH = '/bridge';
const origin = (req) => `${req.protocol}://${req.get('host')}`;
const resourceMetadataUrl = (req) => `${origin(req)}/.well-known/oauth-protected-resource${MCP_PATH}`;

// ─── Discovery (RFC 9728 + RFC 8414, path-based issuer) ──────────────────────

router.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, (req, res) => {
  res.json({
    resource: `${origin(req)}${MCP_PATH}`,
    authorization_servers: [`${origin(req)}${ISSUER_PATH}`],
    bearer_methods_supported: ['header'],
    scopes_supported: ['bridge'],
  });
});

router.get(`/.well-known/oauth-authorization-server${ISSUER_PATH}`, (req, res) => {
  const base = origin(req);
  res.json({
    issuer: `${base}${ISSUER_PATH}`,
    authorization_endpoint: `${base}${ISSUER_PATH}/authorize`,
    token_endpoint: `${base}${ISSUER_PATH}/oauth/token`,
    grant_types_supported: ['authorization_code'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['bridge'],
  });
});

// ─── Authorization code + PKCE, issuing BRIDGE_TOKEN ─────────────────────────

const authCodes = new Map(); // code -> { codeChallenge, redirectUri, expiresAt }

router.get(`${ISSUER_PATH}/authorize`, (req, res) => {
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.query;
  if (response_type !== 'code') return res.status(400).send('unsupported_response_type');
  if (code_challenge_method !== 'S256') return res.status(400).send('code_challenge_method must be S256');
  if (!code_challenge || !redirect_uri) return res.status(400).send('missing required parameters');
  log('normal', `GET ${ISSUER_PATH}/authorize for client ${client_id ?? 'unknown'}`);
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Authorize — Steadfast bridge</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; } body { font-family: system-ui, sans-serif; background: #111; color: #eee; }
  .center { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
  .card { background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 2rem; max-width: 420px; width: 90%; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; } p { color: #aaa; font-size: 0.9rem; margin: 0 0 1.5rem; }
  .client { font-weight: 600; color: #eee; } .warn { color: #f59e0b; }
  button { background: #4f46e5; color: #fff; border: none; border-radius: 8px; padding: 0.75rem 2rem; font-size: 1rem; cursor: pointer; width: 100%; }
</style></head>
<body><div class="center"><div class="card">
  <h1>Authorize the Steadfast bridge</h1>
  <p><span class="client">${escapeHtml(client_id ?? 'Unknown client')}</span> wants to send messages to, and run commands on, the Claude Code sessions on your steadfast-ai box. <span class="warn">This is a remote-execution channel.</span></p>
  <form method="POST" action="${ISSUER_PATH}/authorize">
    <input type="hidden" name="client_id" value="${escapeHtml(client_id ?? '')}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge)}">
    <input type="hidden" name="state" value="${escapeHtml(state ?? '')}">
    <button type="submit">Allow</button>
  </form>
</div></div></body></html>`);
});

router.post(`${ISSUER_PATH}/authorize`, async (req, res) => {
  const { redirect_uri, code_challenge, state } = req.body;
  if (!redirect_uri || !code_challenge) return res.status(400).send('missing required parameters');
  // Same identity as the wiki connector, on purpose (see the header).
  if (req.session?.userId) {
    await setMcpUser(req.session.userId);
    log('light', `bridge authorized by user ${req.session.userId}; MCP identity set (source: POST ${ISSUER_PATH}/authorize with a login session)`);
  } else {
    log('light', `POST ${ISSUER_PATH}/authorize with no login session — tools will refuse until the connector is authorized by a logged-in user`);
  }
  const code = randomUUID();
  authCodes.set(code, { codeChallenge: code_challenge, redirectUri: redirect_uri, expiresAt: Date.now() + 5 * 60 * 1000 });
  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
});

router.post(`${ISSUER_PATH}/oauth/token`, (req, res) => {
  const { grant_type, code, code_verifier } = req.body;
  if (grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });
  if (!BRIDGE_TOKEN) return res.status(500).json({ error: 'server_misconfigured' });
  const stored = authCodes.get(code);
  if (!stored) return res.status(400).json({ error: 'invalid_grant', detail: 'code not found' });
  if (Date.now() > stored.expiresAt) { authCodes.delete(code); return res.status(400).json({ error: 'invalid_grant', detail: 'code expired' }); }
  const challenge = createHash('sha256').update(String(code_verifier ?? '')).digest('base64url');
  if (challenge !== stored.codeChallenge) return res.status(400).json({ error: 'invalid_grant', detail: 'pkce mismatch' });
  authCodes.delete(code);
  log('light', 'bridge token issued (source: authorization_code + PKCE)');
  res.json({ access_token: BRIDGE_TOKEN, token_type: 'Bearer', expires_in: 315360000, scope: 'bridge' });
});

// ─── Gate ─────────────────────────────────────────────────────────────────────

router.use(MCP_PATH, (req, res, next) => {
  log('normal', `${req.method} ${MCP_PATH} — session: ${req.headers['mcp-session-id'] ?? 'none'} — auth: ${req.headers['authorization'] ? 'present' : 'missing'}`);
  if (!BRIDGE_TOKEN) {
    log('light', `refused ${req.method} ${MCP_PATH} with 503 (source: BRIDGE_TOKEN unset)`);
    return res.status(503).json({ error: 'Bridge not configured' });
  }
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${BRIDGE_TOKEN}`) {
    log('light', `refused ${req.method} ${MCP_PATH} with 401 (source: Authorization header ${auth ? 'did not match BRIDGE_TOKEN' : 'absent'})`);
    log('verbose', `rejected Authorization header: ${auth ?? '(none)'}`);
    // Names the resource metadata so an OAuth-capable client can find the bridge's own issuer.
    res.set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl(req)}"`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ─── Tools ───────────────────────────────────────────────────────────────────

const SIDE = z.enum(['box', 'chat']);
const POLL_MS = 1000;
const MAX_WAIT_S = 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const failure = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });

function view(m) {
  return {
    id: String(m._id), to: m.to, session: m.session, kind: m.kind, text: m.text,
    ...(m.kind === 'command' ? { command: m.command } : {}),
    reply_to: m.replyTo ? String(m.replyTo) : null,
    status: m.status, created_at: m.createdAt, delivered_at: m.deliveredAt, acked_at: m.ackedAt,
  };
}
const presenceView = (p) => ({ host: p.host, sessions: p.sessions, announced_at: p.announcedAt });

export function createBridgeServer() {
  const server = new McpServer({ name: 'steadfast-bridge', version: '0.1.0' });

  server.tool(
    'bridge_send',
    'Send a message across the Steadfast bridge. to: "box" reaches a Claude Code session on the steadfast-ai box (name it with session); to: "chat" is a reply back to the claude.ai chat. kind: "command" asks the box to run a named operation instead of relaying text.',
    {
      to: SIDE.describe('Which side reads it: "box" or "chat"'),
      text: z.string().min(1).describe('The message. For commands, a human-readable description of what is being asked'),
      session: z.string().optional().describe('Target session name when to="box" (e.g. "steadfast-ai"); origin session when to="chat"'),
      kind: z.enum(['message', 'command']).optional().describe('Default "message"'),
      command: z.object({ name: z.string(), args: z.record(z.unknown()).optional() }).optional().describe('Required when kind="command": what the box should do'),
      reply_to: z.string().optional().describe('Id of the bridge message this answers'),
    },
    async ({ to, text, session, kind = 'message', command, reply_to }) => {
      const workspaceId = await mcpWorkspaceId();
      if (kind === 'command' && !command?.name) return failure('kind "command" needs command.name');
      let replyTo = null;
      if (reply_to) {
        if (!mongoose.isValidObjectId(reply_to)) return failure(`reply_to is not a valid id: ${reply_to}`);
        // Only this workspace's messages can be answered — a foreign id is refused, not silently dropped.
        const parent = await BridgeMessage.exists({ _id: reply_to, workspaceId });
        if (!parent) return failure(`reply_to not found: ${reply_to}`);
        replyTo = parent._id;
      }
      const m = await BridgeMessage.create({
        workspaceId, to, session: session ?? null, kind, text,
        command: kind === 'command' ? { name: command.name, args: command.args ?? null } : { name: null, args: null },
        replyTo,
      });
      log('normal', `sent ${m._id} to=${to} session=${session ?? '-'} kind=${kind}`);
      return json(view(m));
    }
  );

  server.tool(
    'bridge_poll',
    'Receive pending messages for one side, oldest first, and mark them delivered. wait_seconds long-polls: the call returns as soon as a message arrives or when the wait ends (max 25 s). While the box compiles an answer it sends progress lines starting with ⏳ — relay those as heartbeats ("still working: reading the ledger…"), never as the answer, and poll again with wait_seconds until a reply without the marker arrives.',
    {
      for: SIDE.describe('Whose inbox: "box" or "chat"'),
      session: z.string().optional().describe('Only messages for this session name'),
      limit: z.number().int().min(1).max(50).optional().describe('Default 20'),
      wait_seconds: z.number().int().min(0).max(MAX_WAIT_S).optional().describe('Long-poll up to this many seconds (default 0)'),
    },
    async ({ for: side, session, limit = 20, wait_seconds = 0 }) => {
      const workspaceId = await mcpWorkspaceId();
      const query = { workspaceId, to: side, status: 'pending', ...(session ? { session } : {}) };
      const deadline = Date.now() + Math.min(wait_seconds, MAX_WAIT_S) * 1000;
      let candidates;
      for (;;) {
        candidates = await BridgeMessage.find(query).sort({ createdAt: 1 }).limit(limit).select('_id').lean();
        if (candidates.length || Date.now() >= deadline) break;
        await sleep(POLL_MS);
      }
      // Claim each one individually: two pollers of the same side must never both receive a message.
      const now = new Date();
      const delivered = [];
      for (const { _id } of candidates) {
        const m = await BridgeMessage.findOneAndUpdate(
          { _id, workspaceId, status: 'pending' },
          { $set: { status: 'delivered', deliveredAt: now } },
          { new: true }
        );
        if (m) delivered.push(m);
      }
      log('normal', `poll for=${side} session=${session ?? '-'} → ${delivered.length} message(s)`);
      return json({ messages: delivered.map(view) });
    }
  );

  server.tool(
    'bridge_ack',
    'Mark delivered messages as handled (status "acked"). Call after acting on what bridge_poll returned.',
    { ids: z.array(z.string()).min(1).describe('Ids from bridge_poll') },
    async ({ ids }) => {
      const workspaceId = await mcpWorkspaceId();
      const valid = ids.filter((id) => mongoose.isValidObjectId(id));
      const r = await BridgeMessage.updateMany(
        { _id: { $in: valid }, workspaceId, status: { $ne: 'acked' } },
        { $set: { status: 'acked', ackedAt: new Date() } }
      );
      return json({ acked: r.modifiedCount, ignored: ids.length - r.modifiedCount });
    }
  );

  server.tool(
    'bridge_announce',
    'Box side only: publish which Claude Code sessions exist on a host, replacing the previous announcement for that host. The chat side reads it through bridge_status to know what it can address.',
    {
      host: z.string().describe('Hostname, e.g. "steadfast-ai"'),
      sessions: z.array(z.object({
        name: z.string(), uuid: z.string().optional(), repo: z.string().optional(),
        cwd: z.string().optional(), status: z.string().optional(), kind: z.string().optional(),
      })).describe('Every live session, as the box sees it'),
    },
    async ({ host, sessions }) => {
      const workspaceId = await mcpWorkspaceId();
      // findOne + save/create rather than an upsert, so ownerGuard sees the insert.
      let p = await BridgePresence.findOne({ workspaceId, host });
      if (p) { p.sessions = sessions; p.announcedAt = new Date(); await p.save(); }
      else p = await BridgePresence.create({ workspaceId, host, sessions, announcedAt: new Date() });
      return json(presenceView(p));
    }
  );

  server.tool(
    'bridge_status',
    'What is on the other end: every host\'s last announcement (its sessions) and how many messages wait unread for each side.',
    {},
    async () => {
      const workspaceId = await mcpWorkspaceId();
      const [presence, box, chat] = await Promise.all([
        BridgePresence.find({ workspaceId }).sort({ host: 1 }).lean(),
        BridgeMessage.countDocuments({ workspaceId, to: 'box', status: 'pending' }),
        BridgeMessage.countDocuments({ workspaceId, to: 'chat', status: 'pending' }),
      ]);
      return json({ presence: presence.map(presenceView), pending: { box, chat } });
    }
  );

  server.tool(
    'bridge_history',
    'Recent messages in both directions, oldest first — the conversation so far, optionally for one session.',
    {
      session: z.string().optional().describe('Only this session name'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
    },
    async ({ session, limit = 20 }) => {
      const workspaceId = await mcpWorkspaceId();
      const docs = await BridgeMessage.find({ workspaceId, ...(session ? { session } : {}) }).sort({ createdAt: -1 }).limit(limit).lean();
      return json({ messages: docs.reverse().map(view) });
    }
  );


  // ─── The routine knowledge base: facts the box syncs, answers the chat reads first ─────────────
  //
  // The box is the source of truth for what its hourly routine did; these collections are its
  // cache here, replaced whole on each `bridge_sync_routine`. Nothing here is a Draft: a machine
  // transcribing a machine's ledger is not a model's guess, so it applies directly (decided
  // 2026-09-22). A chat should answer from bridge_kb_* when it can and use bridge_send only for
  // what these cannot hold — the item body, the diff, the review text, a live session.

  const ItemInput = z.object({
    // Titles and blocked details are clipped on the box (routineFacts.js); the caps here are the backstop
    // that keeps one runaway field from making a whole sync too large to accept.
    itemId: z.string().max(64), title: z.string().max(500), state: z.enum(ROUTINE_ITEM_STATES),
    needsHuman: z.boolean().optional(), proposed: z.boolean().optional(), notBefore: z.string().nullable().optional(),
    dependsOn: z.array(z.string()).optional(), attempts: z.number().int().optional(),
    claimedAt: z.string().nullable().optional(), completedAt: z.string().nullable().optional(), mergeSha: z.string().nullable().optional(),
    blockedAt: z.string().nullable().optional(), blockedDetail: z.string().max(4000).nullable().optional(), acked: z.boolean().optional(), lastRunId: z.string().nullable().optional(),
    review: z.object({
      localFindings: z.number().int().nullable().optional(), localModel: z.string().nullable().optional(), reviewedAt: z.string().nullable().optional(),
      gradedAt: z.string().nullable().optional(), confirmed: z.number().int().nullable().optional(), falsePositive: z.number().int().nullable().optional(), duplicate: z.number().int().nullable().optional(),
    }).optional(),
  });
  const date = (v) => (v ? new Date(v) : null);
  const itemView = (d) => ({
    repo: d.repo, item: d.itemId, title: d.title, state: d.state, needs_human: d.needsHuman, proposed: d.proposed, not_before: d.notBefore,
    depends_on: d.dependsOn, attempts: d.attempts, claimed_at: d.claimedAt, completed_at: d.completedAt, merge_sha: d.mergeSha,
    blocked_at: d.blockedAt, blocked_detail: d.blockedDetail, acked: d.acked, last_run: d.lastRunId,
    review: d.review?.reviewedAt || d.review?.localFindings != null ? {
      local_findings: d.review.localFindings, local_model: d.review.localModel, reviewed_at: d.review.reviewedAt,
      graded: Boolean(d.review.gradedAt), graded_at: d.review.gradedAt,
      ...(d.review.gradedAt ? { confirmed: d.review.confirmed, false_positive: d.review.falsePositive, duplicate: d.review.duplicate } : {}),
    } : null,
    ...(d.missingSince ? { missing_since: d.missingSince } : {}),
    synced_at: d.syncedAt,
  });
  const repoView = (r) => ({
    repo: r.repo, github: r.github, host: r.host, synced_at: r.syncedAt, counts: r.counts,
    last_completed: r.lastCompleted?.itemId ? r.lastCompleted : null, last_blocked: r.lastBlocked?.itemId ? r.lastBlocked : null,
    last_fire: r.lastFire?.runId ? r.lastFire : null, backpressure: r.backpressure?.level ? r.backpressure : null,
  });

  server.tool(
    'bridge_sync_routine',
    'Box side only: replace one repository\'s routine facts — counts, last completed/blocked/fire, and every FEATURES.md item with its ledger and review status. Applied directly, no draft. Items absent from this sync are marked missing, not deleted.',
    {
      repo: z.string(), github: z.string().nullable().optional(), host: z.string().nullable().optional(), synced_at: z.string().describe('ISO time the box built these facts'),
      facts_hash: z.string().nullable().optional(),
      counts: z.record(z.number()).optional(),
      last_completed: z.object({ itemId: z.string(), title: z.string().optional(), mergeSha: z.string().nullable().optional(), at: z.string().nullable().optional() }).nullable().optional(),
      last_blocked: z.object({ itemId: z.string(), title: z.string().optional(), detail: z.string().nullable().optional(), at: z.string().nullable().optional() }).nullable().optional(),
      last_fire: z.object({ runId: z.string(), decision: z.string().nullable().optional(), at: z.string().nullable().optional() }).nullable().optional(),
      backpressure: z.object({ level: z.string(), count: z.number(), oldestDays: z.number() }).nullable().optional(),
      items: z.array(ItemInput).max(2000),
    },
    async (a) => {
      const workspaceId = await mcpWorkspaceId();
      const syncedAt = new Date(a.synced_at);
      if (Number.isNaN(syncedAt.getTime())) return failure(`synced_at is not a date: ${a.synced_at}`);
      const repoDoc = {
        github: a.github ?? null, host: a.host ?? null, syncedAt, factsHash: a.facts_hash ?? null, counts: a.counts ?? {},
        lastCompleted: a.last_completed ? { ...a.last_completed, at: date(a.last_completed.at) } : {},
        lastBlocked: a.last_blocked ? { ...a.last_blocked, at: date(a.last_blocked.at) } : {},
        lastFire: a.last_fire ? { ...a.last_fire, at: date(a.last_fire.at) } : {},
        backpressure: a.backpressure ?? {},
      };
      // findOne + save/create rather than upserts, so ownerGuard sees every insert (as bridge_announce).
      let r = await RoutineRepo.findOne({ workspaceId, repo: a.repo });
      if (r) { r.set(repoDoc); await r.save(); } else r = await RoutineRepo.create({ workspaceId, repo: a.repo, ...repoDoc });

      const existing = new Map((await RoutineItem.find({ workspaceId, repo: a.repo })).map((d) => [d.itemId, d]));
      let created = 0, updated = 0;
      const seen = new Set();
      for (const it of a.items) {
        seen.add(it.itemId);
        const fields = {
          title: it.title, state: it.state, needsHuman: it.needsHuman ?? false, proposed: it.proposed ?? false, notBefore: it.notBefore ?? null,
          dependsOn: it.dependsOn ?? [], attempts: it.attempts ?? 0, claimedAt: date(it.claimedAt), completedAt: date(it.completedAt), mergeSha: it.mergeSha ?? null,
          blockedAt: date(it.blockedAt), blockedDetail: it.blockedDetail ?? null, acked: it.acked ?? false, lastRunId: it.lastRunId ?? null,
          review: {
            localFindings: it.review?.localFindings ?? null, localModel: it.review?.localModel ?? null, reviewedAt: date(it.review?.reviewedAt),
            gradedAt: date(it.review?.gradedAt), confirmed: it.review?.confirmed ?? null, falsePositive: it.review?.falsePositive ?? null, duplicate: it.review?.duplicate ?? null,
          },
          missingSince: null, syncedAt,
        };
        const d = existing.get(it.itemId);
        if (d) { d.set(fields); await d.save(); updated++; }
        else { await RoutineItem.create({ workspaceId, repo: a.repo, itemId: it.itemId, ...fields }); created++; }
      }
      let missing = 0;
      for (const [id, d] of existing) {
        if (seen.has(id) || d.missingSince) continue;
        d.missingSince = syncedAt; await d.save(); missing++;
      }
      log('normal', `synced ${a.repo}: ${created} new, ${updated} updated, ${missing} newly missing`);
      return json({ repo: a.repo, created, updated, missing, total: seen.size, synced_at: syncedAt });
    }
  );

  server.tool(
    'bridge_kb_status',
    'ANSWER FROM HERE FIRST. Where each repository\'s routine stands as the box last synced it: counts (pending, blocked, needs-human, proposed, unreviewed, ungraded…), the last completed and blocked items, the last fire. Use bridge_send only for what this cannot hold.',
    { repo: z.string().optional().describe('One repository; default all') },
    async ({ repo }) => {
      const workspaceId = await mcpWorkspaceId();
      const docs = await RoutineRepo.find({ workspaceId, ...(repo ? { repo } : {}) }).sort({ repo: 1 }).lean();
      return json({ repos: docs.map(repoView), stale_after_minutes: 90 });
    }
  );

  server.tool(
    'bridge_kb_items',
    'ANSWER FROM HERE FIRST. List routine items with filters — what is blocked, what waits on Daniel (needs_human / proposed), what is unreviewed (done but not acked) or ungraded (reviewed locally, not yet graded), or a keyword in the title. Newest activity first.',
    {
      repo: z.string().optional(), state: z.enum(ROUTINE_ITEM_STATES).optional(),
      needs_human: z.boolean().optional(), proposed: z.boolean().optional(),
      unreviewed: z.boolean().optional().describe('done and not acked'), ungraded: z.boolean().optional().describe('has a local review and no grade'),
      q: z.string().optional().describe('substring of the title or id, case-insensitive'), limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
    },
    async ({ repo, state, needs_human, proposed, unreviewed, ungraded, q, limit = 50 }) => {
      const workspaceId = await mcpWorkspaceId();
      const query = { workspaceId, missingSince: null };
      if (repo) query.repo = repo;
      if (state) query.state = state;
      if (needs_human !== undefined) query.needsHuman = needs_human;
      if (proposed !== undefined) query.proposed = proposed;
      if (unreviewed) { query.state = 'done'; query.acked = false; }
      if (ungraded) { query['review.reviewedAt'] = { $ne: null }; query['review.gradedAt'] = null; }
      if (q) { const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); query.$or = [{ title: re }, { itemId: re }]; }
      const docs = await RoutineItem.find(query).sort({ completedAt: -1, blockedAt: -1, claimedAt: -1, itemId: -1 }).limit(limit).lean();
      return json({ count: docs.length, items: docs.map(itemView) });
    }
  );

  server.tool(
    'bridge_kb_item',
    'ANSWER FROM HERE FIRST. One routine item: its state, merge sha, blocked detail, and review/grade counts. For the item body, the diff or the review text itself, ask the box with bridge_send.',
    { repo: z.string(), item: z.string().describe('e.g. "SAI-038"') },
    async ({ repo, item }) => {
      const workspaceId = await mcpWorkspaceId();
      const d = await RoutineItem.findOne({ workspaceId, repo, itemId: item }).lean();
      if (!d) return failure(`no item ${item} in ${repo} (as of the last sync)`);
      return json(itemView(d));
    }
  );

  return server;
}

export const BRIDGE_TOOLS = ['bridge_send', 'bridge_poll', 'bridge_ack', 'bridge_announce', 'bridge_status', 'bridge_history', 'bridge_sync_routine', 'bridge_kb_status', 'bridge_kb_items', 'bridge_kb_item'];

// ─── Transport (stateless) ───────────────────────────────────────────────────
//
// No sessions. Each POST gets a fresh McpServer on a fresh transport in the SDK's stateless mode
// (sessionIdGenerator: undefined): no session id is issued, none is validated, and the pair is
// closed when the response ends. /mcp keeps its in-memory session map; here that map was the
// incident: sessions live in one process's memory, every Railway deploy empties it, and on
// 2026-09-22 a claude.ai chat mid-conversation was stranded with "invalid session ID" until it gave
// up. A stateless server has nothing to forget. The cost is one server construction per request —
// tool registration is in-process and every tool hits the database anyway — which is nothing next
// to a long-poll that holds the request for 25 s.
//
// A client that still sends an mcp-session-id (an old session, a stateful-minded SDK) is served all
// the same; the header is ignored.

router.post(MCP_PATH, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = createBridgeServer();
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log('light', `request failed: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32603, message: 'Internal error' } });
  }
});

// Stateless: no standalone SSE stream to open, and nothing to delete — but a client closing what it
// believes is a session must not see an error.
router.get(MCP_PATH, (req, res) => res.status(405).set('Allow', 'POST, DELETE').send('Method Not Allowed'));
router.delete(MCP_PATH, (req, res) => res.status(204).send());

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export default router;
