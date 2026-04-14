import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { addClient, removeClient } from '../lib/broadcaster.js';

const router = Router();

router.get('/', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  addClient(res);
  req.on('close', () => removeClient(res));
});

export default router;
