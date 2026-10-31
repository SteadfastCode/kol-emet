/**
 * Collaborator invites over the real stack (KOL-124): the first thing in the
 * product that can produce a member who is not the owner.
 *
 * `Workspace.members[].role` has carried `owner | editor | viewer` since
 * KOL-071 and every content write has been gated on it since KOL-103, but
 * nothing could create such a member — registration writes the single owner and
 * no route added, re-roled or removed a membership. So the whole write floor
 * was exercised only by tests, and `editor` and `viewer` were unreachable on a
 * real deployment. What this file pins:
 *
 *   - **An owner invites; an editor and a viewer may not** — 403
 *     `NOT_WORKSPACE_OWNER`, and no invite row is written.
 *   - **An invite is an address and nothing else.** No mail, no token, no link.
 *     It is stored lowercased and trimmed, matched to an account on the
 *     identifier registration already keeps unique, and an address with no
 *     account simply waits — answered identically to one that has an account,
 *     which is what keeps the form from being a way to ask who has registered.
 *   - **An accepted role is exactly what it says, driven through a real content
 *     route** rather than read back off the membership row: an accepted editor
 *     gets 201 from `POST /entities` and 403 from `PATCH /workspace`; an
 *     accepted viewer reads and is refused the write.
 *   - **One user cannot accept another's invite** — 404 (never 403, which would
 *     confirm it exists) and no membership is written.
 *   - **The workspace always keeps one owner**: the last owner cannot be
 *     demoted or removed (409 `LAST_OWNER`), and when a *co*-owner is demoted
 *     or removed `Workspace.ownerId` moves to one who still holds the role —
 *     the field `lib/accountDeleter.js` judges sole ownership by.
 *   - **A removed member loses access on their next request**, because
 *     `resolveWorkspace` re-reads the membership list every time: the entity
 *     they created in that workspace is 404 to them afterwards and their
 *     requests resolve their own workspace instead.
 *   - **Account deletion meets a shared workspace.** `lib/accountDeleter.js`
 *     has refused to delete an account that is a member of a workspace it does
 *     not solely own since the start; this item makes that refusal reachable
 *     for the first time, so it is asserted here through the real door — and it
 *     stops refusing once the membership is removed. A pending invite addressed
 *     to a deleted account goes with it.
 *
 * Fixtures are real registrations (bcrypt, the workspace and its template seed)
 * and real sign-ins, one cast per test, because a membership change is exactly
 * the state these tests must not share. Registration is throttled per client
 * address, so the app is built with SUITE_AUTH_LIMITS like every other suite
 * here.
 *
 * Falsification checks: drop `requireWorkspaceRole('owner')` from any write in
 * src/routes/workspace.js and the refusal groups fail; match the invite address
 * case-sensitively and the invitee stops seeing theirs; drop the `email`
 * equality from `ownInvite()` and the third-party accept succeeds; drop the
 * `ownersOf(...).length <= 1` guard and the last-owner group fails; stop moving
 * `ownerId` and the "a demoted owner can still delete their account" case fails.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_INVITES_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture, naming what created it
 *   normal  — light, plus every request, its status and body
 *   verbose — normal, plus the stored membership and invite rows after a write
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import session from 'express-session';

// Every session write is checked against CLIENT_ORIGIN (src/middleware/originGuard.js),
// so this suite names one below and its agents send a matching Origin.
import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';
import * as db from '../helpers/db.js';
// Registration is throttled per client address, and this suite registers every
// fixture through the real endpoint from one. See the helper.
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';

import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import WorkspaceInvite from '../../src/models/WorkspaceInvite.js';
import Entity from '../../src/models/Entity.js';

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
process.env.ACCOUNT_DELETE_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  const active = LEVELS[process.env.TEST_INVITES_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/invites:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

let app;
/** Unique addresses per fixture, so one test's cast cannot be another's. */
let seq = 0;
const nextEmail = (label) => `invites-${label}-${++seq}@example.test`;

/** Registers through the real endpoint and reads back the ids it created. */
async function register(label) {
  const email = nextEmail(label);
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({
    email,
    password: PASSWORD,
    workspaceName: `${label}'s workspace`,
  });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id name').lean();
  assert.ok(workspace, `registration should have created a workspace for ${email}`);

  log('light', `registered ${email} (source: POST /auth/register) → user ${user._id}, own workspace ${workspace._id}`);
  return { agent, email, label, userId: String(user._id), workspaceId: String(workspace._id) };
}

/** Sends a request as `who`, logging it at the normal tier. */
async function send(who, method, url, body) {
  const verb = method.toLowerCase();
  const pending = who.agent[verb](url);
  const res = await (body === undefined ? pending : pending.send(body));
  log('normal', `${method} ${url} as ${who.email} → ${res.status} ${JSON.stringify(res.body ?? null)}`);
  return res;
}

/** The members of a workspace, straight from the database. */
async function storedMembers(workspaceId) {
  const doc = await Workspace.findById(workspaceId).select('members ownerId').lean();
  log('verbose', `workspace ${workspaceId} members: ${JSON.stringify(doc?.members ?? null)}, ownerId ${doc?.ownerId ?? 'none'}`);
  return doc;
}

/** The role `userId` holds in `workspaceId`, or null when they are not a member. */
async function storedRole(workspaceId, userId) {
  const doc = await storedMembers(workspaceId);
  return doc?.members.find(m => String(m.userId) === String(userId))?.role ?? null;
}

/** An owner who has invited `invitee` at `role`, with the invite id. */
async function invited(owner, invitee, role = 'editor') {
  const res = await send(owner, 'POST', '/workspace/invites', { email: invitee.email, role });
  assert.equal(res.status, 201, `POST /workspace/invites failed: ${res.status} ${JSON.stringify(res.body)}`);
  return String(res.body._id);
}

/**
 * An invitee who has accepted, and whose session now acts in the shared
 * workspace. The select is a separate call on purpose: accepting does not
 * change which workspace a session acts in — `POST /workspaces/:id/select` is
 * still the only writer of that (KOL-090).
 */
async function accepted(owner, invitee, role = 'editor') {
  const inviteId = await invited(owner, invitee, role);
  const accept = await send(invitee, 'POST', `/invites/${inviteId}/accept`, {});
  assert.equal(accept.status, 200, `POST /invites/:id/accept failed: ${accept.status} ${JSON.stringify(accept.body)}`);

  const select = await send(invitee, 'POST', `/workspaces/${owner.workspaceId}/select`, {});
  assert.equal(select.status, 200, `POST /workspaces/:id/select failed: ${select.status} ${JSON.stringify(select.body)}`);

  log('light', `${invitee.email} accepted a ${role} invite to workspace ${owner.workspaceId} and selected it (source: the real /invites and /workspaces routes)`);
  return inviteId;
}

/** A cast of an owner and one invitee who has accepted at `role`. */
async function sharedWorkspace(role = 'editor') {
  const owner = await register('owner');
  const invitee = await register(role);
  await accepted(owner, invitee, role);
  return { owner, invitee };
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });
});

after(async () => { await db.disconnect(); });

describe('POST /workspace/invites', () => {
  test('an owner invites an address, stored as it would be registered', async () => {
    const owner = await register('owner');

    const res = await send(owner, 'POST', '/workspace/invites', { email: '  Mixed.Case@Example.TEST ', role: 'viewer' });

    assert.equal(res.status, 201);
    assert.equal(res.body.email, 'mixed.case@example.test', 'the address is trimmed and lowercased, as User.email is');
    assert.equal(res.body.role, 'viewer');
    assert.equal(String(res.body.invitedBy), owner.userId);
    assert.ok(res.body._id, 'the invite answers its own id, which is what accept and withdraw name');

    const stored = await WorkspaceInvite.find({ workspaceId: owner.workspaceId }).lean();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].email, 'mixed.case@example.test');
  });

  test('an address with no account is accepted, and answered exactly like one that has', async () => {
    const owner = await register('owner');
    const registered = await register('registered');

    const nobody = await send(owner, 'POST', '/workspace/invites', { email: 'nobody@example.test', role: 'editor' });
    const somebody = await send(owner, 'POST', '/workspace/invites', { email: registered.email, role: 'editor' });

    assert.equal(nobody.status, somebody.status, 'the status must not say whether the address has an account');
    assert.deepEqual(
      Object.keys(nobody.body).sort(),
      Object.keys(somebody.body).sort(),
      'the body must not say whether the address has an account',
    );
    // And it waits: the row is valid and nothing resolves it yet.
    assert.equal(await WorkspaceInvite.countDocuments({ email: 'nobody@example.test' }), 1);
  });

  test('an editor and a viewer are refused, and write no invite', async () => {
    for (const role of ['editor', 'viewer']) {
      const { owner, invitee } = await sharedWorkspace(role);
      const before = await WorkspaceInvite.countDocuments({ workspaceId: owner.workspaceId });

      const res = await send(invitee, 'POST', '/workspace/invites', { email: 'wanted@example.test', role: 'editor' });

      assert.equal(res.status, 403, `a ${role} should not be able to invite`);
      assert.equal(res.body.error, 'NOT_WORKSPACE_OWNER');
      assert.equal(await WorkspaceInvite.countDocuments({ workspaceId: owner.workspaceId }), before, `a refused ${role} wrote an invite`);
    }
  });

  test('a body that is not an address or not a role is refused, and writes nothing', async () => {
    const owner = await register('owner');
    const cases = [
      ['no email', { role: 'editor' }, 'INVALID_EMAIL'],
      ['a blank email', { email: '   ', role: 'editor' }, 'INVALID_EMAIL'],
      ['an object where the address goes', { email: { $regex: '.' }, role: 'editor' }, 'INVALID_EMAIL'],
      ['a role that is not one', { email: 'x@example.test', role: 'admin' }, 'INVALID_ROLE'],
      ['a role that is an object', { email: 'x@example.test', role: { $ne: null } }, 'INVALID_ROLE'],
    ];

    for (const [what, body, error] of cases) {
      const res = await send(owner, 'POST', '/workspace/invites', body);
      assert.equal(res.status, 400, `${what} should be a 400`);
      assert.equal(res.body.error, error, what);
    }
    assert.equal(await WorkspaceInvite.countDocuments({ workspaceId: owner.workspaceId }), 0, 'a refused invite wrote a row');
  });

  test('an invite defaults to editor when the body names no role', async () => {
    const owner = await register('owner');
    const res = await send(owner, 'POST', '/workspace/invites', { email: 'defaulted@example.test' });

    assert.equal(res.status, 201);
    assert.equal(res.body.role, 'editor', 'a collaborator is the default, not an owner');
  });

  test('inviting someone who is already a member is 409, and changes nothing', async () => {
    const { owner, invitee } = await sharedWorkspace('editor');

    const res = await send(owner, 'POST', '/workspace/invites', { email: invitee.email, role: 'viewer' });

    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'ALREADY_A_MEMBER');
    assert.equal(await storedRole(owner.workspaceId, invitee.userId), 'editor', 'the member was re-roled by a refused invite');
    assert.equal(await WorkspaceInvite.countDocuments({ workspaceId: owner.workspaceId }), 0);
  });

  test('re-inviting a pending address updates that invite rather than adding a second', async () => {
    const owner = await register('owner');
    const invitee = await register('invitee');
    const first = await invited(owner, invitee, 'viewer');

    const again = await send(owner, 'POST', '/workspace/invites', { email: invitee.email, role: 'owner' });

    assert.equal(again.status, 200, 'the second invite is an update, not a create');
    assert.equal(String(again.body._id), first, 'the same row');
    assert.equal(again.body.role, 'owner');
    assert.equal(await WorkspaceInvite.countDocuments({ workspaceId: owner.workspaceId }), 1);
  });

  test('an owner reads and withdraws the invites waiting on their workspace', async () => {
    const owner = await register('owner');
    const invitee = await register('invitee');
    const inviteId = await invited(owner, invitee, 'viewer');

    const list = await send(owner, 'GET', '/workspace/invites');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map(i => [i.email, i.role]), [[invitee.email, 'viewer']]);

    const gone = await send(owner, 'DELETE', `/workspace/invites/${inviteId}`);
    assert.equal(gone.status, 204);
    assert.equal(await WorkspaceInvite.countDocuments({ _id: inviteId }), 0);
    assert.deepEqual((await send(owner, 'GET', '/workspace/invites')).body, []);

    // And the invitee no longer has it to accept.
    const accept = await send(invitee, 'POST', `/invites/${inviteId}/accept`, {});
    assert.equal(accept.status, 404);
  });

  test("an invite of another workspace cannot be withdrawn through this one", async () => {
    const owner = await register('owner');
    const stranger = await register('stranger');
    const inviteId = await invited(stranger, owner, 'editor');

    const res = await send(owner, 'DELETE', `/workspace/invites/${inviteId}`);

    assert.equal(res.status, 404, 'never 403: the API must not confirm another tenant\'s invite exists');
    assert.equal(await WorkspaceInvite.countDocuments({ _id: inviteId }), 1, 'a refused withdrawal deleted an invite');
  });

  test('a malformed invite id is 400 INVALID_ID before the route runs', async () => {
    const owner = await register('owner');
    const res = await send(owner, 'DELETE', '/workspace/invites/not-an-id');

    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'INVALID_ID', param: 'inviteId' });
  });
});

describe('GET /invites — the invitee\'s own', () => {
  test('names the workspace and who asked, matched on the account address whatever case it was typed in', async () => {
    const owner = await register('owner');
    const invitee = await register('invitee');

    const created = await send(owner, 'POST', '/workspace/invites', {
      email: invitee.email.toUpperCase(),
      role: 'viewer',
    });
    assert.equal(created.status, 201);

    const res = await send(invitee, 'GET', '/invites');

    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    const [invite] = res.body;
    assert.equal(String(invite.workspaceId), owner.workspaceId);
    assert.equal(invite.workspaceName, "owner's workspace", 'an invitation nobody can name is not legible');
    assert.equal(invite.role, 'viewer');
    assert.equal(invite.invitedByEmail, owner.email, 'who asked — their own address, which they disclosed by inviting');
  });

  test('shows a caller nothing but their own', async () => {
    const owner = await register('owner');
    const invitee = await register('invitee');
    const bystander = await register('bystander');
    await invited(owner, invitee, 'editor');

    assert.deepEqual((await send(bystander, 'GET', '/invites')).body, []);
    assert.equal((await send(invitee, 'GET', '/invites')).body.length, 1);
  });

  test('is 401 without a session', async () => {
    const res = await originAgent(app).get('/invites');
    assert.equal(res.status, 401);
  });
});

describe('accepting and declining', () => {
  test('accepting writes the membership the invite names and drops the invite', async () => {
    const owner = await register('owner');
    const invitee = await register('invitee');
    const inviteId = await invited(owner, invitee, 'viewer');

    const res = await send(invitee, 'POST', `/invites/${inviteId}/accept`, {});

    assert.equal(res.status, 200);
    assert.equal(String(res.body._id), owner.workspaceId);
    assert.equal(res.body.role, 'viewer', 'the body names the role they now hold');
    assert.equal(await storedRole(owner.workspaceId, invitee.userId), 'viewer');
    assert.equal(await WorkspaceInvite.countDocuments({ _id: inviteId }), 0, 'an accepted invite is spent');

    // Both memberships are now theirs, and their session still acts in the
    // workspace it did: accepting is not selecting (KOL-090).
    const list = await send(invitee, 'GET', '/workspaces');
    assert.deepEqual(
      list.body.map(w => [String(w._id), w.role]).sort(),
      [[invitee.workspaceId, 'owner'], [owner.workspaceId, 'viewer']].sort(),
    );
    assert.equal(String((await send(invitee, 'GET', '/workspace')).body._id), invitee.workspaceId,
      'accepting must not move the workspace this session acts in');
  });

  test('one user cannot accept or decline another\'s invite', async () => {
    const owner = await register('owner');
    const invitee = await register('invitee');
    const thief = await register('thief');
    const inviteId = await invited(owner, invitee, 'editor');

    for (const verb of ['accept', 'decline']) {
      const res = await send(thief, 'POST', `/invites/${inviteId}/${verb}`, {});
      assert.equal(res.status, 404, `${verb} by someone else should be 404, never 403`);
      assert.equal(await storedRole(owner.workspaceId, thief.userId), null, `${verb} wrote a membership for the wrong user`);
      assert.equal(await WorkspaceInvite.countDocuments({ _id: inviteId }), 1, `${verb} by someone else spent the invite`);
    }

    // It is still the invitee's to accept.
    assert.equal((await send(invitee, 'POST', `/invites/${inviteId}/accept`, {})).status, 200);
  });

  test('declining drops the invite and writes no membership', async () => {
    const owner = await register('owner');
    const invitee = await register('invitee');
    const inviteId = await invited(owner, invitee, 'editor');

    const res = await send(invitee, 'POST', `/invites/${inviteId}/decline`, {});

    assert.equal(res.status, 204);
    assert.equal(await WorkspaceInvite.countDocuments({ _id: inviteId }), 0);
    assert.equal(await storedRole(owner.workspaceId, invitee.userId), null);
    assert.deepEqual((await send(invitee, 'GET', '/invites')).body, []);
  });

  test('accepting twice is idempotent: the second is the membership they already hold', async () => {
    const owner = await register('owner');
    const invitee = await register('invitee');
    const inviteId = await invited(owner, invitee, 'editor');
    assert.equal((await send(invitee, 'POST', `/invites/${inviteId}/accept`, {})).status, 200);

    const again = await send(invitee, 'POST', `/invites/${inviteId}/accept`, {});

    assert.equal(again.status, 404, 'the invite is spent, so there is nothing with that id addressed to them');
    const members = (await storedMembers(owner.workspaceId)).members;
    assert.equal(members.filter(m => String(m.userId) === invitee.userId).length, 1, 'a second accept duplicated the membership');
  });

  test('an invite whose workspace is gone is dropped rather than left waiting', async () => {
    const owner = await register('owner');
    const invitee = await register('invitee');
    const inviteId = await invited(owner, invitee, 'editor');
    await Workspace.deleteOne({ _id: owner.workspaceId });

    const res = await send(invitee, 'POST', `/invites/${inviteId}/accept`, {});

    assert.equal(res.status, 404);
    assert.equal(await WorkspaceInvite.countDocuments({ _id: inviteId }), 0, 'an offer of a workspace that does not exist must not be permanent');
  });
});

describe('what an accepted role may do, through a real content route', () => {
  test('an accepted editor writes content and is still refused what only an owner may do', async () => {
    const { owner, invitee } = await sharedWorkspace('editor');

    const created = await send(invitee, 'POST', '/entities', {
      title: 'Written by the invited editor',
      category: 'Characters',
      summary: 'A write the role system has never been able to admit before.',
    });
    assert.equal(created.status, 201, `the editor's write answered ${created.status} ${JSON.stringify(created.body)}`);
    assert.equal(String((await Entity.findById(created.body._id).select('workspaceId').lean()).workspaceId), owner.workspaceId,
      'the editor wrote into the workspace they were invited to');

    const rename = await send(invitee, 'PATCH', '/workspace', { name: 'Editor Was Here' });
    assert.equal(rename.status, 403);
    assert.equal(rename.body.error, 'NOT_WORKSPACE_OWNER');
    assert.equal((await Workspace.findById(owner.workspaceId).select('name').lean()).name, "owner's workspace");
  });

  test('an accepted viewer reads the workspace and is refused every write', async () => {
    const owner = await register('owner');
    const invitee = await register('viewer');
    const seeded = await send(owner, 'POST', '/entities', {
      title: 'Readable by the invited viewer',
      category: 'Characters',
      summary: 'Seeded by the owner.',
    });
    assert.equal(seeded.status, 201);
    await accepted(owner, invitee, 'viewer');

    const list = await send(invitee, 'GET', '/entities');
    assert.equal(list.status, 200);
    assert.ok(
      (list.body.entities ?? list.body).some(e => String(e._id) === String(seeded.body._id)),
      'a viewer should see the workspace they were invited to',
    );

    // Counted around the write, not against a constant: the workspace was
    // seeded from a template at registration, so it already holds content.
    const before = await Entity.countDocuments({ workspaceId: owner.workspaceId });
    const write = await send(invitee, 'POST', '/entities', { title: 'Viewer wrote this', category: 'Characters', summary: 'Must be refused.' });
    assert.equal(write.status, 403);
    assert.equal(write.body.error, 'NOT_WORKSPACE_EDITOR');
    assert.equal(await Entity.countDocuments({ workspaceId: owner.workspaceId }), before, 'a refused viewer write landed');
  });

  test('a re-roled member is held to the new role on their next write', async () => {
    const { owner, invitee } = await sharedWorkspace('editor');

    const demoted = await send(owner, 'PATCH', `/workspace/members/${invitee.userId}`, { role: 'viewer' });
    assert.equal(demoted.status, 200);
    assert.equal(demoted.body.role, 'viewer');

    const write = await send(invitee, 'POST', '/entities', { title: 'After the demotion', category: 'Characters', summary: 'Must be refused.' });
    assert.equal(write.status, 403, 'a demotion that only changes a row is not a demotion');
    assert.equal(write.body.error, 'NOT_WORKSPACE_EDITOR');

    const promoted = await send(owner, 'PATCH', `/workspace/members/${invitee.userId}`, { role: 'editor' });
    assert.equal(promoted.status, 200);
    assert.equal((await send(invitee, 'POST', '/entities', { title: 'After the promotion', category: 'Characters', summary: 'Must land.' })).status, 201);
  });
});

describe('the workspace always keeps one owner', () => {
  test('the last owner cannot be demoted', async () => {
    const owner = await register('owner');

    const res = await send(owner, 'PATCH', `/workspace/members/${owner.userId}`, { role: 'editor' });

    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'LAST_OWNER');
    assert.equal(await storedRole(owner.workspaceId, owner.userId), 'owner');
  });

  test('the last owner cannot be removed', async () => {
    const { owner, invitee } = await sharedWorkspace('editor');

    const res = await send(owner, 'DELETE', `/workspace/members/${owner.userId}`);

    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'LAST_OWNER');
    assert.equal(await storedRole(owner.workspaceId, owner.userId), 'owner');
    // And the editor is untouched by the refusal.
    assert.equal(await storedRole(owner.workspaceId, invitee.userId), 'editor');
  });

  test('a co-owner can be demoted, and ownerId follows the role', async () => {
    const { owner, invitee } = await sharedWorkspace('owner');
    assert.equal(String((await storedMembers(owner.workspaceId)).ownerId), owner.userId);

    // The original owner steps down, which only the second owner makes possible.
    const res = await send(invitee, 'PATCH', `/workspace/members/${owner.userId}`, { role: 'viewer' });

    assert.equal(res.status, 200);
    const stored = await storedMembers(owner.workspaceId);
    assert.equal(stored.members.find(m => String(m.userId) === owner.userId).role, 'viewer');
    assert.equal(String(stored.ownerId), invitee.userId,
      'ownerId must name a member who holds the role — lib/accountDeleter.js judges sole ownership by it');
  });

  test('a co-owner can be removed, and ownerId follows the role', async () => {
    const { owner, invitee } = await sharedWorkspace('owner');

    const res = await send(invitee, 'DELETE', `/workspace/members/${owner.userId}`);

    assert.equal(res.status, 204);
    const stored = await storedMembers(owner.workspaceId);
    assert.equal(stored.members.length, 1);
    assert.equal(String(stored.ownerId), invitee.userId);
  });

  test('an editor and a viewer cannot re-role or remove anyone', async () => {
    for (const role of ['editor', 'viewer']) {
      const { owner, invitee } = await sharedWorkspace(role);

      const patched = await send(invitee, 'PATCH', `/workspace/members/${owner.userId}`, { role: 'viewer' });
      const deleted = await send(invitee, 'DELETE', `/workspace/members/${owner.userId}`);

      for (const res of [patched, deleted]) {
        assert.equal(res.status, 403, `a ${role} should not manage memberships`);
        assert.equal(res.body.error, 'NOT_WORKSPACE_OWNER');
      }
      assert.equal(await storedRole(owner.workspaceId, owner.userId), 'owner');
    }
  });

  test('a role that is not one, and a user who is not a member, are refused', async () => {
    const { owner, invitee } = await sharedWorkspace('editor');
    const stranger = await register('stranger');

    const badRole = await send(owner, 'PATCH', `/workspace/members/${invitee.userId}`, { role: 'admin' });
    assert.equal(badRole.status, 400);
    assert.equal(badRole.body.error, 'INVALID_ROLE');

    for (const res of [
      await send(owner, 'PATCH', `/workspace/members/${stranger.userId}`, { role: 'viewer' }),
      await send(owner, 'DELETE', `/workspace/members/${stranger.userId}`),
    ]) {
      assert.equal(res.status, 404, 'a user who is not a member of this workspace is not here to manage');
    }
    assert.equal(await storedRole(owner.workspaceId, invitee.userId), 'editor');
    assert.equal(await storedRole(stranger.workspaceId, stranger.userId), 'owner', "the stranger's own workspace is untouched");
  });
});

describe('GET /workspace/members', () => {
  test('every member sees who is here, and as what', async () => {
    const { owner, invitee } = await sharedWorkspace('viewer');

    for (const who of [owner, invitee]) {
      const res = await send(who, 'GET', '/workspace/members');
      assert.equal(res.status, 200, `GET /workspace/members as ${who.label} answered ${res.status}`);
      assert.deepEqual(
        res.body.map(m => [m.email, m.role, m.isOwner]).sort(),
        [[owner.email, 'owner', true], [invitee.email, 'viewer', false]].sort(),
        'the member list is role-blind: working together means knowing who you are working with',
      );
    }
  });
});

describe('a removed member loses access on their next request', () => {
  test('the workspace they were in stops resolving, and its content is 404 to them', async () => {
    const { owner, invitee } = await sharedWorkspace('editor');
    const created = await send(invitee, 'POST', '/entities', {
      title: 'Written before the removal',
      category: 'Characters',
      summary: 'Stays with the workspace, not with its writer.',
    });
    assert.equal(created.status, 201);
    const entityId = String(created.body._id);

    const removed = await send(owner, 'DELETE', `/workspace/members/${invitee.userId}`);
    assert.equal(removed.status, 204);

    // No session was cleared and no cookie was touched: resolveWorkspace
    // re-reads the membership list on every request, so the selection this
    // session holds simply stops resolving and falls back to their own
    // workspace rather than locking them out of it.
    const resolved = await send(invitee, 'GET', '/workspace');
    assert.equal(resolved.status, 200);
    assert.equal(String(resolved.body._id), invitee.workspaceId, 'a removed member must land back in their own workspace');

    assert.equal((await send(invitee, 'GET', `/entities/${entityId}`)).status, 404,
      'the content of a workspace they are no longer in must not be readable');
    const list = await send(invitee, 'GET', '/entities');
    assert.ok(
      !(list.body.entities ?? list.body).some(e => String(e._id) === entityId),
      'the removed member still listed the other workspace',
    );
    assert.deepEqual((await send(invitee, 'GET', '/workspaces')).body.map(w => String(w._id)), [invitee.workspaceId]);

    // The entity itself stays: it belongs to the workspace.
    assert.equal(await Entity.countDocuments({ _id: entityId, workspaceId: owner.workspaceId }), 1);
    assert.equal((await send(owner, 'GET', `/entities/${entityId}`)).status, 200);
  });
});

describe('account deletion meets a shared workspace', () => {
  test('refuses while the account is a member of a workspace it does not solely own, and allows it once removed', async () => {
    const { owner, invitee } = await sharedWorkspace('editor');

    const refused = await send(invitee, 'DELETE', '/auth/account', { email: invitee.email, password: PASSWORD });

    assert.equal(refused.status, 409, 'the refusal lib/accountDeleter.js has always carried is reachable for the first time');
    assert.deepEqual(refused.body.memberships, [{
      workspaceId: owner.workspaceId,
      name: "owner's workspace",
      role: 'editor',
    }]);
    assert.ok(await User.exists({ _id: invitee.userId }), 'a refusal must delete nothing');
    assert.equal((await send(invitee, 'GET', '/auth/me')).status, 200, 'a refusal must leave the caller signed in');

    assert.equal((await send(owner, 'DELETE', `/workspace/members/${invitee.userId}`)).status, 204);

    const deleted = await send(invitee, 'DELETE', '/auth/account', { email: invitee.email, password: PASSWORD });
    assert.equal(deleted.status, 204, `deletion after removal answered ${deleted.status} ${JSON.stringify(deleted.body)}`);
    assert.equal(await User.exists({ _id: invitee.userId }), null);
    assert.ok(await Workspace.exists({ _id: owner.workspaceId }), "the shared workspace survives its editor's deletion");
  });

  test("a demoted owner's account can still be deleted: ownerId moved with the role", async () => {
    const { owner, invitee } = await sharedWorkspace('owner');
    // The founder steps down and is removed, which leaves ownerId pointing at
    // someone who is not a member — unless the route moves it.
    assert.equal((await send(invitee, 'DELETE', `/workspace/members/${owner.userId}`)).status, 204);

    const res = await send(owner, 'DELETE', '/auth/account', { email: owner.email, password: PASSWORD });

    assert.equal(res.status, 204, `the founder could not delete their account: ${res.status} ${JSON.stringify(res.body)}`);
    assert.ok(await Workspace.exists({ _id: owner.workspaceId }), 'the workspace stays with its remaining owner');
    assert.equal(String((await storedMembers(owner.workspaceId)).ownerId), invitee.userId);
  });

  test('a pending invite addressed to a deleted account goes with it', async () => {
    const owner = await register('owner');
    const invitee = await register('invitee');
    await invited(owner, invitee, 'editor');
    assert.equal(await WorkspaceInvite.countDocuments({ email: invitee.email }), 1);

    const res = await send(invitee, 'DELETE', '/auth/account', { email: invitee.email, password: PASSWORD });

    assert.equal(res.status, 204, 'a pending invite is not a membership, so it must not block a deletion');
    assert.equal(await WorkspaceInvite.countDocuments({ email: invitee.email }), 0,
      'an invite left behind would be offered to whoever next registers that address');
  });
});
