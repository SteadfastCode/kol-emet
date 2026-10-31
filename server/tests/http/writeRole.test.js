/**
 * `editor` is the write floor (KOL-103): one workspace, three roles, and every
 * write the API has.
 *
 * Roles have existed since KOL-071 — `Workspace.members[].role` is
 * `owner | editor | viewer`, `resolveWorkspace` reads it onto every request and
 * `GET /workspace` hands it to the client — but `requireWorkspaceRole` gated
 * exactly two routes, both owner-only (`PATCH /workspace`, `POST /import`).
 * Every write that makes up the graph was ungated, so a member marked `viewer`
 * could create, edit, delete, roll back and spend the workspace's AI allowance.
 * Nothing *in the product* did that yet, because a workspace had one member;
 * collaborator invites are the next commercial step, which is why the gate has
 * to be in place before the first invite rather than after it.
 *
 * What this file pins:
 *
 *   - **The sweep is derived, not retyped.** `mounts()` walks the mounted
 *     Express app and reads back, for every router mounted behind
 *     `resolveWorkspace`, its prefix, its middleware and each of its routes
 *     with that route's own handler names. Two assertions run over that:
 *     a *static* one — every write route is covered by a role gate, either at
 *     its mount or on the route — and a *behavioural* one, which actually
 *     sends each of those writes as the viewer and demands a 403. So a route
 *     added to one of those routers later, or a whole new content router
 *     mounted without the gate, fails here rather than shipping open.
 *   - **A viewer's write changes nothing.** The whole graph is counted before
 *     and after the sweep — entities, relationship groups, open questions,
 *     entity types, relationship types, tags, drafts, changelog entries, the
 *     workspace's name and its `aiBudget.spentMicros` — and must be identical.
 *   - **`POST /drafts` refuses before any allowance is read.** It is the one
 *     write that spends money, and the gate is at the mount, ahead of
 *     `checkBudget` — so `spentMicros` is unmoved and no `Draft` row exists.
 *   - **An editor and an owner still write.** One real, valid write per
 *     content router (plus the rollback), because a gate that refuses everyone
 *     would satisfy every assertion above.
 *   - **Every `GET` is role-blind.** For each read route discovered, the
 *     viewer's status equals the owner's and is never 403; the core reads are
 *     additionally asserted to be 200 for all three roles. (Status *equality*
 *     rather than a blanket 200, because a derived path like
 *     `GET /drafts/:id/export` may legitimately answer something else for a
 *     fixture draft — what matters is that it answers the same thing to a
 *     viewer as to an owner.)
 *   - **`/mcp` refuses the write tools and answers the reads.** The connector
 *     never passes through `resolveWorkspace`, so a viewer who authorized it
 *     would otherwise keep full write access through Claude. Every advertised
 *     tool must be classified here as a read or a write, so a new tool cannot
 *     slip past this group either.
 *   - **A read-only `/mcp` session has no write tools at all** (KOL-113). That
 *     is the session the in-app assistant's relay opens: `POST /chat` hands the
 *     provider this endpoint with the *connector's* bearer token, so an
 *     unrestricted relay let any chat caller spend the connector's write access
 *     — the floor above, bypassed one mount over. The group drives a second
 *     session opened with chat's scope header, as a member who *may* write, and
 *     demands that all ten writes are unreachable and the reads still answer.
 *     `tests/http/chatMcpRelay.test.js` owns the other end: that chat sends
 *     those headers and that `allowed_tools` in the first place.
 *
 * Deliberately **not** gated, and asserted as exemptions rather than silently
 * skipped: `/export` (reading is what a viewer is for), `/events` (a GET), and
 * `/chat` + `/conversations` — asking the assistant a question reads the graph
 * and writes nothing to it, and a saved conversation is the asker's own row.
 * A floor on who may spend the AI allowance is a pricing decision nobody has
 * made. `/bridge/*` carries its own token and no workspace role.
 *
 * The three members are built the way `tests/http/workspace.test.js` builds
 * its editor: alice registers (and is the owner of the workspace registration
 * created), and the editor and the viewer are a `User` plus a membership
 * `$push`ed into *that* workspace, then signed in through the real
 * `POST /auth/login`. Registering them would give each a workspace of their
 * own, and `resolveWorkspace` takes the first membership it finds — the test
 * would then be asserting against whichever workspace Mongo returned first.
 *
 * Falsification checks: drop `requireWriteRole` from any mount in
 * `src/app.js`, or from the rollback route in `src/routes/changelog.js`, and
 * both sweeps fail naming that route; make `requireWriteRole` gate every
 * method rather than only unsafe ones and the read group fails; make it pass
 * `viewer` and the behavioural sweep fails; put `mcpWorkspaceId()` back in any
 * write tool in `src/routes/mcp.js` and the MCP group fails; register the write
 * tools regardless of scope in `createMcpServer()`, or add one to
 * `MCP_READ_TOOLS`, and the read-only group fails.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_WRITE_ROLE_LOG_LEVEL = off | light | normal | verbose (default light)
 * When one of these fails unattended, the missing information is always which
 * role the request was made as and where the route under test came from —
 * never the assertion itself.
 *   off     — nothing
 *   light   — one line per fixture, naming what created it, and one per mount
 *             the derivation found with the gate it carries
 *   normal  — light, plus every swept request with its status and body
 *   verbose — normal, plus each derived route and each graph count
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import session from 'express-session';
import request from 'supertest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Every session write is checked against CLIENT_ORIGIN (src/middleware/originGuard.js),
// so this suite names one below and its agents send a matching Origin.
import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';
import * as db from '../helpers/db.js';
// Registration is throttled per client address, and this suite registers from one.
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';

import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import Entity from '../../src/models/Entity.js';
import OpenQuestion from '../../src/models/OpenQuestion.js';
import RelationshipGroup from '../../src/models/RelationshipGroup.js';
import EntityType from '../../src/models/EntityType.js';
import RelationshipType from '../../src/models/RelationshipType.js';
import ChangeLog from '../../src/models/ChangeLog.js';
import Draft from '../../src/models/Draft.js';
import { setMcpUser } from '../../src/lib/mcpUserStore.js';
import { MCP_READ_SCOPE, MCP_READ_TOOLS, MCP_SCOPE_HEADER } from '../../src/lib/mcpScope.js';

// Environment before src/app.js is imported, for the reasons in mcp.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
// Load-bearing: with no token the MCP router takes its "dev mode" path and the
// MCP group would be driving an open endpoint.
const MCP_TOKEN = 'test-mcp-bearer-token';
process.env.MCP_BEARER_TOKEN = MCP_TOKEN;
// Unset on purpose: with no REST bearer token configured a stray Authorization
// header cannot resolve to the MCP user and quietly satisfy requireAuth.
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.WORKSPACE_LOG_LEVEL ??= 'off';
process.env.MCP_LOG_LEVEL ??= 'off';
process.env.TAGS_LOG_LEVEL ??= 'off';
process.env.CHANGELOG_LOG_LEVEL ??= 'off';
process.env.DRAFTS_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  const active = LEVELS[process.env.TEST_WRITE_ROLE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/writeRole:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';
const WORKSPACE_NAME = "Alice's Bible";

/** Methods `requireWriteRole` lets through. Must match the middleware's set. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The handler names that are a role gate: `requireWriteRole` is the exported
 * function, `workspaceRoleGate` is the closure `requireWorkspaceRole()` returns.
 * Names rather than identities, because a mount's layer holds the function the
 * app was given and that is all the stack records.
 */
const WRITE_GATES = new Set(['requireWriteRole', 'workspaceRoleGate']);

/**
 * Mounts that sit behind `resolveWorkspace` and deliberately carry no write
 * gate. Each one is a decision, so each one is named with its reason — an
 * unlisted router reaching the sweep ungated is a failure, not a skip.
 */
const UNGATED_BY_DESIGN = {
  '/export': 'a GET-only router: reading the workspace out is what a viewer is for',
  '/events': 'a GET-only SSE stream',
  '/conversations': "a saved conversation is the asker's own row (Conversation.userId), not graph content",
};

/**
 * Mounts the read sweep leaves alone:
 *   /events        — an SSE stream never closes, so supertest would hang on it
 *                    (tests/http/events.test.js owns it)
 *   /conversations — its rows are the asker's *own* (Conversation.userId), so a
 *                    viewer legitimately sees a different answer to
 *                    `GET /conversations/:id` than the owner does; role-blind
 *                    is not the property that route has
 */
const NO_READ_SWEEP = new Set(['/events', '/conversations']);

/** Reads that must answer 200 to all three roles, whatever else is derived. */
const CORE_READS = [
  '/entities',
  '/relationship-groups',
  '/open-questions',
  '/entity-types',
  '/relationship-types',
  '/tags',
  '/drafts',
  '/deleted',
  '/workspace',
];

let app;
let httpServer;
let mcpUrl;
let mcp;
/** A second session over the same endpoint, opened with the read scope. */
let mcpReadOnly;

/** The three members of the one workspace. */
let owner;
let editor;
let viewer;
let members;

/** Fixture ids the derived paths are filled in from. */
const ids = {
  entityId: null,
  otherEntityId: null,
  thirdEntityId: null,
  groupId: null,
  subGroupId: null,
  oqId: null,
  entityTypeId: null,
  relationshipTypeId: null,
  draftId: null,
  logId: null,
  itemId: null,
  inviteId: null,
};

const TAG = 'swept-tag';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Registers through the real endpoint and reads back what it created. */
async function registerOwner(email) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD, workspaceName: WORKSPACE_NAME });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  log('light', `registered ${email} as owner (source: POST /auth/register) → user ${user._id}, workspace ${workspace._id}`);
  return { agent, email, role: 'owner', userId: String(user._id), workspaceId: String(workspace._id) };
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
  return { agent, email, role, userId: String(user._id), workspaceId: String(workspaceId) };
}

/** Everything the derived paths need an id for, created as the owner. */
async function seedGraph() {
  const entity = async (title) => {
    const res = await owner.agent.post('/entities').send({ title, category: 'Characters', summary: `${title}, a fixture.`, tags: [TAG] });
    assert.equal(res.status, 201, `POST /entities (${title}) failed: ${res.status} ${JSON.stringify(res.body)}`);
    return String(res.body._id);
  };
  ids.entityId = await entity('Swept One');
  ids.otherEntityId = await entity('Swept Two');
  ids.thirdEntityId = await entity('Swept Three');

  const group = async (label, memberIds) => {
    const res = await owner.agent.post('/relationship-groups').send({
      label,
      members: memberIds.map((id, i) => ({ entityId: id, label: `member ${i}` })),
    });
    assert.equal(res.status, 201, `POST /relationship-groups (${label}) failed: ${res.status} ${JSON.stringify(res.body)}`);
    return String(res.body._id);
  };
  ids.groupId = await group('Swept Group', [ids.entityId, ids.otherEntityId]);
  ids.subGroupId = await group('Swept Subgroup', [ids.entityId, ids.thirdEntityId]);

  const oq = await owner.agent.post('/open-questions').send({ question: 'Who may write here?', entry_ids: [ids.entityId] });
  assert.equal(oq.status, 201, `POST /open-questions failed: ${oq.status} ${JSON.stringify(oq.body)}`);
  ids.oqId = String(oq.body._id);

  const etype = await owner.agent.post('/entity-types').send({ name: 'Swept Type' });
  assert.equal(etype.status, 201, `POST /entity-types failed: ${etype.status} ${JSON.stringify(etype.body)}`);
  ids.entityTypeId = String(etype.body._id);

  const rtype = await owner.agent.post('/relationship-types').send({ name: 'Swept Relationship' });
  assert.equal(rtype.status, 201, `POST /relationship-types failed: ${rtype.status} ${JSON.stringify(rtype.body)}`);
  ids.relationshipTypeId = String(rtype.body._id);

  // Built directly: every route that creates a draft calls a provider, and this
  // file only needs a row with an item for the derived `:id`/`:itemId` paths.
  const draft = await Draft.create({
    workspaceId: owner.workspaceId,
    createdBy: owner.userId,
    title: 'Swept Draft',
    status: 'ready',
    source: { producer: 'braindump', text: 'swept', textHash: 'swept-hash' },
    items: [{
      localKey: 'swept-1',
      seq: 1,
      kind: 'entity',
      op: 'create',
      proposed: { title: 'Swept Proposal', category: 'Characters' },
      input: { evidence: { quote: 'swept' } },
    }],
  });
  ids.draftId = String(draft._id);
  ids.itemId = String(draft.items[0]._id);

  // A pending collaborator invite (KOL-124), so the derived
  // `DELETE /workspace/invites/:inviteId` has one to aim at. Created as the
  // owner, through the real route, which is the only thing that creates one.
  const invited = await owner.agent.post('/workspace/invites').send({ email: 'swept-invitee@example.test', role: 'viewer' });
  assert.equal(invited.status, 201, `POST /workspace/invites failed: ${invited.status} ${JSON.stringify(invited.body)}`);
  ids.inviteId = String(invited.body._id);

  // A rollback needs an entry that *carries* a snapshot, and only an update
  // writes one (a create logs the event, not a prior state) — so edit the
  // entity once. The changelog is written fire-and-forget, so wait for the row
  // rather than assuming it has landed.
  const edited = await owner.agent.put(`/entities/${ids.entityId}`).send({ summary: 'Edited, so there is a snapshot to roll back to.' });
  assert.equal(edited.status, 200, `PUT /entities/:id failed: ${edited.status} ${JSON.stringify(edited.body)}`);
  for (let attempt = 0; attempt < 100 && !ids.logId; attempt += 1) {
    const entry = await ChangeLog
      .findOne({ entityId: ids.entityId, workspaceId: owner.workspaceId, snapshot: { $exists: true, $ne: null } })
      .select('_id').lean();
    if (entry) ids.logId = String(entry._id);
    else await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(ids.logId, 'an update should have written a ChangeLog entry with a snapshot to roll back to');

  log('light', `seeded the graph as the owner (source: the real REST routes, plus Draft.create): ${JSON.stringify(ids)}`);
}

// ─── Deriving the routes from the mounted app ────────────────────────────────

/** The mount path a layer was created with, read back out of its regexp. */
function mountPath(layer) {
  if (layer.regexp?.fast_slash) return '';
  return layer.regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\\\//g, '/');
}

/** Every route a router holds, including any nested one, with its handlers. */
function routesOf(router, prefix) {
  const found = [];
  for (const layer of router.stack ?? []) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter(m => m !== '_all').map(m => m.toUpperCase());
      found.push({
        path: prefix + layer.route.path,
        methods,
        handlers: (layer.route.stack ?? []).map(h => h.name),
      });
    } else if (layer.handle?.stack) {
      found.push(...routesOf(layer.handle, prefix + mountPath(layer)));
    }
  }
  return found;
}

/**
 * Every router mounted on the app, with the middleware mounted beside it.
 *
 * `app.use(path, a, b, router)` becomes one layer per handler, all sharing the
 * mount's path — so the middleware of a mount is whatever non-router layers
 * were seen since the previous router *at the same path*.
 */
function mounts(application) {
  const stack = application._router?.stack ?? application.router?.stack ?? [];
  const found = [];
  let pending = [];
  for (const layer of stack) {
    const path = mountPath(layer);
    if (layer.handle?.stack) {
      found.push({
        path,
        middleware: pending.filter(p => p.path === path).map(p => p.name),
        routes: routesOf(layer.handle, ''),
      });
      pending = [];
    } else {
      pending.push({ path, name: layer.handle?.name ?? '<anonymous>' });
    }
  }
  return found;
}

/** The content mounts: those sitting behind resolveWorkspace. */
function contentMounts() {
  const all = mounts(app).filter(m => m.middleware.includes('resolveWorkspace'));
  assert.ok(all.length >= 8, `the derivation found only ${all.length} tenant-content mounts, which cannot be right`);
  for (const mount of all) {
    const gate = mount.middleware.find(name => WRITE_GATES.has(name));
    log('light', `mount ${mount.path || '/'} → ${mount.routes.length} route(s), middleware [${mount.middleware.join(', ')}], write gate ${gate ?? 'none at the mount'}`);
    for (const route of mount.routes) {
      log('verbose', `  ${route.methods.join('|')} ${mount.path}${route.path} → handlers [${route.handlers.join(', ')}]`);
    }
  }
  return all;
}

/** Every write route of a content mount, with the gate that covers it. */
function writeRoutes(mount) {
  const mountGate = mount.middleware.find(name => WRITE_GATES.has(name)) ?? null;
  const routes = [];
  for (const route of mount.routes) {
    for (const method of route.methods) {
      if (READ_METHODS.has(method)) continue;
      const routeGate = route.handlers.find(name => WRITE_GATES.has(name)) ?? null;
      routes.push({ mount: mount.path, method, path: route.path, gate: mountGate ?? routeGate, handlers: route.handlers });
    }
  }
  return routes;
}

/** Every read route of a content mount. */
function readRoutes(mount) {
  return mount.routes
    .filter(route => route.methods.some(m => READ_METHODS.has(m)))
    .map(route => ({ mount: mount.path, path: route.path }));
}

/** The fixture id `:id` means under each mount. */
const ID_BY_MOUNT = {
  '/entities': () => ids.entityId,
  '': () => ids.entityId, // the changelog router, mounted at '/'
  '/relationship-groups': () => ids.groupId,
  '/open-questions': () => ids.oqId,
  '/entity-types': () => ids.entityTypeId,
  '/relationship-types': () => ids.relationshipTypeId,
  '/drafts': () => ids.draftId,
};

/**
 * A derived route path with its parameters filled in from the fixtures.
 * An unknown parameter throws rather than being left in the URL, so a route
 * added with a new parameter name has to be accounted for here.
 */
function fillPath(mount, path) {
  return path.replace(/:([A-Za-z]+)/g, (_, param) => {
    switch (param) {
      case 'id': {
        const id = ID_BY_MOUNT[mount];
        assert.ok(id, `no fixture id for :id under the mount "${mount || '/'}" — add one to ID_BY_MOUNT`);
        return id();
      }
      case 'logId': return ids.logId;
      // The membership routes (KOL-124). A real member, so the sweep's refusal
      // is the role gate's and not a 404 the gate never got to.
      case 'userId': return editor.userId;
      case 'inviteId': return ids.inviteId;
      case 'entityId': return ids.otherEntityId;
      case 'subGroupId': return ids.subGroupId;
      case 'itemId': return ids.itemId;
      case 'tag': return TAG;
      default:
        throw new assert.AssertionError({ message: `the derivation hit an unknown route parameter ":${param}" in ${mount}${path} — teach fillPath what to put there` });
    }
  });
}

/** Sends `method url` as `who` with a body that is valid JSON and nothing more. */
async function send(who, method, url, body = {}) {
  const verb = method.toLowerCase();
  const res = await (['get', 'head', 'delete'].includes(verb)
    ? who.agent[verb](url)
    : who.agent[verb](url).send(body));
  log('normal', `${method} ${url} as ${who.role} → ${res.status} ${JSON.stringify(res.body ?? null)}`);
  return res;
}

// ─── The graph, counted ──────────────────────────────────────────────────────

/**
 * Everything a write could change, in one object: the row counts of every
 * collection the content routes touch, the workspace's name (PATCH /workspace)
 * and its AI spend (POST /drafts).
 */
async function graphState() {
  const scope = { workspaceId: owner.workspaceId };
  const [entities, groups, questions, entityTypes, relationshipTypes, drafts, changelog] = await Promise.all([
    Entity.countDocuments(scope),
    RelationshipGroup.countDocuments(scope),
    OpenQuestion.countDocuments(scope),
    EntityType.countDocuments(scope),
    RelationshipType.countDocuments(scope),
    Draft.countDocuments(scope),
    ChangeLog.countDocuments(scope),
  ]);
  const workspace = await Workspace.findById(owner.workspaceId).select('name aiBudget').lean();
  const tagged = await Entity.find(scope).select('tags').lean();
  const state = {
    entities, groups, questions, entityTypes, relationshipTypes, drafts, changelog,
    name: workspace?.name ?? null,
    spentMicros: workspace?.aiBudget?.spentMicros ?? null,
    tags: [...new Set(tagged.flatMap(e => e.tags ?? []))].sort().join(','),
  };
  log('verbose', `graph state: ${JSON.stringify(state)}`);
  return state;
}

// ─── MCP ─────────────────────────────────────────────────────────────────────

/**
 * The four tools that only read. Everything else must be a write.
 *
 * Retyped here rather than imported, and then asserted against
 * `MCP_READ_TOOLS` (src/lib/mcpScope.js) below: that list is what chat's
 * read-only relay is allowed to call (KOL-113), so a write tool added to it
 * would hand the relay a write — and importing it as this group's definition of
 * "a read" would make exactly that mistake invisible here.
 */
const MCP_READS = new Set(['search_entities', 'get_entity', 'list_entity_types', 'list_open_questions']);

/** Arguments good enough to reach each write tool's workspace lookup. */
function mcpWriteArgs() {
  return {
    create_entity: { title: 'Viewer Wrote This', category: 'Characters', summary: 'A write that must be refused.' },
    update_entity: { id: ids.entityId, title: 'Viewer Renamed This' },
    add_open_question: { question: 'May a viewer write?', entry_ids: [ids.entityId] },
    add_relationship: {
      groupLabel: 'Viewer Group',
      members: [{ entityId: ids.entityId, label: 'one' }, { entityId: ids.otherEntityId, label: 'two' }],
    },
    add_member_to_relationship: { groupId: ids.groupId, members: [{ entityId: ids.thirdEntityId, label: 'three' }] },
    update_group_label: { groupId: ids.groupId, label: 'Viewer Label' },
    remove_relationship: { groupId: ids.groupId, entityId: ids.entityId },
    update_relationship_label: { groupId: ids.groupId, entityId: ids.entityId, label: 'viewer label' },
    add_subgroup_to_relationship: { parentGroupId: ids.groupId, subGroupId: ids.subGroupId },
    remove_subgroup_from_relationship: { parentGroupId: ids.groupId, subGroupId: ids.subGroupId },
  };
}

/** Arguments good enough to reach each read tool's query. */
function mcpReadArgs() {
  return {
    search_entities: {},
    get_entity: { id: ids.entityId },
    list_entity_types: {},
    list_open_questions: {},
  };
}

/** Calls a tool and returns { isError, text }. */
async function callTool(name, args) {
  return await callToolOn(mcp, name, args);
}

/**
 * The same, on a given client: the read-only group below drives a second
 * session over the same endpoint and the same bearer token, so the only
 * difference between them is the scope it was opened with.
 *
 * A tool a session never registered is a protocol error rather than a tool
 * result, so a throw is reported as a refusal — which is the shape a read-only
 * session produces for all ten writes.
 */
async function callToolOn(client, name, args) {
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content ?? []).map(part => part.text ?? '').join('');
    log('normal', `mcp ${name}(${JSON.stringify(args)}) → isError=${Boolean(res.isError)}: ${text.slice(0, 120)}`);
    return { isError: Boolean(res.isError), text };
  } catch (err) {
    log('normal', `mcp ${name}(${JSON.stringify(args)}) threw: ${err.message}`);
    return { isError: true, text: err.message };
  }
}

/** Points Settings.mcpUserId at a member, so the connector acts as them. */
async function mcpActAs(who) {
  await setMcpUser(who.userId);
  log('light', `MCP identity is now ${who.email} (${who.role}) (source: setMcpUser via Settings.mcpUserId)`);
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

  owner = await registerOwner('write-role-owner@example.test');
  editor = await addMember('write-role-editor@example.test', owner.workspaceId, 'editor');
  viewer = await addMember('write-role-viewer@example.test', owner.workspaceId, 'viewer');
  members = [owner, editor, viewer];

  await seedGraph();

  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
  });
  mcp = new Client({ name: 'kol-emet-tests', version: '0.0.0' });
  await mcp.connect(transport);

  // The same endpoint and the same bearer token, opened with the scope header
  // chat's relay sends (KOL-113): this is the session the in-app assistant gets.
  const readOnlyTransport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: {
      headers: { Authorization: `Bearer ${MCP_TOKEN}`, [MCP_SCOPE_HEADER]: MCP_READ_SCOPE },
    },
  });
  mcpReadOnly = new Client({ name: 'kol-emet-tests-read-only', version: '0.0.0' });
  await mcpReadOnly.connect(readOnlyTransport);
  log('light', `second MCP session opened read-only (source: ${MCP_SCOPE_HEADER}: ${MCP_READ_SCOPE} on the initialize request)`);
});

after(async () => {
  await mcp?.close();
  await mcpReadOnly?.close();
  if (httpServer) {
    httpServer.closeAllConnections();
    await new Promise(resolve => httpServer.close(resolve));
  }
  await db.disconnect();
});

describe('every content router carries the write gate', () => {
  test('each tenant-content mount is gated, or exempt for a stated reason', () => {
    const ungated = [];
    for (const mount of contentMounts()) {
      const writes = writeRoutes(mount);
      if (!writes.length) continue;
      const reason = UNGATED_BY_DESIGN[mount.path];
      for (const route of writes) {
        if (route.gate) continue;
        if (reason) {
          log('light', `${route.method} ${mount.path}${route.path} is ungated by design: ${reason}`);
          continue;
        }
        ungated.push(`${route.method} ${mount.path || '/'}${route.path} (handlers: ${route.handlers.join(', ')})`);
      }
    }
    assert.deepEqual(ungated, [], `these writes reach the graph with no role gate:\n  ${ungated.join('\n  ')}`);
  });

  test('the derivation sees the routers it is supposed to be sweeping', () => {
    const paths = contentMounts().map(m => m.path);
    for (const expected of ['/entities', '/relationship-groups', '/open-questions', '/entity-types', '/relationship-types', '/tags', '/drafts', '']) {
      assert.ok(paths.includes(expected), `the derivation missed the mount "${expected || '/'}" — it found [${paths.join(', ')}]`);
    }
    const writes = contentMounts().flatMap(writeRoutes).filter(r => !UNGATED_BY_DESIGN[r.mount]);
    assert.ok(writes.length >= 32, `expected at least the 32 known writes, derived ${writes.length}`);
  });
});

describe('a viewer may not write', () => {
  test('every derived write route refuses them, and the graph is untouched', async () => {
    const before = await graphState();
    const swept = [];

    for (const mount of contentMounts()) {
      if (UNGATED_BY_DESIGN[mount.path]) continue;
      for (const route of writeRoutes(mount)) {
        const url = `${mount.path}${fillPath(mount.path, route.path)}`;
        const res = await send(viewer, route.method, url);
        const where = `${route.method} ${url}`;

        assert.equal(res.status, 403, `${where} should refuse a viewer with 403, answered ${res.status} ${JSON.stringify(res.body)}`);
        // An owner-gated route (POST /import, PATCH /workspace) answers its own
        // code; everything behind requireWriteRole answers the editor one.
        const expected = route.gate === 'requireWriteRole' ? 'NOT_WORKSPACE_EDITOR' : /^NOT_WORKSPACE_/;
        if (typeof expected === 'string') assert.equal(res.body.error, expected, `${where} should answer ${expected}`);
        else assert.match(String(res.body.error), expected, `${where} should answer a NOT_WORKSPACE_* code`);
        swept.push(where);
      }
    }

    log('light', `swept ${swept.length} write route(s) as the viewer, all refused (source: the mounted routers)`);
    assert.ok(swept.length >= 32, `expected at least 32 swept writes, got ${swept.length}`);
    assert.deepEqual(await graphState(), before, 'a swept viewer write changed the graph');
  });

  test('POST /drafts refuses before any allowance is read', async () => {
    const before = await graphState();
    const res = await send(viewer, 'POST', '/drafts', { text: 'A braindump a viewer should not be able to pay for.' });

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'NOT_WORKSPACE_EDITOR');

    const after = await graphState();
    assert.equal(after.spentMicros, before.spentMicros, 'the AI allowance moved on a refused generation');
    assert.equal(after.drafts, before.drafts, 'a refused generation created a draft row');
  });
});

describe('an editor and an owner still write', () => {
  /** One valid write per content router, run as both roles that may write. */
  const cases = [
    {
      what: 'POST /entities',
      run: (who, n) => send(who, 'POST', '/entities', { title: `${who.role} wrote ${n}`, category: 'Characters', summary: 'A write that must succeed.' }),
      expect: 201,
    },
    {
      what: 'PUT /entities/:id',
      run: (who) => send(who, 'PUT', `/entities/${ids.entityId}`, { title: `Swept One, renamed by the ${who.role}` }),
      expect: 200,
    },
    {
      what: 'POST /open-questions',
      run: (who, n) => send(who, 'POST', '/open-questions', { question: `Can the ${who.role} write? (${n})`, entry_ids: [ids.entityId] }),
      expect: 201,
    },
    {
      what: 'POST /entity-types',
      run: (who, n) => send(who, 'POST', '/entity-types', { name: `${who.role} type ${n}` }),
      expect: 201,
    },
    {
      what: 'POST /relationship-types',
      run: (who, n) => send(who, 'POST', '/relationship-types', { name: `${who.role} relationship ${n}` }),
      expect: 201,
    },
    {
      what: 'POST /relationship-groups',
      run: (who) => send(who, 'POST', '/relationship-groups', {
        label: `${who.role} group`,
        members: [{ entityId: ids.entityId, label: 'one' }, { entityId: ids.otherEntityId, label: 'two' }],
      }),
      expect: 201,
    },
    {
      what: 'PUT /tags/:tag',
      run: async (who) => {
        const renamed = await send(who, 'PUT', `/tags/${TAG}`, { to: `${TAG}-by-${who.role}` });
        // Put the fixture tag back, so the next role starts from the same graph.
        await send(who, 'PUT', `/tags/${TAG}-by-${who.role}`, { to: TAG });
        return renamed;
      },
      expect: 200,
    },
    {
      what: 'POST /entities/:id/rollback/:logId',
      run: (who) => send(who, 'POST', `/entities/${ids.entityId}/rollback/${ids.logId}`, {}),
      expect: 200,
    },
    {
      what: 'PATCH /drafts/:id/items/:itemId',
      run: (who) => send(who, 'PATCH', `/drafts/${ids.draftId}/items/${ids.itemId}`, { decision: 'accepted' }),
      expect: 200,
    },
  ];

  for (const { what, run, expect } of cases) {
    test(`${what} succeeds for an editor and an owner`, async (t) => {
      for (const who of [editor, owner]) {
        const res = await run(who, t.name.length);
        assert.equal(res.status, expect, `${what} as the ${who.role} answered ${res.status} ${JSON.stringify(res.body)}`);
      }
    });
  }

  test('a draft an editor may decide on, they may also delete', async () => {
    const draft = await Draft.create({
      workspaceId: owner.workspaceId,
      createdBy: owner.userId,
      title: 'Deletable',
      status: 'ready',
      source: { producer: 'braindump', text: 'deletable', textHash: 'deletable-hash' },
    });
    const res = await send(editor, 'DELETE', `/drafts/${draft._id}`);
    assert.equal(res.status, 204, `DELETE /drafts/:id as the editor answered ${res.status} ${JSON.stringify(res.body)}`);
    // Soft: the row is the training corpus, so discarding is a status change.
    const after = await Draft.findById(draft._id).select('status').lean();
    assert.equal(after.status, 'discarded');
  });

  test('an editor is still refused what only an owner may do', async () => {
    const res = await send(editor, 'PATCH', '/workspace', { name: 'Editor Was Here' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'NOT_WORKSPACE_OWNER');
    assert.equal((await graphState()).name, WORKSPACE_NAME);
  });
});

describe('a read is role-blind', () => {
  test('every derived read answers a viewer exactly what it answers an owner', async () => {
    const swept = [];
    for (const mount of contentMounts()) {
      if (NO_READ_SWEEP.has(mount.path)) continue;
      for (const route of readRoutes(mount)) {
        const url = `${mount.path}${fillPath(mount.path, route.path)}`;
        const [asOwner, asEditor, asViewer] = [
          await send(owner, 'GET', url),
          await send(editor, 'GET', url),
          await send(viewer, 'GET', url),
        ];
        for (const [who, res] of [[editor, asEditor], [viewer, asViewer]]) {
          assert.notEqual(res.status, 403, `GET ${url} refused the ${who.role} with ${JSON.stringify(res.body)}`);
          assert.equal(res.status, asOwner.status, `GET ${url} answered the ${who.role} ${res.status} but the owner ${asOwner.status}`);
        }
        swept.push(url);
      }
    }
    log('light', `swept ${swept.length} read route(s) for all three roles (source: the mounted routers)`);
    assert.ok(swept.length >= 12, `expected at least 12 swept reads, got ${swept.length}`);
  });

  test('the core reads answer 200 to all three roles', async () => {
    for (const url of CORE_READS) {
      for (const who of members) {
        const res = await send(who, 'GET', url);
        assert.equal(res.status, 200, `GET ${url} as the ${who.role} answered ${res.status} ${JSON.stringify(res.body)}`);
      }
    }
  });

  test('GET /export stays open to a viewer', async () => {
    const res = await send(viewer, 'GET', '/export');
    assert.equal(res.status, 200, `GET /export as the viewer answered ${res.status}`);
  });
});

describe('/mcp holds the same floor', () => {
  test('every advertised tool is classified here as a read or a write', async () => {
    const advertised = (await mcp.listTools()).tools.map(t => t.name).sort();
    const classified = [...MCP_READS, ...Object.keys(mcpWriteArgs())].sort();
    assert.deepEqual(advertised, classified,
      'a tool /mcp advertises is neither in MCP_READS nor in mcpWriteArgs(), so this group would not be driving it');
  });

  test('a viewer connector is refused every write tool, and the graph is untouched', async () => {
    await mcpActAs(viewer);
    const before = await graphState();
    const args = mcpWriteArgs();

    for (const [name, toolArgs] of Object.entries(args)) {
      const res = await callTool(name, toolArgs);
      assert.equal(res.isError, true, `${name} should have refused a viewer, answered: ${res.text}`);
      assert.match(res.text, /NOT_WORKSPACE_EDITOR/, `${name}'s refusal should name the code: ${res.text}`);
      assert.match(res.text, /viewer/, `${name}'s refusal should name the role it read: ${res.text}`);
    }

    assert.deepEqual(await graphState(), before, 'a refused MCP write tool changed the graph');
  });

  test('a viewer connector still reads', async () => {
    await mcpActAs(viewer);
    for (const [name, toolArgs] of Object.entries(mcpReadArgs())) {
      const res = await callTool(name, toolArgs);
      assert.equal(res.isError, false, `${name} should answer a viewer, returned: ${res.text}`);
    }
    const entities = JSON.parse((await callTool('search_entities', {})).text);
    assert.ok(entities.length > 0, 'a viewer connector should see the workspace it is a member of');
    for (const entity of entities) {
      assert.equal(String(entity.workspaceId), owner.workspaceId, 'a viewer read the wrong workspace');
    }
  });

  test('an editor connector writes', async () => {
    await mcpActAs(editor);
    const res = await callTool('create_entity', { title: 'MCP editor wrote this', category: 'Characters', summary: 'Written over MCP.' });
    assert.equal(res.isError, false, `create_entity as the editor returned: ${res.text}`);
    const created = JSON.parse(res.text);
    assert.equal(String(created.workspaceId), owner.workspaceId);
    assert.equal(await Entity.countDocuments({ _id: created._id, workspaceId: owner.workspaceId }), 1);
  });

  test("the read set this group classifies is the one chat's relay is given", async () => {
    // Two lists that must not drift: what this file treats as a read, and what
    // src/lib/mcpScope.js lets the in-app assistant's relay call. A write tool
    // appearing on that list is a write offered to every chat caller (KOL-113).
    assert.deepEqual([...MCP_READ_TOOLS].sort(), [...MCP_READS].sort(),
      'MCP_READ_TOOLS (src/lib/mcpScope.js) and this group\'s MCP_READS disagree about which tools only read');
  });

  test('a read-only session advertises the read tools and nothing else', async () => {
    const advertised = (await mcpReadOnly.listTools()).tools.map(t => t.name).sort();
    assert.deepEqual(advertised, [...MCP_READ_TOOLS].sort(),
      `a session opened with ${MCP_SCOPE_HEADER}: ${MCP_READ_SCOPE} should carry no write tool: ${advertised.join(', ')}`);
  });

  test('a read-only session cannot write even as an editor, and the graph is untouched', async () => {
    // The role behind the token is deliberately one that *may* write: this is
    // the scope refusing, not the write floor, which is the whole point —
    // chat's relay carries the connector's identity rather than the caller's.
    await mcpActAs(editor);
    const before = await graphState();

    for (const [name, toolArgs] of Object.entries(mcpWriteArgs())) {
      const res = await callToolOn(mcpReadOnly, name, toolArgs);
      assert.equal(res.isError, true, `${name} should be unreachable on a read-only session, answered: ${res.text}`);
    }

    assert.deepEqual(await graphState(), before, 'a write on a read-only MCP session changed the graph');
  });

  test('a read-only session still reads', async () => {
    await mcpActAs(editor);
    for (const [name, toolArgs] of Object.entries(mcpReadArgs())) {
      const res = await callToolOn(mcpReadOnly, name, toolArgs);
      assert.equal(res.isError, false, `${name} should answer a read-only session, returned: ${res.text}`);
    }
  });

  test('a member with no role at all is refused, not defaulted', async () => {
    // Fails closed: the membership exists (so the workspace resolves) but
    // carries no role, which is what a row written by an older or a broken
    // path would look like.
    const stray = await User.create({ email: 'write-role-stray@example.test', passwordHash: await bcrypt.hash(PASSWORD, 10) });
    await Workspace.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(owner.workspaceId) },
      { $push: { members: { userId: stray._id } } }
    );
    await setMcpUser(String(stray._id));

    const res = await callTool('create_entity', { title: 'No role wrote this', category: 'Characters', summary: 'A write with no role.' });
    assert.equal(res.isError, true, `create_entity with no role returned: ${res.text}`);
    assert.match(res.text, /NOT_WORKSPACE_EDITOR/);
    assert.match(res.text, /none/, `the refusal should say the role was absent: ${res.text}`);

    await Workspace.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(owner.workspaceId) },
      { $pull: { members: { userId: stray._id } } }
    );
  });
});
