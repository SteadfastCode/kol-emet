/**
 * A failed generation says nothing about the deployment — not on the stream,
 * and not in the row it leaves behind.
 *
 * KOL-075 put one error shape behind every router, and KOL-099 gave the body
 * parser's failures their statuses back. Both are about the response to the
 * request that failed. This suite is about the failure that is *stored*:
 * `POST /drafts` wrote `draft.diagnostics.error = err.message` and
 * `GET /drafts/:id` returns the whole document, so the provider's own HTTP
 * body — or a Mongo pool error from the grounding read, connection string and
 * all — reached a caller in an ordinary JSON response a request later
 * (KOL-100). The source sweep in errorShape.test.js could not see it: the
 * leaking statement is an assignment, not a `res.json(...)`.
 *
 * What this file defends, driving the real route against a stand-in provider
 * that answers 500 with a connection string in its message:
 *   - neither the SSE `error` frame, nor `GET /drafts/:id`, nor the list view
 *     carries one character of that message — they carry a code, a sentence of
 *     ours, and a `ref`;
 *   - the same `ref` is in the captured server log beside the real error, which
 *     is the whole trade: the note says nothing, so the log says everything;
 *   - a refusal this codebase wrote on purpose — no AI provider configured —
 *     still reaches the person who asked, verbatim and with no `ref`, because
 *     sanitising it would be a worse answer than the sentence;
 *   - the row ends `failed` either way, with `errorCode` set, so a client
 *     branches on one field whatever killed the run.
 *
 * Falsification check: put `err.message` back into either the `diagnostics`
 * assignment or the `error` frame in `src/routes/drafts.js` and the first test
 * fails naming the string it found. Drop the `publicMessage` rule from
 * `src/lib/failureNote.js` and the refusal test fails instead.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_DRAFT_FAILURE_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture account and per generation driven, naming
 *             what made it fail
 *   normal  — light, plus the stored note and code read back off the row
 *   verbose — normal, plus the whole SSE stream and every captured log line
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import session from 'express-session';

import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';
import * as db from '../helpers/db.js';
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import Draft from '../../src/models/Draft.js';

// Environment before src/app.js is imported, for the reasons in tenancy.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.GENERATOR_LOG_LEVEL ??= 'off';
process.env.USAGE_LOG_LEVEL ??= 'off';
// The tier a deployment runs with, and the one this suite reads back: the ref
// and the real error have to be in the log at *light*, not only at verbose.
process.env.ERROR_LOG_LEVEL = 'light';
// Only the self-hosted provider is configured, so pickRoute cannot wander off
// to a real API if a developer's shell happens to hold another key.
for (const key of ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY']) {
  delete process.env[key];
}
process.env.STEADFAST_AI_API_KEY = 'test-provider-key';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  const active = LEVELS[process.env.TEST_DRAFT_FAILURE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/draftFailure:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

/**
 * What the provider says and nobody else may repeat. Shaped like the error
 * this item was found through — a driver's text, with credentials and a host
 * in it — because that is the string whose absence is the whole assertion.
 */
const LEAK = 'MongoServerSelectionError: connect ECONNREFUSED mongodb://wiki:hunter2@cluster0.internal.invalid:27017';
/** Fragments asserted separately, so a partial leak cannot pass as a clean run. */
const LEAK_FRAGMENTS = ['hunter2', 'cluster0.internal.invalid', 'MongoServerSelectionError', 'ECONNREFUSED'];

let app;
let provider;
let alice;

/**
 * A stand-in for an OpenAI-compatible `/chat/completions` that fails the way a
 * provider really does: a 500 whose body is prose nobody here wrote.
 *
 * `x-should-retry: false` is honoured by the OpenAI client, so the run fails on
 * the first call rather than after two backoffs — this suite is about what the
 * failure is turned into, not about the retry policy.
 */
function startFailingProvider() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      log('light', `stand-in provider refused ${req.method} ${req.url} with 500 (source: this suite)`);
      res.writeHead(500, { 'Content-Type': 'application/json', 'x-should-retry': 'false' });
      res.end(JSON.stringify({ error: { message: LEAK, type: 'server_error' } }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Runs `fn` with console.log and console.error collected rather than printed. */
async function captured(fn) {
  const lines = [];
  const realLog = console.log;
  const realError = console.error;
  const collect = (...args) => lines.push(args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '));
  console.log = collect;
  console.error = collect;
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

/** Every `data:` frame of an SSE body, parsed. */
function frames(body) {
  return body
    .split('\n\n')
    .map(chunk => chunk.replace(/^data: /, '').trim())
    .filter(Boolean)
    .map(json => JSON.parse(json));
}

async function registerUser(email) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  log('light', `registered ${email} (source: POST /auth/register) → workspace ${workspace._id}`);
  return { agent, email, workspaceId: String(workspace._id) };
}

/** Drives one generation to failure and hands back the stream's frames. */
async function generate(who) {
  const { value: res, lines } = await captured(() =>
    who.agent.post('/drafts').send({ provider: 'steadfast', text: 'Mira pilots the Kestrel. The Kestrel is a ship.' }));
  assert.equal(res.status, 200, `POST /drafts failed before the stream: ${res.status} ${res.text}`);
  log('verbose', `stream: ${JSON.stringify(res.text)}`);
  for (const line of lines) log('verbose', `log: ${line}`);
  return { events: frames(res.text), lines };
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });

  provider = await startFailingProvider();
  process.env.STEADFAST_AI_BASE_URL = `http://127.0.0.1:${provider.address().port}/v1`;
  log('light', `stand-in provider on ${process.env.STEADFAST_AI_BASE_URL} (source: port requested as 0)`);

  alice = await registerUser('draft-failure-alice@example.test');
});

after(async () => {
  await db.disconnect();
  await new Promise(resolve => provider.close(resolve));
});

beforeEach(async () => {
  await Draft.deleteMany({});
});

describe('a generation that fails on the provider', () => {
  test('publishes a code and a ref, never the provider\'s own text', async () => {
    const { events, lines } = await generate(alice);

    const created = events.find(e => e.type === 'created');
    const failure = events.find(e => e.type === 'error');
    assert.ok(created, `expected a created frame: ${JSON.stringify(events)}`);
    assert.ok(failure, `expected an error frame: ${JSON.stringify(events)}`);

    assert.equal(failure.code, 'INTERNAL');
    assert.match(failure.ref, /^[0-9a-f]{8}$/);
    assert.equal(failure.message, `Something went wrong on the server. (INTERNAL, ref ${failure.ref})`);

    // The row, read back the way a client reads it.
    const single = await alice.agent.get(`/drafts/${created.draftId}`);
    assert.equal(single.status, 200, `GET /drafts/:id failed: ${single.status} ${single.text}`);
    assert.equal(single.body.status, 'failed');
    assert.equal(single.body.diagnostics.errorCode, 'INTERNAL');
    assert.equal(single.body.diagnostics.errorRef, failure.ref);
    assert.equal(single.body.diagnostics.error, failure.message);
    log('normal', `stored note: ${single.body.diagnostics.error}`);

    const list = await alice.agent.get('/drafts');
    assert.equal(list.status, 200);

    // Three readings of the same document — the stream, the row, the list —
    // and the provider's sentence is in none of them.
    for (const [where, text] of [['the stream', JSON.stringify(events)], ['GET /drafts/:id', single.text], ['GET /drafts', list.text]]) {
      for (const fragment of [...LEAK_FRAGMENTS, LEAK]) {
        assert.ok(!text.includes(fragment),
          `${where} published "${fragment}" — a stored failure is as public as a response body: ${text.slice(0, 400)}`);
      }
    }

    // And the other half of the trade: the real error is in the log, under the
    // ref the caller was given, at the tier a deployment actually runs.
    const logged = lines.filter(l => l.includes(failure.ref));
    assert.ok(logged.length >= 1, `ref ${failure.ref} should be in the server log: ${lines.join('\n')}`);
    assert.ok(lines.some(l => l.includes('hunter2')),
      `the log is where the reason survives, so the provider's message belongs in it: ${lines.join('\n')}`);
  });

  test('charges nothing and leaves the workspace free to try again', async () => {
    // The lock is released in the route's finally, so a second run is not
    // refused with the 409 a stranded lock would produce.
    await generate(alice);
    const second = await alice.agent.post('/drafts').send({ provider: 'steadfast', text: 'A second attempt.' });
    assert.equal(second.status, 200, `a retry after a failed run should be allowed, got ${second.status} ${second.text}`);
  });
});

describe('a refusal this codebase wrote on purpose', () => {
  test('reaches the person who asked, as itself', async () => {
    // Nothing configured, so pickRoute finds no route and the generator
    // refuses before any provider call. That sentence is ours — not a
    // driver's, not a provider's — which is the distinction KOL-100 draws.
    const key = process.env.STEADFAST_AI_API_KEY;
    delete process.env.STEADFAST_AI_API_KEY;
    try {
      const { events } = await generate(alice);
      const created = events.find(e => e.type === 'created');
      const failure = events.find(e => e.type === 'error');

      assert.equal(failure.code, 'GENERATOR_NOT_CONFIGURED');
      assert.equal(failure.message, 'No AI provider is configured on the server');
      assert.equal(failure.ref, null, 'a refusal of ours indexes no log line — there is nothing withheld');

      const single = await alice.agent.get(`/drafts/${created.draftId}`);
      assert.equal(single.body.status, 'failed');
      assert.equal(single.body.diagnostics.error, 'No AI provider is configured on the server');
      assert.equal(single.body.diagnostics.errorCode, 'GENERATOR_NOT_CONFIGURED');
      assert.equal(single.body.diagnostics.errorRef, null);
      log('normal', `stored refusal: ${single.body.diagnostics.error}`);
    } finally {
      process.env.STEADFAST_AI_API_KEY = key;
    }
  });
});
