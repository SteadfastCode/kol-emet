import { Router } from 'express';
import Workspace from '../models/Workspace.js';
import { objectIdParam } from '../middleware/objectId.js';
import {
  WORKSPACE_NAME_MAX,
  defaultWorkspace,
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
 *
 * It deliberately does *not* sit behind `resolveWorkspace`: a membership list is
 * not content inside one workspace, and the choice must not be gated on the role
 * the caller happens to hold in the workspace they are leaving.
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

export default router;
