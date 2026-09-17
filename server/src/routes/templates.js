import { Router } from 'express';
import { listTemplates } from '../config/templates.js';

const router = Router();

// GET /templates
// Public on purpose: the signup form offers these before an account exists.
// Only keys, names and descriptions leave — never a template's content — and
// the list is code-defined, so there is nothing tenant-scoped to leak.
router.get('/', (req, res) => {
  res.json(listTemplates());
});

export default router;
