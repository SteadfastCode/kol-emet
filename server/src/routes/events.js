import { Router } from 'express';
import { randomUUID } from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { addClient, removeClient } from '../lib/broadcaster.js';

const router = Router();

router.get('/', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = randomUUID();
  // Send the client its own ID so it can tag outgoing write requests
  res.write(`event: client:id\ndata: ${JSON.stringify({ clientId })}\n\n`);

  addClient(clientId, res);
  req.on('close', () => removeClient(clientId));
});

export default router;
