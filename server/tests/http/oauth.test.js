/**
 * HTTP tests for the OAuth authorization-code + PKCE flow used by the
 * Claude.ai MCP connector, plus the unauthenticated-request guard.
 *
 * These are the first tests that drive the real Express app. They build it via
 * createApp() with an in-memory session store, so no MongoDB is touched and no
 * route reached here queries one — POST /authorize only writes the MCP user
 * association when there is a logged-in session, and requireAuth rejects an
 * anonymous /entities request before the workspace lookup runs.
 */

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import session from 'express-session';
import request from 'supertest';

// The OAuth router reads MCP_BEARER_TOKEN once, at module load, so the
// environment has to be in place before src/app.js is imported — hence the
// dynamic import below rather than a static one at the top of the file.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.MCP_BEARER_TOKEN = 'test-mcp-bearer-token';

const { createApp } = await import('../../src/app.js');

const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

let app;

before(() => {
  app = createApp({ sessionStore: new session.MemoryStore() });
});

/** PKCE pair: a verifier and its S256 challenge. */
function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Walks POST /authorize and returns the issued authorization code. */
async function issueCode(challenge) {
  const res = await request(app)
    .post('/authorize')
    .type('form')
    .send({ redirect_uri: REDIRECT_URI, code_challenge: challenge, state: 'opaque-state' });

  assert.equal(res.status, 302, 'POST /authorize should redirect back to the client');
  const location = new URL(res.headers.location);
  assert.equal(location.searchParams.get('state'), 'opaque-state', 'state must round-trip');

  const code = location.searchParams.get('code');
  assert.ok(code, 'redirect must carry an authorization code');
  return code;
}

describe('GET /.well-known/oauth-authorization-server', () => {
  test('advertises the S256 PKCE method', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(res.body.response_types_supported, ['code']);
    assert.deepEqual(res.body.grant_types_supported, ['authorization_code']);
    assert.match(res.body.token_endpoint, /\/oauth\/token$/);
  });
});

describe('POST /oauth/token', () => {
  test('rejects a code redeemed with the wrong verifier', async () => {
    const { challenge } = pkcePair();
    const code = await issueCode(challenge);

    const res = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, code_verifier: pkcePair().verifier });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_grant');
    assert.equal(res.body.detail, 'pkce mismatch');
    assert.equal(res.body.access_token, undefined, 'no token may leak on a failed exchange');
  });

  test('rejects an unsupported grant type', async () => {
    const res = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'client_credentials' });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'unsupported_grant_type');
  });

  test('issues a token once and refuses to replay a consumed code', async () => {
    const { verifier, challenge } = pkcePair();
    const code = await issueCode(challenge);

    const exchange = () => request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, code_verifier: verifier });

    const first = await exchange();
    assert.equal(first.status, 200);
    assert.equal(first.body.access_token, 'test-mcp-bearer-token');
    assert.equal(first.body.token_type, 'Bearer');

    const replay = await exchange();
    assert.equal(replay.status, 400, 'a consumed code must not be redeemable twice');
    assert.equal(replay.body.error, 'invalid_grant');
    assert.equal(replay.body.access_token, undefined);
  });
});

describe('requireAuth', () => {
  test('rejects GET /entities with no session and no bearer token', async () => {
    const res = await request(app).get('/entities');

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Unauthorized');
  });

  test('rejects GET /entities with a bearer token that is not the configured one', async () => {
    const res = await request(app)
      .get('/entities')
      .set('Authorization', 'Bearer not-the-configured-token');

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Unauthorized');
  });
});
