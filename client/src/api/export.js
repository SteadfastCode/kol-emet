import { sseClientId } from '../composables/useEvents.js';

const BASE_URL = import.meta.env.VITE_API_URL ?? '';

/**
 * `GET /export` → a file in the user's downloads folder (KOL-070).
 *
 * The browser half of taking your graph out of the product. Deliberately not
 * an `<a href="/export" download>`: the request needs the session cookie
 * (`credentials: 'include'`, since the API can be on another origin in
 * production), and a 401 or a 500 on a plain link navigates the tab away from
 * the app to show the error body. Fetching it means a failure stays a message
 * in Settings and the app keeps its state.
 *
 * The filename is the server's — `Content-Disposition` names it, derived from
 * the workspace name and the export's own UTC day — so the file a user gets is
 * the file the API says it sent, rather than one this module invents. It is
 * re-sanitized here anyway: a `download` attribute is the one place a filename
 * crosses back into the filesystem.
 *
 * Tiered debug logging: set localStorage.EXPORT_LOG_LEVEL to
 * off | light | normal | verbose (default light). The server logs the same
 * export on its own EXPORT_LOG_LEVEL.
 *   light   — every download and how it ended, naming what started it
 *   normal  — light, plus the response status, size and filename header
 *   verbose — normal, plus the object URL the anchor was given
 */

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  let configured;
  try { configured = localStorage.getItem('EXPORT_LOG_LEVEL'); } catch { configured = null; }
  const active = LEVELS[configured] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[export:${level}] ${msg}`);
}

/** What a download is called when the response names nothing usable. */
export const FALLBACK_FILENAME = 'workspace-export.json';

/**
 * The filename out of a `Content-Disposition` header, or null.
 *
 * Path separators and leading dots are stripped rather than passed to the
 * `download` attribute: browsers sanitize it too, but a filename is the one
 * value here that reaches a filesystem, and this module should not be the
 * reason that works.
 */
export function filenameFromDisposition(header) {
  const match = /filename="?([^";]+)"?/i.exec(header ?? '');
  if (!match) return null;
  const name = match[1].trim().replace(/[/\\]/g, '-').replace(/^\.+/, '');
  return name || null;
}

/**
 * Downloads the caller's workspace as one canonical JSON file.
 *
 * @param {object} [options]
 * @param {string} [options.source] what asked for it, for the log line.
 * @returns {Promise<{ filename: string, bytes: number }>}
 * @throws {Error & { status?: number }} on a refusal, with the server's message.
 */
export async function downloadWorkspaceExport({ source = 'unknown' } = {}) {
  const res = await fetch(`${BASE_URL}/export`, { credentials: 'include' });

  if (res.status === 401) {
    log('light', `export refused 401 (source: ${source})`);
    throw Object.assign(new Error('Unauthorized'), { status: 401 });
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    log('light', `export failed ${res.status} (source: ${source}): ${body?.error ?? res.statusText}`);
    throw Object.assign(
      new Error(body?.error ?? `${res.status} ${res.statusText}`),
      { status: res.status },
    );
  }

  const blob = await res.blob();
  const filename = filenameFromDisposition(res.headers.get('Content-Disposition')) ?? FALLBACK_FILENAME;
  log('normal', `export ${res.status}, ${blob.size} bytes, filename "${filename}" (source: ${source})`);

  // An anchor click rather than a navigation, so the app is never unloaded.
  const url = URL.createObjectURL(blob);
  log('verbose', `object URL ${url} (source: ${source})`);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked straight away: the click has already handed the blob to the
  // download, and an un-revoked object URL keeps the whole export in memory
  // for as long as the tab lives.
  URL.revokeObjectURL(url);

  log('light', `downloaded "${filename}" (${blob.size} bytes) (source: ${source})`);
  return { filename, bytes: blob.size };
}

/**
 * The sentence Settings shows for each refusal the import can answer with
 * (KOL-077). The server sends a code and keeps the reason in its own log, so
 * the wording is the client's job — and a code with no entry here would
 * otherwise reach a user as `WORKSPACE_NOT_EMPTY`.
 */
export const IMPORT_MESSAGES = Object.freeze({
  WORKSPACE_NOT_EMPTY: 'This workspace already has content. An import only writes into an empty one — delete what is here first, or import into a new workspace.',
  UNSUPPORTED_VERSION: 'That file was not written by a version of the export format this app reads.',
  MALFORMED_JSON: 'That file is not JSON.',
  MALFORMED_DOCUMENT: 'That file is JSON, but not a workspace export this app can read.',
  IMPORT_TOO_LARGE: 'That file is too large to import in one request.',
  NOT_WORKSPACE_OWNER: 'Only the owner of a workspace can import into it.',
  Unauthorized: 'Your session has ended. Sign in again to import.',
});

/**
 * `POST /import` → a chosen file's graph in the current workspace (KOL-077).
 *
 * The other half of the row above. The file is read in the browser and posted
 * as the request body rather than as a multipart upload: the server reads one
 * JSON document (`routes/import.js`), and a file that is not JSON is worth
 * saying so about before spending the upload.
 *
 * The bytes posted are the file's own, not a re-serialization of the parsed
 * object — the parse here is a check, so nothing this module does can change
 * what the server is asked to import.
 *
 * @param {File|{ text: () => Promise<string>, name?: string }} file
 * @param {object} [options]
 * @param {string} [options.source] what asked for it, for the log line.
 * @returns {Promise<{ version: string, imported: object, skipped: object, dropped: object }>}
 * @throws {Error & { status?: number, code?: string }} with a sentence for Settings.
 */
export async function importWorkspaceFile(file, { source = 'unknown' } = {}) {
  const name = file?.name ?? 'the chosen file';
  const text = await file.text();

  try {
    JSON.parse(text);
  } catch {
    log('light', `refused "${name}" before sending: not JSON (source: ${source})`);
    throw Object.assign(new Error(IMPORT_MESSAGES.MALFORMED_JSON), { code: 'MALFORMED_JSON' });
  }

  log('normal', `posting "${name}", ${text.length} bytes (source: ${source})`);
  // The same header every other write sends (api/entities.js and friends): the
  // import broadcasts one `workspace:imported` frame, and this tab reloads on
  // the 201 below, so it has to be excluded from its own frame or it reloads
  // and toasts twice (KOL-102).
  const headers = { 'Content-Type': 'application/json' };
  if (sseClientId) headers['X-SSE-Client-Id'] = sseClientId;

  const res = await fetch(`${BASE_URL}/import`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: text,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const code = body?.error ?? `${res.status}`;
    log('light', `import of "${name}" refused ${res.status} ${code} (source: ${source})`);
    throw Object.assign(
      new Error(IMPORT_MESSAGES[code] ?? `Import failed (${code}).`),
      { status: res.status, code },
    );
  }

  const result = await res.json();
  const counts = Object.entries(result.imported ?? {}).map(([key, n]) => `${key} ${n}`).join(', ');
  log('light', `imported "${name}" as ${result.version}: ${counts} (source: ${source})`);
  return result;
}

export default downloadWorkspaceExport;
