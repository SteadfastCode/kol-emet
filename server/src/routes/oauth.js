import { Router } from 'express';

const router = Router();

const CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
const MCP_TOKEN = process.env.MCP_BEARER_TOKEN;

// RFC 8414 authorization server metadata — Claude.ai fetches this first
router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    issuer: base,
    token_endpoint: `${base}/oauth/token`,
    grant_types_supported: ['client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
  });
});

// Token endpoint — validates client credentials, returns MCP bearer token
router.post('/oauth/token', (req, res) => {
  const { grant_type, client_id, client_secret } = req.body;

  if (grant_type !== 'client_credentials') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  if (!CLIENT_ID || !CLIENT_SECRET || !MCP_TOKEN) {
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  if (client_id !== CLIENT_ID || client_secret !== CLIENT_SECRET) {
    return res.status(401).json({ error: 'invalid_client' });
  }

  res.json({
    access_token: MCP_TOKEN,
    token_type: 'Bearer',
    expires_in: 315360000, // 10 years — effectively non-expiring
  });
});

export default router;
