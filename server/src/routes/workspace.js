import { Router } from 'express';
import Workspace from '../models/Workspace.js';
import { objectIdParam } from '../middleware/objectId.js';
import { hasTemplate } from '../config/templates.js';
import { createWorkspace } from '../lib/workspaceSeeder.js';
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

export default router;
