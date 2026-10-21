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
 * That typing rule is why `boundedInteger` lives here too (KOL-067), next to
 * the rule it applies, rather than in the paginated route that reads it: a
 * `?limit=` is the same caller-supplied query-string value arriving through the
 * same parser, and the answer to a value nobody wrote is the same answer.
 * `idCursor` (KOL-092) joined them on the same terms: an `?after=` is read at
 * the edge too, and two routes page over the same `_id` cursor.
 *
 * Pure and synchronous — no logging tier here; what reaches these functions is
 * visible in the request the caller made.
 */

import mongoose from 'mongoose';

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

/**
 * Only an optional sign and digits. `Number` is far more generous than a query
 * parameter should be — `0x10` is 16, `1e3` is 1000, `' 2 '` is 2, `''` is 0 —
 * and a caller who meant a page size typed digits. Anything else is a value
 * nobody wrote on purpose, so it is no page size rather than a surprising one.
 */
const INTEGER_ONLY = /^[+-]?\d+$/;

/**
 * The integer counterpart to `searchTerm`: a caller-supplied query-string value
 * normalized into a bounded integer, for `?limit=` on `GET /entities`.
 *
 * Same typing rule, same reason. The extended query parser hands
 * `?limit[$gt]=1` to the route as an object and `?limit=1&limit=2` as an array,
 * and a page size is arithmetic rather than a filter — `Number({})` is NaN and
 * `Number(['1','2'])` is NaN, which would reach `.limit()` and throw inside the
 * route's `try` as a 500. A non-string answers null, and null means *no limit*:
 * the caller gets the unpaged response they would have got without the
 * parameter, not a page boundary they never asked for.
 *
 * Below `min` is also null, for the same reason — `?limit=0` and `?limit=-1`
 * are not page sizes, and `.limit(0)` means *no limit* to MongoDB, so passing
 * one straight through would be read as a page of everything. Above `max` is
 * clamped rather than refused: a caller asking for more rows than the route
 * will serve gets the most it serves, which is what a page size is for.
 *
 * @param {unknown} raw whatever the caller sent — a string, an operator object
 *   from the extended query parser, a repeated parameter's array, or nothing
 * @param {{ min: number, max: number }} bounds inclusive
 * @returns {number|null} the integer, clamped to `max`, or null when there is
 *   no usable one. Callers treat null as "no limit".
 */
export function boundedInteger(raw, { min, max }) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!INTEGER_ONLY.test(trimmed)) return null;
  // Only digits reached here, so a value too large to be a safe integer (or to
  // be finite at all) is still unambiguously above `max`, and the clamp below
  // is the right answer for it rather than a special case.
  const value = Number(trimmed);
  if (value < min) return null;
  return Math.min(value, max);
}

/**
 * The `?after=` cursor for the routes whose sort is `_id` alone — a bare id.
 *
 * `GET /entities` pages over `{ title, _id }` because its sort is by title, so
 * its cursor is two fields and lives in that route (`listCursor`). The two
 * routes KOL-092 capped — `GET /relationship-groups` and `GET /open-questions`
 * — sort by `_id`, which is already unique, so the previous page's last `_id`
 * *is* the whole position: no tie-break, and no index beyond the one every
 * collection has. One reader for both of them lives here, beside
 * `boundedInteger`, for the reason that one does: it is the same caller-supplied
 * query-string value arriving through the same parser.
 *
 * A present-but-unusable cursor is refused rather than ignored, exactly as the
 * compound one is: dropping it would answer page 1 to a request for page 2, and
 * a client that pages until `nextAfter` is null would then never stop. An empty
 * `?after=` is the exception — that is a client that built a query string
 * around a value it does not have, which is no cursor.
 *
 * `mongoose.isValidObjectId` is the whole check, as in `middleware/objectId.js`:
 * under Mongoose 8 / bson 6 a string passes only if it is 24 hex characters,
 * which is exactly the set `new ObjectId(value)` will not throw on — and
 * exactly the form `String(row._id)` handed out.
 *
 * @param {unknown} raw whatever the caller sent — a string, an operator object
 *   from the extended query parser, a repeated parameter's array, or nothing
 * @returns {{ after: string|null } | { error: string }} `after` is null when
 *   there is no cursor; `error` is the sentence the route answers 400 with.
 */
export function idCursor(raw) {
  if (raw === undefined || raw === '') return { after: null };

  const error = { error: "after must be the previous page's nextAfter, as after=<id>" };
  if (typeof raw !== 'string' || !mongoose.isValidObjectId(raw)) return error;

  return { after: raw };
}
