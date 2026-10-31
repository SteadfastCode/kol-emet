const BASE_URL = import.meta.env.VITE_API_URL ?? '';

/**
 * The workspace this session is in: its name, and the caller's role (KOL-071).
 * Since KOL-090, also *which* workspace that is, out of the ones the user
 * belongs to.
 *
 * `GET /workspace` is what the Workspace group in Settings shows, and
 * `PATCH /workspace` is the rename. The role comes from the server's reading of
 * the caller's own membership, so the client hides a rename it may not do
 * rather than deciding for itself who an owner is — the server refuses it
 * either way (`403 NOT_WORKSPACE_OWNER`).
 *
 * `GET /workspaces` lists every workspace the user is a member of and
 * `POST /workspaces/:id/select` makes one of them the one this session acts in.
 * The choice is server-side session state, not a client preference: the client
 * cannot scope its own reads, so a workspace "chosen" in a store here while the
 * server resolved another is the split KOL-090 exists to remove.
 *
 * `POST /workspaces` creates a second one (KOL-123) — seeded from a template,
 * or empty. It deliberately does not select what it creates, so the caller
 * follows it with `selectWorkspace()`: that route stays the only writer of
 * which workspace a session acts in.
 *
 * A refusal keeps the server's code on the error (`NOT_WORKSPACE_OWNER`,
 * `INVALID_WORKSPACE_NAME`) plus its status, because Settings says something
 * different for each.
 *
 * Tiered debug logging: set localStorage.WORKSPACE_LOG_LEVEL to
 * off | light | normal | verbose (default light). The server logs the same
 * operations on its own WORKSPACE_LOG_LEVEL.
 *   light   — every rename sent from here and how it ended, naming what asked
 *             for it and the name it replaced, every workspace switch, naming
 *             the one it replaced, and every create, naming what it was seeded
 *             from — a template key, or nothing
 *   normal  — light, plus each read and the role it came back with
 *   verbose — normal, plus the whole response body
 */

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  let configured;
  try { configured = localStorage.getItem('WORKSPACE_LOG_LEVEL'); } catch { configured = null; }
  const active = LEVELS[configured] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[workspace:${level}] ${msg}`);
}

/** The longest name `PATCH /workspace` accepts, mirroring the server's rule. */
export const WORKSPACE_NAME_MAX = 80;

async function req(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    // `limit` comes off `409 WORKSPACE_LIMIT_REACHED` only, and is carried
    // rather than dropped so the message can name the number instead of
    // telling a user they have hit a cap nobody will say the size of.
    throw Object.assign(new Error(body?.error ?? `${res.status}`), { status: res.status, limit: body?.limit });
  }
  return body;
}

/** `{ _id, name, role, createdAt }` for the signed-in user's workspace. */
export async function getWorkspace({ source } = {}) {
  const workspace = await req('/workspace');
  log('normal', `read "${workspace.name}" as ${workspace.role} (source: ${source ?? 'GET /workspace'})`);
  log('verbose', JSON.stringify(workspace));
  return workspace;
}

/**
 * Renames the workspace. Owners only; anyone else gets a 403 whose message is
 * `NOT_WORKSPACE_OWNER`.
 *
 * @param {string} name the new name, 1–80 characters once trimmed
 * @param {object} [options]
 * @param {string} [options.source] what asked for it, for the log line
 * @param {string} [options.from] the name being replaced, for the log line
 * @returns {Promise<{ _id: string, name: string, role: string, createdAt: string }>}
 */
export async function renameWorkspace(name, { source, from } = {}) {
  try {
    const workspace = await req('/workspace', { method: 'PATCH', body: JSON.stringify({ name }) });
    log('light', `renamed from "${from ?? 'unknown'}" to "${workspace.name}" (source: ${source ?? 'PATCH /workspace'})`);
    log('verbose', JSON.stringify(workspace));
    return workspace;
  } catch (err) {
    log('light', `rename to "${name}" refused with ${err.status ?? 'no status'} ${err.message} (source: ${source ?? 'PATCH /workspace'}, replacing "${from ?? 'unknown'}")`);
    throw err;
  }
}

/**
 * Every workspace the signed-in user is a member of, oldest first, each
 * `{ _id, name, role, createdAt }` — the same shape as `getWorkspace()`.
 *
 * What the switcher in Settings is built from. Since a user can create a second
 * workspace (KOL-123) the switcher is shown for a single membership too — it is
 * where the one just created appears, and hiding it would have hidden the place
 * the New workspace form beside it puts things.
 *
 * @param {object} [options]
 * @param {string} [options.source] what asked for it, for the log line
 * @returns {Promise<Array<{ _id: string, name: string, role: string, createdAt: string }>>}
 */
export async function listWorkspaces({ source } = {}) {
  const workspaces = await req('/workspaces');
  log('normal', `listed ${workspaces.length} workspace(s) (source: ${source ?? 'GET /workspaces'})`);
  log('verbose', JSON.stringify(workspaces));
  return workspaces;
}

/**
 * Makes `id` the workspace this session acts in, server-side.
 *
 * Answers the selected workspace in the same shape. A workspace the user is not
 * a member of is a 404 (never a 403, which would confirm it exists) and changes
 * nothing. Everything already on screen came from the *previous* workspace, so
 * the caller's job after this resolves is to start again — see the switcher in
 * WikiLayout.vue.
 *
 * @param {string} id
 * @param {object} [options]
 * @param {string} [options.source] what asked for it, for the log line
 * @param {string} [options.from] the workspace being left, for the log line
 */
export async function selectWorkspace(id, { source, from } = {}) {
  try {
    const workspace = await req(`/workspaces/${id}/select`, { method: 'POST' });
    log('light', `this session now acts in "${workspace.name}" (${workspace._id}) as ${workspace.role}, replacing ${from ?? 'the default'} (source: ${source ?? 'POST /workspaces/:id/select'})`);
    log('verbose', JSON.stringify(workspace));
    return workspace;
  } catch (err) {
    log('light', `switch to workspace ${id} refused with ${err.status ?? 'no status'} ${err.message} (source: ${source ?? 'POST /workspaces/:id/select'}, leaving ${from ?? 'the default'})`);
    throw err;
  }
}

/**
 * Creates a workspace owned by the signed-in user and answers it in the same
 * `{ _id, name, role, createdAt }` shape, with `role: 'owner'`.
 *
 * **It is not the workspace this session acts in afterwards.** The server does
 * not select what it creates — `POST /workspaces/:id/select` stays the only
 * writer of that — so a caller that wants to land in the new workspace calls
 * `selectWorkspace()` next; see the New workspace form in WikiLayout.vue.
 *
 * `template` is a key from `getTemplates()` (api/auth.js), `undefined` for the
 * server's default, or **`null` to seed nothing** — an empty workspace, which
 * is the only kind `POST /import` will write into. It is omitted from the body
 * when `undefined`, so "say nothing" and "say nothing on purpose" stay
 * different requests.
 *
 * Refusals keep the server's code and status, because the form says something
 * different for each: 400 `INVALID_WORKSPACE_NAME`, 400 `Unknown template`,
 * 409 `WORKSPACE_LIMIT_REACHED` (whose `limit` is carried on the error).
 *
 * @param {string} name 1–80 characters once trimmed
 * @param {object} [options]
 * @param {string|null} [options.template] a template key, or null for an empty workspace
 * @param {string} [options.source] what asked for it, for the log line
 * @returns {Promise<{ _id: string, name: string, role: string, createdAt: string }>}
 */
export async function createWorkspace(name, { template, source } = {}) {
  const seededFrom = template === null ? 'nothing (an empty workspace)' : template ?? 'the server default template';
  try {
    const workspace = await req('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name, ...(template !== undefined && { template }) }),
    });
    log('light', `created "${workspace.name}" (${workspace._id}) as ${workspace.role}, seeded from ${seededFrom}; this session still acts in whatever it did before (source: ${source ?? 'POST /workspaces'})`);
    log('verbose', JSON.stringify(workspace));
    return workspace;
  } catch (err) {
    log('light', `create of "${name}" from ${seededFrom} refused with ${err.status ?? 'no status'} ${err.message} (source: ${source ?? 'POST /workspaces'})`);
    throw err;
  }
}

/**
 * Collaborators (KOL-124): the invite, the membership, and the invitee's side.
 *
 * An invite names an **email address** and delivers nothing — no mail is sent
 * and no link is minted (see server/src/models/WorkspaceInvite.js). So the
 * client's job is to be honest about that: the form below tells the inviter to
 * pass the word on themselves, and says nothing about whether the address has
 * an account here, because the server deliberately does not say.
 *
 *   - `listMembers` / `listWorkspaceInvites` — who is in this workspace, and
 *     who has been asked. Both are open to every member, like every other read.
 *   - `inviteCollaborator` / `withdrawInvite` / `setMemberRole` /
 *     `removeMember` — the owner's writes. A non-owner gets
 *     `403 NOT_WORKSPACE_OWNER`, which Settings hides the controls for rather
 *     than deciding for itself who an owner is.
 *   - `listMyInvites` / `acceptInvite` / `declineInvite` — the caller's own
 *     invitations, matched by the server on their account address.
 *
 * Accepting does **not** switch this tab to the new workspace: the server
 * leaves that to `POST /workspaces/:id/select`, so the caller follows it with
 * `selectWorkspace()` if they want to go there — the same shape `createWorkspace`
 * above has.
 *
 * Refusals keep the server's code and status, because Settings says something
 * different for each: 400 `INVALID_EMAIL`, 400 `INVALID_ROLE`,
 * 409 `ALREADY_A_MEMBER`, 409 `LAST_OWNER`, 403 `NOT_WORKSPACE_OWNER`.
 */

/** `[{ userId, email, role, isOwner }]` for the workspace this session acts in. */
export async function listMembers({ source } = {}) {
  const members = await req('/workspace/members');
  log('normal', `listed ${members.length} member(s) (source: ${source ?? 'GET /workspace/members'})`);
  log('verbose', JSON.stringify(members));
  return members;
}

/** `[{ _id, email, role, invitedBy, createdAt }]` — the invites waiting on this workspace. */
export async function listWorkspaceInvites({ source } = {}) {
  const invites = await req('/workspace/invites');
  log('normal', `listed ${invites.length} pending invite(s) (source: ${source ?? 'GET /workspace/invites'})`);
  log('verbose', JSON.stringify(invites));
  return invites;
}

/**
 * Invites `email` to this workspace at `role`. Owners only.
 *
 * Nothing is delivered, and the answer is the same whether or not that address
 * has an account — which is the privacy answer as well as the product one.
 *
 * @param {string} email
 * @param {object} [options]
 * @param {'owner'|'editor'|'viewer'} [options.role] defaults to the server's `editor`
 * @param {string} [options.source] what asked for it, for the log line
 */
export async function inviteCollaborator(email, { role, source } = {}) {
  try {
    const invite = await req('/workspace/invites', {
      method: 'POST',
      body: JSON.stringify({ email, ...(role !== undefined && { role }) }),
    });
    log('light', `invited ${invite.email} as ${invite.role}; no mail was sent, so the inviter has to pass the word on (source: ${source ?? 'POST /workspace/invites'})`);
    log('verbose', JSON.stringify(invite));
    return invite;
  } catch (err) {
    log('light', `invite of ${email}${role ? ` as ${role}` : ''} refused with ${err.status ?? 'no status'} ${err.message} (source: ${source ?? 'POST /workspace/invites'})`);
    throw err;
  }
}

/** Withdraws a pending invite. Owners only. */
export async function withdrawInvite(inviteId, { email, source } = {}) {
  try {
    await req(`/workspace/invites/${inviteId}`, { method: 'DELETE' });
    log('light', `withdrew the invite for ${email ?? inviteId} (source: ${source ?? 'DELETE /workspace/invites/:inviteId'})`);
  } catch (err) {
    log('light', `withdrawal of invite ${inviteId} refused with ${err.status ?? 'no status'} ${err.message} (source: ${source ?? 'DELETE /workspace/invites/:inviteId'})`);
    throw err;
  }
}

/**
 * Changes a member's role. Owners only, and the workspace keeps at least one
 * owner: demoting the last one is `409 LAST_OWNER`.
 */
export async function setMemberRole(userId, role, { from, email, source } = {}) {
  try {
    const member = await req(`/workspace/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) });
    log('light', `${email ?? userId} is now ${member.role}, was ${from ?? 'unknown'} (source: ${source ?? 'PATCH /workspace/members/:userId'})`);
    return member;
  } catch (err) {
    log('light', `role change of ${email ?? userId} to ${role} refused with ${err.status ?? 'no status'} ${err.message} (source: ${source ?? 'PATCH /workspace/members/:userId'}, replacing ${from ?? 'unknown'})`);
    throw err;
  }
}

/** Removes a membership. Owners only; the last owner is `409 LAST_OWNER`. */
export async function removeMember(userId, { email, role, source } = {}) {
  try {
    await req(`/workspace/members/${userId}`, { method: 'DELETE' });
    log('light', `removed ${email ?? userId} (${role ?? 'unknown role'}); their content stays with the workspace (source: ${source ?? 'DELETE /workspace/members/:userId'})`);
  } catch (err) {
    log('light', `removal of ${email ?? userId} refused with ${err.status ?? 'no status'} ${err.message} (source: ${source ?? 'DELETE /workspace/members/:userId'})`);
    throw err;
  }
}

/**
 * The caller's own pending invitations, each
 * `{ _id, workspaceId, workspaceName, role, invitedByEmail, createdAt }`.
 *
 * Matched by the server against the address this account is keyed by, so there
 * is nothing for the client to hold onto and nothing to paste.
 */
export async function listMyInvites({ source } = {}) {
  const invites = await req('/invites');
  log('normal', `listed ${invites.length} invitation(s) for this account (source: ${source ?? 'GET /invites'})`);
  log('verbose', JSON.stringify(invites));
  return invites;
}

/**
 * Accepts an invitation, answering the workspace just joined in the
 * `{ _id, name, role, createdAt }` shape.
 *
 * It is **not** the workspace this session acts in afterwards — call
 * `selectWorkspace()` for that, as `createWorkspace()` requires.
 */
export async function acceptInvite(inviteId, { source } = {}) {
  try {
    const workspace = await req(`/invites/${inviteId}/accept`, { method: 'POST' });
    log('light', `joined "${workspace.name}" (${workspace._id}) as ${workspace.role}; this session still acts where it did (source: ${source ?? 'POST /invites/:id/accept'})`);
    log('verbose', JSON.stringify(workspace));
    return workspace;
  } catch (err) {
    log('light', `accept of invite ${inviteId} refused with ${err.status ?? 'no status'} ${err.message} (source: ${source ?? 'POST /invites/:id/accept'})`);
    throw err;
  }
}

/** Declines an invitation. The inviter is not told. */
export async function declineInvite(inviteId, { workspaceName, source } = {}) {
  try {
    await req(`/invites/${inviteId}/decline`, { method: 'POST' });
    log('light', `declined the invitation to ${workspaceName ?? inviteId}; the inviter is not told (source: ${source ?? 'POST /invites/:id/decline'})`);
  } catch (err) {
    log('light', `decline of invite ${inviteId} refused with ${err.status ?? 'no status'} ${err.message} (source: ${source ?? 'POST /invites/:id/decline'})`);
    throw err;
  }
}

export default getWorkspace;
