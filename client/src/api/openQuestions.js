import { sseClientId } from '../composables/useEvents.js';

const BASE_URL = import.meta.env.VITE_API_URL ?? '';

/**
 * `/open-questions` from the browser (KOL-104).
 *
 * The collection has had full CRUD behind the route, two MCP tools and its own
 * section in the data model since the start, and no client caller at all: open
 * questions reached the browser already populated on `GET /entities` and were
 * rendered as static text. So the "what don't I know yet" half of the model
 * could only be *written* by a user who had connected an AI client, and a
 * question an agent raised could never be marked answered from the UI. This
 * module is the browser's side of the same four routes.
 *
 * Shaped like api/entities.js: `credentials: 'include'`, the `X-SSE-Client-Id`
 * header on every unsafe method so the live-sync stream can tell this tab's own
 * writes from another's, and a 401 raised as its own error. The refusal body
 * rides along on `.body` as it does there — a caller shows the server's
 * sentence, not "500".
 */
async function req(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (sseClientId && options.method && options.method !== 'GET') {
    headers['X-SSE-Client-Id'] = sseClientId;
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers,
  });
  if (res.status === 401) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw Object.assign(
      new Error(body?.error ?? `${res.status} ${res.statusText}`),
      { status: res.status, body },
    );
  }
  return res.status === 204 ? null : res.json();
}

/** The page size a question walk asks for; the route's own cap (QUESTION_LIMIT_MAX). */
export const QUESTION_PAGE_SIZE = 200;

/**
 * One page of the workspace's questions, newest first (KOL-092's contract).
 *
 * `?limit=` is what opts into the envelope — `{ items, nextAfter }` instead of
 * a bare array — and `after` is the previous page's `nextAfter` verbatim, a
 * bare id (this route's sort is `_id` alone). A cursor the server did not issue
 * is a 400 rather than a silent first page.
 *
 * Only the paged form is wrapped here on purpose: no `?limit=` is the route's
 * unbounded bare array, which serializes every question in the workspace *and*
 * resolves each one's `entry_ids` in a single response. A browser has no reason
 * to ask for that. A server from before the cap answers the bare array however
 * it is asked, so a caller that walks pages checks for an array first — see
 * `getAllGroups` in api/relationshipGroups.js, which does exactly that.
 *
 * @param {{ status?: 'open'|'resolved', limit?: number, after?: string|null }} opts
 * @returns {Promise<{ items: object[], nextAfter: string|null }|object[]>}
 */
export const getOpenQuestionPage = ({ status = null, limit = QUESTION_PAGE_SIZE, after = null } = {}) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (status) params.set('status', status);
  if (after) params.set('after', after);
  return req(`/open-questions?${params}`);
};

/** A single question, with its `entry_ids` populated. 404 outside the workspace. */
export const getOpenQuestion = (id) => req(`/open-questions/${id}`);

/**
 * Creates a question, optionally linked to entities.
 *
 * `entry_ids` naming entities outside the caller's workspace are dropped by the
 * server rather than stored, so the created question that comes back is the
 * only honest account of what was linked — render it, don't assume the request.
 *
 * @param {{ question: string, entry_ids?: string[] }} data
 */
export const createOpenQuestion = ({ question, entry_ids = [] }) =>
  req('/open-questions', { method: 'POST', body: JSON.stringify({ question, entry_ids }) });

/**
 * Rewrites a question's text and nothing else.
 *
 * `PUT /open-questions/:id` applies whichever of `question`, `status` and
 * `entry_ids` the body carries, so the two writes a reader makes are kept apart
 * *here* rather than in a component: a body built from a whole row would send
 * the status it happened to be holding back alongside the text, and a stale
 * status would silently reopen a question somebody else resolved.
 */
export const renameOpenQuestion = (id, question) =>
  req(`/open-questions/${id}`, { method: 'PUT', body: JSON.stringify({ question }) });

/**
 * Marks a question answered or puts it back, writing `status` alone — same
 * reasoning as `renameOpenQuestion`, from the other side: a resolve must not
 * carry the text that was on screen when the toggle was clicked.
 *
 * @param {string} id
 * @param {'open'|'resolved'} status
 */
export const setOpenQuestionStatus = (id, status) =>
  req(`/open-questions/${id}`, { method: 'PUT', body: JSON.stringify({ status }) });

/**
 * Replaces the entities a question is linked to. The server syncs the
 * back-links on both sides and drops ids outside the workspace.
 */
export const setOpenQuestionEntries = (id, entry_ids) =>
  req(`/open-questions/${id}`, { method: 'PUT', body: JSON.stringify({ entry_ids }) });

/** Deletes a question and its back-links. Answers 204, so this resolves to null. */
export const deleteOpenQuestion = (id) =>
  req(`/open-questions/${id}`, { method: 'DELETE' });
