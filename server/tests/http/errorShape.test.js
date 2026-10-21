/**
 * One error shape for the API, instead of the database's own error text.
 *
 * Fifty-nine handlers across twelve routers used to end in
 * `catch (err) { res.status(500).json({ error: err.message }) }` or its 400
 * variant, and `createApp` installed no error middleware at all — so whatever
 * Mongoose or the driver said reached the caller verbatim. KOL-075 made every
 * one of those catches `next(err)` and put the shape in one place,
 * `src/middleware/errorHandler.js`.
 *
 * What this file defends:
 *   - a write that fails schema validation is **400 `VALIDATION_FAILED`** whose
 *     `fields` are our own schema paths, and whose body contains neither
 *     `validation failed` nor the model's name;
 *   - a **real** duplicate-key error from mongod is **409 `DUPLICATE`** with
 *     the index's key names and none of the colliding values, and no `E11000`,
 *     no collection and no index name anywhere in the body;
 *   - a route forced to throw something nobody mapped is **500 `INTERNAL`**
 *     with a `ref` and no `message` — and that same `ref` is in the captured
 *     server log, beside the real stack, which is the whole trade: the body
 *     says nothing, so the log has to say everything;
 *   - an `httpError()` becomes exactly the status and code it names, which is
 *     how a route raises a coded refusal from inside a helper — and that the
 *     mark it carries, not the shape, is what rule 5 reads: a **provider SDK
 *     error** carrying the very same pair (the OpenAI client sets `status` from
 *     the response and `code` from its body) is a 500 with a `ref`, not that
 *     dependency's string published as a code of this API's (KOL-101);
 *   - and that the mark is **not copied** onto an error this code did not
 *     raise. `Object.assign` and object spread both copy own *enumerable*
 *     symbol-keyed properties, so the plain assignment KOL-101 shipped did
 *     carry the mark across a copy, against the guarantee written over it;
 *     `httpError()` now sets it non-enumerably, and the cases that prove it
 *     copy a *marked* error rather than build an unmarked lookalike, which is
 *     why the old group could not fail on this (KOL-108);
 *   - a `CastError` is 400 `INVALID_VALUE` and not a 500, because those routes
 *     answered 400 for an uncastable value before this middleware existed and
 *     KOL-075 moves no status a route chose deliberately;
 *   - a body **body-parser could not read** keeps the status body-parser chose
 *     — 400 `MALFORMED_JSON`, 413 `BODY_TOO_LARGE`, 415
 *     `UNSUPPORTED_ENCODING` — rather than the 500 `INTERNAL` it answered
 *     between KOL-075 and KOL-099, because those errors carry a `status` and a
 *     `type` but no string `code` for rule 5 to read;
 *   - and that the table those statuses come from still covers **every failure
 *     type body-parser and raw-body can raise**, asserted against their own
 *     sources, so a dependency upgrade that adds one is named here instead of
 *     quietly answering 500;
 *   - and, as a sweep over the source rather than over responses, that **no
 *     file under `src/routes/` or `src/middleware/` passes `err.message` into
 *     a response body** — so the sweep cannot quietly regress one catch at a
 *     time, which is the only way fifty-nine of them appeared in the first
 *     place.
 *   - and that no file under `src/routes/`, `src/middleware/` or `src/lib/`
 *     **writes a caught message into a field instead**, which is the same leak
 *     with a delay: `POST /drafts` stored `err.message` on the draft and
 *     `GET /drafts/:id` returns the whole document, so the provider's own HTTP
 *     body reached a caller in a plain JSON response a request later (KOL-100);
 *   - and that both of those walks read **subdirectories too**. They used a
 *     flat `readdirSync` and so skipped `src/lib/producers/` whole — the one
 *     directory the ParseError gate below carves its exception out for, and
 *     therefore the one place a caught `YAMLParseError` or a driver string
 *     could have been published with both sweeps green. A floor on a file
 *     count cannot notice a missing directory, so the coverage assertions name
 *     the producers (KOL-106).
 *
 * Falsification check: drop the `RAISED_HERE` test from rule 5 and the provider
 * group fails: `classify()` maps an error nobody here raised, and
 * `/probe/provider` answers 401 `invalid_api_key`. Put the mark back as a plain
 * `err[RAISED_HERE] = true` and the two copy cases in that same group fail,
 * because the mark rides the copy. Drop `app.use(errorHandler)`
 * from `src/app.js` and the
 * first three groups fail (Express's own handler answers HTML and, outside
 * production, the stack). Put `err.message` back into any router's catch and
 * the source sweep fails naming the file and line; put a
 * `res.json({ error: err.message })` in `src/lib/producers/openApi.js` and the
 * stored sweep fails naming that path, which it could not do while the walk
 * was flat. Delete a row from `BODY_PARSER_RULES` and two groups fail — one on
 * the response, one on the coverage of the dependencies' own types.
 *
 * Why a second, bare app for three of the cases: a duplicate key, an explicit
 * coded error and an unmapped throw are all *reachable* in the deployment but
 * none is reachable *on demand* through a route — every route that could
 * collide on a unique index pre-checks for the collision first, which is
 * correct and must stay. So those are driven through routes that exist only
 * here, mounted in front of the real `errorHandler`. The errors themselves are
 * real: the duplicate comes from mongod rejecting a second insert, not from a
 * hand-written object with `code: 11000`.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_ERROR_SHAPE_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture, naming what created it
 *   normal  — light, plus every probe, its status and body
 *   verbose — normal, plus the server log captured around each probe
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import express from 'express';
// The real client, so the error whose shape this suite turns on is built by the
// dependency that produces it rather than guessed at with a literal.
import { APIError } from 'openai';
import mongoose from 'mongoose';
import session from 'express-session';
import request from 'supertest';

// Every session write is checked against CLIENT_ORIGIN (src/middleware/originGuard.js),
// so this suite names one below and its agents send a matching Origin.
import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';

import * as db from '../helpers/db.js';
// Registration is throttled per client address, and this suite registers its
// fixtures through the real endpoint from one address. See the helper.
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import User from '../../src/models/User.js';
import Entity from '../../src/models/Entity.js';
import Workspace from '../../src/models/Workspace.js';

// Environment before src/app.js is imported, for the reasons in tenancy.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
// Unset on purpose: with no bearer token configured a stray Authorization
// header cannot resolve to the MCP user and quietly satisfy requireAuth.
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.WORKSPACE_LOG_LEVEL ??= 'off';
// The handler under test, at its default tier — the `ref` assertion below is
// specifically that the *light* tier carries it, since that is what a
// deployment runs with.
process.env.ERROR_LOG_LEVEL = 'light';

const { createApp } = await import('../../src/app.js');
const { errorHandler, httpError, classify, BODY_PARSER_RULES, BODY_PARSER_OURS } =
  await import('../../src/middleware/errorHandler.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  const active = LEVELS[process.env.TEST_ERROR_SHAPE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/errorShape:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

/** Repo-relative root of the server package, for the source sweep. */
const SERVER_ROOT = path.resolve(import.meta.dirname, '../..');

let app;
let probe;
let alice;

/**
 * Runs `fn` with console.log and console.error collected rather than printed,
 * and hands back both the result and every line.
 *
 * Both streams, because the handler deliberately splits them: the one-line
 * summary goes to console.log through its tiered logger and the stack to
 * console.error, so a test that captured only one would miss half the trade.
 */
async function capturingLog(fn) {
  const lines = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

/** Registers through the real endpoint and reads back the ids it created. */
async function registerUser(email) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  log('light', `registered ${email} (source: POST /auth/register) → workspace ${workspace._id}`);
  return { agent, email, userId: String(user._id), workspaceId: String(workspace._id) };
}

/**
 * Routes that reach the real `errorHandler` with errors no route can be made to
 * produce on demand. See the file comment for why this app exists.
 */
function buildProbeApp() {
  const DUP = 'duplicate@example.test';
  const probeApp = express();
  probeApp.use(express.json());

  // A real duplicate key, from mongod: User.email is unique, so the second
  // insert is rejected by the index rather than by anything in this file.
  probeApp.get('/probe/duplicate', async (req, res, next) => {
    try {
      await User.create({ email: DUP, passwordHash: 'not-a-real-hash' });
      await User.create({ email: DUP, passwordHash: 'not-a-real-hash' });
      res.json({ ok: 'the unique index on User.email did not fire' });
    } catch (err) { next(err); }
  });

  // A coded refusal raised from inside a helper, the way routes/drafts.js
  // raises one for an unconfigured export.
  probeApp.get('/probe/explicit', (req, res, next) => {
    next(httpError(503, 'EXPORT_NOT_CONFIGURED'));
  });

  // A bare CastError: a filter value Mongoose cannot cast, which is what a
  // `findOneAndUpdate(…, { runValidators: true })` throws instead of a
  // ValidationError.
  probeApp.get('/probe/cast', async (req, res, next) => {
    try {
      await Entity.countDocuments({ workspaceId: 'not-an-object-id' });
      res.json({ ok: 'the cast did not fail' });
    } catch (err) { next(err); }
  });

  // The case the whole item is about: something nobody mapped, whose message
  // is exactly what must never be published.
  probeApp.get('/probe/opaque', (req, res, next) => {
    next(new Error(`connection pool destroyed for ${SECRET_URI}`));
  });

  // An error from the AI client every provider in the registry is reached
  // through, raised the way a wrong key really raises one. Reachable in the
  // deployment but not on demand through a route, like the three above.
  probeApp.get('/probe/provider', (req, res, next) => {
    next(providerError(PROVIDER_FAILURES[0]));
  });

  probeApp.use(errorHandler);
  return probeApp;
}

/** Stands in for the connection string a pool error would carry. */
const SECRET_URI = 'mongodb+srv://kolemet:s3cr3t-pa55@cluster0.example.net/kol_emet';

/**
 * The three ways a generation really dies, as bodies the provider sends back.
 * Every one carries a `code`, which is the half rule 5 used to read as proof
 * that this codebase had raised the error itself.
 */
const PROVIDER_FAILURES = [
  { status: 401, code: 'invalid_api_key', type: 'invalid_request_error', message: 'Incorrect API key provided: sk-live-TOPSECRET' },
  { status: 429, code: 'insufficient_quota', type: 'insufficient_quota', message: 'You exceeded your current quota' },
  { status: 400, code: 'context_length_exceeded', type: 'invalid_request_error', message: "This model's maximum context length is 8192 tokens" },
];

/** One of those bodies, turned into an error by the client that would raise it. */
function providerError({ status, code, type, message }) {
  const err = APIError.generate(status, { error: { message, type, code } }, undefined, new Headers());
  // The premise of the group below: if an SDK upgrade stopped hanging this pair
  // on its errors, those tests would pass without testing anything.
  assert.equal(err.status, status, 'the client sets an integer status');
  assert.equal(err.code, code, 'and a string code, read out of the response body');
  return err;
}

before(async () => {
  await db.connect();
  app = createApp({
    sessionStore: new session.MemoryStore(),
    authLimits: SUITE_AUTH_LIMITS,
  });
  probe = buildProbeApp();
});

beforeEach(async () => {
  await db.clear();
  // db.clear() resyncs indexes only when there were collections to drop, and
  // the duplicate-key group depends on the unique index on User.email being
  // there — so it is asked for explicitly rather than inherited.
  await User.syncIndexes();
  alice = await registerUser('alice@example.test');
});

after(async () => {
  await db.disconnect();
});

describe('a failed schema validation', () => {
  test('is 400 VALIDATION_FAILED naming our own schema paths', async () => {
    // Passes every hand-written check POST /entities makes (no blocks to
    // validate) and fails only in Mongoose: category and summary are required.
    const res = await alice.agent.post('/entities').send({ title: 'A title and nothing else' });

    log('normal', `POST /entities (missing required fields) → ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.status, 400, `a missing required field is the caller's mistake: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'VALIDATION_FAILED');
    assert.deepEqual(res.body.fields, ['category', 'summary'],
      'fields must be the schema paths a client needs in order to mark the inputs');
  });

  test('publishes neither Mongoose\'s sentence nor the model name', async () => {
    const res = await alice.agent.post('/entities').send({ title: 'A title and nothing else' });
    const body = JSON.stringify(res.body);

    assert.doesNotMatch(body, /validation failed/i, `Mongoose's own sentence must not be in the body: ${body}`);
    assert.doesNotMatch(body, /\bEntity\b/, `the model name must not be in the body: ${body}`);
    assert.equal(res.body.message, undefined, `no message key at all: ${body}`);
    assert.deepEqual(Object.keys(res.body).sort(), ['error', 'fields'], `the shape is exactly { error, fields }: ${body}`);
  });
});

describe('a duplicate unique value', () => {
  test('is 409 DUPLICATE with the index key names', async () => {
    const res = await request(probe).get('/probe/duplicate');

    log('normal', `GET /probe/duplicate → ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.status, 409, `a collision is neither a 500 nor a 400: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'DUPLICATE');
    assert.deepEqual(res.body.fields, ['email'], 'the index\'s key names, so a client can mark the field');
  });

  test('publishes no E11000, no collection, no index name and no colliding value', async () => {
    const res = await request(probe).get('/probe/duplicate');
    const body = JSON.stringify(res.body);

    assert.doesNotMatch(body, /E11000/, body);
    assert.doesNotMatch(body, /duplicate key/i, body);
    assert.doesNotMatch(body, /index:/i, body);
    assert.doesNotMatch(body, /duplicate@example\.test/, `keyValue holds the colliding value and must not be published: ${body}`);
  });
});

describe('an error nobody mapped', () => {
  test('is 500 INTERNAL with a ref and nothing else', async () => {
    const { result: res } = await capturingLog(() => request(probe).get('/probe/opaque'));

    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'INTERNAL');
    assert.match(res.body.ref ?? '', /^[0-9a-f]{8}$/, `a short ref a user can quote: ${JSON.stringify(res.body)}`);
    assert.deepEqual(Object.keys(res.body).sort(), ['error', 'ref'], `exactly { error, ref }: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.message, undefined);
    assert.equal(res.body.stack, undefined);
  });

  test('publishes nothing about the deployment', async () => {
    const { result: res } = await capturingLog(() => request(probe).get('/probe/opaque'));
    const body = JSON.stringify(res.body);

    assert.doesNotMatch(body, /mongodb/i, `a pool error's connection string must not leave the box: ${body}`);
    assert.doesNotMatch(body, /s3cr3t/, body);
    assert.doesNotMatch(body, /example\.net/, body);
  });

  test('writes that same ref to the log, beside the real stack, at the light tier', async () => {
    const { result: res, lines } = await capturingLog(() => request(probe).get('/probe/opaque'));
    const { ref } = res.body;

    log('verbose', `captured ${lines.length} log line(s): ${JSON.stringify(lines, null, 2)}`);

    const withRef = lines.filter(line => line.includes(ref));
    assert.ok(withRef.length >= 1, `the ref a user would quote must appear in the log: ${JSON.stringify(lines)}`);

    // The light tier's summary says which rule chose the status, not just the
    // status — a 500 whose reason is only "500" is the defect, one tier down.
    const summary = withRef.find(line => line.includes('500 INTERNAL'));
    assert.ok(summary, `one line must carry the status and the code: ${JSON.stringify(withRef)}`);
    assert.match(summary, /source: rule 7/, `the light tier names the rule that chose it: ${summary}`);
    assert.match(summary, /GET \/probe\/opaque/, `and the route it came from: ${summary}`);

    // And the thing the body withheld is on the log, keyed by the same ref.
    const stack = withRef.find(line => line.includes(SECRET_URI));
    assert.ok(stack, `the real error must be logged beside the ref: ${JSON.stringify(withRef)}`);
  });

  test('says nothing at all when ERROR_LOG_LEVEL is off', async () => {
    const before = process.env.ERROR_LOG_LEVEL;
    process.env.ERROR_LOG_LEVEL = 'off';
    try {
      const { result: res, lines } = await capturingLog(() => request(probe).get('/probe/opaque'));
      assert.equal(res.status, 500, 'the answer is unchanged by the log tier');
      assert.deepEqual(lines, [], `"off" means the stack too: ${JSON.stringify(lines)}`);
    } finally {
      process.env.ERROR_LOG_LEVEL = before;
    }
  });
});

describe('an error carrying an explicit status and code', () => {
  test('becomes exactly those', async () => {
    const res = await request(probe).get('/probe/explicit');

    log('normal', `GET /probe/explicit → ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { error: 'EXPORT_NOT_CONFIGURED' });
  });
});

describe('an uncastable value', () => {
  test('is 400 INVALID_VALUE and not a 500, keeping the status those routes chose', async () => {
    const res = await request(probe).get('/probe/cast');

    log('normal', `GET /probe/cast → ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.status, 400, `a value the caller sent: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'INVALID_VALUE');
    assert.deepEqual(res.body.fields, ['workspaceId']);
    assert.doesNotMatch(JSON.stringify(res.body), /Cast to/, 'no cast path, no model name');
  });
});

describe('a body the parser could not read', () => {
  // Driven through the real app, not the probe app: the defect was in the
  // app-wide `express.json()`, which runs ahead of every router — and ahead of
  // the session middleware — so no probe route can stand in for it.
  const MALFORMED = '{"title": "unterminated';

  test('malformed JSON is 400 MALFORMED_JSON rather than 500 INTERNAL', async () => {
    const res = await alice.agent.post('/entities').type('json').send(MALFORMED);

    log('normal', `POST /entities (malformed JSON) → ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.status, 400,
      `bytes the caller sent are the caller's mistake, and were a 400 before this middleware existed: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { error: 'MALFORMED_JSON' });
    assert.equal(res.body.ref, undefined, 'a client mistake is not a server fault and gets no ref');
  });

  test('publishes neither the parser\'s sentence nor the bytes it choked on', async () => {
    const res = await alice.agent.post('/entities').type('json').send(MALFORMED);
    const body = JSON.stringify(res.body);

    assert.doesNotMatch(body, /SyntaxError/i, body);
    assert.doesNotMatch(body, /unexpected/i, `the parser's own sentence stays in the log: ${body}`);
    assert.doesNotMatch(body, /position/i, body);
    assert.doesNotMatch(body, /unterminated/, `nor the body it was handed: ${body}`);
    assert.doesNotMatch(body, /entity\.parse\.failed/, `nor the dependency's type string: ${body}`);
    assert.deepEqual(Object.keys(res.body), ['error'], `the shape is exactly { error }: ${body}`);
  });

  test('a body over the app-wide limit is 413 BODY_TOO_LARGE, and the limit is not published', async () => {
    // Over `express.json()`'s 100 kB default. Valid JSON: the refusal happens
    // while reading, before anything is parsed.
    const oversized = JSON.stringify({ title: 'x'.repeat(200 * 1024), category: 'Characters', summary: 'big' });
    const res = await alice.agent.post('/entities').type('json').send(oversized);

    log('normal', `POST /entities (${oversized.length} bytes) → ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.status, 413, `an over-limit body is a 413, not a 500: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { error: 'BODY_TOO_LARGE' });
    assert.doesNotMatch(JSON.stringify(res.body), /\d|limit/i,
      'the configured limit is a deployment detail and stays out of the body');
  });

  test('an unsupported Content-Encoding is 415 UNSUPPORTED_ENCODING', async () => {
    const res = await alice.agent.post('/entities').type('json').set('Content-Encoding', 'br').send('{}');

    log('normal', `POST /entities (Content-Encoding: br) → ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.status, 415, `an encoding this server cannot read is a 415: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { error: 'UNSUPPORTED_ENCODING' });
  });

  test('the light tier names the parser type that chose the status', async () => {
    const { result: res, lines } = await capturingLog(() =>
      alice.agent.post('/entities').type('json').send(MALFORMED));

    log('verbose', `captured ${lines.length} log line(s): ${JSON.stringify(lines, null, 2)}`);
    assert.equal(res.status, 400);

    const summary = lines.find(line => line.includes('400 MALFORMED_JSON'));
    assert.ok(summary, `one line must carry the status and the code: ${JSON.stringify(lines)}`);
    assert.match(summary, /source: body-parser entity\.parse\.failed/,
      `and the source of the change, not just the number it produced: ${summary}`);
    assert.match(summary, /POST \/entities/, `and the route it came from: ${summary}`);
  });
});

/** body-parser's and raw-body's own sources, resolved rather than guessed at. */
function parserSourceFiles() {
  const resolve = createRequire(import.meta.url);
  const files = [resolve.resolve('raw-body')];
  const stack = [path.join(path.dirname(resolve.resolve('body-parser')), 'lib')];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (abs.endsWith('.js')) files.push(abs);
    }
  }
  return files;
}

describe('the body-parser table', () => {
  test('every entry answers its own status and code', () => {
    for (const [type, expected] of Object.entries(BODY_PARSER_RULES)) {
      // `status: 999` on purpose: the table's status must win over whatever the
      // error object itself claims, which is the same reason rule 5 is strict.
      const mapped = classify(Object.assign(new Error('a dependency\'s own sentence'), { type, status: 999 }));

      assert.ok(mapped, `${type} must be mapped, or it is a 500`);
      assert.equal(mapped.status, expected.status, `${type} answers the table's status, not the error's`);
      assert.deepEqual(mapped.body, { error: expected.code }, `${type} answers our code, not the dependency's type`);
      assert.equal(mapped.rule, `body-parser ${type}`, `the log line names the type: ${mapped.rule}`);
    }
  });

  test('the types that mean this code misconfigured a stream stay a 500', () => {
    for (const type of BODY_PARSER_OURS) {
      const err = Object.assign(new Error('stream misconfigured'), { type, status: 500 });
      assert.equal(classify(err), null, `${type} is this code's mistake, so 500 INTERNAL is the honest answer`);
    }
  });

  test('covers every failure type body-parser and raw-body can raise', () => {
    const found = new Set();
    for (const file of parserSourceFiles()) {
      for (const m of readFileSync(file, 'utf8').matchAll(/type:\s*(?:[\w.]+\s*\|\|\s*)?'([^']+)'/g)) {
        found.add(m[1]);
      }
    }
    log('light', `body-parser and raw-body raise ${found.size} type(s) (source: their own sources): ${[...found].sort().join(', ')}`);

    // A sweep that matched nothing would pass forever.
    assert.ok(found.size >= 8,
      `the walk over the two dependencies' sources found ${found.size} type(s) — the walk is broken, not the table`);

    const accounted = new Set([...Object.keys(BODY_PARSER_RULES), ...BODY_PARSER_OURS]);
    const unaccounted = [...found].filter(type => !accounted.has(type)).sort();
    assert.deepEqual(unaccounted, [],
      'a body-parser upgrade raises a failure type nobody mapped, so it answers 500 INTERNAL with a ref for what is ' +
      'probably the caller\'s mistake. Put it in BODY_PARSER_RULES with a status and a code of ours, or in ' +
      'BODY_PARSER_OURS if it means this code misconfigured a stream:\n' + unaccounted.join('\n'));

    const stale = Object.keys(BODY_PARSER_RULES).filter(type => !found.has(type)).sort();
    assert.deepEqual(stale, [],
      `the table maps a type the dependencies no longer raise: ${stale.join(', ')}`);
  });
});

describe('a route that answers deliberately', () => {
  test('still answers its own sentence, untouched by the middleware', async () => {
    // KOL-075 swept the catch-alls and nothing else: a refusal a route wrote on
    // purpose is part of its contract. One of each, so a regression that routed
    // these through the error handler would be caught here and not only in the
    // suites that own them.
    const notFound = await alice.agent.get(`/entities/${new mongoose.Types.ObjectId()}`);
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.error, 'Not found');

    const malformed = await alice.agent.get('/entities/not-an-id');
    assert.equal(malformed.status, 400, 'KOL-069 answers before the route runs');
    assert.equal(malformed.body.error, 'INVALID_ID');

    const unauthorized = await request(app).get('/entities');
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.error, 'Unauthorized');

    const badName = await alice.agent.patch('/workspace').send({ name: '   ' });
    assert.equal(badName.status, 400);
    assert.equal(badName.body.error, 'INVALID_WORKSPACE_NAME');
  });
});

// ─── The source sweep ─────────────────────────────────────────────────────────

/**
 * Comments out, so a file that *describes* the defect in prose — this item's
 * middleware does, at length — is not read as committing it.
 *
 * Crude on purpose: it is not a parser, and a `//` inside a string literal
 * would truncate that statement. The failure mode that costs something is a
 * false *pass*, and truncating a statement can only shorten what is searched
 * for a `res.json` plus a `.message` in the same breath — both of which are in
 * the first few tokens of the statement, before any URL.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Statements, roughly: enough to tell "one call" from "the next line". */
function statements(source) {
  return stripComments(source).split(';');
}

/** A call that writes a response body. */
const RESPONSE_CALL = /\bres\s*\.\s*(?:status\s*\([^)]*\)\s*\.\s*)?(?:json|jsonp|send)\s*\(/;

/** Anything read off a caught error's message. */
const A_MESSAGE = /\berr(?:or)?\s*(?:\?)?\.\s*message\b|\be\s*(?:\?)?\.\s*message\b/;

/**
 * routes/bridge.js and routes/mcp.js are out of scope and stay out: both answer
 * JSON-RPC error objects on their own protocol, which is KOL-047's subject, and
 * neither calls `next(err)`. Listed here rather than silently skipped so that
 * adding a third exemption is a decision somebody makes on purpose.
 *
 * Matched on the path from the server root rather than on the bare filename,
 * so an exemption written for a router cannot silently cover a same-named file
 * in a subdirectory the walk now reaches (KOL-106).
 */
const OUT_OF_SCOPE = new Set(['src/routes/bridge.js', 'src/routes/mcp.js']);

/**
 * A caught message being written INTO something rather than answered with:
 * `item.applyError = err.message`, `{ error: err.message }`.
 *
 * The response sweep above cannot see this. `POST /drafts` stored
 * `err.message` on the draft and `GET /drafts/:id` returns the whole
 * document, so the provider's HTTP body reached a caller in a plain JSON
 * response one request later — a leak made of an assignment, on a route the
 * SSE exemption does not cover (KOL-100). Anything stored goes through
 * `lib/failureNote.js`, which publishes a code and keeps the text for the log.
 */
const STORED_MESSAGE = /(?:\.\s*\w+|\b\w+)\s*(?:=|:)\s*(?:err(?:or)?|e)\s*\??\.\s*message\b/;

/**
 * The two places a caught message is still written into a value, each because
 * it reaches no stored document and no response body:
 *
 *   - `routes/chat.js` puts it on an SSE `error` frame. Streamed failures are
 *     the scope KOL-075 deliberately left alone, and chat stores nothing;
 *     `POST /drafts` is in the sweep because its frame is *also* a row.
 *   - `lib/workspaceSeeder.js` returns it to its one caller, `routes/auth.js`,
 *     which hands it to console.error and answers 201 regardless.
 *
 * Listed rather than silently skipped, so a third is somebody's decision, and
 * matched on the same whole path as `OUT_OF_SCOPE`.
 */
const STORED_EXEMPT = new Set(['src/routes/chat.js', 'src/lib/workspaceSeeder.js']);

/** The response sweep exempts nothing: chat.js is in it, only its frames are out. */
const NO_EXEMPTIONS = new Set();

/**
 * Every `.js` file under `dirs`, recursively — the same walk
 * `parserSourceFiles()` already does over body-parser's own `lib`, which is
 * why this one being flat was one loop out of step with its neighbour.
 *
 * `rel` is the path from the server root and it is what both exemption sets
 * are read with, so an exemption is a decision about one file and not about a
 * name that a subdirectory could reuse.
 */
function walkSources(dirs, exempt) {
  const files = [];
  for (const dir of dirs) {
    const stack = [dir];
    while (stack.length) {
      const relDir = stack.pop();
      for (const entry of readdirSync(path.join(SERVER_ROOT, relDir), { withFileTypes: true })) {
        const rel = `${relDir}/${entry.name}`;
        if (entry.isDirectory()) { stack.push(rel); continue; }
        if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
        if (OUT_OF_SCOPE.has(rel) || exempt.has(rel)) continue;
        files.push({ rel, source: readFileSync(path.join(SERVER_ROOT, rel), 'utf8') });
      }
    }
  }
  return files;
}

/**
 * Routers, middleware AND libs: the applier that writes `applyError` is a lib,
 * and so are the producers under `src/lib/producers/` that this walk reaching
 * subdirectories finally reads (KOL-106).
 */
function writingFiles() {
  return walkSources(['src/routes', 'src/middleware', 'src/lib'], STORED_EXEMPT);
}

/** What answers a request directly, and everything under it. */
function sourceFiles() {
  return walkSources(['src/routes', 'src/middleware'], NO_EXEMPTIONS);
}

describe('the sweep, asserted over the source', () => {
  test('no router or middleware passes a caught message into a response body', () => {
    const offenders = [];
    for (const { rel, source } of sourceFiles()) {
      for (const statement of statements(source)) {
        if (!RESPONSE_CALL.test(statement)) continue;
        if (!A_MESSAGE.test(statement)) continue;
        offenders.push(`${rel}: ${statement.trim().replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }

    assert.deepEqual(offenders, [],
      'a caught error\'s message belongs in the log, not the response — hand the error to next(err) ' +
      'and let src/middleware/errorHandler.js choose the shape:\n' + offenders.join('\n'));
  });

  test('the one message a route may still publish is a producer\'s own parse error', () => {
    // `routes/drafts.js` answers a malformed docker-compose or OpenAPI file with
    // the parse error's message and its line number, and two suites assert that
    // wording (composeDraft.test.js, openApiDraft.test.js). That message is a
    // sentence this codebase wrote about the caller's own file — not the
    // driver's, and not about the deployment — which is the whole distinction
    // KOL-075 draws. So it stays, and this is the guard that it stays *that*:
    // every refusal built from a caught message must be gated on ParseError in
    // the same breath.
    const ungated = [];
    for (const { rel, source } of sourceFiles()) {
      for (const line of stripComments(source).split('\n')) {
        if (!/\brefuse\s*\(/.test(line)) continue;
        if (!A_MESSAGE.test(line)) continue;
        if (/instanceof ParseError/.test(line)) continue;
        ungated.push(`${rel}: ${line.trim()}`);
      }
    }

    assert.deepEqual(ungated, [],
      'a refusal built from a caught message must be gated on `err instanceof ParseError`:\n' + ungated.join('\n'));
  });

  test('no caught message is written into a field that outlives the request', () => {
    const offenders = [];
    for (const { rel, source } of writingFiles()) {
      for (const statement of statements(source)) {
        if (!STORED_MESSAGE.test(statement)) continue;
        offenders.push(`${rel}: ${statement.trim().replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }

    assert.deepEqual(offenders, [],
      'a stored failure is as public as a response body — GET /drafts/:id hands the whole document back. ' +
      'Store what src/lib/failureNote.js returns and let the log keep the error:\n' + offenders.join('\n'));
  });

  test('the stored-failure sweep reads the libs too, and the applier among them', () => {
    const names = writingFiles().map(f => f.rel);
    log('light', `the stored-failure sweep read ${names.length} file(s) (source: a recursive walk of ` +
      `src/routes, src/middleware and src/lib)`);
    log('verbose', `files read: ${[...names].sort().join(', ')}`);

    assert.ok(names.includes('src/lib/draftApplier.js'), `the applier writes applyError and must be swept: ${names.length} file(s) read`);
    assert.ok(names.includes('src/lib/failureNote.js'), 'the helper itself is swept, so it cannot leak what it exists to withhold');

    // Named, not counted. The producers sat in a subdirectory this walk did not
    // enter, and a `>= 30` floor could not notice: they are the one place whose
    // parse message a route may publish, so an unswept one could have returned
    // a YAMLParseError or a driver string with both sweeps green (KOL-106).
    for (const producer of [
      'src/lib/producers/dockerCompose.js',
      'src/lib/producers/openApi.js',
      'src/lib/producers/kubernetes.js',
      'src/lib/producers/redactSecrets.js',
    ]) {
      assert.ok(names.includes(producer),
        `${producer} is in the one directory the ParseError gate makes an exception for, so it must be swept: ${names.join(', ')}`);
    }

    assert.ok(names.length >= 30, `expected the routers, middleware and libs, got ${names.length}`);
    for (const exempt of STORED_EXEMPT) assert.ok(!names.includes(exempt), `${exempt} is exempt by path and must stay out`);
  });

  test('every router and middleware file was actually read', () => {
    // A sweep that silently matched nothing would pass forever. The count is
    // asserted loosely — a file added later should not fail this — but zero or
    // one would mean the directory walk broke.
    const files = sourceFiles();
    assert.ok(files.length >= 14, `expected the routers and middleware, got ${files.length}`);
    const names = files.map(f => f.rel);
    log('light', `the response sweep read ${names.length} file(s) (source: a recursive walk of ` +
      `src/routes and src/middleware)`);
    log('verbose', `files read: ${[...names].sort().join(', ')}`);
    for (const expected of ['src/routes/entities.js', 'src/routes/drafts.js', 'src/middleware/auth.js', 'src/middleware/workspace.js']) {
      assert.ok(names.includes(expected), `${expected} must be in the sweep: ${names.join(', ')}`);
    }
    assert.ok(!names.some(n => n.endsWith('bridge.js') || n.endsWith('mcp.js')), 'the two out-of-scope routers stay out');
  });
});

describe('an error from the AI client that carries the same status and code', () => {
  test('is not rule 5 — a shape is not provenance', () => {
    for (const failure of PROVIDER_FAILURES) {
      const mapped = classify(providerError(failure));
      assert.equal(mapped, null,
        `${failure.code} must not be mapped: a provider's own string is not a code this API chose, and it changes with the provider and the SDK version (got ${JSON.stringify(mapped)})`);
    }
  });

  test('while the same pair raised by httpError is mapped, because it is marked', () => {
    const marked = classify(httpError(503, 'EXPORT_NOT_CONFIGURED'));
    assert.ok(marked, 'httpError marks its own, which is what rule 5 reads');
    assert.equal(marked.status, 503);
    assert.deepEqual(marked.body, { error: 'EXPORT_NOT_CONFIGURED' });

    // The same shape, hand-built and unmarked, is not: the mark is the claim.
    const lookalike = Object.assign(new Error('a dependency\'s own sentence'), { status: 503, code: 'EXPORT_NOT_CONFIGURED' });
    assert.equal(classify(lookalike), null,
      'an error nobody here raised cannot acquire rule 5 by carrying the right two properties');
  });

  test('and neither is a copy of a marked error, because the mark does not copy', () => {
    // The sentence over `RAISED_HERE` promises the mark cannot arrive by
    // accident — "not a property copied across by `Object.assign`". That
    // quarter of it was false until KOL-108: `Object.assign` and object spread
    // both copy own *enumerable* symbol-keyed properties, so a plain
    // `err[RAISED_HERE] = true` rode along onto whatever a future
    // `Object.assign(new Error('wrapped'), err)` built, and the wrapper would
    // then publish its own `status` and `code` as though this codebase had
    // chosen them — the one leak rule 5 exists to stop. The case above cannot
    // fail on that, because it builds a fresh *unmarked* literal; these two
    // copy a marked error, each of the two ways.
    const raised = httpError(503, 'EXPORT_NOT_CONFIGURED');
    log('light', 'the copy fixtures are copied from a real httpError(503, EXPORT_NOT_CONFIGURED), not hand-built');

    const wrapped = Object.assign(new Error('a dependency\'s own sentence'), raised);
    assert.equal(wrapped.status, 503, 'the premise: a copy does carry the shape, status and code both');
    assert.equal(wrapped.code, 'EXPORT_NOT_CONFIGURED');
    assert.equal(classify(wrapped), null,
      'Object.assign from a marked error must not carry the mark: the wrapper is not what this code raised');

    const spread = { ...raised };
    assert.equal(spread.status, 503, 'likewise a spread, which copies own enumerable symbol keys too');
    assert.equal(classify(spread), null,
      'object spread from a marked error must not carry the mark either');

    // And rule 5 still reads the mark where it is meant to, `fields` included,
    // so the fix cannot have passed by breaking the rule it protects.
    const mapped = classify(httpError(503, 'EXPORT_NOT_CONFIGURED', { fields: ['secret'] }));
    assert.equal(mapped?.status, 503, 'an error this code did raise is still rule 5');
    assert.deepEqual(mapped.body, { error: 'EXPORT_NOT_CONFIGURED', fields: ['secret'] });
  });

  test('is 500 INTERNAL with a ref through the handler, publishing neither the code nor the key', async () => {
    const { result: res, lines } = await capturingLog(() => request(probe).get('/probe/provider'));
    const body = JSON.stringify(res.body);

    log('normal', `GET /probe/provider → ${res.status} ${body}`);
    assert.equal(res.status, 500,
      `a provider the deployment cannot authenticate to is this deployment's fault, not the caller's: ${body}`);
    assert.equal(res.body.error, 'INTERNAL');
    assert.match(res.body.ref ?? '', /^[0-9a-f]{8}$/, body);
    assert.doesNotMatch(body, /invalid_api_key/, `the dependency's code must not be published: ${body}`);
    assert.doesNotMatch(body, /sk-live-TOPSECRET/, `nor the key it quoted back: ${body}`);

    // And the trade holds where it matters most: a mapped error logs its cause
    // only from `normal` up, so the commonest provider failure used to leave
    // nothing behind at the tier a deployment runs.
    const withRef = lines.filter(line => line.includes(res.body.ref));
    const summary = withRef.find(line => line.includes('500 INTERNAL'));
    assert.ok(summary, `one line must carry the status and the code: ${JSON.stringify(lines)}`);
    assert.match(summary, /source: rule 7/, `and the rule that chose it: ${summary}`);
    assert.ok(withRef.some(line => line.includes('sk-live-TOPSECRET')),
      `the real error belongs in the log, beside the ref: ${JSON.stringify(withRef)}`);
  });
});
