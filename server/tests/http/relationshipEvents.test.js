/**
 * The frames `/relationship-groups` writes put on `/events` (KOL-149).
 *
 * KOL-116 found this exact hole in `/open-questions` and closed it; the sibling
 * collection still had it. The route has **nine** write paths — create, relabel,
 * add members, reorder, relabel a member, remove a member, add and remove a
 * subgroup, and delete a group — and it imported neither `broadcaster` nor
 * `changeLogger`, so nothing any of them wrote reached another client, while the
 * browser has echoed `X-SSE-Client-Id` on every one of those requests since
 * KOL-104 (`client/src/api/relationshipGroups.js`): the header was inert because
 * no frame ever carried an exclusion. The other tab went on drawing edges that
 * no longer existed — and the graph, whose entire content is relationships, is
 * the view with no other way to notice, since it reads the group list once on
 * mount.
 *
 * What can only be asserted over real requests, and is asserted below:
 *
 *   **Every one of the nine writes emits exactly one frame, of the right name.**
 *   One `group:updated` for every write that changes a group's own row —
 *   membership, order, a member's label, the group's label, a subgroup link — so
 *   there is one vocabulary and not nine; `group:created` for the create;
 *   `group:deleted` for the delete *and* for the removal that leaves a group
 *   with fewer than two entity members, because that path deletes the group and
 *   a listener has edges to drop rather than a row to re-read.
 *
 *   **`entityIds` is the flattened entity set, nested subgroups included, as
 *   plain strings.** A subgroup is a reference — the parent holds its id and
 *   nothing else — so the entities it contributes are not in the document the
 *   route has in hand, and they are exactly the entities whose panels and edges
 *   a write to the parent changes. They are bare strings for the reason KOL-116
 *   gives for `entry_ids`: a listener that had to branch on which of the nine
 *   writes a frame came from would be reading the server's internals.
 *
 *   **A removal still names the member that left.** It is no longer in the row
 *   the frame is built from, and its panel is as affected as the ones that
 *   stayed.
 *
 *   **A delete still names the entities the group held**, which is all a
 *   listener has to refresh from: a 204 carries nothing and this collection
 *   keeps no snapshot anywhere else (no `ChangeLog` trail, no rollback route).
 *
 *   **Tenancy and the echo.** Every frame reaches the workspace's other tabs
 *   and no tab in another workspace, and never the tab that asked for the write
 *   — which already has the response.
 *
 * Falsification: drop any one `broadcastGroup*` call from
 * `src/routes/relationshipGroups.js` and that write's case fails with no frame;
 * drop `workspaceId` from the options and every case fails (the broadcaster
 * delivers to nobody); drop `excludeClientId` and the writer's-own-tab
 * assertions fail; stop walking subgroups in `lib/relationshipEvents.js` and the
 * nested cases lose their entities; drop `alsoTouched` and the two removal cases
 * stop naming the member that left; emit `group:updated` from the orphaning
 * removal and that case fails on the frame name.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_GROUP_SSE_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture document, naming the request that created it
 *             and the workspace it landed in
 *   normal  — light, plus every listener registered and every write with its
 *             status
 *   verbose — normal, plus every frame a listener received
 */

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import session from 'express-session';

// Every session write is checked against CLIENT_ORIGIN (src/middleware/originGuard.js),
// so this suite names one below and its agents send a matching Origin.
import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';

import * as db from '../helpers/db.js';
// Registration is throttled per client address, and these suites register
// their fixtures through the real endpoint from one address. See the helper.
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import RelationshipGroup from '../../src/models/RelationshipGroup.js';

// The environment has to be in place before src/app.js is imported — same
// reasoning as tests/http/relationshipGroupList.test.js, hence the dynamic
// imports below.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
// Unset on purpose: every request here authenticates with a session cookie, so
// a stray Authorization header must not be able to satisfy requireAuth.
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.GROUP_LIST_LOG_LEVEL ??= 'off';
process.env.CHANGELOG_LOG_LEVEL ??= 'off';
// This suite drives real broadcasts; both of these narrate every one of them,
// which is readable when a frame is being chased and noise here.
process.env.SSE_LOG_LEVEL ??= 'off';
process.env.RELATIONSHIP_SSE_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');
// The same module instance the app broadcasts through — one process, one client
// map — so a connection registered here really is a listener on the route's
// fan-out. `tests/http/events.test.js` owns the socket's own behaviour over real
// sockets and `tests/unit/broadcaster.test.js` the fan-out's; the subject here
// is the route: whether it broadcasts at all, with what payload, scoped to whom.
const { addClient, removeClient } = await import('../../src/lib/broadcaster.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_GROUP_SSE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/groupSse:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

/** `Worlds` is in the default template's entity-type registry. */
const entityBody = (title) => ({
  title,
  category: 'Worlds',
  summary: `${title}, for a group to point at.`,
  tags: ['stations'],
});

let app;
let alice;
let bob;

/**
 * Registers a user through the real endpoint and reads back the ids
 * registration created, so the fixture asserts on what the API actually did.
 */
async function registerUser(email) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  assert.ok(user, `registration should have created a User for ${email}`);
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  log('light', `registered ${email} (source: POST /auth/register) → user ${user._id}, workspace ${workspace._id}`);
  return { agent, email, userId: String(user._id), workspaceId: String(workspace._id) };
}

/** POSTs `count` entities as `who` and returns their ids. */
async function entities(who, ...titles) {
  const ids = [];
  for (const title of titles) {
    const res = await who.agent.post('/entities').send(entityBody(`${title} ${Math.random().toString(36).slice(2, 7)}`));
    assert.equal(res.status, 201, `POST /entities as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
    log('light', `created entity ${res.body._id} "${res.body.title}" (source: POST /entities as ${who.email})`);
    ids.push(String(res.body._id));
  }
  return ids;
}

/** POSTs a group over `entityIds` as `who` and returns the created document. */
async function createGroup(who, label, entityIds) {
  const res = await who.agent.post('/relationship-groups').send({
    label,
    members: entityIds.map(entityId => ({ entityId })),
  });
  assert.equal(res.status, 201, `POST /relationship-groups as ${who.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  log('light', `created group ${res.body._id} "${label}" over ${entityIds.length} entity(ies) (source: POST /relationship-groups as ${who.email})`);
  return res.body;
}

/** Links `childId` under `parentId` as a sub-group, asserted. */
async function linkSubGroup(who, parentId, childId, label = null) {
  const res = await who.agent.post(`/relationship-groups/${parentId}/subgroups`).send({ groupId: childId, label });
  assert.equal(res.status, 201, `POST /relationship-groups/${parentId}/subgroups answered ${res.status}: ${JSON.stringify(res.body)}`);
  log('light', `linked group ${childId} under ${parentId} (source: POST /relationship-groups/${parentId}/subgroups as ${who.email})`);
  return res.body;
}

before(async () => {
  await db.connect();

  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });

  alice = await registerUser('rg-sse-alice@example.test');
  bob = await registerUser('rg-sse-bob@example.test');
  assert.notEqual(alice.workspaceId, bob.workspaceId, 'two registrations must yield two distinct workspaces');
});

after(async () => {
  await db.disconnect();
});

/** Every client registered by the current test, dropped in afterEach. */
let connected = [];
let clientCounter = 0;

afterEach(() => {
  for (const clientId of connected) removeClient(clientId);
  connected = [];
});

/** One SSE frame as the broadcaster wrote it. */
function parseFrame(chunk) {
  const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? null;
  const raw = /^data: (.*)$/m.exec(chunk)?.[1] ?? null;
  let data = null;
  try { data = raw === null ? null : JSON.parse(raw); } catch { data = raw; }
  return { event, data };
}

/**
 * A listener in `who`'s workspace, collecting what it receives. The returned
 * `clientId` is what a browser would echo back as `X-SSE-Client-Id`.
 */
function listen(label, who) {
  const received = [];
  const clientId = `${label}-${(clientCounter += 1)}`;
  const added = addClient(clientId, { write: (chunk) => received.push(parseFrame(chunk)) },
    who.workspaceId, { userId: who.userId });
  assert.ok(added.accepted, `the broadcaster refused a listener for ${label}: ${JSON.stringify(added)}`);
  connected.push(clientId);
  log('normal', `listening as ${clientId} in workspace ${who.workspaceId} (source: addClient)`);
  return {
    clientId,
    named: (event) => received.filter((f) => f.event === event),
    // The `group:*` traffic alone. The fixtures these tests build are entities,
    // and an entity create broadcasts its own frame from a fire-and-forget
    // `logCreate` that can land at any point after — so "received nothing" has
    // to mean "received no group frame", not "received no frame".
    groups: () => {
      const frames = received.filter((f) => (f.event ?? '').startsWith('group:'));
      for (const frame of frames) log('verbose', `${clientId} received ${frame.event}: ${JSON.stringify(frame.data)}`);
      return frames;
    },
  };
}

/**
 * Runs one write under three listeners — the writing tab, a second tab in the
 * same workspace, and a tab in another workspace — and asserts the three
 * invariants every one of the nine writes shares: the other tab gets exactly
 * one frame of `expected`, the writer gets none (it echoed its own client id),
 * and the other workspace gets none.
 *
 * @param {(clientId: string) => Promise<import('supertest').Response>} run
 * @returns {Promise<{res: object, frame: object}>} the response and the frame's payload
 */
async function writeUnderListeners(expected, run, { status = null } = {}) {
  const writer = listen('alice/writing-tab', alice);
  const other = listen('alice/other-tab', alice);
  const stranger = listen('bob/tab', bob);

  const res = await run(writer.clientId);
  if (status !== null) {
    assert.equal(res.status, status, `the write answered ${res.status}: ${JSON.stringify(res.body)}`);
  }
  log('normal', `write → ${res.status} (expecting one ${expected})`);

  const frames = other.named(expected);
  assert.equal(frames.length, 1,
    `the other tab should have received exactly one ${expected}; it received ${JSON.stringify(other.groups())}`);
  assert.equal(other.groups().length, 1,
    `the write should emit one group frame and no others: ${JSON.stringify(other.groups())}`);
  assert.deepEqual(writer.groups(), [], 'the tab that did the write received its own echo');
  assert.deepEqual(stranger.groups(), [], "another workspace's tab received this workspace's write");

  return { res, frame: frames[0].data };
}

/** The frame's `entityIds`, asserted to be bare strings, as a sorted array. */
function entityIdsOf(frame) {
  assert.ok(Array.isArray(frame.entityIds), `the frame carried no entityIds: ${JSON.stringify(frame)}`);
  for (const id of frame.entityIds) {
    assert.equal(typeof id, 'string',
      `entityIds must be plain string ids, never a populated document: ${JSON.stringify(frame.entityIds)}`);
  }
  return [...frame.entityIds].sort();
}

const sorted = (ids) => [...ids].sort();

describe('the frame each of the nine writes broadcasts', () => {
  test('POST /relationship-groups sends one group:created, carrying the group and its members', async () => {
    const [a, b] = await entities(alice, 'Alder Street', 'Boiler Room');

    const { res, frame } = await writeUnderListeners('group:created', (clientId) =>
      alice.agent
        .post('/relationship-groups')
        .set('X-SSE-Client-Id', clientId)
        .send({ label: 'Runs through', members: [{ entityId: a }, { entityId: b }] }),
    { status: 201 });

    assert.equal(frame.group._id, String(res.body._id));
    assert.equal(frame.group.label, 'Runs through');
    // The row as a panel renders it: the members, with each one's populated ref.
    assert.deepEqual(frame.group.members.map(m => m.refId), [a, b]);
    assert.deepEqual(frame.group.members.map(m => m.refModel), ['Entity', 'Entity']);
    assert.ok(frame.group.members.every(m => typeof m.ref?.title === 'string'),
      `each member should carry its populated ref: ${JSON.stringify(frame.group.members)}`);
    assert.deepEqual(entityIdsOf(frame), sorted([a, b]));
  });

  test('PATCH /relationship-groups/:id sends one group:updated with the new label', async () => {
    const [a, b] = await entities(alice, 'Coupling Yard', 'Depot');
    const group = await createGroup(alice, 'Old label', [a, b]);

    const { frame } = await writeUnderListeners('group:updated', (clientId) =>
      alice.agent
        .patch(`/relationship-groups/${group._id}`)
        .set('X-SSE-Client-Id', clientId)
        .send({ label: 'New label' }),
    { status: 200 });

    assert.equal(frame.group._id, String(group._id));
    assert.equal(frame.group.label, 'New label', 'the frame carried the label as it was before the write');
    assert.deepEqual(entityIdsOf(frame), sorted([a, b]));
  });

  test('POST /relationship-groups/:id/members sends one group:updated naming the new member', async () => {
    const [a, b, c] = await entities(alice, 'Engine Shed', 'Firebox', 'Gantry');
    const group = await createGroup(alice, 'Runs through', [a, b]);

    const { frame } = await writeUnderListeners('group:updated', (clientId) =>
      alice.agent
        .post(`/relationship-groups/${group._id}/members`)
        .set('X-SSE-Client-Id', clientId)
        .send({ members: [{ entityId: c, label: 'Added' }] }),
    { status: 201 });

    assert.deepEqual(frame.group.members.map(m => m.refId), [a, b, c]);
    assert.deepEqual(entityIdsOf(frame), sorted([a, b, c]));
  });

  test('PATCH /relationship-groups/:id/members/reorder sends one group:updated in the new order', async () => {
    const [a, b, c] = await entities(alice, 'Halt', 'Inspection Pit', 'Junction');
    const group = await createGroup(alice, 'Runs through', [a, b, c]);

    const { frame } = await writeUnderListeners('group:updated', (clientId) =>
      alice.agent
        .patch(`/relationship-groups/${group._id}/members/reorder`)
        .set('X-SSE-Client-Id', clientId)
        .send({ orderedMembers: [c, a, b].map(refId => ({ refModel: 'Entity', refId })) }),
    { status: 200 });

    // Array position is the display order, so the order is the change.
    assert.deepEqual(frame.group.members.map(m => m.refId), [c, a, b]);
    assert.deepEqual(entityIdsOf(frame), sorted([a, b, c]));
  });

  test("PATCH /relationship-groups/:id/members/:entityId sends one group:updated with the member's new label", async () => {
    const [a, b] = await entities(alice, 'Kiosk', 'Level Crossing');
    const group = await createGroup(alice, 'Runs through', [a, b]);

    const { frame } = await writeUnderListeners('group:updated', (clientId) =>
      alice.agent
        .patch(`/relationship-groups/${group._id}/members/${b}`)
        .set('X-SSE-Client-Id', clientId)
        .send({ label: 'Signalled by' }),
    { status: 200 });

    assert.equal(frame.group.members.find(m => m.refId === b).label, 'Signalled by');
    assert.deepEqual(entityIdsOf(frame), sorted([a, b]));
  });

  test('DELETE /relationship-groups/:id/members/:entityId sends one group:updated that still names the member that left', async () => {
    const [a, b, c] = await entities(alice, 'Mess Room', 'Night Run', 'Oil Store');
    const group = await createGroup(alice, 'Runs through', [a, b, c]);

    const { frame } = await writeUnderListeners('group:updated', (clientId) =>
      alice.agent
        .delete(`/relationship-groups/${group._id}/members/${a}`)
        .set('X-SSE-Client-Id', clientId),
    { status: 204 });

    assert.deepEqual(frame.group.members.map(m => m.refId), [b, c], 'the row should be the group as it is now');
    // The removed entity's panel is as affected as the two that stayed, and it
    // is no longer in the row — so the frame has to name it anyway.
    assert.deepEqual(entityIdsOf(frame), sorted([a, b, c]));
  });

  test('a removal that orphans the group sends group:deleted, not group:updated', async () => {
    // Fewer than two entity members left: the route deletes the group, so a
    // listener has edges to drop rather than a row to re-read.
    const [a, b] = await entities(alice, 'Platform', 'Quarry Siding');
    const group = await createGroup(alice, 'Runs through', [a, b]);

    const { frame } = await writeUnderListeners('group:deleted', (clientId) =>
      alice.agent
        .delete(`/relationship-groups/${group._id}/members/${a}`)
        .set('X-SSE-Client-Id', clientId),
    { status: 204 });

    assert.equal(frame.groupId, String(group._id));
    assert.equal(frame.group._id, String(group._id));
    assert.deepEqual(entityIdsOf(frame), sorted([a, b]),
      'both the member that left and the one that was stranded have a panel to refresh');
    assert.equal(await RelationshipGroup.findById(group._id), null, 'premise: the group really was deleted');
  });

  test('POST /relationship-groups/:id/subgroups sends one group:updated reaching into the sub-group', async () => {
    const [a, b, c, d] = await entities(alice, 'Rail Head', 'Signal Box', 'Turntable', 'Underpass');
    const parent = await createGroup(alice, 'Parent', [a, b]);
    const child = await createGroup(alice, 'Child', [c, d]);

    const { frame } = await writeUnderListeners('group:updated', (clientId) =>
      alice.agent
        .post(`/relationship-groups/${parent._id}/subgroups`)
        .set('X-SSE-Client-Id', clientId)
        .send({ groupId: child._id, label: 'Within' }),
    { status: 201 });

    assert.equal(frame.group._id, String(parent._id));
    // The parent's own row holds the child's *id* and nothing else …
    const link = frame.group.members.find(m => m.refModel === 'RelationshipGroup');
    assert.equal(link.refId, String(child._id));
    assert.equal(link.ref.label, 'Child');
    // … so the child's entities can only come from the walk, and they are what
    // the parent's new edges are drawn between.
    assert.deepEqual(entityIdsOf(frame), sorted([a, b, c, d]));
  });

  test('DELETE /relationship-groups/:id/subgroups/:subGroupId sends one group:updated', async () => {
    const [a, b, c, d] = await entities(alice, 'Viaduct', 'Water Tower', 'Xing Keeper', 'Yard Office');
    const parent = await createGroup(alice, 'Parent', [a, b]);
    const child = await createGroup(alice, 'Child', [c, d]);
    await linkSubGroup(alice, parent._id, child._id, 'Within');

    const { frame } = await writeUnderListeners('group:updated', (clientId) =>
      alice.agent
        .delete(`/relationship-groups/${parent._id}/subgroups/${child._id}`)
        .set('X-SSE-Client-Id', clientId),
    { status: 204 });

    assert.equal(frame.group._id, String(parent._id));
    assert.ok(!frame.group.members.some(m => m.refModel === 'RelationshipGroup'), 'the link should be gone');
    // The unlink promotes the sub-group's entity members into the parent, so
    // the same four entities are reachable — directly now.
    assert.deepEqual(entityIdsOf(frame), sorted([a, b, c, d]));
  });

  test('DELETE /relationship-groups/:id sends one group:deleted naming the entities it held', async () => {
    const [a, b, c] = await entities(alice, 'Zig Zag', 'Ash Pit', 'Brake Van');
    const group = await createGroup(alice, 'Runs through', [a, b, c]);

    const { frame } = await writeUnderListeners('group:deleted', (clientId) =>
      alice.agent
        .delete(`/relationship-groups/${group._id}`)
        .set('X-SSE-Client-Id', clientId),
    { status: 204 });

    // The id at the top level, because that is all a listener needs to drop its
    // edges, and the row behind it so a toast can name what is gone — a 204
    // carries nothing and this collection keeps no snapshot anywhere else.
    assert.equal(frame.groupId, String(group._id));
    assert.equal(frame.group.label, 'Runs through');
    assert.deepEqual(frame.group.members.map(m => m.refId), [a, b, c]);
    assert.deepEqual(entityIdsOf(frame), sorted([a, b, c]),
      'a listener has nothing else to tell it which entities just changed');
  });
});

describe('what entityIds carries', () => {
  test('it flattens a sub-group nested two deep, and never a populated document', async () => {
    // P ⊃ { a, b, C }, C ⊃ { c, d, D }, D ⊃ { e, f } — so a write to P must
    // name all six, or a tab showing `e` goes on drawing an edge P removed.
    const [a, b, c, d, e, f] = await entities(alice, 'P1', 'P2', 'C1', 'C2', 'D1', 'D2');
    const deepest = await createGroup(alice, 'Deepest', [e, f]);
    const middle = await createGroup(alice, 'Middle', [c, d]);
    const top = await createGroup(alice, 'Top', [a, b]);
    await linkSubGroup(alice, middle._id, deepest._id, 'Within');
    await linkSubGroup(alice, top._id, middle._id, 'Within');

    const { frame } = await writeUnderListeners('group:updated', (clientId) =>
      alice.agent
        .patch(`/relationship-groups/${top._id}`)
        .set('X-SSE-Client-Id', clientId)
        .send({ label: 'Top, renamed' }),
    { status: 200 });

    assert.deepEqual(entityIdsOf(frame), sorted([a, b, c, d, e, f]),
      'the walk did not reach every nested member');
    // Plain strings throughout, whatever the route's own response happens to
    // carry: `entityIdsOf` asserts the type, and this asserts the shape is not
    // a populated row that merely stringifies.
    assert.ok(frame.entityIds.every(id => /^[a-f0-9]{24}$/.test(id)),
      `entityIds should be bare ObjectId strings: ${JSON.stringify(frame.entityIds)}`);
  });

  test("a sub-group in another workspace contributes nothing", async () => {
    // The walk is workspace-scoped, like every other read on this route: a
    // frame must not carry another tenant's entity ids even by accident.
    const [a, b] = await entities(alice, 'Mine', 'Also mine');
    const [x, y] = await entities(bob, 'Theirs', 'Also theirs');
    const parent = await createGroup(alice, 'Parent', [a, b]);
    const foreign = await createGroup(bob, 'Foreign', [x, y]);

    // The route refuses to *link* it, so the dangling reference is written
    // straight into the document — which is the state the walk has to survive.
    await RelationshipGroup.updateOne(
      { _id: parent._id },
      { $push: { members: { refId: foreign._id, refModel: 'RelationshipGroup', label: null, notes: null } } },
    );

    const { frame } = await writeUnderListeners('group:updated', (clientId) =>
      alice.agent
        .patch(`/relationship-groups/${parent._id}`)
        .set('X-SSE-Client-Id', clientId)
        .send({ label: 'Parent, renamed' }),
    { status: 200 });

    assert.deepEqual(entityIdsOf(frame), sorted([a, b]),
      `a foreign workspace's entities reached the frame: ${JSON.stringify(frame.entityIds)}`);
  });

  test('a cycle between two groups terminates', async () => {
    // The route refuses a group as its own direct sub-group and nothing refuses
    // A → B → A, so the walk has to survive one.
    const [a, b, c, d] = await entities(alice, 'Loop A1', 'Loop A2', 'Loop B1', 'Loop B2');
    const first = await createGroup(alice, 'First', [a, b]);
    const second = await createGroup(alice, 'Second', [c, d]);
    await linkSubGroup(alice, first._id, second._id, 'Within');
    await linkSubGroup(alice, second._id, first._id, 'Within');

    const { frame } = await writeUnderListeners('group:updated', (clientId) =>
      alice.agent
        .patch(`/relationship-groups/${first._id}`)
        .set('X-SSE-Client-Id', clientId)
        .send({ label: 'First, renamed' }),
    { status: 200 });

    assert.deepEqual(entityIdsOf(frame), sorted([a, b, c, d]));
  });
});

describe('what does not broadcast', () => {
  test('a refused write broadcasts nothing', async () => {
    // The frame follows the write, not the request: a 400 left nothing to tell
    // another tab about, and a frame for it would have every listener redraw a
    // graph that did not change.
    const [a] = await entities(alice, 'Only one member');
    const other = listen('alice/other-tab', alice);

    const res = await alice.agent.post('/relationship-groups').send({ label: 'Too small', members: [{ entityId: a }] });
    assert.equal(res.status, 400, `POST answered ${res.status}: ${JSON.stringify(res.body)}`);

    assert.deepEqual(other.groups(), [], `a refused write still broadcast: ${JSON.stringify(other.groups())}`);
  });

  test("a write on another workspace's group is a 404 and broadcasts nothing", async () => {
    const [a, b] = await entities(alice, 'Hers 1', 'Hers 2');
    const hers = await createGroup(alice, 'Hers', [a, b]);
    const herTab = listen('alice/tab', alice);
    const hisTab = listen('bob/tab', bob);

    for (const res of [
      await bob.agent.patch(`/relationship-groups/${hers._id}`).send({ label: 'Mine now' }),
      await bob.agent.delete(`/relationship-groups/${hers._id}`),
    ]) {
      assert.equal(res.status, 404, `a foreign group answered ${res.status}: ${JSON.stringify(res.body)}`);
    }

    assert.deepEqual(herTab.groups(), [], 'a refused foreign write reached her tab');
    assert.deepEqual(hisTab.groups(), [], 'a refused foreign write reached his own tab');
  });

  test('a write with no X-SSE-Client-Id reaches every tab in the workspace', async () => {
    // The MCP tools and curl have no stream to exclude; nor does a browser
    // whose stream has not come back yet.
    const [a, b] = await entities(alice, 'No header 1', 'No header 2');
    const first = listen('alice/tab-1', alice);
    const second = listen('alice/tab-2', alice);

    const res = await alice.agent.post('/relationship-groups')
      .send({ label: 'Who asked, though?', members: [{ entityId: a }, { entityId: b }] });
    assert.equal(res.status, 201, `POST answered ${res.status}: ${JSON.stringify(res.body)}`);

    assert.equal(first.named('group:created').length, 1, `tab 1 received ${JSON.stringify(first.groups())}`);
    assert.equal(second.named('group:created').length, 1, `tab 2 received ${JSON.stringify(second.groups())}`);
  });
});
