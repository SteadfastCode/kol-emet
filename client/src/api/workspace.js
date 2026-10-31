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

export default getWorkspace;
