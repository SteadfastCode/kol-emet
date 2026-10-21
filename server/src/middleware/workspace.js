import Workspace from '../models/Workspace.js';
import { getMcpUser } from '../lib/mcpUserStore.js';

/**
 * The tenancy boundary, as middleware: who is acting, which workspace they are
 * acting in, and — since KOL-071 — what they are allowed to do there.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * WORKSPACE_LOG_LEVEL = off | light | normal | verbose (default light), shared
 * with routes/workspace.js and the workspace half of routes/auth.js.
 * A role refusal and a rename are both invisible afterwards — the refusal
 * leaves no row at all, and a rename leaves only its result — so the light
 * tier names the *source* of each: who asked, through which route, and the
 * role this middleware read for them. Since KOL-090 the same rule covers which
 * workspace a request acted in: a request answers from one of possibly several,
 * and afterwards nothing in the response says which — or why that one.
 *   off     — nothing
 *   light   — every rename (old name, new name, who asked), every refusal
 *             (the role read, the role required, the request), every selection
 *             and every fall-back from a selection that is no longer a
 *             membership
 *   normal  — light, plus each workspace resolved — naming *where the choice
 *             came from*, not just the id — and each read
 *   verbose — normal, plus the membership the role came from and every
 *             membership considered
 */

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

/** Named `workspaceLog` on import; resolved per call so a test can change it. */
export function workspaceLog(level, msg) {
  const active = LEVELS[process.env.WORKSPACE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[workspace:${level}] ${msg}`);
}

/** What `POST /auth/register` names a workspace when the request does not. */
export const DEFAULT_WORKSPACE_NAME = 'My Workspace';

/** The longest workspace name, in code points — see workspaceName(). */
export const WORKSPACE_NAME_MAX = 80;

/**
 * The one rule for a workspace name, shared by `PATCH /workspace` and the
 * optional `workspaceName` of `POST /auth/register` so the two cannot drift:
 * a string, trimmed, 1–80 characters. Anything else — an empty or
 * whitespace-only string, a number, an object, null — is not a name.
 *
 * Counted in code points rather than UTF-16 units, so a cap written as
 * "80 characters" is the same cap for a Hebrew or an emoji name as for an
 * ASCII one.
 *
 * @param {unknown} value
 * @returns {string|null} the name as it should be stored, or null if it isn't one
 */
export function workspaceName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || [...name].length > WORKSPACE_NAME_MAX) return null;
  return name;
}

/** Roles, weakest first: a gate asking for one accepts everything above it. */
export const ROLE_RANK = Object.freeze({ viewer: 1, editor: 2, owner: 3 });

/**
 * Resolves the acting user id from either auth path.
 * Session → req.session.userId. Bearer (MCP) → the associated wiki user.
 * Returns null when neither yields a user.
 */
export async function resolveUserId(req) {
  if (req.session?.userId) return req.session.userId;

  const header = req.headers['authorization'] ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token && token === process.env.BEARER_TOKEN) return await getMcpUser();

  return null;
}

/** The caller's own entry in a workspace's `members` array, or null. */
export function membershipOf(workspace, userId) {
  return (workspace?.members ?? []).find(m => String(m.userId) === String(userId)) ?? null;
}

/**
 * Every workspace `userId` is a member of, oldest first.
 *
 * Sorted on `createdAt` **then `_id`**, so the order is *total*: two
 * workspaces stamped in the same millisecond — a seed script, a test fixture,
 * an import — would otherwise come back in whatever order the storage engine
 * chose, and "oldest" would not be a fact. `_id` is unique by definition and
 * its leading bytes are a timestamp, so it breaks the tie the same way time
 * would.
 *
 * The projection is what both callers need between them: `_id` and `members`
 * for the acting workspace and the role in it, `name` and `createdAt` for
 * `GET /workspaces`. One query shape, so the list route and the middleware
 * cannot disagree about the order they see.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 */
export async function workspacesForUser(userId) {
  return await Workspace.find({ 'members.userId': userId })
    .select('_id name members createdAt')
    .sort({ createdAt: 1, _id: 1 })
    .lean();
}

/**
 * The workspace a caller acts in when they have not chosen one: **the oldest
 * they own, else the oldest they are a member of** (KOL-090).
 *
 * Ownership first because the workspace a user created for themselves is the
 * one they mean by "my wiki", and an invitation to someone else's — which, once
 * invites land, can arrive without being asked for — must not be able to become
 * the place their own writes land. Age second because it is the only ordering
 * that is stable for a user whose memberships change: a "most recently used"
 * default would make the resolved workspace a function of history nothing
 * records, which is the same unpredictability this item removes.
 *
 * "Owns" is read from the caller's own membership role, not from
 * `Workspace.ownerId`: the role is what every gate in this file judges, so a
 * default derived from it cannot disagree with `requireWorkspaceRole('owner')`
 * about who an owner is.
 *
 * @param {Array<object>} workspaces as returned by workspacesForUser (oldest first)
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @returns {{ workspace: object|null, reason: string }} the choice, and why — the
 *   light log tier names the source of a resolution, not just its id
 */
export function defaultWorkspace(workspaces, userId) {
  const owned = workspaces.find(w => membershipOf(w, userId)?.role === 'owner');
  if (owned) return { workspace: owned, reason: 'the oldest workspace this user owns' };
  const member = workspaces[0] ?? null;
  return {
    workspace: member,
    reason: member ? 'the oldest workspace this user is a member of (they own none)' : 'nothing — this user has no membership',
  };
}

/**
 * Sets req.workspaceId to the workspace the caller is acting in, plus
 * req.workspaceRole (their role in it) and req.actingUserId (who they are).
 *
 * Every scoped query must filter on it, so a missing workspace is a hard 403
 * rather than a silent fall-through to unscoped data — failing closed is the
 * whole point of this middleware.
 *
 * Mounted after requireAuth on every route that touches tenant content — see
 * app.js (chat mounts it per-route). /mcp never passes through here: its tools
 * scope themselves via mcpWorkspaceId() in routes/mcp.js, which takes the same
 * default this does.
 *
 * The role is read from the caller's own `members` entry, never from a request:
 * it is what `requireWorkspaceRole` below gates on, and what `GET /workspace`
 * hands the client so it can hide what an editor or a viewer may not do.
 *
 * ─── Which workspace, and why (KOL-090) ──────────────────────────────────────
 * This used to be `findOne({ 'members.userId': userId })` with no sort, under a
 * comment that said a user belongs to exactly one. The moment one belongs to
 * two — which collaborator invites make routine — every request resolved to
 * whichever document the server happened to return first, so one session could
 * read workspace A and then write workspace B and `GET /workspace` could report
 * a name the content did not come from.
 *
 * So the choice is explicit, and it is **session state**: `POST
 * /workspaces/:id/select` writes `req.session.workspaceId`, and this prefers it
 * over the default. Two properties matter more than the preference itself:
 *
 *   - **The membership is re-checked on every request**, against the caller's
 *     live membership list, so a selection is never a standing capability. A
 *     session holding an id is not authority to act in it.
 *   - **A stale selection falls back, it does not refuse.** When the membership
 *     behind the id is gone — revoked, or the workspace deleted — answering 403
 *     would lock a user out of *their own* workspace over access they lost to
 *     someone else's. The id is left in the session rather than cleared: this
 *     middleware runs on `/events` too, whose response ends only when the
 *     stream does, and a session written there would be saved minutes later on
 *     top of whatever was chosen since. `POST /workspaces/:id/select` is the
 *     one writer.
 */
export async function resolveWorkspace(req, res, next) {
  try {
    const userId = await resolveUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Every membership, oldest first: the acting workspace is chosen from this
    // list rather than by a findOne whose answer was the storage engine's to pick.
    const workspaces = await workspacesForUser(userId);
    workspaceLog('verbose', `user ${userId} is a member of ${workspaces.length} workspace(s): ${workspaces.map(w => `${w._id} "${w.name}" as ${membershipOf(w, userId)?.role ?? 'no role'}`).join(', ') || '(none)'}`);

    const chosenId = req.session?.workspaceId ?? null;
    const chosen = chosenId ? workspaces.find(w => String(w._id) === String(chosenId)) ?? null : null;

    let workspace = chosen;
    let source = 'the session selection (POST /workspaces/:id/select)';
    if (!chosen) {
      const fallback = defaultWorkspace(workspaces, userId);
      workspace = fallback.workspace;
      source = `the default — ${fallback.reason}`;
      if (chosenId) {
        // Light tier: the request acts somewhere other than where this session
        // asked to, and nothing in the response says so.
        workspaceLog('light', `session selection of workspace ${chosenId} is no longer a membership of user ${userId}; falling back to ${workspace?._id ?? 'no workspace'} rather than refusing, so losing access to one workspace cannot lock a user out of their own (source: ${req.method} ${req.originalUrl})`);
      }
    }

    if (!workspace) {
      return res.status(403).json({ error: 'No workspace for this user' });
    }

    const membership = membershipOf(workspace, userId);

    req.workspaceId = workspace._id;
    req.actingUserId = String(userId);
    req.workspaceRole = membership?.role ?? null;

    workspaceLog('normal', `resolved workspace ${workspace._id} "${workspace.name}" for user ${req.actingUserId} as ${req.workspaceRole ?? 'no role'} (source: ${source}, for ${req.method} ${req.originalUrl})`);
    workspaceLog('verbose', `membership read: ${JSON.stringify(membership ?? null)}`);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Gates a route on the caller's role in the workspace resolveWorkspace found.
 *
 * Lives here, beside resolveWorkspace, because it is the piece every later
 * sharing route needs — collaborator invites, member removal, billing — and a
 * role check re-derived per route is a role check that will eventually be
 * forgotten on one of them.
 *
 * Hierarchical: `requireWorkspaceRole('editor')` passes an owner too, since a
 * role is a floor and not an exact match. A refusal is
 * `403 { error: 'NOT_WORKSPACE_<ROLE>' }` — a code rather than prose, because
 * the client branches on it.
 *
 * Fails closed: with no `req.workspaceRole` (a route mounted without
 * resolveWorkspace in front of it) the rank is 0 and nothing passes, and the
 * light log line says which of the two it was.
 *
 * @param {'owner'|'editor'|'viewer'} required
 */
export function requireWorkspaceRole(required) {
  const needed = ROLE_RANK[required];
  if (!needed) throw new Error(`requireWorkspaceRole: unknown role "${required}"`);
  const error = `NOT_WORKSPACE_${required.toUpperCase()}`;

  return function workspaceRoleGate(req, res, next) {
    const role = req.workspaceRole;
    if ((ROLE_RANK[role] ?? 0) >= needed) return next();

    workspaceLog('light', `refused ${req.method} ${req.originalUrl} for user ${req.actingUserId ?? 'unknown'} in workspace ${req.workspaceId ?? 'unresolved'}: role read as ${role ?? 'none (resolveWorkspace did not run)'}, ${required} required → 403 ${error}`);
    res.status(403).json({ error });
  };
}

/**
 * The write gate every content router carries: a read passes, anything else
 * needs `editor`.
 *
 * `editor` is the write floor (KOL-103). Roles existed from KOL-071 and were
 * enforced on exactly two routes — `PATCH /workspace` and `POST /import`, both
 * owner-only — while the 32 writes that make up the graph were ungated, so a
 * viewer could create, edit, delete and spend the workspace's AI allowance.
 * There was nothing to enforce against while every workspace had one member;
 * collaborator invites are the next commercial step, so the gate has to exist
 * before the first invite rather than after it.
 *
 * Unsafe-methods-only, the same shape `originGuard` uses: `GET`, `HEAD` and
 * `OPTIONS` pass through untouched (reading is what a viewer is *for*), and
 * every other method goes through `requireWorkspaceRole('editor')` — so the
 * refusal is the same `403 { error: 'NOT_WORKSPACE_EDITOR' }` the client
 * already branches on, and an owner passes because a role is a floor.
 *
 * Mounted once per content router in app.js rather than per route, so a route
 * added to one of those routers later inherits the gate instead of having to
 * remember it. The one exception is the changelog router, which is mounted at
 * `/` — a mount-level gate there would also see every request on its way to a
 * later mount — so its single write carries the gate on the route itself.
 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The role a write needs. A gate asking for it passes an owner too. */
export const WRITE_ROLE = 'editor';

const writeGate = requireWorkspaceRole(WRITE_ROLE);

export function requireWriteRole(req, res, next) {
  if (READ_METHODS.has(req.method)) {
    workspaceLog('verbose', `allowed ${req.method} ${req.originalUrl} unchecked (source: read-only method)`);
    return next();
  }
  return writeGate(req, res, next);
}
