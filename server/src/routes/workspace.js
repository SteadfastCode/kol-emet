import { Router } from 'express';
import Workspace from '../models/Workspace.js';
import WorkspaceInvite from '../models/WorkspaceInvite.js';
import User from '../models/User.js';
import { objectIdParam } from '../middleware/objectId.js';
import { hasTemplate } from '../config/templates.js';
import { createWorkspace } from '../lib/workspaceSeeder.js';
import {
  WORKSPACE_NAME_MAX,
  defaultWorkspace,
  isRole,
  memberEmail,
  membershipOf,
  requireWorkspaceRole,
  resolveUserId,
  workspaceLog as log,
  workspaceName,
  workspacesForUser,
} from '../middleware/workspace.js';

/**
 * The workspace itself as a resource (KOL-071).
 *
 * Registration has always created a workspace named "My Workspace" and nothing
 * ever read it back: no route returned or changed the name and no component
 * showed one, so every tenant's workspace was anonymous and indistinguishable
 * from every other. For a product whose next commercial step is collaborator
 * invites, that is a gap in the shape of the product.
 *
 *   - **`GET /workspace`** answers `{ _id, name, role, createdAt }` for the
 *     caller's own workspace. `role` is the caller's own membership role, read
 *     by `resolveWorkspace` from the `members` array and never from a request,
 *     so the client can hide what an editor or a viewer may not do.
 *   - **`PATCH /workspace`** sets `name` — trimmed, 1–80 characters — and only
 *     for an owner. The role check is `requireWorkspaceRole('owner')` from
 *     middleware/workspace.js rather than an `if` in here, because invites,
 *     member removal and billing will each need exactly it.
 *
 * Scope comes from the mount, as everywhere else: `requireAuth` +
 * `resolveWorkspace` in app.js, so the workspace read or renamed is the
 * caller's own and there is no parameter with which to name another. Only
 * `name` is ever read from a body, so a forged `_id`, `members`, `ownerId` or
 * `aiBudget` there is ignored.
 *
 * Logging is `WORKSPACE_LOG_LEVEL` — see middleware/workspace.js. A rename is
 * the one write here, and afterwards the old name is gone, so the light tier
 * records both names and who asked.
 *
 * ─── Which workspace, as a resource (KOL-090) ────────────────────────────────
 * `workspacesRouter` below is the second half, mounted at `/workspaces` rather
 * than `/workspace` because it is about the *set*:
 *
 *   - **`GET /workspaces`** — every workspace the caller is a member of, in the
 *     same body shape, oldest first. Without it a client cannot show the choice,
 *     let alone change it.
 *   - **`POST /workspaces/:id/select`** — makes one of them the workspace this
 *     session acts in, by writing `req.session.workspaceId`.
 *   - **`POST /workspaces`** (KOL-123) — a second workspace, seeded from a
 *     template or left empty. Until it existed, `POST /auth/register` was the
 *     only thing in the product that had ever created one, so the list and the
 *     choice above were a switcher with nothing to switch between.
 *
 * It deliberately does *not* sit behind `resolveWorkspace`: a membership list is
 * not content inside one workspace, the choice must not be gated on the role the
 * caller happens to hold in the workspace they are leaving, and a create is not
 * something the caller does *inside* a workspace at all — they are not acting in
 * the new one yet, and will not be until they select it.
 */

const router = Router();

/** The response shape, from a workspace document plus the caller's own role. */
const workspaceBody = (doc, role) => ({
  _id: doc._id,
  name: doc.name,
  role,
  createdAt: doc.createdAt,
});

/** How a refused name is described in a log line, without printing a whole object. */
const describeName = (value) =>
  typeof value === 'string' ? `a ${[...value].length}-character string` : `a ${value === null ? 'null' : typeof value}`;

// GET /workspace — the caller's workspace, and their role in it.
router.get('/', async (req, res, next) => {
  try {
    const workspace = await Workspace.findById(req.workspaceId)
      .select('_id name createdAt')
      .lean();

    // resolveWorkspace found it a moment ago, so this is a workspace deleted
    // mid-request rather than someone else's id — there is no id to pass here.
    if (!workspace) return res.status(404).json({ error: 'Not found' });

    log('normal', `read workspace ${workspace._id} "${workspace.name}" as ${req.workspaceRole} (source: GET /workspace by user ${req.actingUserId})`);
    res.json(workspaceBody(workspace, req.workspaceRole));
  } catch (err) {
    log('light', `failed to read workspace ${req.workspaceId} (source: GET /workspace by user ${req.actingUserId}): ${err.message}`);
    next(err);
  }
});

// PATCH /workspace — rename it. Owners only.
router.patch('/', requireWorkspaceRole('owner'), async (req, res, next) => {
  const name = workspaceName(req.body?.name);
  if (!name) {
    log('light', `refused rename of workspace ${req.workspaceId} (source: PATCH /workspace by user ${req.actingUserId}, role ${req.workspaceRole}): ${describeName(req.body?.name)} is not a name of 1–${WORKSPACE_NAME_MAX} characters`);
    return res.status(400).json({ error: 'INVALID_WORKSPACE_NAME' });
  }

  try {
    // `new: false`, so the document that comes back is the one *before* the
    // write: one round trip that both renames and yields the old name the log
    // line below needs. The new name is `name`, already in hand.
    const before = await Workspace.findByIdAndUpdate(
      req.workspaceId,
      { name },
      { new: false, runValidators: true },
    ).select('_id name createdAt').lean();

    if (!before) return res.status(404).json({ error: 'Not found' });

    log('light', `renamed workspace ${before._id} from "${before.name}" to "${name}" (source: PATCH /workspace by user ${req.actingUserId}, role ${req.workspaceRole})`);
    res.json(workspaceBody({ ...before, name }, req.workspaceRole));
  } catch (err) {
    log('light', `failed to rename workspace ${req.workspaceId} to "${name}" (source: PATCH /workspace by user ${req.actingUserId}): ${err.message}`);
    next(err);
  }
});

/* ─── Collaborators (KOL-124) ───────────────────────────────────────────────
 *
 * The routes that can finally produce a member who is not the owner. Roles
 * have been in the schema since KOL-071 and gated on since KOL-103, but
 * registration wrote the single owner and nothing added, re-roled or removed a
 * membership — so `editor` and `viewer` were unreachable outside the tests.
 *
 * **An invite names an email address and delivers nothing** (see
 * models/WorkspaceInvite.js for why, and what follows from it).
 *
 *   - `POST   /workspace/invites`             — owner: invite an address
 *   - `GET    /workspace/invites`             — any member: who is pending
 *   - `DELETE /workspace/invites/:inviteId`   — owner: withdraw one
 *   - `GET    /workspace/members`             — any member: who is here
 *   - `PATCH  /workspace/members/:userId`     — owner: change a role
 *   - `DELETE /workspace/members/:userId`     — owner: remove a membership
 *
 * The two reads are **role-blind on purpose**: knowing who else is in a
 * workspace, and who has been asked to join it, is part of working in one, and
 * every read on a content route is already open to a viewer (KOL-103). Every
 * *write* here is `requireWorkspaceRole('owner')` — on the route rather than at
 * the mount, because the two reads beside them must stay open.
 *
 * **The workspace always keeps one owner.** The last owner cannot be demoted or
 * removed (409 `LAST_OWNER`) — the mirror of KOL-025's "an account keeps one
 * way in": a workspace with no owner could never be renamed, invited into or
 * deleted again, by anyone. `Workspace.ownerId` is kept pointing at a member
 * who holds the role: when the holder is demoted or removed it moves to another
 * owner, so `lib/accountDeleter.js` — which reads `ownerId` to decide whether a
 * workspace is solely owned — cannot be left refusing to delete the account of
 * someone who is no longer a member at all.
 *
 * An invite to someone who is already a member is 409 `ALREADY_A_MEMBER`;
 * re-inviting an address that is already pending updates that invite's role
 * rather than leaving two rows that disagree.
 */

// A malformed id is 400 INVALID_ID before the route runs, as on every other
// router that takes one (middleware/objectId.js). A *well-formed* id that is
// not an invite of this workspace, or not a member of it, stays 404 below.
router.param('inviteId', objectIdParam('inviteId'));
router.param('userId', objectIdParam('userId'));

/** The response shape for an invite as the *workspace* sees it. */
const inviteBody = (doc) => ({
  _id: doc._id,
  email: doc.email,
  role: doc.role,
  invitedBy: doc.invitedBy,
  createdAt: doc.createdAt,
});

/** The members array of the resolved workspace, or null if it is gone. */
async function membersOf(workspaceId) {
  const workspace = await Workspace.findById(workspaceId).select('_id name ownerId members createdAt').lean();
  return workspace ?? null;
}

/** Those members holding `owner` — what the last-owner guard counts. */
const ownersOf = (workspace) => (workspace.members ?? []).filter(m => m.role === 'owner');

/**
 * Keeps `Workspace.ownerId` naming a member who holds the owner role.
 *
 * `ownerId` is a separate field from the `members` array, and it is what
 * account deletion judges sole ownership by. Left alone, demoting or removing
 * the user it names would leave it pointing at a non-owner — or at someone who
 * is not a member at all, whose own account could then never be deleted
 * (lib/accountDeleter.js would see a workspace they "own" but do not solely
 * own, and refuse). So it moves to another owner.
 *
 * `members` is the array *after* the change. Returns the id it should hold, or
 * the current one when that is still an owner.
 */
function ownerIdAfter(workspace, members) {
  const stillAnOwner = members.some(m => m.role === 'owner' && String(m.userId) === String(workspace.ownerId));
  if (stillAnOwner) return null;
  const next = members.find(m => m.role === 'owner');
  return next ? next.userId : null;
}

// POST /workspace/invites — invite an address to this workspace. Owners only.
router.post('/invites', requireWorkspaceRole('owner'), async (req, res, next) => {
  const email = memberEmail(req.body?.email);
  const role = req.body?.role === undefined ? 'editor' : req.body.role;

  if (!email) {
    log('light', `refused POST /workspace/invites in workspace ${req.workspaceId} and wrote nothing (source: user ${req.actingUserId}, role ${req.workspaceRole}): email is ${typeof req.body?.email === 'string' ? 'blank' : `a ${req.body?.email === null ? 'null' : typeof req.body?.email}`}, not an address`);
    return res.status(400).json({ error: 'INVALID_EMAIL' });
  }
  if (!isRole(role)) {
    log('light', `refused POST /workspace/invites in workspace ${req.workspaceId} and wrote nothing (source: user ${req.actingUserId}): role ${JSON.stringify(role)} is not owner, editor or viewer`);
    return res.status(400).json({ error: 'INVALID_ROLE' });
  }

  try {
    const workspace = await membersOf(req.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Not found' });

    // Already a member? The one thing an invite form *does* reveal about an
    // address, and only to someone who can read the member list anyway.
    const member = await User.findOne({ email }).select('_id').lean();
    if (member && membershipOf(workspace, member._id)) {
      log('light', `refused POST /workspace/invites in workspace ${req.workspaceId} with 409 and wrote nothing (source: user ${req.actingUserId}): that address is already a ${membershipOf(workspace, member._id).role} here`);
      return res.status(409).json({ error: 'ALREADY_A_MEMBER' });
    }

    // Upsert on (workspaceId, email), the pair the unique index covers: a
    // second invite to the same address is the same invitation with a possibly
    // different role, not a second row. `invitedBy` moves with it, so the
    // invitee is told who asked most recently.
    const before = await WorkspaceInvite.findOneAndUpdate(
      { workspaceId: req.workspaceId, email },
      { $set: { role, invitedBy: req.actingUserId } },
      { new: false, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean();

    const invite = await WorkspaceInvite.findOne({ workspaceId: req.workspaceId, email }).lean();
    // Nothing here says whether that address has an account: the body is the
    // same either way, which is what keeps the form from being a way to ask
    // who has registered.
    log('light', `${before ? `re-invited ${email} to workspace ${req.workspaceId} as ${role}, replacing the pending ${before.role} invite` : `invited ${email} to workspace ${req.workspaceId} as ${role}`}; no mail was sent and no link was minted (source: POST /workspace/invites by user ${req.actingUserId}, role ${req.workspaceRole})`);
    res.status(before ? 200 : 201).json(inviteBody(invite));
  } catch (err) {
    log('light', `failed to invite ${email} to workspace ${req.workspaceId} (source: POST /workspace/invites by user ${req.actingUserId}): ${err.message}`);
    next(err);
  }
});

// GET /workspace/invites — the addresses waiting on this workspace. Any member.
router.get('/invites', async (req, res, next) => {
  try {
    const invites = await WorkspaceInvite.find({ workspaceId: req.workspaceId })
      .sort({ createdAt: 1, _id: 1 })
      .lean();

    log('normal', `listed ${invites.length} pending invite(s) in workspace ${req.workspaceId} (source: GET /workspace/invites by user ${req.actingUserId}, role ${req.workspaceRole})`);
    res.json(invites.map(inviteBody));
  } catch (err) {
    next(err);
  }
});

// DELETE /workspace/invites/:inviteId — withdraw one. Owners only.
router.delete('/invites/:inviteId', requireWorkspaceRole('owner'), async (req, res, next) => {
  try {
    // Scoped to the resolved workspace, so an invite id from another tenant is
    // a 404 and this cannot be used to withdraw someone else's invitation.
    const invite = await WorkspaceInvite.findOneAndDelete({
      _id: req.params.inviteId,
      workspaceId: req.workspaceId,
    }).lean();

    if (!invite) {
      log('light', `withdrew nothing for invite ${req.params.inviteId}: no such invite in workspace ${req.workspaceId} (source: DELETE /workspace/invites/:inviteId by user ${req.actingUserId})`);
      return res.status(404).json({ error: 'Not found' });
    }

    log('light', `withdrew the ${invite.role} invite for ${invite.email} in workspace ${req.workspaceId} (source: DELETE /workspace/invites/:inviteId by user ${req.actingUserId}, role ${req.workspaceRole})`);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// GET /workspace/members — who is in this workspace, and as what. Any member.
router.get('/members', async (req, res, next) => {
  try {
    const workspace = await membersOf(req.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Not found' });

    // One query for every member's address, rather than one per member.
    const users = await User.find({ _id: { $in: workspace.members.map(m => m.userId) } })
      .select('_id email').lean();
    const emailOf = new Map(users.map(u => [String(u._id), u.email]));

    const body = workspace.members.map(m => ({
      userId: m.userId,
      // Null for a member whose account is gone — a row the product should not
      // be able to produce, reported rather than hidden.
      email: emailOf.get(String(m.userId)) ?? null,
      role: m.role ?? null,
      isOwner: String(m.userId) === String(workspace.ownerId),
    }));

    log('normal', `listed ${body.length} member(s) of workspace ${req.workspaceId} (source: GET /workspace/members by user ${req.actingUserId}, role ${req.workspaceRole})`);
    log('verbose', JSON.stringify(body));
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// PATCH /workspace/members/:userId — change a member's role. Owners only.
router.patch('/members/:userId', requireWorkspaceRole('owner'), async (req, res, next) => {
  const role = req.body?.role;
  if (!isRole(role)) {
    log('light', `refused PATCH /workspace/members/${req.params.userId} in workspace ${req.workspaceId} and wrote nothing (source: user ${req.actingUserId}): role ${JSON.stringify(role)} is not owner, editor or viewer`);
    return res.status(400).json({ error: 'INVALID_ROLE' });
  }

  try {
    const workspace = await membersOf(req.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Not found' });

    const member = membershipOf(workspace, req.params.userId);
    if (!member) {
      log('light', `refused PATCH /workspace/members/${req.params.userId} with 404 and wrote nothing: not a member of workspace ${req.workspaceId} (source: user ${req.actingUserId})`);
      return res.status(404).json({ error: 'Not found' });
    }

    if (member.role === role) {
      log('normal', `PATCH /workspace/members/${req.params.userId} changed nothing: already ${role} in workspace ${req.workspaceId} (source: user ${req.actingUserId})`);
      return res.json({ userId: member.userId, role });
    }

    // The floor: a workspace keeps at least one owner, or nobody could ever
    // rename it, invite into it or manage it again.
    if (member.role === 'owner' && ownersOf(workspace).length <= 1) {
      log('light', `refused PATCH /workspace/members/${req.params.userId} with 409 LAST_OWNER and wrote nothing: workspace ${req.workspaceId} has one owner, and demoting them to ${role} would leave it with none (source: user ${req.actingUserId})`);
      return res.status(409).json({ error: 'LAST_OWNER' });
    }

    const after = workspace.members.map(m => (
      String(m.userId) === String(req.params.userId) ? { ...m, role } : m
    ));
    const nextOwnerId = ownerIdAfter(workspace, after);

    await Workspace.updateOne(
      { _id: req.workspaceId, 'members.userId': req.params.userId },
      {
        $set: {
          'members.$.role': role,
          ...(nextOwnerId && { ownerId: nextOwnerId }),
        },
      },
    );

    log('light', `member ${req.params.userId} of workspace ${req.workspaceId} is now ${role}, was ${member.role}${nextOwnerId ? `; ownerId moved to ${nextOwnerId}, the demoted owner no longer holds the role` : ''} (source: PATCH /workspace/members/:userId by user ${req.actingUserId}, role ${req.workspaceRole})`);
    res.json({ userId: member.userId, role });
  } catch (err) {
    log('light', `failed to re-role member ${req.params.userId} of workspace ${req.workspaceId} (source: PATCH /workspace/members/:userId by user ${req.actingUserId}): ${err.message}`);
    next(err);
  }
});

// DELETE /workspace/members/:userId — remove a membership. Owners only.
router.delete('/members/:userId', requireWorkspaceRole('owner'), async (req, res, next) => {
  try {
    const workspace = await membersOf(req.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Not found' });

    const member = membershipOf(workspace, req.params.userId);
    if (!member) {
      log('light', `refused DELETE /workspace/members/${req.params.userId} with 404 and wrote nothing: not a member of workspace ${req.workspaceId} (source: user ${req.actingUserId})`);
      return res.status(404).json({ error: 'Not found' });
    }

    if (member.role === 'owner' && ownersOf(workspace).length <= 1) {
      log('light', `refused DELETE /workspace/members/${req.params.userId} with 409 LAST_OWNER and wrote nothing: workspace ${req.workspaceId} has one owner (source: user ${req.actingUserId})`);
      return res.status(409).json({ error: 'LAST_OWNER' });
    }

    const after = workspace.members.filter(m => String(m.userId) !== String(req.params.userId));
    const nextOwnerId = ownerIdAfter(workspace, after);

    await Workspace.updateOne(
      { _id: req.workspaceId },
      {
        $pull: { members: { userId: req.params.userId } },
        ...(nextOwnerId && { $set: { ownerId: nextOwnerId } }),
      },
    );

    // Nothing is cleared from the removed member's session: resolveWorkspace
    // re-reads the membership list on every request, so a selection of this
    // workspace stops resolving on their very next one and falls back to a
    // workspace they are still in (middleware/workspace.js). Their content
    // stays — it belongs to the workspace, not to them.
    log('light', `removed member ${req.params.userId} (${member.role}) from workspace ${req.workspaceId}${nextOwnerId ? `; ownerId moved to ${nextOwnerId}` : ''}; their next request resolves elsewhere (source: DELETE /workspace/members/:userId by user ${req.actingUserId}, role ${req.workspaceRole})`);
    res.status(204).end();
  } catch (err) {
    log('light', `failed to remove member ${req.params.userId} from workspace ${req.workspaceId} (source: DELETE /workspace/members/:userId by user ${req.actingUserId}): ${err.message}`);
    next(err);
  }
});

/**
 * `/workspaces` — the set, and the choice. See the file comment above.
 *
 * Its own router rather than routes on the one above, because the two want
 * different mounts: `/workspace` carries `resolveWorkspace` (the workspace it
 * reads and renames is the resolved one) and this must not, or listing the
 * memberships of a user who has none would 403 instead of answering that they
 * have none.
 */
export const workspacesRouter = Router();

// A malformed :id is 400 INVALID_ID before the route runs, as on every other
// router that takes an id — see middleware/objectId.js. A *well-formed* id the
// caller is not a member of stays 404 below, so the API never confirms another
// tenant's workspace exists.
workspacesRouter.param('id', objectIdParam('id'));

// GET /workspaces — every workspace the caller is a member of, oldest first.
workspacesRouter.get('/', async (req, res, next) => {
  try {
    // Resolved here rather than by middleware because this route serves both
    // auth paths: a session user, and the bearer identity /mcp authorizes.
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const workspaces = await workspacesForUser(userId);
    const body = workspaces.map(w => workspaceBody(w, membershipOf(w, userId)?.role ?? null));

    const chosenId = req.session?.workspaceId ?? null;
    const acting = body.find(w => String(w._id) === String(chosenId))
      ?? defaultWorkspace(workspaces, userId).workspace;
    log('normal', `listed ${body.length} workspace(s) for user ${userId}; this session acts in ${acting?._id ?? 'none'} (source: GET /workspaces, ${chosenId ? `session selection ${chosenId}` : 'no session selection — the default'})`);
    log('verbose', JSON.stringify(body));
    res.json(body);
  } catch (err) {
    log('light', `failed to list workspaces (source: GET /workspaces): ${err.message}`);
    next(err);
  }
});

/**
 * POST /workspaces/:id/select — make this the workspace the session acts in.
 *
 * Session only. The choice *is* session state (see resolveWorkspace), and a
 * bearer connector carries no session to hold one in — it takes the same
 * default instead, in lib/mcpWorkspace.js — so a bearer caller here is 401
 * rather than a selection written into a session nobody will send back.
 *
 * 404, not 403, for an id the caller is not a member of: the same rule the
 * content routes follow, so this route cannot be used to discover that another
 * tenant's workspace exists. It writes nothing in that case.
 *
 * The session is saved before the response, so the very next request — which a
 * client will send the moment it sees this answer — resolves the new workspace
 * rather than racing the store write.
 */
workspacesRouter.post('/:id/select', async (req, res, next) => {
  const userId = req.session?.userId;
  if (!userId) {
    log('light', `refused POST /workspaces/${req.params.id}/select with 401 (source: a caller with no login session; a selection is session state, and a bearer connector takes the default instead)`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // The membership is the authorization: one query that both finds the
    // workspace and proves the caller is in it.
    const workspace = await Workspace.findOne({ _id: req.params.id, 'members.userId': userId })
      .select('_id name members createdAt')
      .lean();

    if (!workspace) {
      log('light', `refused selection of workspace ${req.params.id} with 404 and wrote nothing (source: POST /workspaces/:id/select by user ${userId}, which is not a membership of theirs)`);
      return res.status(404).json({ error: 'Not found' });
    }

    const role = membershipOf(workspace, userId)?.role ?? null;
    const previous = req.session.workspaceId ?? null;
    req.session.workspaceId = String(workspace._id);
    await new Promise((resolve, reject) => {
      req.session.save(err => (err ? reject(err) : resolve()));
    });

    log('light', `session ${req.sessionID} now acts in workspace ${workspace._id} "${workspace.name}" as ${role ?? 'no role'}, replacing ${previous ?? 'the default (no previous selection)'} (source: POST /workspaces/:id/select by user ${userId})`);
    res.json(workspaceBody(workspace, role));
  } catch (err) {
    log('light', `failed to select workspace ${req.params.id} (source: POST /workspaces/:id/select by user ${userId}): ${err.message}`);
    next(err);
  }
});

/**
 * The ceiling on how many workspaces one account may **own**, overridable per
 * deployment with `WORKSPACE_MAX_PER_OWNER`.
 *
 * `POST /workspaces` is an authenticated create loop on an open-registration
 * product, and each create writes a `Workspace` plus a whole template seed —
 * 38 relationship types and starter content (lib/workspaceSeeder.js). The
 * signup ceiling is the precedent (KOL-050, KOL-081): a refusal with its own
 * error code is far cheaper to run than a quota somebody has to administer,
 * and this is a number, not a policy.
 *
 * Owned rather than joined, because a membership can arrive unasked once
 * invites land (KOL-124) and being invited into other people's workspaces must
 * not be able to use up a user's own allowance. Read per call rather than at
 * module load, like every log level here, so a test can set it.
 */
export const WORKSPACE_MAX_PER_OWNER = 10;

function ownedLimit() {
  const configured = Number(process.env.WORKSPACE_MAX_PER_OWNER);
  return Number.isInteger(configured) && configured > 0 ? configured : WORKSPACE_MAX_PER_OWNER;
}

/** How many workspaces `userId` is an `owner` of — the thing the cap counts. */
function countOwned(userId) {
  // $elemMatch, not two dotted paths: `{'members.userId': u, 'members.role':
  // 'owner'}` matches a document where *some* member is this user and *some*
  // member is an owner, which is any workspace they are a viewer in.
  return Workspace.countDocuments({ members: { $elemMatch: { userId, role: 'owner' } } });
}

/**
 * POST /workspaces — a second workspace, seeded from a template or left empty.
 *
 * Session only, like `/:id/select` above and for the same reason: the bearer
 * identity `requireAuth` also admits is one shared secret mapped to a single
 * wiki user (lib/mcpUserStore.js), so a workspace created through it would be
 * owned by that user rather than by whoever is talking to the connector — and
 * with no session to hold a selection in, nothing could ever act in it.
 *
 * What it reads from the body is `name` and `template`, and nothing else: a
 * forged `members`, `ownerId`, `aiBudget` or `_id` is ignored, as on
 * `PATCH /workspace`.
 *
 *   - **`name`** goes through `workspaceName()`, the one rule `PATCH /workspace`
 *     and registration's optional `workspaceName` already share, so the three
 *     cannot drift apart: trimmed, 1–`WORKSPACE_NAME_MAX` code points, and
 *     anything else is 400 `INVALID_WORKSPACE_NAME`. Deliberately **not**
 *     unique: two workspaces of one name are a user's business, and a uniqueness
 *     rule would be a second thing to explain in a refusal.
 *   - **`template`** names what it is seeded with. Absent is the default, the
 *     same as registration; a key that names no template is refused in
 *     registration's words (`Unknown template`, KOL-031) rather than quietly
 *     seeding the default into a workspace nobody asked for that; and **`null`
 *     seeds nothing**, which is the shape registration has no use for — an
 *     empty workspace is where `POST /import` can land, since it refuses a
 *     non-empty one (409 `WORKSPACE_NOT_EMPTY`) and the one workspace an
 *     account used to have was seeded at signup.
 *   - **The creator is its `owner`** — the role, in `members`, which is what
 *     every gate judges, not merely `ownerId`.
 *
 * **It does not select the new workspace.** The client calls
 * `POST /workspaces/:id/select` afterwards, so that route stays the only writer
 * of `req.session.workspaceId` — a create that also selected would be a second
 * writer of the one piece of state KOL-090 exists to make unambiguous, and the
 * tab that asked for it has to reload either way.
 *
 * **201**, with the new workspace in the `workspaceBody` shape every other
 * route here answers in, so a client can put it straight into the list it is
 * holding.
 */
workspacesRouter.post('/', async (req, res, next) => {
  const userId = req.session?.userId;
  if (!userId) {
    log('light', `refused POST /workspaces with 401 (source: a caller with no login session; a workspace is created for a person, and the bearer identity is one shared secret mapped to a single user)`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const name = workspaceName(req.body?.name);
  if (!name) {
    log('light', `refused POST /workspaces for user ${userId} and wrote nothing: ${describeName(req.body?.name)} is not a name of 1–${WORKSPACE_NAME_MAX} characters`);
    return res.status(400).json({ error: 'INVALID_WORKSPACE_NAME' });
  }

  // `null` is the one non-string this accepts, and it means "seed nothing".
  const { template } = req.body ?? {};
  if (template !== undefined && template !== null && !hasTemplate(template)) {
    log('light', `refused POST /workspaces for user ${userId} and wrote nothing: template ${String(JSON.stringify(template)).slice(0, 80)} names no template`);
    return res.status(400).json({ error: 'Unknown template' });
  }

  try {
    // Before the writes, so a refused create costs no seed — the expensive half.
    //
    // Honest limit: this is a count read before the write rather than a
    // reservation taken atomically with it, so N creates that arrive together
    // can all read the same count and pass. Unlike the signup window KOL-081
    // closed, the overshoot here is one-shot and bounded by the caller's own
    // concurrency: every later request sees the higher count and is refused,
    // so an account cannot mint another burst per window. Closing it properly
    // needs either a transaction (the deployment is a single mongod — see
    // routes/import.js) or an owned-count field on `User` kept in step with
    // reality by every create, delete and future membership change, which is a
    // second source of truth for a number the workspaces themselves already
    // state.
    const limit = ownedLimit();
    const owned = await countOwned(userId);
    if (owned >= limit) {
      log('light', `refused POST /workspaces for user ${userId} with 409 and wrote nothing: they already own ${owned} workspace(s), at the cap of ${limit} (source: WORKSPACE_MAX_PER_OWNER)`);
      return res.status(409).json({ error: 'WORKSPACE_LIMIT_REACHED', limit });
    }

    const { workspace, templateKey, seed } = await createWorkspace({
      name,
      ownerId: userId,
      template,
      source: `POST /workspaces by user ${userId}`,
    });

    log('light', `user ${userId} owns ${owned + 1} of ${limit} workspace(s) after creating ${workspace._id} "${workspace.name}" from ${templateKey ? `template "${templateKey}"` : 'no template (empty)'}${seed.ok ? '' : ' — seeding failed, the workspace is usable but bare'}; this session still acts in ${req.session.workspaceId ?? 'the default'}, since only POST /workspaces/:id/select changes that (source: POST /workspaces)`);
    log('verbose', `seed counts: ${JSON.stringify(seed.counts ?? {})}`);
    res.status(201).json(workspaceBody(workspace, 'owner'));
  } catch (err) {
    log('light', `failed to create workspace "${name}" for user ${userId} (source: POST /workspaces): ${err.message}`);
    next(err);
  }
});

/**
 * `/invites` — the invitee's side (KOL-124).
 *
 * Its own router, mounted at `/invites` with `requireAuth` and **no**
 * `resolveWorkspace`, for the reason `/workspaces` is mounted that way: an
 * invitation is not content inside the workspace the caller is acting in — it
 * is about one they are *not yet a member of*, so there is no role in it to
 * gate on and nothing to scope to.
 *
 *   - `GET  /invites`             — the caller's own pending invites
 *   - `POST /invites/:id/accept`  — writes the membership, drops the invite
 *   - `POST /invites/:id/decline` — drops the invite
 *
 * **An invite is matched to the caller by the address their account is keyed
 * by**, lowercased on both sides (`User.email`'s schema and
 * models/WorkspaceInvite.js), so there is no token to hold and no id to guess:
 * an invite addressed to someone else is a **404** on both verbs — never a 403,
 * which would confirm it exists — and nothing is written.
 *
 * `GET` resolves the caller through `resolveUserId`, like `GET /workspaces`, so
 * the bearer identity can read. The two writes are **session only**: accepting
 * an invitation is a person's decision about their own account, and the bearer
 * identity is one shared secret mapped to a single wiki user
 * (lib/mcpUserStore.js) — a connector accepting on that user's behalf would
 * join a workspace nobody asked to join.
 *
 * Accept does **not** select the new workspace: `POST /workspaces/:id/select`
 * stays the only writer of which workspace a session acts in (KOL-090).
 */
export const invitesRouter = Router();

invitesRouter.param('id', objectIdParam('id'));

/** The caller's own email, as invites are keyed by it, or null. */
async function callerEmail(userId) {
  const user = await User.findById(userId).select('email').lean();
  return user?.email ?? null;
}

/** The response shape for an invite as its *invitee* sees it. */
const myInviteBody = (invite, workspace, inviterEmail) => ({
  _id: invite._id,
  workspaceId: invite.workspaceId,
  // The name is the only thing that makes an invitation legible, and it is
  // already being offered to this address — so it comes with the invite rather
  // than needing a read of a workspace they are not in yet.
  workspaceName: workspace?.name ?? null,
  role: invite.role,
  // Who asked. Their own address, which they disclosed by inviting.
  invitedByEmail: inviterEmail ?? null,
  createdAt: invite.createdAt,
});

// GET /invites — every workspace waiting for this account to join it.
invitesRouter.get('/', async (req, res, next) => {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const email = await callerEmail(userId);
    if (!email) return res.status(401).json({ error: 'Unauthorized' });

    const invites = await WorkspaceInvite.find({ email }).sort({ createdAt: 1, _id: 1 }).lean();
    const workspaces = await Workspace.find({ _id: { $in: invites.map(i => i.workspaceId) } })
      .select('_id name').lean();
    const inviters = await User.find({ _id: { $in: invites.map(i => i.invitedBy) } })
      .select('_id email').lean();
    const nameOf = new Map(workspaces.map(w => [String(w._id), w]));
    const emailOf = new Map(inviters.map(u => [String(u._id), u.email]));

    const body = invites.map(invite => myInviteBody(
      invite,
      nameOf.get(String(invite.workspaceId)),
      emailOf.get(String(invite.invitedBy)),
    ));

    log('normal', `listed ${body.length} invite(s) for user ${userId} (source: GET /invites, matched on their account address)`);
    log('verbose', JSON.stringify(body));
    res.json(body);
  } catch (err) {
    log('light', `failed to list invites (source: GET /invites): ${err.message}`);
    next(err);
  }
});

/**
 * The invite `:id` if it is addressed to this session's own account, else null.
 * One query, so the ownership test *is* the lookup: an id belonging to someone
 * else cannot be read, let alone acted on.
 */
async function ownInvite(req) {
  const email = await callerEmail(req.session.userId);
  if (!email) return null;
  return await WorkspaceInvite.findOne({ _id: req.params.id, email }).lean();
}

// POST /invites/:id/accept — join the workspace, as the role the invite names.
invitesRouter.post('/:id/accept', async (req, res, next) => {
  const userId = req.session?.userId;
  if (!userId) {
    log('light', `refused POST /invites/${req.params.id}/accept with 401 (source: a caller with no login session; joining a workspace is a person's decision, and the bearer identity is one shared secret)`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const invite = await ownInvite(req);
    if (!invite) {
      log('light', `refused POST /invites/${req.params.id}/accept with 404 and wrote nothing (source: user ${userId}; no invite with that id is addressed to their account)`);
      return res.status(404).json({ error: 'Not found' });
    }

    // The membership first, the invite second: a crash between the two leaves a
    // stale invite whose accept is idempotent (below), never a dropped invite
    // with no membership to show for it.
    const joined = await Workspace.findOneAndUpdate(
      { _id: invite.workspaceId, 'members.userId': { $ne: userId } },
      { $push: { members: { userId, role: invite.role } } },
      { new: true },
    ).select('_id name members createdAt').lean();

    const workspace = joined ?? await Workspace.findById(invite.workspaceId)
      .select('_id name members createdAt').lean();

    if (!workspace) {
      // The workspace was deleted while the invite waited. Drop the invite:
      // there is nothing left to join, and it would otherwise be a permanent
      // offer of a workspace that no longer exists.
      await WorkspaceInvite.deleteOne({ _id: invite._id });
      log('light', `dropped invite ${invite._id} on accept: workspace ${invite.workspaceId} no longer exists (source: POST /invites/:id/accept by user ${userId})`);
      return res.status(404).json({ error: 'Not found' });
    }

    await WorkspaceInvite.deleteOne({ _id: invite._id });

    const role = membershipOf(workspace, userId)?.role ?? null;
    log('light', `user ${userId} ${joined ? `joined workspace ${workspace._id} "${workspace.name}" as ${invite.role}` : `was already a ${role} of workspace ${workspace._id} "${workspace.name}", so the invite was dropped and no membership written`}; this session still acts where it did, since only POST /workspaces/:id/select changes that (source: POST /invites/:id/accept, invite ${invite._id} from user ${invite.invitedBy})`);
    res.json(workspaceBody(workspace, role));
  } catch (err) {
    log('light', `failed to accept invite ${req.params.id} for user ${userId} (source: POST /invites/:id/accept): ${err.message}`);
    next(err);
  }
});

// POST /invites/:id/decline — drop it. Nothing tells the inviter.
invitesRouter.post('/:id/decline', async (req, res, next) => {
  const userId = req.session?.userId;
  if (!userId) {
    log('light', `refused POST /invites/${req.params.id}/decline with 401 (source: a caller with no login session)`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const invite = await ownInvite(req);
    if (!invite) {
      log('light', `refused POST /invites/${req.params.id}/decline with 404 and wrote nothing (source: user ${userId}; no invite with that id is addressed to their account)`);
      return res.status(404).json({ error: 'Not found' });
    }

    await WorkspaceInvite.deleteOne({ _id: invite._id });
    log('light', `user ${userId} declined the ${invite.role} invite to workspace ${invite.workspaceId} from user ${invite.invitedBy}; the invite is gone and the inviter is not told (source: POST /invites/:id/decline)`);
    res.status(204).end();
  } catch (err) {
    log('light', `failed to decline invite ${req.params.id} for user ${userId} (source: POST /invites/:id/decline): ${err.message}`);
    next(err);
  }
});

export default router;
