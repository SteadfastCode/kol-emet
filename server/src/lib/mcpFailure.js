/**
 * One shape for every refused MCP request, on both endpoints (KOL-047).
 *
 * The incident: a claude.ai chat using the bridge saw `bridge_poll` answer a
 * bare `400 {"error":"Bad request: missing or invalid session ID"}` over and
 * over while `bridge_send` still worked, then send began failing the same way.
 * Two things made that un-debuggable from either side.
 *
 * On the wire the body was neither JSON-RPC nor machine-readable, so the client
 * could not tell the two cases apart that matter to it: *re-handshake and
 * retry* (this process never issued that session id, or forgot it on a deploy)
 * from *your credential is wrong* (no amount of retrying will help). Both
 * arrived as an opaque sentence, so the chat side did neither and simply went
 * quiet. Every refusal now carries `error.data.retry`, one of:
 *
 *   reinitialize — run `initialize` again and replay the call; the session is
 *                  the only thing that was wrong.
 *   after_delay  — the server cannot serve this right now (not configured, or
 *                  it failed building a session). Back off and try again.
 *   never        — a human has to act: a bad token, or a method this endpoint
 *                  does not answer. Retrying the same request cannot succeed.
 *
 * Server-side there was nothing to read afterwards: the refusals logged a line
 * each, unparseable and without the caller or the tool, so "which tool broke,
 * for whom, and why was the session id rejected" could not be answered from the
 * logs at all. Every refusal now also emits exactly one JSON record (`event:
 * "mcp_request_refused"`) naming the endpoint, the JSON-RPC method, the tool,
 * the caller, the status and code it answered with, the `reason`, and `source`
 * — the sentence that says *why this request was rejected*, which is the field
 * that separates "never issued by this process" from "issued here and closed"
 * from "this endpoint is stateless and ignores the header".
 *
 * `reason` is the diagnosis and is finer-grained than the wire answer on
 * purpose: `session_unknown` and `session_closed` are both a 404 asking for a
 * re-handshake, but only one of them means this process had the session and let
 * it go.
 *
 * Tiering: the record goes out at the `light` tier, through whichever `log()`
 * the calling router owns (`MCP_LOG_LEVEL`, `BRIDGE_LOG_LEVEL`), so a refusal
 * is visible in a deployed process by default and can still be silenced with
 * `off`. Nothing here logs a credential: the caller's `auth` field says whether
 * a bearer header was present, never its value.
 */

/** What the client should do about it; see the header. */
export const RETRY = {
  REINITIALIZE: 'reinitialize',
  AFTER_DELAY: 'after_delay',
  NEVER: 'never',
};

/**
 * The refusal catalogue: `reason` -> what goes on the wire. The message is a
 * full sentence because a client is expected to show it to a person.
 */
export const MCP_REFUSALS = {
  unauthorized: {
    status: 401,
    code: -32000,
    retry: RETRY.NEVER,
    message: 'The bearer token for this endpoint is missing or wrong. Check the credential — re-running initialize will not help.',
  },
  not_configured: {
    status: 503,
    code: -32000,
    retry: RETRY.AFTER_DELAY,
    message: 'This endpoint is not configured to serve: its token is unset in this process. Retry later; an operator has to set it.',
  },
  session_missing: {
    status: 400,
    code: -32001,
    retry: RETRY.REINITIALIZE,
    message: 'This request carried no MCP session id and was not an initialize call. Run initialize first, then retry with the session id it returns.',
  },
  session_unknown: {
    status: 404,
    code: -32001,
    retry: RETRY.REINITIALIZE,
    message: 'This server has no record of that MCP session — it was never issued here, or the process restarted and forgot it. Run initialize again and retry the call.',
  },
  session_closed: {
    status: 404,
    code: -32001,
    retry: RETRY.REINITIALIZE,
    message: 'That MCP session was closed and cannot be used again. Run initialize again and retry the call.',
  },
  session_scope_mismatch: {
    status: 403,
    code: -32002,
    retry: RETRY.REINITIALIZE,
    message: 'That MCP session was initialized with a different scope than this request asks for. Run initialize again in the scope you want.',
  },
  method_not_allowed: {
    status: 405,
    code: -32600,
    retry: RETRY.NEVER,
    message: 'This MCP endpoint answers POST only; it keeps no standalone event stream.',
  },
  init_failed: {
    status: 500,
    code: -32603,
    retry: RETRY.AFTER_DELAY,
    message: 'The server could not build an MCP session for this request. Retry; if it persists the server is misconfigured.',
  },
  internal_error: {
    status: 500,
    code: -32603,
    retry: RETRY.AFTER_DELAY,
    message: 'The server failed while handling this MCP request.',
  },
};

/** Session ids are long and appear in logs a lot; eight characters identify one. */
export const shortSession = (id) => (id ? `${String(id).slice(0, 8)}…` : null);

/**
 * Who is calling, as far as a refused request can tell. `auth` describes the
 * *presentation* of the credential, never its value — a rejected token is a
 * secret someone typed, and the routers already log it at `verbose` only.
 */
export function callerView(req) {
  const auth = req.headers?.['authorization'];
  const clientInfo = req.body?.params?.clientInfo;
  return {
    ip: req.ip ?? req.socket?.remoteAddress ?? null,
    ua: req.headers?.['user-agent'] ?? null,
    client: clientInfo?.name ? `${clientInfo.name}/${clientInfo.version ?? '?'}` : null,
    auth: !auth ? 'absent' : /^Bearer /.test(auth) ? 'bearer' : 'non-bearer',
  };
}

/**
 * What was asked. A JSON-RPC batch is an array — there is no single id or
 * method then, and `null` is the correct id for an error about the whole batch.
 */
export function rpcView(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { id: null, rpc: Array.isArray(body) ? 'batch' : null, tool: null };
  }
  const id = body.id ?? null;
  const rpc = typeof body.method === 'string' ? body.method : null;
  // The tool name is the single most useful field in the record: "bridge_poll
  // was refused 40 times" is the shape of the incident this came from.
  const tool = rpc === 'tools/call' && typeof body.params?.name === 'string' ? body.params.name : null;
  return { id, rpc, tool };
}

/**
 * The JSON record for one refused (or otherwise notable) MCP request. One line,
 * parseable, with `source` saying why — see the header.
 */
export function mcpLogRecord({ event, endpoint, req, status = null, code = null, reason = null, retry = null, source, extra = {} }) {
  const { id, rpc, tool } = rpcView(req.body);
  return JSON.stringify({
    event,
    endpoint,
    method: req.method,
    status,
    code,
    reason,
    retry,
    rpc,
    tool,
    requestId: id,
    session: shortSession(req.headers?.['mcp-session-id']),
    caller: callerView(req),
    source,
    ...extra,
  });
}

/**
 * Refuse one MCP request: log the record at `light`, then answer a JSON-RPC
 * error body carrying the machine-readable `reason`/`retry` pair.
 *
 * `source` is required — a refusal whose log does not say what made it a
 * refusal is the thing this module exists to prevent. `extra` goes to the
 * record only: the body is the same four fields whatever went wrong, so a
 * client can branch on it without knowing which refusal it is holding, and
 * server-side counts stay server-side.
 */
export function refuseMcp(req, res, { endpoint, reason, source, log, headers = {}, extra = {} }) {
  const refusal = MCP_REFUSALS[reason];
  if (!refusal) throw new Error(`refuseMcp: unknown reason "${reason}"`);
  const { status, code, retry, message } = refusal;

  log('light', mcpLogRecord({ event: 'mcp_request_refused', endpoint, req, status, code, reason, retry, source, extra }));

  for (const [name, value] of Object.entries(headers)) res.set(name, value);
  return res.status(status).json({
    jsonrpc: '2.0',
    id: rpcView(req.body).id,
    error: {
      code,
      message,
      data: { reason, retry, endpoint, status },
    },
  });
}
