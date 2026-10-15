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
 *   - an error carrying an explicit `status` and `code` becomes exactly those,
 *     which is how a route raises a coded refusal from inside a helper;
 *   - a `CastError` is 400 `INVALID_VALUE` and not a 500, because those routes
 *     answered 400 for an uncastable value before this middleware existed and
 *     KOL-075 moves no status a route chose deliberately;
 *   - and, as a sweep over the source rather than over responses, that **no
 *     file under `src/routes/` or `src/middleware/` passes `err.message` into
 *     a response body** — so the sweep cannot quietly regress one catch at a
 *     time, which is the only way fifty-nine of them appeared in the first
 *     place.
 *
 * Falsification check: drop `app.use(errorHandler)` from `src/app.js` and the
 * first three groups fail (Express's own handler answers HTML and, outside
 * production, the stack). Put `err.message` back into any router's catch and
 * the source sweep fails naming the file and line.
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
import path from 'node:path';

import express from 'express';
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
const { errorHandler, httpError } = await import('../../src/middleware/errorHandler.js');

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

  probeApp.use(errorHandler);
  return probeApp;
}

/** Stands in for the connection string a pool error would carry. */
const SECRET_URI = 'mongodb+srv://kolemet:s3cr3t-pa55@cluster0.example.net/kol_emet';

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
    assert.match(summary, /source: rule 6/, `the light tier names the rule that chose it: ${summary}`);
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
 */
const OUT_OF_SCOPE = new Set(['bridge.js', 'mcp.js']);

function sourceFiles() {
  const files = [];
  for (const dir of ['src/routes', 'src/middleware']) {
    const abs = path.join(SERVER_ROOT, dir);
    for (const name of readdirSync(abs)) {
      if (!name.endsWith('.js')) continue;
      if (OUT_OF_SCOPE.has(name)) continue;
      files.push({ rel: `${dir}/${name}`, source: readFileSync(path.join(abs, name), 'utf8') });
    }
  }
  return files;
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

  test('every router and middleware file was actually read', () => {
    // A sweep that silently matched nothing would pass forever. The count is
    // asserted loosely — a file added later should not fail this — but zero or
    // one would mean the directory walk broke.
    const files = sourceFiles();
    assert.ok(files.length >= 14, `expected the routers and middleware, got ${files.length}`);
    const names = files.map(f => f.rel);
    for (const expected of ['src/routes/entities.js', 'src/routes/drafts.js', 'src/middleware/auth.js', 'src/middleware/workspace.js']) {
      assert.ok(names.includes(expected), `${expected} must be in the sweep: ${names.join(', ')}`);
    }
    assert.ok(!names.some(n => n.endsWith('bridge.js') || n.endsWith('mcp.js')), 'the two out-of-scope routers stay out');
  });
});
