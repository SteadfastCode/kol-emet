/**
 * Caller-supplied search terms, made safe to compile into a regex.
 *
 * Three routes let a caller search entities — `GET /entities`, the MCP
 * `search_entities` tool, and the chat assistant's local copy of that tool —
 * and each one built the same `$or` by hand, around a bare
 * `new RegExp(theCallersString, 'i')`. That is two separate defects:
 *
 *   A term holding regex punctuation is a crash, not a search. `?q=C++ (v2)`
 *   throws a SyntaxError inside the route's `try` and answers 500, and a model
 *   that emits the same string gets a tool error back instead of the entity it
 *   was looking for. Punctuation in a title is ordinary — version numbers,
 *   `C++`, parenthetical asides — so this is the common case, not the exotic one.
 *
 *   A catastrophic pattern is a denial of service. `(a+)+$` compiled and run
 *   against every title, summary and block markdown in a workspace burns the
 *   single event loop this multi-tenant API shares, so one tenant's query
 *   stalls everybody else's requests. Escaping is what removes the class
 *   entirely: an escaped term has no quantifiers left to nest.
 *
 * `routes/bridge.js` already escaped its own `q` with exactly this character
 * class; the entity searches never got it. The escape lives here now so the
 * next caller inherits it rather than re-deriving it.
 *
 * The second half of the job is typing. Express 4's default (extended) query
 * parser hands `?category[$ne]=Characters` to the route as an object and
 * `?q=a&q=b` as an array, and Mongoose casts whatever it is given: the object
 * reaches the filter as a live operator (workspace-scoped, so it selects the
 * caller's own rows rather than another tenant's, but it is still a query the
 * caller wrote rather than the one the route meant), and the array stringifies
 * to `a,b`. `searchTerm` answers null for anything that is not a non-empty
 * string, so a non-string is *no filter* rather than a filter the caller wrote.
 * Same reasoning as `usableEmail` in routes/auth.js (KOL-044): type the value at
 * the edge, before it becomes a query.
 *
 * Pure and synchronous — no logging tier here; what reaches these functions is
 * visible in the request the caller made.
 */

/**
 * Every character that means something to the regex engine. The same class
 * routes/bridge.js escapes its routine-item search with.
 */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * Longest term a search will compile. A term is matched against every entity
 * in the workspace, so its length is a per-document cost; nothing a person
 * types into a search box comes near 200 characters, and a model emitting more
 * than that is pasting a document, not searching for one.
 */
export const MAX_TERM_LENGTH = 200;

/** Escapes `s` so it matches literally when compiled as a regex. */
export function escapeRegex(s) {
  return String(s).replace(REGEX_METACHARACTERS, '\\$&');
}

/**
 * Normalizes a caller-supplied query-string value into a term to search for.
 *
 * @param {unknown} raw whatever the caller sent — a string, an operator object
 *   from the extended query parser, a repeated parameter's array, or nothing
 * @returns {string|null} the trimmed term, capped at `MAX_TERM_LENGTH`, or null
 *   when there is nothing searchable. Callers treat null as "no filter".
 */
export function searchTerm(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Trimmed again after the cap so a term cut mid-whitespace has no tail. The
  // slice starts on a non-space (trim ran first), so this cannot empty it.
  return trimmed.slice(0, MAX_TERM_LENGTH).trim();
}

/**
 * The keyword clause the entity searches share: a case-insensitive literal
 * match against a title, a summary, or any block's markdown.
 *
 * @param {string} term a term from `searchTerm` — already trimmed and capped
 * @returns {{ $or: object[] }} spread into the filter beside the workspace key
 */
export function keywordFilter(term) {
  const re = new RegExp(escapeRegex(term), 'i');
  return {
    $or: [
      { title: re },
      { summary: re },
      { blocks: { $elemMatch: { 'data.markdown': re } } },
    ],
  };
}
