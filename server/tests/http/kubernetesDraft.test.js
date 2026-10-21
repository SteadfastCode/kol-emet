/**
 * POST /drafts/kubernetes end to end: a `---` stream of manifests becomes a
 * draft, and the draft lands in the graph through the same review and apply
 * routes a generated one uses.
 *
 * Same harness as openApiDraft.test.js: `createApp()` over supertest, real
 * `POST /auth/register` — so the Software Architecture types arrive through the
 * real seeder — and real mongod. No AI provider is configured in this process,
 * which is itself part of the test: a producer must never need one.
 *
 * What it defends:
 *   - the draft records its producer (`kubernetes`, `kubernetes@1`), a textHash
 *     computed exactly as POST /drafts computes it, and the workspace's
 *     categories as its grounding;
 *   - no allowance is spent, and none is required — the quota is untouched
 *     either side of an import, which is what makes a deterministic producer
 *     safe to re-run;
 *   - the fixture's credentials reach neither `source.text`, nor an evidence
 *     quote, nor the database: a Secret's `stringData` above all, which is
 *     where a manifest keeps its passwords, and an env `value` whose
 *     credential is named by the `name:` beside it;
 *   - decide-clean + apply writes the workloads, the claim, the APIs and the
 *     external hosts with those categories, and the Exposes / Calls / Depends
 *     on groups between them;
 *   - importing the same stream again proposes updates to what the first
 *     import created rather than a second copy;
 *   - a body over the character cap is refused with the size it was;
 *   - a file that is not a manifest is a 400, a workspace without the types is
 *     a 400 naming them, and no workspace but the caller's own can be named —
 *     neither by reading the draft nor by having one made in it.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_KUBERNETES_DRAFT_LOG_LEVEL = off | light | normal | verbose (default light)
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

// Every session write is checked against CLIENT_ORIGIN (src/middleware/originGuard.js),
// so this suite names one below and its agents send a matching Origin.
import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';

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
import { MAX_KUBERNETES_CHARS } from '../../src/lib/producers/kubernetes.js';

// Environment before src/app.js is imported, for the reasons in tenancy.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
// The origin the guard compares a session write's Origin header against;
// originAgent() above sends it. See tests/helpers/origin.js.
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.KUBERNETES_LOG_LEVEL ??= 'off';
process.env.REDACT_LOG_LEVEL ??= 'off';
process.env.APPLY_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };
function log(level, msg) {
  const active = LEVELS[process.env.TEST_KUBERNETES_DRAFT_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/kubernetesDraft:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';
const FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/kubernetes.yaml', import.meta.url)), 'utf8');
// The credentials the fixture carries, asserted against by their literal text:
// a leak is "this string is somewhere it should not be", not "the line looks
// wrong". One in a DSN, one in an env `value` whose `name:` is the credential,
// and two in a Secret's `stringData` — including a username, which no word list
// has a reason to recognise.
const SECRETS = ['hunter2-fixture-secret', 'plain-fixture-session-secret', 'appuser'];
// What the server stores: the stream with those taken out, which is also what
// it hashes. Computed here the way the route computes it rather than pasted, so
// this test fails if redaction stops running, not if it changes.
const REDACTED_FIXTURE = redactSecrets(FIXTURE.trim()).text;

let app;
let architect;   // software-architecture workspace
let writer;      // default (worldbuilding) workspace

async function registerUser(email, template) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD, ...(template && { template }) });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  log('light', `registered ${email} (source: POST /auth/register, template ${template ?? 'not named'}) → workspace ${workspace._id}`);
  return { agent, email, workspaceId: String(workspace._id) };
}

async function postManifest(who, body) {
  const res = await who.agent.post('/drafts/kubernetes').send(body);
  if (res.status === 201) {
    log('light', `draft ${res.body._id} created (source: POST /drafts/kubernetes as ${who.email}) with ${res.body.items.length} items`);
    for (const i of res.body.items) {
      log('verbose', `  ${i.localKey} ${i.kind} ${i.op} ${JSON.stringify(i.proposed.title ?? i.proposed.label)}`);
    }
  } else {
    log('normal', `${who.email} POST /drafts/kubernetes → ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res;
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });
  architect = await registerUser('k8s-architect@example.test', 'software-architecture');
  writer = await registerUser('k8s-writer@example.test');
});

after(async () => { await db.disconnect(); });

describe('POST /drafts/kubernetes', () => {
  let draft;
  let applied;
  let quotaBefore;

  test('turns the fixture into a ready draft recording its producer', async () => {
    const quota = await architect.agent.get('/drafts/quota');
    assert.equal(quota.status, 200);
    quotaBefore = quota.body;

    const res = await postManifest(architect, { text: FIXTURE, filename: 'acme.manifests.yaml' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    draft = res.body;

    assert.equal(String(draft.workspaceId), architect.workspaceId);
    assert.equal(draft.status, 'ready');
    assert.equal(draft.title, 'acme.manifests.yaml');
    assert.equal(draft.source.producer, 'kubernetes');
    assert.equal(draft.source.producerVersion, 'kubernetes@1');
    assert.equal(draft.source.text, REDACTED_FIXTURE);
    const expectedHash = `sha256:${crypto.createHash('sha256').update(REDACTED_FIXTURE).digest('hex')}`;
    assert.equal(draft.source.textHash, expectedHash, 'textHash is of the text that was stored');
    assert.deepEqual(draft.grounding.categories, ['Service', 'Data Store', 'API', 'Team', 'External Dependency']);
    assert.equal(draft.route.strategy, 'deterministic');
    assert.equal(draft.route.provider, null, 'no model was involved');

    const entities = draft.items.filter(i => i.kind === 'entity');
    assert.deepEqual(entities.map(i => [i.proposed.title, i.proposed.category]), [
      ['web', 'Service'],
      ['postgres', 'Data Store'],
      ['postgres-data', 'Data Store'],
      ['web:80', 'API'],
      ['postgres:5432', 'API'],
      ['api.stripe.com', 'External Dependency'],
      ['search.internal.example', 'External Dependency'],
    ]);
    assert.equal(draft.items.filter(i => i.kind === 'relationship').length, 5);
    assert.deepEqual(draft.counts, { ...draft.counts, proposed: 12, pending: 12, dropped: 1 });
    assert.deepEqual(draft.diagnostics.dropReasons, [
      'Ingress "web" was skipped — this producer has no reading for `kind: Ingress`',
    ], 'a kind with no reading costs its own object, not the import');
  });

  test('spends no allowance, and needs none', async () => {
    // The property that makes a producer re-runnable: there is no model call,
    // so there is nothing to check a budget against and nothing to charge.
    const quota = await architect.agent.get('/drafts/quota');
    assert.equal(quota.status, 200);
    assert.deepEqual(quota.body, quotaBefore, 'the import moved the quota not at all');
    log('light', `quota unchanged across the import (source: GET /drafts/quota): ${JSON.stringify(quota.body)}`);
  });

  test('the fixture\'s credentials reach neither the draft nor the database', async () => {
    // The client posts a manifest without ever showing it in the textarea, so
    // nobody reviewed what went up. Draft has no TTL and the exporter carries
    // source.text and every evidence quote out verbatim, so anything stored
    // here is stored for good.
    const stored = await Draft.findById(draft._id).lean();
    const everywhere = JSON.stringify({ response: draft, stored });
    for (const secret of SECRETS) {
      assert.ok(!everywhere.includes(secret), `${JSON.stringify(secret)} reached the draft`);
    }
    assert.equal(stored.source.redactedCount, 4, 'the DSN, the env value and both Secret values');
    assert.match(stored.source.text, /POSTGRES_PASSWORD: REDACTED/);
    assert.match(stored.source.text, /POSTGRES_USER: REDACTED/, 'a Secret\'s values go by position, not by name');
    // The hosts the mapping needs are not secrets, and survive.
    assert.match(stored.source.text, /postgres:\/\/REDACTED@postgres:5432\/app/);
    assert.match(stored.source.text, /api\.stripe\.com/);
    assert.match(stored.source.text, /search\.internal\.example/);

    // Evidence offsets point into the text that was stored, not into the upload.
    for (const item of stored.items) {
      const { quote, charStart, charEnd } = item.input.evidence;
      assert.equal(stored.source.text.slice(charStart, charEnd), quote, `${item.localKey}'s offsets`);
    }
    log('light', `draft ${draft._id} stored ${stored.source.redactedCount} redactions (source: POST /drafts/kubernetes)`);
  });

  test('decide-clean then apply lands the entities with those categories, and the groups between them', async () => {
    const decided = await architect.agent.post(`/drafts/${draft._id}/decide-clean`);
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body.accepted, 12);
    assert.equal(decided.body.skippedFlagged, 0);

    const res = await architect.agent.post(`/drafts/${draft._id}/apply`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    log('light', `draft ${draft._id} applied (source: POST /drafts/:id/apply as ${architect.email}): ${JSON.stringify(res.body)}`);
    assert.equal(res.body.applied, 12);
    assert.equal(res.body.failed, 0);
    assert.equal(res.body.blocked, 0);
    assert.equal(res.body.status, 'applied');

    applied = await Entity.find({ workspaceId: architect.workspaceId, tags: 'kubernetes' }).lean();
    for (const e of applied) log('verbose', `  entity ${e._id} "${e.title}" (${e.category})`);
    const byTitle = Object.fromEntries(applied.map(e => [e.title, e]));
    assert.deepEqual(
      Object.fromEntries(applied.map(e => [e.title, e.category])),
      {
        web: 'Service',
        postgres: 'Data Store',
        'postgres-data': 'Data Store',
        'web:80': 'API',
        'postgres:5432': 'API',
        'api.stripe.com': 'External Dependency',
        'search.internal.example': 'External Dependency',
      },
    );
    assert.deepEqual(byTitle.web.blocks.map(b => [b.data.label, b.data.value]), [
      ['Kind', 'Deployment (apps/v1)'],
      ['Image', 'ghcr.io/acme/web:1.4.2'],
      ['Replicas', '3'],
    ]);
    assert.deepEqual(byTitle['web:80'].blocks.map(b => [b.data.label, b.data.value]), [
      ['Port', '80/TCP → 8080'],
      ['Service type', 'LoadBalancer'],
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
      'Calls: Caller:web → Callee:postgres',
      'Depends on: Dependent:web → Dependency:api.stripe.com',
      'Depends on: Dependent:web → Dependency:search.internal.example',
      'Exposes: Provider:postgres → Endpoint:postgres:5432',
      'Exposes: Provider:web → Endpoint:web:80',
    ]);
    const web = await Entity.findById(byTitle.web._id).lean();
    assert.equal(web.relationships.length, 4, 'back-references are written on the members');
  });

  test('importing the same stream again proposes updates to what the first import created', async () => {
    const res = await postManifest(architect, { text: FIXTURE });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.title, 'kubernetes', 'no filename, so a generic title');

    const idByTitle = new Map(applied.map(e => [e.title, String(e._id)]));
    const entities = res.body.items.filter(i => i.kind === 'entity');
    assert.equal(entities.length, 7);
    for (const item of entities) {
      assert.equal(item.op, 'update', `${item.proposed.title} should be an update`);
      assert.equal(item.matchedBy, 'exact-normalized-title');
      assert.equal(String(item.targetEntityId), idByTitle.get(item.proposed.title));
      assert.deepEqual(item.proposed.blocks, [],
        `${item.proposed.title} already has every block this stream gives it`);
    }
    for (const item of res.body.items.filter(i => i.kind === 'relationship')) {
      assert.equal(item.op, 'update', `${item.proposed.label} should target the group it created`);
      assert.equal(item.matchedBy, 'same-members-and-label');
    }
  });

  test('another workspace cannot read the draft', async () => {
    const res = await writer.agent.get(`/drafts/${draft._id}`);
    log('normal', `${writer.email} GET /drafts/${draft._id} → ${res.status}`);
    assert.equal(res.status, 404);
  });
});

describe('POST /drafts/kubernetes refusals', () => {
  test('a file that declares no Kubernetes object is a 400 saying so', async () => {
    const res = await postManifest(architect, { text: 'name: CI\non: push\njobs: {}\n', filename: 'ci.yml' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Not a Kubernetes manifest/);
  });

  test('invalid YAML is a 400 naming the line in the file as sent', async () => {
    const res = await postManifest(architect, {
      text: '\n\napiVersion: v1\nkind: Service\nmetadata:\n  name: x\n   bad: indent\n',
    });
    assert.equal(res.status, 400);
    // Line 4 of the trimmed text is the mapping the bad indent breaks out of,
    // which is where the parser reports it; plus the two blank lines the server
    // trimmed off the top before parsing.
    assert.equal(res.body.line, 6, 'the two blank lines the server trims still count');
    assert.match(res.body.error, /on line 6/);
  });

  test('a body over the character cap is refused with the size it was, and stores nothing', async () => {
    // Deliberately a VALID manifest: the cap is measured before the parse, so
    // a file this big is refused for its size rather than for its content.
    const before = (await architect.agent.get('/drafts')).body.length;
    const filler = 'a'.repeat(200);
    const lines = ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: web', '  annotations:'];
    // Grown until it is over rather than computed: the cap is the thing under
    // test, so the fixture must not depend on an arithmetic guess about it.
    for (let i = 0; lines.join('\n').length <= MAX_KUBERNETES_CHARS; i++) lines.push(`    note-${i}: ${filler}`);
    const text = lines.join('\n');
    assert.ok(text.length > MAX_KUBERNETES_CHARS, 'the fixture for this test must be over the cap');

    const res = await postManifest(architect, { text, filename: 'enormous.yaml' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, new RegExp(`^The file is ${text.length.toLocaleString()} characters; the limit is `));
    const after = (await architect.agent.get('/drafts')).body.length;
    assert.equal(after, before, 'nothing was stored for a request that was refused');
  });

  test('missing or non-string text is a 400', async () => {
    assert.equal((await postManifest(architect, {})).status, 400);
    assert.equal((await postManifest(architect, { text: '   ' })).status, 400);
    assert.equal((await postManifest(architect, { text: { kind: 'Deployment' } })).status, 400);
  });

  test('a workspace without the types the manifest needs is a 400 naming them, and creates no draft', async () => {
    const res = await postManifest(writer, { text: FIXTURE });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.missingCategories, ['Service', 'Data Store', 'API', 'External Dependency']);
    assert.match(res.body.error, /a Kubernetes import needs/);
    const list = await writer.agent.get('/drafts');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 0);
  });

  test('a caller cannot name another workspace to import into', async () => {
    // The workspace is resolved from the session, never from the body: a
    // request naming someone else's lands in the caller's own or nowhere.
    const res = await postManifest(writer, {
      text: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: smuggled\n',
      workspaceId: architect.workspaceId,
    });
    log('normal', `${writer.email} POST /drafts/kubernetes naming another workspace → ${res.status}`);
    assert.ok(res.status === 201 || res.status === 400, `unexpected ${res.status}: ${JSON.stringify(res.body)}`);
    if (res.status === 201) {
      assert.equal(String(res.body.workspaceId), writer.workspaceId, 'the body cannot choose the workspace');
    }
    const theirs = await Draft.find({ workspaceId: architect.workspaceId }).select('title').lean();
    assert.ok(!theirs.some(d => d.title === 'kubernetes' && String(d.workspaceId) === architect.workspaceId
      && d.title === 'smuggled'), 'nothing of the writer\'s reached the architect\'s workspace');
    const architectDrafts = await Draft.find({ workspaceId: architect.workspaceId }).lean();
    for (const d of architectDrafts) {
      assert.ok(!JSON.stringify(d.items).includes('smuggled'), 'nothing of the writer\'s reached the architect\'s workspace');
    }
  });

  test('an unauthenticated request is refused', async () => {
    const res = await request(app).post('/drafts/kubernetes').send({ text: FIXTURE });
    log('normal', `anonymous POST /drafts/kubernetes → ${res.status}`);
    assert.equal(res.status, 401);
  });
});
