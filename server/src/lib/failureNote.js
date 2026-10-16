/**
 * The publishable description of a failure that is STORED rather than answered.
 *
 * `middleware/errorHandler.js` closed the case where the driver's own text
 * reaches a caller in the response to the request that failed. This is the
 * same defect one step removed: a failure written ONTO a document, where the
 * response that publishes it belongs to a later, entirely successful request.
 *
 * `POST /drafts` wrote `draft.diagnostics.error = err.message`, and
 * `GET /drafts/:id` returns the whole document — so a provider's HTTP body, or
 * a Mongo pool error from the grounding read with a connection string in it,
 * still reached a caller verbatim in a plain JSON body, just later (KOL-100).
 * The applier's `item.applyError` is the same field in the same document, and
 * the review UI prints it. Neither is reachable by the source sweep in
 * `tests/http/errorShape.test.js`, which looks for a message inside a
 * `res.json(...)`: the statement that leaks here is an assignment.
 *
 * ─── The rules, in order ─────────────────────────────────────────────────────
 *   1. the error carries `publicMessage` → that sentence, with its own code.
 *      A sentence THIS codebase wrote for the person who asked — the same
 *      distinction that lets a producer's parse error name the line in the
 *      file they uploaded. `publicFailure()` below is the only way to set it,
 *      so nothing can acquire one by accident.
 *   2. `classify()` maps it — a Mongoose ValidationError, a duplicate key, a
 *      CastError, an `httpError()`, a body-parser failure → that rule's code
 *      and a sentence of ours. The code is published; the error's text, the
 *      offending values and the index names are not.
 *   3. anything else → `INTERNAL` and a `ref`, with the real error written to
 *      the server log beside that same ref. Rule 7's trade, for a field: the
 *      stored note says nothing, so the log has to say everything.
 *
 * The rules come from `classify()` rather than a second table of the same
 * shape: one mapping, two destinations. What differs is only where the answer
 * goes — a response body there, a string field on a document here — and that a
 * stored note has to read as a sentence, because the draft UI prints it to the
 * person whose run failed.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * Shares ERROR_LOG_LEVEL (`off | light | normal | verbose`, default `light`)
 * with the middleware, because this is the same decision being made:
 *   off     — nothing at all, the stack included
 *   light   — one line per failure: where it happened, the code stored, the
 *             `ref` when there is one, and *which rule* chose it. Plus the real
 *             error, prefixed with that ref, whenever rule 3 fired.
 *   normal  — light, plus the error's own name and message, server-side, so a
 *             stored code can be read back to its cause without reproducing it
 *   verbose — normal, plus the note as stored, and the stack of every failure
 */

import { randomBytes } from 'node:crypto';

import { classify, errorLog, errorLogEnabled } from '../middleware/errorHandler.js';

/**
 * What rules 2 and 3 say out loud.
 *
 * Deliberately incurious. A stored note is read by the person whose run
 * failed, and the only things they can act on are the code and — for an
 * unmapped failure — the `ref` to quote. Nothing here names a model, a
 * collection, a field's value, a provider or a host.
 */
const SENTENCES = Object.freeze({
  INTERNAL:          'Something went wrong on the server.',
  VALIDATION_FAILED: 'What this produced did not pass validation.',
  DUPLICATE:         'Something this tried to write is already there.',
  INVALID_VALUE:     'A value this produced could not be stored as the type its field holds.',
});

/** `<sentence> (<CODE>)`, or `(<CODE>, ref <ref>)` when there is one to quote. */
function compose(code, ref) {
  const sentence = SENTENCES[code] ?? SENTENCES.INTERNAL;
  return `${sentence} (${code}${ref ? `, ref ${ref}` : ''})`;
}

/**
 * A refusal written on purpose, whose message is meant for the person who
 * asked.
 *
 * Use it where the reason is a sentence worth reading — "depends on an item
 * that was not applied" — and plain `new Error()` everywhere else, which is
 * the safe default: an unmarked error is a rule-3 failure, so a message that
 * turns out to carry the driver's text cannot be published by forgetting
 * something.
 *
 *   throw publicFailure('APPLY_TARGET_MISSING', 'The entity this updates no longer exists');
 *
 * @param {string} code    the stable string stored beside the sentence
 * @param {string} message the sentence itself — ours, never a dependency's
 * @param {object} [extra] copied onto the error (the applier's `blocked`, say)
 * @returns {Error & {code: string, publicMessage: string}}
 */
export function publicFailure(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.publicMessage = message;
  return Object.assign(err, extra);
}

/**
 * Turns a caught error into the note that is safe to persist and to show.
 *
 * @param {any} err
 * @param {string} where  what failed, for the log line only — never stored
 * @returns {{message: string, code: string, ref: string|null}} `message` is
 *   what a person reads, `code` what a client branches on, `ref` the index
 *   into the server log, non-null only for an unmapped failure.
 */
export function describeFailure(err, where) {
  if (typeof err?.publicMessage === 'string' && err.publicMessage) {
    const code = typeof err.code === 'string' && err.code ? err.code : 'REFUSED';
    errorLog('light', `${where} → stored ${code} (source: rule 1, the error was raised by publicFailure)`);
    errorLog('verbose', `${where}: stored note ${JSON.stringify(err.publicMessage)}`);
    return { message: err.publicMessage, code, ref: null };
  }

  const mapped = classify(err);
  if (mapped) {
    const code = mapped.body.error;
    const message = compose(code, null);
    errorLog('light', `${where} → stored ${code} (source: rule 2, ${mapped.rule})`);
    errorLog('normal', `${where}: ${describe(err)}`);
    errorLog('verbose', `${where}: stored note ${JSON.stringify(message)}`);
    if (errorLogEnabled('verbose') && err instanceof Error) console.error(`[error:verbose] ${where}`, err);
    return { message, code, ref: null };
  }

  const ref = randomBytes(4).toString('hex');
  errorLog('light', `${where} → stored INTERNAL ref=${ref} (source: rule 3, no rule matched — the error was not raised by publicFailure and is not a ValidationError, a duplicate key, a CastError, a body-parser failure or an error carrying both status and code)`);
  errorLog('normal', `${where} ref=${ref}: ${describe(err)}`);
  // The stack beside the ref, at the light tier, for the same reason the
  // middleware does it: the note says nothing, so the log has to say it all.
  if (errorLogEnabled('light')) console.error(`[error:light] ref=${ref} ${where} —`, err);

  return { message: compose('INTERNAL', ref), code: 'INTERNAL', ref };
}

/** `name: message`, for the log only. */
function describe(err) {
  if (!(err instanceof Error)) return `non-Error value ${JSON.stringify(String(err))}`;
  return `${err.name}: ${err.message}`;
}

export default describeFailure;
