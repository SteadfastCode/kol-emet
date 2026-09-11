/**
 * HTTP tests for DELETE /auth/account: the route in front of lib/accountDeleter.js.
 *
 * The cascade itself is pinned in tests/lib/accountDeleter.test.js. This file
 * defends the door: the route runs that cascade for the caller and only the
 * caller, refuses without a fresh proof of the account, and leaves a deleted
 * account's session dead rather than merely forgotten by the browser. Real
 * stack throughout — createApp() over supertest, real registration (bcrypt,
 * Workspace, seedWorkspace), real mongod — for the reasons at the top of
 * tests/http/auth.test.js.
 *
 * The central assertion is the whole-database diff the library test uses:
 * after deleting tenant A over HTTP, the database must equal what it held
 * before, minus exactly A's documents. That proves A is gone from every
 * collection and a second tenant is untouched down to the field. Every refusal
 * asserts the opposite: the database is exactly what it was.
 *
 * Falsification checks: drop the password comparison and the wrong-password
 * case deletes the account; swap req.session.destroy() for a bare clearCookie
 * and the replayed cookie still answers 200; ignore the deleter's refusal and
 * the 409 test fails on its status; drop refusedBearer() and the bearer test
 * deletes the account.
 *
 * Not covered: a *successful* passkey confirmation, which needs a real
 * authenticator signing a real assertion (see auth.test.js on WebAuthn). The
 * refusals around it are covered, since they are where a mistake deletes an
 * account. They all answer the same 403; the route's light-tier log line says
 * which check refused.
 *
 * Isolation: every test registers its own users under unique emails and diffs
 * the whole database around its own request, so tests neither clear the
 * database (registration costs a bcrypt hash at cost 12) nor depend on each
 * other's leftovers.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_ACCOUNT_DELETE_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per account created, naming the request that created it
 *             and the user/workspace ids it produced
 *   normal  — light, plus every account-deletion call and what it answered
 *   verbose — normal, plus per-collection counts for each database snapshot
 * The route and the deleter log on ACCOUNT_DELETE_LOG_LEVEL, silenced here
 * unless set, for when a failure needs their trail.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';
import session from 'express-session';
import request from 'supertest';

import * as db from '../helpers/db.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import UserMemory from '../../src/models/UserMemory.js';
import Conversation from '../../src/models/Conversation.js';
import Settings from '../../src/models/Settings.js';
import ChangeLog from '../../src/models/ChangeLog.js';

// createApp() reads NODE_ENV when called, so the environment has to be in
// place before src/app.js is imported — hence the dynamic import below. Not
// 'production': that arms secure/domain-scoped cookies supertest won't return.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
// Unset so every request here is a session request; the one test about the
// bearer token sets it for itself and removes it again.
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.ACCOUNT_DELETE_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.TEST_ACCOUNT_DELETE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/accountDeletion:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

let app;

let emailCounter = 0;
function uniqueEmail(label) {
  emailCounter += 1;
  return `${label}-${emailCounter}@example.test`;
}

/** The `connect.sid=<value>` pair from a response's Set-Cookie, in Cookie-header form. */
function sessionCookie(res) {
  const cookie = (res.headers['set-cookie'] ?? []).find(c => c.startsWith('connect.sid='));
  return cookie ? cookie.split(';')[0] : null;
}

/** True when the response's Set-Cookie expires connect.sid rather than issuing one. */
function clearsSessionCookie(res) {
  return (res.headers['set-cookie'] ?? [])
    .some(c => /^connect\.sid=;/.test(c) && /Expires=Thu, 01 Jan 1970/.test(c));
}

/** Logs an account-deletion call and its answer at the 'normal' tier. */
function called(what, res) {
  log('normal', `${what} → ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

/**
 * A tenant registered through the real endpoint and signed in on its own
 * agent, with an entity created over HTTP plus the two user-keyed rows
 * registration never makes — a memory and a pre-tenancy chat — so the fixture
 * reaches every kind of collection a tenant can own.
 */
async function tenant(label) {
  const email = uniqueEmail(label);
  const agent = request.agent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ ownerId: user._id }).select('_id').lean();

  const entity = await agent.post('/entities').send({ title: `${label} entity`, category: 'Worlds', summary: 'fixture' });
  assert.equal(entity.status, 201, `POST /entities as ${email} failed: ${entity.status} ${JSON.stringify(entity.body)}`);
  // POST /entities writes its ChangeLog row after answering. Wait for it, so a
  // snapshot taken next cannot race the write and see a tenant "change".
  for (let i = 0; i < 100 && !(await ChangeLog.exists({ entityId: entity.body._id })); i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await UserMemory.create({ userId: user._id, fact: `${label} rides the night train` });
  await Conversation.create({ workspaceId: null, userId: user._id, provider: 'test', model: 'test' });

  log('light', `registered ${email} (source: POST /auth/register) → user ${user._id}, workspace ${workspace._id}`);
  return {
    email,
    agent,
    cookie: sessionCookie(res),
    userId: String(user._id),
    workspaceId: String(workspace._id),
  };
}

/** Every document in every collection, as plain JSON so ObjectIds and Dates compare by value. */
async function snapshot() {
  const out = {};
  for (const collection of await mongoose.connection.db.collections()) {
    const docs = await collection.find().sort({ _id: 1 }).toArray();
    out[collection.collectionName] = JSON.parse(JSON.stringify(docs));
  }
  log('verbose', `snapshot: ${Object.entries(out).map(([name, docs]) => `${name}=${docs.length}`).join(' ')}`);
  return out;
}

/** True when a snapshot document belongs to `t` — by its own id, workspace or user. */
function belongsTo(doc, t) {
  const ids = new Set([t.userId, t.workspaceId]);
  return [doc._id, doc.workspaceId, doc.userId].some(v => ids.has(v));
}

/** `snap` with every document belonging to `t` removed. */
function without(snap, t) {
  return Object.fromEntries(
    Object.entries(snap).map(([name, docs]) => [name, docs.filter(d => !belongsTo(d, t))])
  );
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore() });
});

after(async () => { await db.disconnect(); });

describe('DELETE /auth/account', () => {
  test('deletes the account and all its tenancy holds, leaves another tenant untouched, and ends the session', async () => {
    const a = await tenant('deleted');
    const b = await tenant('survivor');
    const before = await snapshot();

    const res = called('DELETE /auth/account (right email and password)', await a.agent
      .delete('/auth/account')
      .send({ email: a.email, password: PASSWORD }));

    assert.equal(res.status, 204, `deletion failed: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.text, '', 'a 204 carries no body');
    assert.ok(clearsSessionCookie(res), 'deletion must expire connect.sid in the browser');

    const after = await snapshot();
    assert.deepEqual(after, without(before, a), 'the database must equal the one before, minus exactly tenant A');

    // The same, collection by collection, so a failure names the collection
    // rather than printing the whole diff.
    for (const [name, docs] of Object.entries(before)) {
      assert.equal(after[name].filter(d => belongsTo(d, a)).length, 0, `${name}: tenant A left behind`);
      assert.deepEqual(after[name].filter(d => belongsTo(d, b)), docs.filter(d => belongsTo(d, b)), `${name}: tenant B changed`);
    }
    // Only as strong as the fixture: A must have had something to lose in each.
    for (const name of ['users', 'workspaces', 'entities', 'relationshiptypes', 'changelogs', 'usermemories', 'conversations']) {
      assert.ok(before[name]?.some(d => belongsTo(d, a)), `fixture gap: tenant A had nothing in ${name}`);
    }

    // The real session check: replay the cookie the browser was told to forget.
    const me = called('GET /auth/me with the deleted account\'s cookie', await request(app).get('/auth/me').set('Cookie', a.cookie));
    assert.equal(me.status, 401, 'the deleted account\'s session must be destroyed server-side');
    assert.equal((await request(app).get('/entities').set('Cookie', a.cookie)).status, 401);
    assert.equal((await request(app).post('/auth/login').send({ email: a.email, password: PASSWORD })).status, 401,
      'the deleted account\'s credentials must no longer sign in');

    assert.equal((await b.agent.get('/auth/me')).status, 200, 'tenant B stays signed in');
    assert.equal((await b.agent.get('/entities')).status, 200);
  });

  test('a non-owner member of another workspace gets 409 with the memberships, and nothing is deleted', async () => {
    const a = await tenant('member-elsewhere');
    const b = await tenant('host');
    await Workspace.updateOne({ _id: b.workspaceId }, { $push: { members: { userId: a.userId, role: 'editor' } } });
    const before = await snapshot();

    const res = called('DELETE /auth/account (editor elsewhere)', await a.agent
      .delete('/auth/account')
      .send({ email: a.email, password: PASSWORD }));

    assert.equal(res.status, 409);
    assert.deepEqual(res.body.memberships, [{ workspaceId: b.workspaceId, name: 'My Workspace', role: 'editor' }]);
    assert.deepEqual(await snapshot(), before, 'a refusal must delete nothing');
    assert.equal(sessionCookie(res), null, 'a refusal must not touch the session cookie');
    assert.equal((await a.agent.get('/auth/me')).status, 200, 'a refusal must leave the caller signed in');
  });

  test('refuses, deleting nothing and keeping the session, without the right email and password', async () => {
    const a = await tenant('unconfirmed');
    const before = await snapshot();

    const cases = [
      ['wrong password', { email: a.email, password: 'incorrect-horse-battery-staple' }, 403, 'Incorrect password'],
      ['someone else\'s email', { email: uniqueEmail('someone-else'), password: PASSWORD }, 400, 'That email does not match this account'],
      ['no password or passkey', { email: a.email }, 400],
      ['no email', { password: PASSWORD }, 400],
      ['a non-string password', { email: a.email, password: { $ne: '' } }, 400],
      ['no body', undefined, 400],
    ];
    for (const [what, body, status, error] of cases) {
      const pending = a.agent.delete('/auth/account');
      const res = called(`DELETE /auth/account (${what})`, await (body === undefined ? pending : pending.send(body)));
      assert.equal(res.status, status, `${what}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
      if (error) assert.equal(res.body.error, error, what);
    }

    // No passkey on the account, so there is nothing to challenge.
    const challenge = called('POST /auth/account/passkey-challenge (no passkey)', await a.agent.post('/auth/account/passkey-challenge'));
    assert.equal(challenge.status, 400);

    assert.deepEqual(await snapshot(), before, 'a refusal must delete nothing');
    assert.equal((await a.agent.get('/auth/me')).status, 200, 'a refusal must leave the caller signed in');
  });

  test('without a session it is 401', async () => {
    const res = called('DELETE /auth/account (anonymous)', await request(app)
      .delete('/auth/account')
      .send({ email: uniqueEmail('anonymous'), password: PASSWORD }));

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Unauthorized');
  });

  test('the MCP bearer token cannot delete the account it acts for, even with the password', async () => {
    const a = await tenant('mcp-user');
    await Settings.findByIdAndUpdate('global', { mcpUserId: a.userId }, { upsert: true });
    process.env.BEARER_TOKEN = 'test-bearer-token';
    try {
      const before = await snapshot();

      const res = called('DELETE /auth/account (bearer token)', await request(app)
        .delete('/auth/account')
        .set('Authorization', 'Bearer test-bearer-token')
        .send({ email: a.email, password: PASSWORD }));

      assert.equal(res.status, 403, 'account deletion is a session-only action');
      assert.deepEqual(await snapshot(), before, 'a refusal must delete nothing');
    } finally {
      delete process.env.BEARER_TOKEN;
      await Settings.updateOne({ _id: 'global' }, { $set: { mcpUserId: null } });
    }
  });
});

describe('DELETE /auth/account with a passkey', () => {
  test('refuses, deleting nothing, without a live challenge or with a passkey that is not the caller\'s', async () => {
    const a = await tenant('passkey-owner');
    const b = await tenant('passkey-other');
    const fakePasskey = (id) => ({ credentialID: id, publicKey: Buffer.from('not-a-real-key'), counter: 0, transports: ['internal'] });
    await User.updateOne({ _id: a.userId }, { $push: { passkeys: fakePasskey('a-credential') } });
    await User.updateOne({ _id: b.userId }, { $push: { passkeys: fakePasskey('b-credential') } });
    const before = await snapshot();

    const assertion = (id) => ({ id, rawId: id, type: 'public-key', response: {}, clientExtensionResults: {} });
    const attempt = async (what, id) => {
      const res = called(`DELETE /auth/account (${what})`, await a.agent
        .delete('/auth/account')
        .send({ email: a.email, passkey: assertion(id) }));
      assert.equal(res.status, 403, `${what}: expected 403, got ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, 'Passkey confirmation failed', what);
    };
    const challenge = async () => {
      const res = called('POST /auth/account/passkey-challenge', await a.agent.post('/auth/account/passkey-challenge'));
      assert.equal(res.status, 200);
      return res.body;
    };

    await attempt('own passkey, no challenge issued', 'a-credential');

    const options = await challenge();
    assert.deepEqual(options.allowCredentials.map(c => c.id), ['a-credential'], 'the challenge must offer only the caller\'s passkeys');
    await attempt('someone else\'s passkey', 'b-credential');

    await challenge();
    await attempt('own passkey, unsigned assertion', 'a-credential');
    await attempt('own passkey, challenge already spent', 'a-credential');

    assert.deepEqual(await snapshot(), before, 'a refusal must delete nothing');
    assert.equal((await a.agent.get('/auth/me')).status, 200, 'a refusal must leave the caller signed in');
  });
});
