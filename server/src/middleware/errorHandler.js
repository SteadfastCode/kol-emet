/**
 * One error shape for the API, instead of the database's own error text.
 *
 * Fifty-nine handlers across twelve routers used to end in
 * `catch (err) { res.status(500).json({ error: err.message }) }` or its 400
 * variant, and `createApp` installed no error middleware at all. So whatever
 * Mongoose or the driver said reached the caller verbatim: `E11000 duplicate
 * key error collection: kol_emet.entityTypes index: workspaceId_1_name_1 dup
 * key: …`, `Entity validation failed: category: "Hero" is not an entity type
 * in this workspace`, or a pool error carrying a connection string. Two
 * defects in one: a public API whose error bodies describe the deployment's
 * internals, and a shape no client can branch on because it is prose that
 * changes with the driver version.
 *
 * KOL-069 closed the one case it could close from outside the catch — a
 * malformed `:id` is 400 `INVALID_ID` before the route runs (see
 * `middleware/objectId.js`) — and this is the same idea finished: the shape
 * belongs in one place, not in fifty-nine catches. Each of those catches is
 * now `catch (err) { next(err) }`, and every 400/403/404/409 a route answers
 * *on purpose* with a written sentence it chose stays exactly as it was. A
 * route's deliberate refusal is part of its contract; the catch-all was not.
 *
 * ─── The rules, in order ─────────────────────────────────────────────────────
 *   1. the response has already begun  → hand to Express, which closes it
 *   2. Mongoose `ValidationError`      → 400 { error: 'VALIDATION_FAILED', fields }
 *   3. duplicate key (11000)           → 409 { error: 'DUPLICATE', fields }
 *   4. Mongoose `CastError`            → 400 { error: 'INVALID_VALUE', fields }
 *   5. explicit `status` *and* `code`  → that status, { error: code }
 *   6. body-parser's own `type`        → that type's status, { error: code }
 *   7. anything else                   → 500 { error: 'INTERNAL', ref }
 *
 * `fields` is always schema paths or index key names — *our own* names, which
 * are safe to publish and are the one thing a client actually needs in order to
 * mark the offending input. Never the values, never the message, never the
 * model or collection name.
 *
 * Rule 4 is not in the original three because rules 2 and 3 were written for
 * what a `save()` throws. A `findOneAndUpdate(…, { runValidators: true })` with
 * an uncastable value throws a bare `CastError` instead, and those routes
 * answered 400 for it before this file existed. Mapping it keeps that status —
 * changing a status a route chose deliberately is out of scope — while dropping
 * a body that named the model and the driver's cast path.
 *
 * Rule 5 requires *both* an integer `status` and a string `code`, which is what
 * `httpError()` below produces. Demanding both is deliberate: a Mongo error
 * carries a numeric `code` and a Node system error a string one (`ENOENT`,
 * `ECONNREFUSED`) with no `status`, and neither must be able to talk its way
 * into becoming the body of a 4xx.
 *
 * Rule 6 is the half of rule 5 that demand left out (KOL-099). Requiring a
 * string `code` keeps a Mongo error out, but it also kept out the one kind of
 * error that arrives with a *correct* status and no code at all: body-parser's.
 * A malformed JSON body is `{ name: 'SyntaxError', status: 400, type:
 * 'entity.parse.failed' }`; an over-limit one `{ status: 413, type:
 * 'entity.too.large' }`. Neither carries a `code`, so both fell through to the
 * last rule and answered 500 `INTERNAL` — with a `ref` and a logged stack per
 * bad request — where Express's own finalhandler had honoured the 400 and the
 * 413 before this file existed. Two client mistakes reported as server faults,
 * on every route but `/import`, which had already noticed and answers its own
 * 400/413 from a path-scoped handler (`routes/import.js`). That handler is
 * mounted ahead of the app-wide parser and still runs first, so `/import` keeps
 * its own `MALFORMED_JSON` / `IMPORT_TOO_LARGE` and this rule never sees it.
 *
 * The status is the table's and not the error's: a status read off an arbitrary
 * error object is a status that object got to choose, and rule 5 exists because
 * that matters. The code is ours for a different reason — a client branches on
 * `MALFORMED_JSON`, not on a `type` string owned by a dependency. Every type
 * body-parser and raw-body can raise below 500 is in the table (asserted
 * against their source in tests/http/errorShape.test.js, so a dependency
 * upgrade that adds one is named rather than silently answered as a 500); the
 * two that *are* 500s — `stream.encoding.set`, `stream.not.readable` — mean a
 * stream was misconfigured by this code, so they stay with the last rule, where
 * a 500 is the truth.
 *
 * Rule 7 publishes nothing. The caller gets a short `ref`; the same `ref` is
 * written to the server log beside the real stack, so a user can quote eight
 * characters and nothing about the deployment leaves the box.
 *
 * Not this file's business: `routes/bridge.js` and `routes/mcp.js` answer
 * JSON-RPC error objects on their own protocol and never call `next(err)`
 * (KOL-047), and the SSE routes report failures as stream events because their
 * headers went out long before the error did — rule 1 is only the backstop for
 * one that still reaches here.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * ERROR_LOG_LEVEL = off | light | normal | verbose (default light)
 * An error that used to be legible in the response body is now a code, so the
 * log is the only place the *reason* survives — and a status alone does not say
 * why it was chosen. So the light tier names the rule that chose it, not just
 * the number it produced.
 *   off     — nothing at all, the stack included
 *   light   — one line per handled error: the route, the status chosen, the
 *             code, the `ref` when there is one, and *which rule* chose it.
 *             For a 500, the real stack too, prefixed with the same `ref`.
 *   normal  — light, plus the error's own name and message, server-side, so a
 *             mapped 400 can be read without reproducing it
 *   verbose — normal, plus the body sent and the stack of every handled error,
 *             mapped 4xx included
 */

import { randomBytes } from 'node:crypto';

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

/** Whether `level` is currently being logged. Read per call, not at import. */
export function errorLogEnabled(level) {
  const active = LEVELS[process.env.ERROR_LOG_LEVEL] ?? LEVELS.light;
  return active >= LEVELS[level];
}

/** Named `errorLog` on import; shares ERROR_LOG_LEVEL with the handler. */
export function errorLog(level, msg) {
  if (errorLogEnabled(level)) console.log(`[error:${level}] ${msg}`);
}

/**
 * An error a route raises on purpose, for rule 5 to turn back into the status
 * and code it names.
 *
 * Use it where the refusal is a *code* the client branches on and the reason is
 * not worth a sentence; keep `res.status(…).json({ error: 'a sentence' })`
 * where the sentence is the point. Either is fine — what is not fine is the
 * driver writing the sentence.
 *
 *   if (!secret) throw httpError(503, 'EXPORT_NOT_CONFIGURED');
 *
 * @param {number} status 4xx/5xx
 * @param {string} code   the stable string the body's `error` becomes
 * @param {{fields?: string[], cause?: unknown}} [extra] `fields` is published
 *   alongside the code; `cause` is kept for the log and never published.
 * @returns {Error & {status: number, code: string}}
 */
export function httpError(status, code, extra = {}) {
  const err = new Error(`${status} ${code}`);
  err.status = status;
  err.code = code;
  if (extra.fields) err.fields = extra.fields;
  if (extra.cause !== undefined) err.cause = extra.cause;
  return err;
}

/** 11000 is the duplicate-key code, wherever the driver hung it. */
function duplicateKeyError(err) {
  if (!err) return null;
  if (err.code === 11000) return err;
  if (err.cause?.code === 11000) return err.cause;
  const write = err.writeErrors?.find?.(e => e?.code === 11000 || e?.err?.code === 11000);
  if (write) return write.err ?? write;
  return null;
}

/**
 * The index's key names — never `keyValue`, which holds the colliding values.
 * An error that carries neither yields `[]` rather than the message being
 * mined for the index name: the message is the thing being withheld.
 */
function duplicateFields(dup) {
  const pattern = dup.keyPattern ?? dup.keyValue;
  return pattern && typeof pattern === 'object' ? Object.keys(pattern).sort() : [];
}

/**
 * body-parser's failures, by the `type` it hangs on them — rule 6.
 *
 * Keyed by `type` rather than by status because the type is the only stable
 * thing on the error: the message is English prose from a dependency and the
 * status, on an error object that could be anything, is not ours to trust.
 *
 * Everything body-parser and raw-body can raise under 500 is here. `/import`
 * answers its own codes for the first two before this is reached; the rest are
 * reachable through the app-wide `express.json()` and through the two
 * form-encoded OAuth endpoints that mount `express.urlencoded` themselves.
 */
export const BODY_PARSER_RULES = Object.freeze({
  // raw-body and body-parser, JSON and form-encoded alike
  'entity.parse.failed': { status: 400, code: 'MALFORMED_JSON' },
  'entity.too.large': { status: 413, code: 'BODY_TOO_LARGE' },
  'request.size.invalid': { status: 400, code: 'BODY_SIZE_MISMATCH' },
  'request.aborted': { status: 400, code: 'REQUEST_ABORTED' },
  'encoding.unsupported': { status: 415, code: 'UNSUPPORTED_ENCODING' },
  'charset.unsupported': { status: 415, code: 'UNSUPPORTED_CHARSET' },
  // form-encoded only: the OAuth issuers' /authorize and /oauth/token
  'parameters.too.many': { status: 413, code: 'TOO_MANY_PARAMETERS' },
  'querystring.parse.rangeError': { status: 400, code: 'MALFORMED_BODY' },
  // only with a `verify` option, which nothing here passes today
  'entity.verify.failed': { status: 403, code: 'BODY_VERIFY_FAILED' },
});

/**
 * The two types that are this code's own bug rather than the caller's, so they
 * stay a 500. Named here so the dependency sweep in errorShape.test.js can tell
 * "deliberately unmapped" from "nobody noticed it was added".
 */
export const BODY_PARSER_OURS = Object.freeze(['stream.encoding.set', 'stream.not.readable']);

/**
 * Which rule an error falls under, or null for "none — this is a 500".
 *
 * Separated from the handler so it can be asserted directly, and so the mapping
 * reads as the table it is.
 *
 * @param {any} err
 * @returns {{status: number, rule: string, body: object}|null}
 */
export function classify(err) {
  if (err?.name === 'ValidationError' && err.errors && typeof err.errors === 'object') {
    return {
      status: 400,
      rule: 'Mongoose ValidationError',
      body: { error: 'VALIDATION_FAILED', fields: Object.keys(err.errors).sort() },
    };
  }

  const dup = duplicateKeyError(err);
  if (dup) {
    return {
      status: 409,
      rule: 'duplicate key 11000',
      body: { error: 'DUPLICATE', fields: duplicateFields(dup) },
    };
  }

  if (err?.name === 'CastError' && typeof err.path === 'string') {
    return {
      status: 400,
      rule: 'Mongoose CastError',
      body: { error: 'INVALID_VALUE', fields: [err.path] },
    };
  }

  if (Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599 && typeof err.code === 'string' && err.code) {
    const fields = Array.isArray(err.fields) && err.fields.length ? { fields: err.fields } : {};
    return {
      status: err.status,
      rule: 'explicit status and code',
      body: { error: err.code, ...fields },
    };
  }

  // Disjoint from rule 5 by construction, so the order between them does not
  // matter: body-parser hangs no `code` on its errors and `httpError()` hangs
  // no `type` on its own.
  const parser = typeof err?.type === 'string' ? BODY_PARSER_RULES[err.type] : undefined;
  if (parser) {
    return {
      status: parser.status,
      rule: `body-parser ${err.type}`,
      body: { error: parser.code },
    };
  }

  return null;
}

/** `name: message`, for the log only. */
function describe(err) {
  if (!(err instanceof Error)) return `non-Error value ${JSON.stringify(String(err))}`;
  return `${err.name}: ${err.message}`;
}

/**
 * The API's only error middleware. Four arguments, so Express treats it as one,
 * and mounted last in `createApp` — after every router, because Express walks
 * error middleware in mount order and anything mounted before a router can
 * never see that router's errors.
 */
export function errorHandler(err, req, res, next) {
  const where = `${req.method} ${req.originalUrl}`;

  // Headers are already out — a stream, a file download, a response that threw
  // after res.send(). Nothing can be written over it, so Express's own handler
  // gets it: that one destroys the socket, which is the only honest ending.
  if (res.headersSent) {
    errorLog('light', `${where} → connection closed, no body (source: rule 1, the response had already begun)`);
    errorLog('normal', `${where}: ${describe(err)}`);
    return next(err);
  }

  const mapped = classify(err);

  if (mapped) {
    const fields = mapped.body.fields?.length ? ` fields=${mapped.body.fields.join(',')}` : '';
    errorLog('light', `${where} → ${mapped.status} ${mapped.body.error}${fields} (source: ${mapped.rule})`);
    errorLog('normal', `${where}: ${describe(err)}`);
    errorLog('verbose', `${where}: sent ${JSON.stringify(mapped.body)}`);
    if (errorLogEnabled('verbose') && err instanceof Error) console.error(`[error:verbose] ${where}`, err);
    return res.status(mapped.status).json(mapped.body);
  }

  // Short on purpose: it is meant to be read off a screen and typed into a
  // support message, and it indexes a log line rather than identifying anything.
  const ref = randomBytes(4).toString('hex');
  errorLog('light', `${where} → 500 INTERNAL ref=${ref} (source: rule 7, no rule matched — not a ValidationError, a duplicate key, a CastError, a body-parser failure, or an error carrying both status and code)`);
  errorLog('normal', `${where} ref=${ref}: ${describe(err)}`);
  // The stack beside the ref, at the light tier, is the whole trade: the body
  // says nothing, so the log has to say everything.
  if (errorLogEnabled('light')) console.error(`[error:light] ref=${ref} ${where} —`, err);

  return res.status(500).json({ error: 'INTERNAL', ref });
}

export default errorHandler;
