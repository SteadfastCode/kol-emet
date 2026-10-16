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
 *   - everything else is INTERNAL with an eight-character ref, and the real
 *     error reaches the log under that same ref — at the light tier, which is
 *     what a deployment runs with;
 *   - no note ever contains the caught message, which is the whole point.
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
