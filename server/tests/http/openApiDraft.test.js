/**
 * POST /drafts/openapi end to end: an OpenAPI document becomes a draft, and the
 * draft lands in the graph through the same review and apply routes a generated
 * one uses.
 *
 * Same harness as composeDraft.test.js: `createApp()` over supertest, real
 * `POST /auth/register` — so the Software Architecture types arrive through the
 * real seeder — and real mongod. No AI provider is configured in this process,
 * which is itself part of the test: a producer must never need one.
 *
 * What it defends:
 *   - the draft records its producer (`openapi`, `openapi@1`), a textHash
 *     computed exactly as POST /drafts computes it, and the workspace's
 *     categories as its grounding;
 *   - the example API key in the fixture reaches neither `source.text`, nor an
 *     evidence quote, nor the database — a spec carries credentials just as a
 *     compose file does, and the client uploads it unseen either way;
 *   - decide-clean + apply writes the Service, the two APIs and the external
 *     server host with those categories, and the Exposes / Depends on groups;
 *   - importing the same document again proposes updates to what the first
 *     import created rather than a second copy;
 *   - a document that is not OpenAPI is a 400 naming what it found instead, a
 *     workspace without the types is a 400 naming them, and another tenant
 *     cannot read the draft.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_OPENAPI_DRAFT_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture account and per draft created or applied,
 *             naming the request that did it
 *   normal  — light, plus every refused request and the status it got
 *   verbose — normal, plus each draft item and each entity read back
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import session from 'express-session';
import request from 'supertest';

import * as db from '../helpers/db.js';
// Registration is throttled per client address, and these suites register
// their fixtures through the real endpoint from one address. See the helper.
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import Entity from '../../src/models/Entity.js';
import RelationshipGroup from '../../src/models/RelationshipGroup.js';
import Draft from '../../src/models/Draft.js';
import { redactSecrets } from '../../src/lib/producers/redactSecrets.js';

// Environment before src/app.js is imported, for the reasons in tenancy.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.OPENAPI_LOG_LEVEL ??= 'off';
process.env.REDACT_LOG_LEVEL ??= 'off';
process.env.APPLY_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };
function log(level, msg) {
  const active = LEVELS[process.env.TEST_OPENAPI_DRAFT_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/openApiDraft:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';
const FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/openapi.yaml', import.meta.url)), 'utf8');
// The credential the fixture carries, asserted against by its literal text: a
// leak is "this string is somewhere it should not be", not "the line looks wrong".
const SECRET = 'sk-fixture-0000000000000000';
// What the server stores: the document with that taken out, which is also what
// it hashes. Computed here the way the route computes it rather than pasted, so
// this test fails if redaction stops running, not if it changes.
const REDACTED_FIXTURE = redactSecrets(FIXTURE.trim()).text;

let app;
let architect;   // software-architecture workspace
let writer;      // default (worldbuilding) workspace

async function registerUser(email, template) {
  const agent = request.agent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD, ...(template && { template }) });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  log('light', `registered ${email} (source: POST /auth/register, template ${template ?? 'not named'}) → workspace ${workspace._id}`);
  return { agent, email, workspaceId: String(workspace._id) };
}

async function postOpenApi(who, body) {
  const res = await who.agent.post('/drafts/openapi').send(body);
  if (res.status === 201) {
    log('light', `draft ${res.body._id} created (source: POST /drafts/openapi as ${who.email}) with ${res.body.items.length} items`);
    for (const i of res.body.items) {
      log('verbose', `  ${i.localKey} ${i.kind} ${i.op} ${JSON.stringify(i.proposed.title ?? i.proposed.label)}`);
    }
  } else {
    log('normal', `${who.email} POST /drafts/openapi → ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res;
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });
  architect = await registerUser('openapi-architect@example.test', 'software-architecture');
  writer = await registerUser('openapi-writer@example.test');
});

after(async () => { await db.disconnect(); });

describe('POST /drafts/openapi', () => {
  let draft;
  let applied;

  test('turns the fixture into a ready draft recording its producer', async () => {
    const res = await postOpenApi(architect, { text: FIXTURE, filename: 'petstore.openapi.yaml' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    draft = res.body;

    assert.equal(String(draft.workspaceId), architect.workspaceId);
    assert.equal(draft.status, 'ready');
    assert.equal(draft.title, 'petstore.openapi.yaml');
    assert.equal(draft.source.producer, 'openapi');
    assert.equal(draft.source.producerVersion, 'openapi@1');
    assert.equal(draft.source.text, REDACTED_FIXTURE);
    const expectedHash = `sha256:${crypto.createHash('sha256').update(REDACTED_FIXTURE).digest('hex')}`;
    assert.equal(draft.source.textHash, expectedHash, 'textHash is of the text that was stored');
    assert.deepEqual(draft.grounding.categories, ['Service', 'Data Store', 'API', 'Team', 'External Dependency']);
    assert.equal(draft.route.strategy, 'deterministic');
    assert.equal(draft.route.provider, null, 'no model was involved');

    const entities = draft.items.filter(i => i.kind === 'entity');
    assert.deepEqual(entities.map(i => [i.proposed.title, i.proposed.category]), [
      ['Pet Store API', 'Service'],
      ['Pets', 'API'],
      ['Vets', 'API'],
      ['sandbox.partner.example', 'External Dependency'],
    ]);
    assert.equal(draft.items.filter(i => i.kind === 'relationship').length, 3);
    assert.deepEqual(draft.counts, { ...draft.counts, proposed: 7, pending: 7, dropped: 0 });
  });

  test('the example key in the document reaches neither the draft nor the database', async () => {
    // The client posts a spec without ever showing it in the textarea, so
    // nobody reviewed what went up. Draft has no TTL and the exporter carries
    // source.text and every evidence quote out verbatim, so anything stored
    // here is stored for good.
    const stored = await Draft.findById(draft._id).lean();
    const everywhere = JSON.stringify({ response: draft, stored });
    assert.ok(!everywhere.includes(SECRET), `${JSON.stringify(SECRET)} reached the draft`);
    assert.equal(stored.source.redactedCount, 1, 'the example API key, counted');
    assert.match(stored.source.text, /example: REDACTED/);
    // The hosts the mapping needs are not secrets, and survive.
    assert.match(stored.source.text, /sandbox\.partner\.example/);

    // Evidence offsets point into the text that was stored, not into the upload.
    for (const item of stored.items) {
      const { quote, charStart, charEnd } = item.input.evidence;
      assert.equal(stored.source.text.slice(charStart, charEnd), quote, `${item.localKey}'s offsets`);
    }
    log('light', `draft ${draft._id} stored ${stored.source.redactedCount} redactions (source: POST /drafts/openapi)`);
  });

  test('decide-clean then apply lands the entities with those categories, and the groups between them', async () => {
    const decided = await architect.agent.post(`/drafts/${draft._id}/decide-clean`);
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body.accepted, 7);
    assert.equal(decided.body.skippedFlagged, 0);

    const res = await architect.agent.post(`/drafts/${draft._id}/apply`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    log('light', `draft ${draft._id} applied (source: POST /drafts/:id/apply as ${architect.email}): ${JSON.stringify(res.body)}`);
    assert.equal(res.body.applied, 7);
    assert.equal(res.body.failed, 0);
    assert.equal(res.body.blocked, 0);
    assert.equal(res.body.status, 'applied');

    applied = await Entity.find({ workspaceId: architect.workspaceId, tags: 'openapi' }).lean();
    for (const e of applied) log('verbose', `  entity ${e._id} "${e.title}" (${e.category})`);
    const byTitle = Object.fromEntries(applied.map(e => [e.title, e]));
    assert.deepEqual(
      Object.fromEntries(applied.map(e => [e.title, e.category])),
      {
        'Pet Store API': 'Service',
        Pets: 'API',
        Vets: 'API',
        'sandbox.partner.example': 'External Dependency',
      },
    );
    assert.deepEqual(byTitle['Pet Store API'].blocks.map(b => [b.type, b.data.label ?? 'markdown']), [
      ['attribute', 'API version'],
      ['attribute', 'Spec version'],
      ['text', 'markdown'],
    ]);
    assert.deepEqual(byTitle.Pets.blocks.map(b => [b.type, b.data.label, b.data.value]), [
      ['attribute', 'Operations', 'GET /pets, POST /pets, GET /pets/{petId}'],
    ]);

    const titleOf = new Map(applied.map(e => [String(e._id), e.title]));
    const groups = await RelationshipGroup.find({
      workspaceId: architect.workspaceId,
      'members.refId': { $in: applied.map(e => e._id) },
    }).lean();
    const described = groups
      .map(g => `${g.label}: ${g.members.map(m => `${m.label}:${titleOf.get(String(m.refId))}`).join(' → ')}`)
      .sort();
    assert.deepEqual(described, [
      'Depends on: Dependent:Pet Store API → Dependency:sandbox.partner.example',
      'Exposes: Provider:Pet Store API → Endpoint:Pets',
      'Exposes: Provider:Pet Store API → Endpoint:Vets',
    ]);
    const service = await Entity.findById(byTitle['Pet Store API']._id).lean();
    assert.equal(service.relationships.length, 3, 'back-references are written on the members');
  });

  test('importing the same document again proposes updates to what the first import created', async () => {
    const res = await postOpenApi(architect, { text: FIXTURE });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.title, 'openapi', 'no filename, so a generic title');

    const idByTitle = new Map(applied.map(e => [e.title, String(e._id)]));
    const entities = res.body.items.filter(i => i.kind === 'entity');
    assert.equal(entities.length, 4);
    for (const item of entities) {
      assert.equal(item.op, 'update', `${item.proposed.title} should be an update`);
      assert.equal(item.matchedBy, 'exact-normalized-title');
      assert.equal(String(item.targetEntityId), idByTitle.get(item.proposed.title));
      assert.deepEqual(item.proposed.blocks, [],
        `${item.proposed.title} already has every block this document gives it`);
    }
  });

  test('another workspace cannot read the draft', async () => {
    const res = await writer.agent.get(`/drafts/${draft._id}`);
    log('normal', `${writer.email} GET /drafts/${draft._id} → ${res.status}`);
    assert.equal(res.status, 404);
  });
});

describe('POST /drafts/openapi refusals', () => {
  test('a document that is not OpenAPI is a 400 naming what it found instead', async () => {
    const res = await postOpenApi(architect, { text: 'name: CI\non: push\njobs: {}\n', filename: 'ci.yml' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Not an OpenAPI document/);
    assert.match(res.body.error, /`name`/);
  });

  test('a docker-compose file posted here is refused and pointed at its own producer', async () => {
    const res = await postOpenApi(architect, { text: 'services:\n  web:\n    image: nginx\n' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /import it as one/);
  });

  test('invalid YAML is a 400 naming the line in the file as sent', async () => {
    const res = await postOpenApi(architect, { text: '\n\nopenapi: 3.1.0\ninfo:\n  title: X\n   version: 1\n' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /on line 5/);
    assert.equal(res.body.line, 5, 'the two blank lines the server trims still count');
  });

  test('missing or non-string text is a 400', async () => {
    assert.equal((await postOpenApi(architect, {})).status, 400);
    assert.equal((await postOpenApi(architect, { text: '   ' })).status, 400);
    assert.equal((await postOpenApi(architect, { text: { openapi: '3.1.0' } })).status, 400);
  });

  test('a workspace without the types the document needs is a 400 naming them, and creates no draft', async () => {
    const res = await postOpenApi(writer, { text: FIXTURE });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.missingCategories, ['Service', 'API', 'External Dependency']);
    assert.match(res.body.error, /an OpenAPI import needs/);
    const list = await writer.agent.get('/drafts');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 0);
  });

  test('an unauthenticated request is refused', async () => {
    const res = await request(app).post('/drafts/openapi').send({ text: FIXTURE });
    log('normal', `anonymous POST /drafts/openapi → ${res.status}`);
    assert.equal(res.status, 401);
  });
});
