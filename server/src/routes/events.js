import { Router } from 'express';
import { randomUUID } from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { addClient, removeClient, streamErrorFrame } from '../lib/broadcaster.js';

const router = Router();

router.get('/', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = randomUUID();

  // Authenticated once, then held open for hours — so what the connection was
  // authenticated *by* is recorded with it, and the broadcaster's keep-alive
  // sweep re-checks it (KOL-062). Only a session-authenticated connection gets
  // a session id: the BEARER_TOKEN path through requireAuth has a req.sessionID
  // too, but no stored session (saveUninitialized is false), so recording it
  // would have the first sweep drop the stream as "session gone".
  const bySession = Boolean(req.session?.userId);

  // req.workspaceId is set by resolveWorkspace, mounted ahead of this router.
  const added = addClient(clientId, res, req.workspaceId, {
    userId: bySession ? req.session.userId : null,
    sessionId: bySession ? req.sessionID : null,
    // Built by createApp from the session store, so the broadcaster needs no
    // store of its own — see app.js.
    sessionAlive: req.app.locals.sessionAlive ?? null,
  });

  if (!added.accepted) {
    // 200 with an SSE error event, not a status code: an EventSource reports a
    // non-200 as an indistinguishable network error, and a client that cannot
    // tell "you have too many tabs open" from "the wifi dropped" will simply
    // reconnect forever. Sent before any client:id, so a refused connection
    // never gets an id it could tag writes with.
    res.write(streamErrorFrame({ error: 'too-many-streams', limit: added.limit }));
    return res.end();
  }

  // Send the client its own ID so it can tag outgoing write requests
  res.write(`event: client:id\ndata: ${JSON.stringify({ clientId })}\n\n`);
  req.on('close', () => removeClient(clientId));
});

export default router;
