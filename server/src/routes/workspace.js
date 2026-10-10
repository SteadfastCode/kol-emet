import { Router } from 'express';
import Workspace from '../models/Workspace.js';
import {
  WORKSPACE_NAME_MAX,
  requireWorkspaceRole,
  workspaceLog as log,
  workspaceName,
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
router.get('/', async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

// PATCH /workspace — rename it. Owners only.
router.patch('/', requireWorkspaceRole('owner'), async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

export default router;
