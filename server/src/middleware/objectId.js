/**
 * A malformed `:id` is the caller's mistake, answered as one.
 *
 * Every `:id` route handed `req.params.id` straight to Mongoose, so anything
 * that is not a 24-hex id — a slug, a truncated id, a URL-encoded title, a
 * stale link — threw a `CastError` inside the route's `try` and came back as
 * **500** `Cast to ObjectId failed for value "…" (type string) at path "_id"
 * for model "Entity"`. Two defects in one: a client error reported as a server
 * fault, so in whatever monitors a deployment a mistyped URL is
 * indistinguishable from a real outage; and a body that names the model and the
 * driver's cast path, which is not a shape a public API should return.
 *
 * **400 and not 404, on purpose.** A well-formed id belonging to another tenant
 * stays 404 (see the comment in `routes/entities.js`), so the API still never
 * confirms another workspace's row exists. A malformed id cannot name anyone's
 * row and so reveals nothing by being refused — it is simply a request the
 * caller got wrong, and telling them that is strictly more useful than making
 * it look like content that is not there.
 *
 * Registered with `router.param` rather than checked per handler, so a route
 * added to one of these routers later inherits the check instead of
 * re-deriving it:
 *
 *   router.param('id', objectIdParam('id'));
 *
 * Express runs a param callback only for a layer that actually matched, so a
 * literal single-segment route declared ahead of `/:id` (`/drafts/quota`,
 * `/deleted`) is never put through it.
 *
 * `mongoose.isValidObjectId` is the whole rule: under Mongoose 8 / bson 6 a
 * string passes only if it is 24 hex characters — the 12-byte-string form older
 * bson accepted is gone — which is exactly the set `new ObjectId(value)` will
 * not throw on.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * OBJECT_ID_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — every refusal, naming the param, the method and URL it came from,
 *             the mount the check is registered on, and the value (truncated).
 *             A 400 the client did not expect is otherwise indistinguishable
 *             from the route not existing.
 *   normal  — light, plus every id that passed, so a route answering 404 can be
 *             told apart from one this guard never ran on
 *   verbose — normal, plus the untruncated value and its length, for a value
 *             the light tier cut (a long stale link, an encoded title)
 */

import mongoose from 'mongoose';

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.OBJECT_ID_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[objectId:${level}] ${msg}`);
}

/** How much of a refused value the light tier prints. */
const VALUE_PREVIEW = 80;

function preview(value) {
  const text = String(value);
  return text.length > VALUE_PREVIEW ? `${text.slice(0, VALUE_PREVIEW)}…` : text;
}

/**
 * An Express `router.param` callback that refuses a route parameter which is
 * not a valid ObjectId with 400 `{ error: 'INVALID_ID', param }`.
 *
 * @param {string} name the route parameter's name, echoed back as `param`
 * @returns {(req, res, next, value) => void}
 */
export function objectIdParam(name) {
  return function checkObjectIdParam(req, res, next, value) {
    if (typeof value === 'string' && mongoose.isValidObjectId(value)) {
      log('normal', `${name}=${value} is a valid id (source: ${req.method} ${req.originalUrl})`);
      return next();
    }

    log('light', `refused ${name}=${JSON.stringify(preview(value))} with 400 INVALID_ID (source: ${req.method} ${req.originalUrl}, mount ${req.baseUrl || '/'})`);
    log('verbose', `refused ${name} in full: ${JSON.stringify(String(value))} (${String(value).length} characters)`);
    return res.status(400).json({ error: 'INVALID_ID', param: name });
  };
}

export default objectIdParam;
