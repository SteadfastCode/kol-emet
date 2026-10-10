const BASE_URL = import.meta.env.VITE_API_URL ?? '';

/**
 * The workspace this session is in: its name, and the caller's role (KOL-071).
 *
 * `GET /workspace` is what the Workspace group in Settings shows, and
 * `PATCH /workspace` is the rename. The role comes from the server's reading of
 * the caller's own membership, so the client hides a rename it may not do
 * rather than deciding for itself who an owner is — the server refuses it
 * either way (`403 NOT_WORKSPACE_OWNER`).
 *
 * A refusal keeps the server's code on the error (`NOT_WORKSPACE_OWNER`,
 * `INVALID_WORKSPACE_NAME`) plus its status, because Settings says something
 * different for each.
 *
 * Tiered debug logging: set localStorage.WORKSPACE_LOG_LEVEL to
 * off | light | normal | verbose (default light). The server logs the same
 * operations on its own WORKSPACE_LOG_LEVEL.
 *   light   — every rename sent from here and how it ended, naming what asked
 *             for it and the name it replaced
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
    throw Object.assign(new Error(body?.error ?? `${res.status}`), { status: res.status });
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

export default getWorkspace;
