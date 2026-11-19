/**
 * Unit tests for src/lib/mcpFailure.js — the refusal record's caps (KOL-146),
 * and the module's first tests.
 *
 * The record is emitted at the `light` tier, which is the tier a deployment
 * actually runs, and on `/mcp` the bearer gate refuses *with* it before any
 * credential has been accepted. Several of its fields are the caller's own
 * text: the JSON-RPC `id`, the `user-agent` header, the `clientInfo` a
 * handshake announces, the method and tool names, and the address (`trust
 * proxy` is set). The app parses bodies at `express.json()`'s ~100 kB default,
 * so before the caps an unauthenticated `POST /mcp` carrying
 * `{"id": "<100 kB of chosen text>"}` wrote 100 kB of a stranger's prose into
 * the deployed log on every request — where the old 401 path printed one fixed
 * line — and an `id` that was an object or an array went into the line whole,
 * which is the "one line, parseable" promise in the module header handed to the
 * caller to break.
 *
 * So these hold the record to four properties, in this order of importance:
 *
 *   1. **It is bounded.** Whatever the request was, the record fits under the
 *      stated ceiling (`MAX_RECORD_BYTES` below) — checked by building records
 *      from deliberately hostile requests and measuring them, not by reading
 *      the limits back out of the module.
 *   2. **It is still one parseable JSON line**, which is what any log reader
 *      downstream assumes. Asserted for every case here, including the ones
 *      whose input was an object where an id belongs.
 *   3. **A cut value says so.** The marker is what separates "this module
 *      shortened it" from "the caller sent it short", and it names how many
 *      characters went missing, so the scale of what arrived survives even
 *      though the text does not.
 *   4. **Nothing honest changes.** A short id, a number, a real user-agent and
 *      a real client come through verbatim, and the JSON-RPC *response* body
 *      still answers the client with the id it sent — the cap is on the record,
 *      not on what the caller is told.
 *
 * Falsification checks, run red by hand against a deliberately broken module:
 *   - `requestIdView` put back to `id`           -> the 100 kB id, the object
 *                                                   and the array cases fail
 *   - the `typeof id === 'string'` branch        -> the long-id case fails on
 *     returning the string unclipped                size and on its marker
 *   - the object/array branch returning          -> the object case fails: the
 *     `JSON.stringify(id)` instead of a type        record carries the
 *     name                                          caller's structure whole
 *   - `clip` dropping its marker                 -> every marker assertion
 *                                                   fails (and a cut value
 *                                                   becomes indistinguishable
 *                                                   from a short one)
 *   - `clip` marking a value it did not cut      -> the "nothing honest
 *                                                   changes" cases fail
 *   - the `ua`/`client`/`ip` clips removed from  -> the header and clientInfo
 *     `callerView`                                  cases fail
 *   - the `rpc`/`tool` clips removed from        -> the long-method and
 *     `mcpLogRecord`                                long-tool cases fail
 *   - the clip moved into `rpcView` (so the      -> the response-body case
 *     response body is capped too)                  fails
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_MCP_FAILURE_LOG_LEVEL = off | light | normal | verbose (default light)
 * When one of these fails unattended, the missing information is which field
 * was built from which part of the request, never the assertion itself.
 *   off     — nothing
 *   light   — one line per record: the case, the size it came out at, and the
 *             input size that produced it
 *   normal  — light, plus each capped field with the ceiling it was cut to
 *   verbose — normal, plus the whole record
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mcpLogRecord,
  callerView,
  rpcView,
  requestIdView,
  clip,
  clipMark,
  refuseMcp,
  MCP_RECORD_LIMITS,
} from '../../src/lib/mcpFailure.js';

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };
function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_MCP_FAILURE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/mcpFailure:${level}] ${msg}`);
}

/**
 * The stated size. A record is this module's own fields plus at most
 * `MCP_RECORD_LIMITS` worth of the caller's, so it has a ceiling — and the
 * number is written here as a literal rather than computed from the limits,
 * because a bound derived from the thing it bounds agrees with any mistake.
 * Measured in bytes: the truncation marker is a multi-byte character, and
 * bytes are what a log line costs.
 */
const MAX_RECORD_BYTES = 2048;

/** What `/mcp`'s bearer gate passes when it refuses an unauthenticated POST. */
const UNAUTHORIZED = {
  event: 'mcp_request_refused',
  endpoint: '/mcp',
  status: 401,
  code: -32000,
  reason: 'unauthorized',
  retry: 'never',
  source: 'Authorization header absent',
};

/** A request as the gate sees one: whatever headers, body and address are given. */
function fakeReq({ body = null, headers = {}, ip = '203.0.113.7' } = {}) {
  return { method: 'POST', headers, body, ip };
}

/**
 * Builds one record and asserts the two properties every case shares: it is a
 * single line, and it parses. Returns the parsed record plus its byte size.
 */
function record(label, req, fields = UNAUTHORIZED) {
  const line = mcpLogRecord({ ...fields, req });
  const bytes = Buffer.byteLength(line, 'utf8');
  const inputBytes = Buffer.byteLength(JSON.stringify(req.body ?? null), 'utf8');
  log('light', `${label}: ${bytes} byte record (source: mcpLogRecord over a ${inputBytes}-byte body and ${Object.keys(req.headers).length} header(s))`);
  log('verbose', `${label}: ${line}`);

  assert.doesNotMatch(line, /\n/, `${label}: a record must be one line`);
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(line); }, `${label}: a record must parse as JSON: ${line.slice(0, 200)}`);
  assert.equal(parsed.event, 'mcp_request_refused', `${label}: the record must keep its event`);
  return { r: parsed, bytes, line };
}

/** Asserts `value` was cut to `ceiling` and says so, and logs what happened. */
function assertCut(label, field, value, ceiling, { from }) {
  assert.equal(typeof value, 'string', `${label}: ${field} should be recorded as text, got ${JSON.stringify(value)}`);
  assert.ok(value.startsWith('…') === false, `${label}: ${field} should keep the head of what was sent, got ${JSON.stringify(value.slice(0, 40))}`);
  assert.equal(
    value, `${'x'.repeat(ceiling)}${clipMark(from - ceiling)}`,
    `${label}: ${field} must be the first ${ceiling} characters plus a marker naming the ${from - ceiling} dropped`,
  );
  log('normal', `${label}: ${field} cut to the ${ceiling}-character ceiling from ${from} (source: MCP_RECORD_LIMITS.${field})`);
}

const HUGE = 'x'.repeat(100_000);

describe('a caller-chosen value cannot choose how much of the log it gets (KOL-146)', () => {
  test('a 100,000-character id is cut to a short ceiling, marked, and the record stays small', () => {
    const { r, bytes } = record('100k id', fakeReq({
      body: { jsonrpc: '2.0', id: HUGE, method: 'tools/call', params: { name: 'get_entity' } },
    }));

    assertCut('100k id', 'requestId', r.requestId, MCP_RECORD_LIMITS.requestId, { from: HUGE.length });
    assert.ok(
      bytes < MAX_RECORD_BYTES,
      `a refusal record must stay under ${MAX_RECORD_BYTES} bytes however large the request was, got ${bytes}`,
    );
    // The fields that make the record worth reading survive the capping.
    assert.equal(r.tool, 'get_entity');
    assert.equal(r.reason, 'unauthorized');
    assert.equal(r.source, UNAUTHORIZED.source);
  });

  test('every caller-chosen field at 100,000 characters at once still fits', () => {
    const { r, bytes } = record('all fields huge', fakeReq({
      headers: { 'user-agent': HUGE, 'mcp-session-id': HUGE, authorization: `Bearer ${HUGE}` },
      ip: HUGE,
      body: {
        jsonrpc: '2.0', id: { nested: HUGE }, method: HUGE,
        params: { name: HUGE, clientInfo: { name: HUGE, version: HUGE } },
      },
    }));

    assert.ok(
      bytes < MAX_RECORD_BYTES,
      `the whole record is bounded, not one field of it: got ${bytes} bytes`,
    );
    // `tool` is null here: rpcView only reads it when the method is tools/call.
    for (const [field, value] of Object.entries({ requestId: r.requestId, rpc: r.rpc, ua: r.caller.ua, client: r.caller.client, ip: r.caller.ip })) {
      assert.ok(String(value).length < 300, `${field} came through at ${String(value).length} characters: ${String(value).slice(0, 80)}`);
    }
    assert.equal(r.caller.auth, 'bearer', 'the presentation of the credential, never its value');
    assert.doesNotMatch(r.caller.auth, /x{10}/, 'no field may carry the token it rejected');
  });

  test('a long user-agent and a long clientInfo name are each cut to their own ceiling', () => {
    const { r } = record('long headers', fakeReq({
      headers: { 'user-agent': HUGE },
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: HUGE, version: '1.0.0' } } },
    }));

    assertCut('long headers', 'ua', r.caller.ua, MCP_RECORD_LIMITS.ua, { from: HUGE.length });
    // `client` is `name/version`, so the composed value is what gets cut —
    // a name this long has spent the version's room as well as its own.
    assert.equal(r.caller.client.length, MCP_RECORD_LIMITS.client + clipMark(HUGE.length + '/1.0.0'.length - MCP_RECORD_LIMITS.client).length);
    assert.match(r.caller.client, /^x+…\(\+\d+\)$/, `client must be cut and marked: ${r.caller.client}`);
    assert.notEqual(r.caller.ua, r.caller.client, 'the two fields have their own ceilings');
  });

  test('a long method and a long tool name are cut too', () => {
    const { r } = record('long rpc', fakeReq({
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: HUGE } },
    }));
    assertCut('long rpc', 'tool', r.tool, MCP_RECORD_LIMITS.tool, { from: HUGE.length });

    const { r: r2 } = record('long method', fakeReq({ body: { jsonrpc: '2.0', id: 1, method: HUGE } }));
    assertCut('long method', 'rpc', r2.rpc, MCP_RECORD_LIMITS.rpc, { from: HUGE.length });
  });

  test('an id that is not an id is recorded as a type name, not stringified whole', () => {
    for (const [label, id, expected] of [
      ['object', { a: HUGE }, '<object>'],
      ['array', [HUGE, HUGE], '<array>'],
      ['boolean', true, '<boolean>'],
    ]) {
      const { r, bytes } = record(`${label} id`, fakeReq({ body: { jsonrpc: '2.0', id, method: 'tools/list' } }));
      assert.equal(r.requestId, expected, `a ${label} where an id belongs must be recorded as its type`);
      assert.ok(bytes < MAX_RECORD_BYTES, `a ${label} id must not inflate the record: ${bytes} bytes`);
      assert.doesNotMatch(r.requestId, /x/, `a ${label} id must not carry the caller's content`);
    }
  });
});

describe('nothing honest changes', () => {
  test('a short id, a number and a real client come through verbatim', () => {
    const { r } = record('honest', fakeReq({
      headers: { 'user-agent': 'node', 'mcp-session-id': 'abcdefghijklmnop' },
      body: { jsonrpc: '2.0', id: 'req-7', method: 'tools/call', params: { name: 'get_entity', clientInfo: { name: 'claude-ai', version: '1.2.3' } } },
    }));

    assert.equal(r.requestId, 'req-7', 'an id that fits is the id that was sent');
    assert.equal(r.caller.ua, 'node');
    assert.equal(r.caller.client, 'claude-ai/1.2.3');
    assert.equal(r.rpc, 'tools/call');
    assert.equal(r.tool, 'get_entity');
    assert.equal(r.session, 'abcdefgh…', 'the session id keeps its own long-standing shortening');
    assert.doesNotMatch(JSON.stringify({ ...r, session: '' }), /…\(\+/, 'nothing short may carry a truncation marker');

    // A number is its own ceiling: a JSON number parses to a double, which
    // prints in about twenty characters however many digits arrived.
    const { r: big } = record('number id', fakeReq({ body: { jsonrpc: '2.0', id: Number(`1e${308}`), method: 'tools/list' } }));
    assert.equal(typeof big.requestId, 'number', 'a numeric id stays a number, so a log search for id=6 still finds it');

    const { r: six } = record('small number id', fakeReq({ body: { jsonrpc: '2.0', id: 6, method: 'tools/list' } }));
    assert.equal(six.requestId, 6);
  });

  test('an absent id, user-agent and client are null, not a marker', () => {
    const { r } = record('empty', fakeReq({ body: { jsonrpc: '2.0', method: 'tools/list' } }));
    assert.equal(r.requestId, null);
    assert.equal(r.caller.ua, null);
    assert.equal(r.caller.client, null);
    assert.equal(r.caller.auth, 'absent');
    assert.equal(r.session, null);
  });

  test('a batch (an array body) is still recorded as a batch', () => {
    const { r } = record('batch', fakeReq({ body: [{ jsonrpc: '2.0', id: HUGE, method: 'tools/list' }] }));
    assert.equal(r.rpc, 'batch', 'an array body has no single method; the record says so');
    assert.equal(r.requestId, null, 'and no single id');
  });

  test('clip and requestIdView are exact at the boundary', () => {
    const ceiling = MCP_RECORD_LIMITS.requestId;
    assert.equal(requestIdView('x'.repeat(ceiling)), 'x'.repeat(ceiling), 'a value exactly at its ceiling is not cut');
    assert.equal(requestIdView('x'.repeat(ceiling + 1)), `${'x'.repeat(ceiling)}${clipMark(1)}`, 'one character over is cut, and says one went');
    assert.equal(clip(null, 10), null);
    assert.equal(clip('short', 10), 'short');
    assert.equal(clip('0123456789abc', 10), `0123456789${clipMark(3)}`);
  });
});

describe('the cap is on the record, not on the answer', () => {
  /** Enough of an Express response for refuseMcp: status, json and set. */
  function fakeRes() {
    const res = { statusCode: null, body: null, headers: {} };
    res.set = (name, value) => { res.headers[name] = value; return res; };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
  }

  test('a refused request is answered with the id it sent, verbatim, while the log line is capped', () => {
    const req = fakeReq({ headers: { 'user-agent': HUGE }, body: { jsonrpc: '2.0', id: HUGE, method: 'tools/list' } });
    const res = fakeRes();
    const lines = [];

    refuseMcp(req, res, {
      endpoint: '/mcp', reason: 'unauthorized', source: 'Authorization header absent',
      log: (level, msg) => lines.push(`${level} ${msg}`),
    });

    assert.equal(res.statusCode, 401);
    // The client matches an answer to its call by the id it chose. Capping that
    // would break a correct client to punish an abusive one.
    assert.equal(res.body.id, HUGE, 'the JSON-RPC response must echo the id the caller sent');
    assert.equal(res.body.error.data.reason, 'unauthorized');

    assert.equal(lines.length, 1, `one record per refusal: ${JSON.stringify(lines.map(l => l.slice(0, 80)))}`);
    const [line] = lines;
    assert.ok(line.startsWith('light '), `the record goes out at the light tier: ${line.slice(0, 40)}`);
    const bytes = Buffer.byteLength(line, 'utf8');
    log('light', `refuseMcp logged ${bytes} bytes for a ${HUGE.length}-character id and the same user-agent`);
    assert.ok(bytes < MAX_RECORD_BYTES, `the logged record must stay under ${MAX_RECORD_BYTES} bytes, got ${bytes}`);
    const r = JSON.parse(line.slice(line.indexOf('{')));
    assertCut('refuseMcp', 'requestId', r.requestId, MCP_RECORD_LIMITS.requestId, { from: HUGE.length });
  });

  test('rpcView still reads the body as it arrived — the caps live where the record is built', () => {
    const { id, rpc, tool } = rpcView({ jsonrpc: '2.0', id: HUGE, method: 'tools/call', params: { name: HUGE } });
    assert.equal(id, HUGE, 'rpcView feeds the response body as well as the record');
    assert.equal(rpc, 'tools/call');
    assert.equal(tool.length, HUGE.length, 'the tool name reaches mcpLogRecord uncut; the cap is applied there');
    // …and callerView, which only ever feeds the record, caps at the source.
    const caller = callerView(fakeReq({ headers: { 'user-agent': HUGE } }));
    assert.ok(caller.ua.length < 300, `callerView must cap: ${caller.ua.length} characters`);
  });
});
