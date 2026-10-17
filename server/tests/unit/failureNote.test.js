/**
 * `lib/failureNote.js`: the three rules that decide what a stored failure says.
 *
 * The end-to-end proof is `tests/http/draftFailure.test.js`, which drives a
 * real generation against a provider that answers 500. This file asserts the
 * table directly, including the rule that suite cannot reach through the
 * route: a Mongoose ValidationError, which is mapped rather than hidden.
 *
 * What it defends:
 *   - only `publicFailure()` can mark a sentence as publishable, so an error
 *     cannot acquire one by carrying a likely-looking property;
 *   - a mapped error publishes its code and none of the error's own text;
 *   - a *provider's* error is not a mapped one, however much it looks like it:
 *     the OpenAI client hangs an integer `status` and a string `code` from the
 *     response body on every API error it raises, which is the shape
 *     `classify()`'s rule 5 used to read as "raised on purpose" (KOL-101);
 *   - everything else is INTERNAL with an eight-character ref, and the real
 *     error reaches the log under that same ref — at the light tier, which is
 *     what a deployment runs with;
 *   - no note ever contains the caught message, which is the whole point.
 *
 * Falsification check: drop the `RAISED_HERE` test from rule 5 of
 * `src/middleware/errorHandler.js` and the provider group fails naming the
 * dependency's own code in the note it found.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_FAILURE_NOTE_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per note produced, naming the rule it came from
 *   verbose — light, plus every line the module logged while producing it
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
// The real client, not a hand-written stand-in: the whole point is the shape
// *this dependency* produces, which a literal here would only be a guess at.
import { APIError } from 'openai';

// The module reads ERROR_LOG_LEVEL per call, so this is set before the first.
process.env.ERROR_LOG_LEVEL = 'light';

const { describeFailure, publicFailure } = await import('../../src/lib/failureNote.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };
function log(level, msg) {
  const active = LEVELS[process.env.TEST_FAILURE_NOTE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/failureNote:${level}] ${msg}`);
}

/** The driver's text, in the shape that made this item: credentials and a host. */
const LEAK = 'MongoServerSelectionError: connect ECONNREFUSED mongodb://wiki:hunter2@cluster0.internal.invalid:27017';

/** Runs `fn` with console.log and console.error collected rather than printed. */
function captured(fn) {
  const lines = [];
  const realLog = console.log;
  const realError = console.error;
  const collect = (...args) => lines.push(args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '));
  console.log = collect;
  console.error = collect;
  try {
    return { value: fn(), lines };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

function note(err) {
  const { value, lines } = captured(() => describeFailure(err, 'a test'));
  log('light', `${JSON.stringify(value)}`);
  for (const line of lines) log('verbose', `log: ${line}`);
  return { ...value, lines };
}

describe('rule 1 — a refusal written on purpose', () => {
  test('publishes its own sentence and code, and indexes no log line', () => {
    const n = note(publicFailure('GENERATOR_NOT_CONFIGURED', 'No AI provider is configured on the server'));
    assert.equal(n.message, 'No AI provider is configured on the server');
    assert.equal(n.code, 'GENERATOR_NOT_CONFIGURED');
    assert.equal(n.ref, null);
  });

  test('carries the extras it was given, so a blocked apply is still blocked', () => {
    const err = publicFailure('APPLY_TOO_FEW_MEMBERS', 'Fewer than 2 resolvable members', { blocked: true });
    assert.equal(err.blocked, true);
    assert.equal(note(err).code, 'APPLY_TOO_FEW_MEMBERS');
  });

  test('a message is publishable only because publicFailure said so', () => {
    // The same sentence on an ordinary error is withheld: the mark is the
    // claim, and nothing acquires it by looking like it should have one.
    const err = new Error('No AI provider is configured on the server');
    err.code = 'GENERATOR_NOT_CONFIGURED';
    const n = note(err);
    assert.equal(n.code, 'INTERNAL');
    assert.ok(!n.message.includes('AI provider'), `withheld, not echoed: ${n.message}`);
  });
});

describe('rule 2 — an error the shared table maps', () => {
  test('a ValidationError publishes its code, not its paths or its prose', () => {
    const schema = new mongoose.Schema({ title: { type: String, required: true } });
    const Thing = mongoose.model(`FailureNoteThing${Date.now()}`, schema);
    const err = new Thing({}).validateSync();
    assert.equal(err.name, 'ValidationError');

    const n = note(err);
    assert.equal(n.code, 'VALIDATION_FAILED');
    assert.equal(n.ref, null);
    assert.equal(n.message, 'What this produced did not pass validation. (VALIDATION_FAILED)');
    assert.ok(!n.message.includes('validation failed'), 'the driver\'s wording stays out');
  });

  test('a duplicate key publishes DUPLICATE and no index, collection or value', () => {
    const err = Object.assign(new Error('E11000 duplicate key error collection: kol_emet.users index: email_1 dup key: { email: "a@b.test" }'), {
      code: 11000,
      keyPattern: { email: 1 },
      keyValue: { email: 'a@b.test' },
    });
    const n = note(err);
    assert.equal(n.code, 'DUPLICATE');
    for (const fragment of ['E11000', 'kol_emet.users', 'email_1', 'a@b.test']) {
      assert.ok(!n.message.includes(fragment), `"${fragment}" must not be in ${n.message}`);
    }
  });
});

describe('rule 3 — anything else', () => {
  test('withholds the error and hands back a ref to quote', () => {
    const n = note(new Error(LEAK));
    assert.equal(n.code, 'INTERNAL');
    assert.match(n.ref, /^[0-9a-f]{8}$/);
    assert.equal(n.message, `Something went wrong on the server. (INTERNAL, ref ${n.ref})`);
    for (const fragment of ['hunter2', 'cluster0.internal.invalid', 'ECONNREFUSED']) {
      assert.ok(!n.message.includes(fragment), `"${fragment}" must not be in ${n.message}`);
    }
  });

  test('writes the real error to the log beside that ref, at the light tier', () => {
    const n = note(new Error(LEAK));
    assert.ok(n.lines.some(l => l.includes(n.ref)), `the ref should be logged: ${n.lines.join('\n')}`);
    assert.ok(n.lines.some(l => l.includes('hunter2')), `the reason survives in the log: ${n.lines.join('\n')}`);
  });

  test('a thrown non-Error is a note, not a crash', () => {
    const n = note('a string nobody should see');
    assert.equal(n.code, 'INTERNAL');
    assert.ok(!n.message.includes('nobody should see'));
  });

  test('each failure gets its own ref', () => {
    assert.notEqual(note(new Error('one')).ref, note(new Error('two')).ref);
  });
});

/**
 * The three ways a real generation dies, as the OpenAI client raises them —
 * `status` off the response, `code` straight out of the body. Every provider in
 * the registry is reached through this client, Anthropic and Google included,
 * so this is not an OpenAI-only shape.
 */
const PROVIDER_FAILURES = [
  { status: 401, code: 'invalid_api_key', type: 'invalid_request_error',
    message: `Incorrect API key provided: sk-live-TOPSECRET. ${LEAK}` },
  { status: 429, code: 'insufficient_quota', type: 'insufficient_quota',
    message: `You exceeded your current quota. ${LEAK}` },
  { status: 400, code: 'context_length_exceeded', type: 'invalid_request_error',
    message: `This model's maximum context length is 8192 tokens. ${LEAK}` },
];

/** One error, built by the dependency from the body a provider really sends. */
function providerError({ status, code, type, message }) {
  const err = APIError.generate(status, { error: { message, type, code } }, undefined, new Headers());
  // Guards the premise of the whole group: if a client upgrade stopped hanging
  // this pair on its errors, these tests would pass for the wrong reason.
  assert.equal(err.status, status, 'the client sets an integer status');
  assert.equal(err.code, code, 'and a string code, from the response body');
  return err;
}

describe('rule 3 — a provider error, which is not rule 2 however much it looks like one', () => {
  for (const failure of PROVIDER_FAILURES) {
    test(`${failure.code} is INTERNAL with a ref, not the provider's own code`, () => {
      const n = note(providerError(failure));

      assert.equal(n.code, 'INTERNAL',
        `a dependency's string is not a code this API chose, and not one a client can branch on: ${n.code}`);
      assert.match(n.ref, /^[0-9a-f]{8}$/, 'and the failure is indexed, because the note says nothing');
      assert.equal(n.message, `Something went wrong on the server. (INTERNAL, ref ${n.ref})`);
      assert.ok(!n.message.includes(failure.code), `the provider's code must not be published: ${n.message}`);
    });

    test(`${failure.code} keeps the provider's sentence out of the note and in the log`, () => {
      const n = note(providerError(failure));

      for (const fragment of ['hunter2', 'cluster0.internal.invalid', 'sk-live-TOPSECRET', 'context length']) {
        assert.ok(!n.message.includes(fragment), `"${fragment}" must not be in ${n.message}`);
      }

      // The other half of the trade, and the half this item was really about:
      // at the *light* tier — what a deployment runs — rule 2 logged nothing
      // but a code, so the commonest real failure left no account of itself.
      assert.ok(n.lines.some(l => l.includes(n.ref)), `the ref should be logged: ${n.lines.join('\n')}`);
      assert.ok(n.lines.some(l => l.includes('hunter2')),
        `the reason has to survive in the log, at light: ${n.lines.join('\n')}`);
      assert.ok(n.lines.some(l => l.includes('rule 3')),
        `and the light line names the rule that chose it: ${n.lines.join('\n')}`);
    });
  }

  test('a connection error, which carries no status at all, is the same answer', () => {
    // The other common one: the provider was unreachable. `APIConnectionError`
    // has `status: undefined`, so it never satisfied rule 5 — asserted so the
    // group covers both halves of what a dead provider produces.
    const err = APIError.generate(undefined, undefined, LEAK, undefined);
    const n = note(err);
    assert.equal(n.code, 'INTERNAL');
    assert.match(n.ref, /^[0-9a-f]{8}$/);
  });
});

describe('a refusal this codebase raised with httpError still maps', () => {
  test('because httpError marks its own, which is what rule 5 now reads', async () => {
    const { httpError } = await import('../../src/middleware/errorHandler.js');
    const n = note(httpError(503, 'EXPORT_NOT_CONFIGURED'));

    assert.equal(n.code, 'EXPORT_NOT_CONFIGURED', 'a code of ours is still published');
    assert.equal(n.ref, null, 'and it is mapped, so there is no log line to index');
    assert.equal(n.message, 'Something went wrong on the server. (EXPORT_NOT_CONFIGURED)');
  });
});
