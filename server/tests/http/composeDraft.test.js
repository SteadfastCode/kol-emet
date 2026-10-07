/**
 * POST /drafts/compose end to end: a docker-compose file becomes a draft, and
 * the draft lands in the graph through the same review and apply routes a
 * generated one uses.
 *
 * Same harness as entityTypes.test.js: `createApp()` over supertest, real
 * `POST /auth/register` — so the Software Architecture types arrive through the
 * real seeder — and real mongod. No AI provider is configured in this process,
 * which is itself part of the test: the producer must never need one.
 *
 * What it defends:
 *   - the draft records its producer (`docker-compose`, `docker-compose@1`), a
 *     textHash computed exactly as POST /drafts computes it, and the
 *     workspace's categories as its grounding;
 *   - the credentials in the fixture — a password and a DSN's userinfo —
 *     reach neither `source.text`, nor an evidence quote, nor the database,
 *     while the host in that DSN still becomes the edge it is there for;
 *   - decide-clean + apply writes the services, data stores and external host
 *     with those categories, and the Depends on / Calls groups between them;
 *   - importing the same file again proposes updates to what the first import
 *     created rather than a second copy — the entities AND the groups between
 *     them, so applying a re-import twice over leaves one group per edge and
 *     one back-reference per entity (KOL-054);
 *   - a group someone has widened by hand survives a re-import with their
 *     member intact;
 *   - a parse error is a 400 naming the line, a workspace without the types
 *     is a 400 naming them, and another tenant cannot read the draft;
 *   - a file declaring far more services than the item cap still yields one
 *     bounded, reviewable draft rather than thousands of items.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_COMPOSE_DRAFT_LOG_LEVEL = off | light | normal | verbose (default light)
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
import { MAX_ITEMS } from '../../src/lib/draftNormalizer.js';
import { redactSecrets } from '../../src/lib/producers/redactSecrets.js';

// Environment before src/app.js is imported, for the reasons in tenancy.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.COMPOSE_LOG_LEVEL ??= 'off';
process.env.REDACT_LOG_LEVEL ??= 'off';
process.env.APPLY_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };
function log(level, msg) {
  const active = LEVELS[process.env.TEST_COMPOSE_DRAFT_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/composeDraft:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';
const FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/docker-compose.yml', import.meta.url)), 'utf8');
// The two credentials the fixture carries, asserted against by their literal
// text: a leak is "this string is somewhere it should not be", not "the line
// looks wrong".
const SECRETS = ['hunter2-fixture-secret', 'app:app@'];
// What the server stores: the file with those taken out, which is also what it
// hashes. Computed here the way the route computes it rather than pasted, so
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

async function postCompose(who, body) {
  const res = await who.agent.post('/drafts/compose').send(body);
  if (res.status === 201) {
    log('light', `draft ${res.body._id} created (source: POST /drafts/compose as ${who.email}) with ${res.body.items.length} items`);
    for (const i of res.body.items) {
      log('verbose', `  ${i.localKey} ${i.kind} ${i.op} ${JSON.stringify(i.proposed.title ?? i.proposed.label)}`);
    }
  } else {
    log('normal', `${who.email} POST /drafts/compose → ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res;
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });
  architect = await registerUser('architect@example.test', 'software-architecture');
  writer = await registerUser('writer@example.test');
});

after(async () => { await db.disconnect(); });

describe('POST /drafts/compose', () => {
  let draft;
  let applied;
  let reimport;

  test('turns the fixture into a ready draft recording its producer', async () => {
    const res = await postCompose(architect, { text: FIXTURE, filename: 'docker-compose.yml' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    draft = res.body;

    assert.equal(String(draft.workspaceId), architect.workspaceId);
    assert.equal(draft.status, 'ready');
    assert.equal(draft.title, 'docker-compose.yml');
    assert.equal(draft.source.producer, 'docker-compose');
    assert.equal(draft.source.producerVersion, 'docker-compose@1');
    assert.equal(draft.source.text, REDACTED_FIXTURE);
    assert.notEqual(draft.source.text, FIXTURE.trim(), 'the file as sent is not what is stored');
    const expectedHash = `sha256:${crypto.createHash('sha256').update(REDACTED_FIXTURE).digest('hex')}`;
    assert.equal(draft.source.textHash, expectedHash, 'textHash is of the text that was stored');
    assert.deepEqual(draft.grounding.categories, ['Service', 'Data Store', 'API', 'Team', 'External Dependency']);
    assert.equal(draft.route.strategy, 'deterministic');
    assert.equal(draft.route.provider, null, 'no model was involved');

    const entities = draft.items.filter(i => i.kind === 'entity');
    assert.deepEqual(entities.map(i => [i.proposed.title, i.proposed.category]), [
      ['web', 'Service'],
      ['worker', 'Service'],
      ['postgres', 'Data Store'],
      ['redis', 'Data Store'],
      ['api.stripe.com', 'External Dependency'],
    ]);
    assert.equal(draft.items.filter(i => i.kind === 'relationship').length, 7);
    assert.deepEqual(draft.counts, { ...draft.counts, proposed: 12, pending: 12, dropped: 0 });
  });

  test('the credentials in the file reach neither the draft nor the database', async () => {
    // The client posts a docker-compose file without ever showing it in the
    // textarea, so nobody reviewed what went up. Draft has no TTL and the
    // exporter carries source.text and every evidence quote out verbatim, so
    // anything stored here is stored for good.
    const stored = await Draft.findById(draft._id).lean();
    const everywhere = JSON.stringify({ response: draft, stored });
    for (const secret of SECRETS) {
      assert.ok(!everywhere.includes(secret), `${JSON.stringify(secret)} reached the draft`);
    }
    assert.equal(stored.source.redactedCount, 2, 'the password and the DSN userinfo, counted');
    assert.match(stored.source.text, /postgres:\/\/REDACTED@postgres:5432\/app/, 'the host is not the secret');

    // The evidence quote for the Calls edge is the DSN line — redacted, but
    // still the line, at offsets that point into the text that was stored.
    const calls = draft.items.find(i => i.kind === 'relationship' && i.proposed.label === 'Calls');
    assert.equal(calls.input.evidence.quote, 'DATABASE_URL: postgres://REDACTED@postgres:5432/app');
    assert.equal(
      stored.source.text.slice(calls.input.evidence.charStart, calls.input.evidence.charEnd),
      calls.input.evidence.quote,
      'the offsets are offsets into the stored text',
    );
    log('light', `draft ${draft._id} stored ${stored.source.redactedCount} redactions (source: POST /drafts/compose)`);
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

    applied = await Entity.find({ workspaceId: architect.workspaceId, tags: 'docker-compose' }).lean();
    for (const e of applied) log('verbose', `  entity ${e._id} "${e.title}" (${e.category})`);
    const byTitle = Object.fromEntries(applied.map(e => [e.title, e]));
    assert.deepEqual(
      Object.fromEntries(applied.map(e => [e.title, e.category])),
      { web: 'Service', worker: 'Service', postgres: 'Data Store', redis: 'Data Store', 'api.stripe.com': 'External Dependency' },
    );
    assert.deepEqual(byTitle.postgres.blocks.map(b => [b.type, b.data.label, b.data.value]), [
      ['attribute', 'Image', 'postgres:16-alpine'],
      ['attribute', 'Ports', '5432:5432'],
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
      'Calls: Caller:worker → Callee:redis',
      'Depends on: Dependent:web → Dependency:api.stripe.com',
      'Depends on: Dependent:web → Dependency:postgres',
      'Depends on: Dependent:web → Dependency:redis',
      'Depends on: Dependent:worker → Dependency:postgres',
      'Depends on: Dependent:worker → Dependency:redis',
    ]);
    const web = await Entity.findById(byTitle.web._id).lean();
    assert.equal(web.relationships.length, 4, 'back-references are written on the members');
  });

  test('importing the same file again proposes updates to what the first import created', async () => {
    const res = await postCompose(architect, { text: FIXTURE });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.title, 'docker-compose', 'no filename, so a generic title');

    const idByTitle = new Map(applied.map(e => [e.title, String(e._id)]));
    const entities = res.body.items.filter(i => i.kind === 'entity');
    assert.equal(entities.length, 5);
    for (const item of entities) {
      assert.equal(item.op, 'update', `${item.proposed.title} should be an update`);
      assert.equal(item.matchedBy, 'exact-normalized-title');
      assert.equal(String(item.targetEntityId), idByTitle.get(item.proposed.title));
      assert.deepEqual(item.proposed.blocks, [], `${item.proposed.title} already has every attribute this file gives it`);
    }
  });

  /**
   * Every group joining the entities this file imported, as
   * "label: Role:title → Role:title" with its id.
   *
   * Scoped to those entities rather than the whole workspace so a template's
   * own sample content, if it ever grows any, cannot be counted as an edge of
   * this file.
   */
  async function composeGraph() {
    const ents = await Entity.find({ workspaceId: architect.workspaceId, tags: 'docker-compose' })
      .select('_id title relationships').lean();
    const titleOf = new Map(ents.map(e => [String(e._id), e.title]));
    const groups = await RelationshipGroup.find({
      workspaceId: architect.workspaceId,
      'members.refId': { $in: ents.map(e => e._id) },
    }).sort({ _id: 1 }).lean();
    return {
      groups: groups.map(g => ({
        id: String(g._id),
        described: `${g.label}: ${g.members.map(m => `${m.label}:${titleOf.get(String(m.refId)) ?? m.refId}`).join(' → ')}`,
      })),
      // How many links each entity's Relationships section would show.
      backRefs: Object.fromEntries(ents.map(e => [e.title, e.relationships.length])),
    };
  }

  /** decide-clean + apply, asserting every item landed. */
  async function decideAndApply(id, expected) {
    const decided = await architect.agent.post(`/drafts/${id}/decide-clean`);
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body.accepted, expected, JSON.stringify(decided.body));
    assert.equal(decided.body.skippedFlagged, 0, 'a re-import of an unchanged file flags nothing');

    const res = await architect.agent.post(`/drafts/${id}/apply`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    log('light', `draft ${id} applied (source: POST /drafts/:id/apply as ${architect.email}): ${JSON.stringify(res.body)}`);
    assert.deepEqual(
      { applied: res.body.applied, failed: res.body.failed, blocked: res.body.blocked, status: res.body.status },
      { applied: expected, failed: 0, blocked: 0, status: 'applied' },
    );
    return res.body;
  }

  test('the re-import proposes an update to each group the first import created, by id', async () => {
    const res = await postCompose(architect, { text: FIXTURE });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    reimport = res.body;

    const { groups } = await composeGraph();
    const ids = new Set(groups.map(g => g.id));
    const rels = reimport.items.filter(i => i.kind === 'relationship');
    assert.equal(rels.length, 7);
    for (const r of rels) {
      assert.equal(r.op, 'update', `${r.proposed.label} should be an update`);
      assert.equal(r.matchedBy, 'same-members-and-label');
      assert.ok(ids.has(r.proposed.targetGroupId), `${r.proposed.label} must target a group that exists`);
    }
    assert.equal(new Set(rels.map(r => r.proposed.targetGroupId)).size, 7, 'one group per edge, each claimed once');
  });

  test('applying the re-import leaves exactly one group per edge, and the same back-references', async () => {
    const before = await composeGraph();
    assert.equal(before.groups.length, 7);

    await decideAndApply(reimport._id, 12);

    const after = await composeGraph();
    // The same documents, not new ones beside them: ids included.
    assert.deepEqual(after.groups, before.groups);
    assert.deepEqual(after.backRefs, before.backRefs, "no entity's Relationships section grew");
  });

  test('a group someone widened by hand keeps their member, and the file still owns the roles it names', async () => {
    const ents = await Entity.find({ workspaceId: architect.workspaceId, tags: 'docker-compose' })
      .select('_id title').lean();
    const idOf = Object.fromEntries(ents.map(e => [e.title, e._id]));
    const widened = await RelationshipGroup.findOne({
      workspaceId: architect.workspaceId,
      label: 'Depends on',
      'members.refId': { $all: [idOf.web, idOf.redis] },
    });
    assert.ok(widened, 'the web → redis Depends on group');

    // A person edits the group: a third member of their own, and a role of
    // their own on one of the two the file named.
    widened.members.push({ refId: idOf['api.stripe.com'], refModel: 'Entity', label: 'Noted by', notes: 'added by hand' });
    widened.members.find(m => String(m.refId) === String(idOf.redis)).label = 'Neighbour';
    await widened.save();
    log('light', `group ${widened._id} widened by hand (source: the test, standing in for a person)`);

    const before = await composeGraph();
    const third = await postCompose(architect, { text: FIXTURE });
    assert.equal(third.status, 201, JSON.stringify(third.body));
    const matched = third.body.items.filter(i => i.proposed.targetGroupId === String(widened._id));
    assert.equal(matched.length, 1, 'the widened group is still the one edge it holds');
    await decideAndApply(third.body._id, 12);

    const after = await composeGraph();
    assert.equal(after.groups.length, before.groups.length, 'still one group per edge');
    assert.deepEqual(after.backRefs, before.backRefs);

    const reread = await RelationshipGroup.findById(widened._id).lean();
    assert.deepEqual(
      reread.members.map(m => [String(m.refId), m.label, m.notes]),
      [
        [String(idOf.web), 'Dependent', null],
        // Set back from 'Neighbour': the file is authoritative about the roles
        // of the members it names.
        [String(idOf.redis), 'Dependency', null],
        // Untouched, and still in the place the person put it: an apply never
        // removes or re-orders a member it was not told about.
        [String(idOf['api.stripe.com']), 'Noted by', 'added by hand'],
      ],
    );
  });

  test('another workspace cannot read the draft', async () => {
    const res = await writer.agent.get(`/drafts/${draft._id}`);
    log('normal', `${writer.email} GET /drafts/${draft._id} → ${res.status}`);
    assert.equal(res.status, 404);
  });
});

describe('POST /drafts/compose refusals', () => {
  test('invalid YAML is a 400 naming the line in the file as sent', async () => {
    const res = await postCompose(architect, { text: '\n\nservices:\n  web:\n    image: nginx\n   ports: [80\n' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /on line 6/);
    assert.equal(res.body.line, 6, 'the two blank lines the server trims still count');
  });

  test('a YAML file with no services is a 400', async () => {
    const res = await postCompose(architect, { text: 'name: CI\non: push\n', filename: 'ci.yml' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /No services found/);
  });

  test('missing or non-string text is a 400', async () => {
    assert.equal((await postCompose(architect, {})).status, 400);
    assert.equal((await postCompose(architect, { text: '   ' })).status, 400);
    assert.equal((await postCompose(architect, { text: { services: {} } })).status, 400);
  });

  test('a workspace without the types the file needs is a 400 naming them, and creates no draft', async () => {
    const res = await postCompose(writer, { text: FIXTURE });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.missingCategories, ['Service', 'Data Store', 'External Dependency']);
    const list = await writer.agent.get('/drafts');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 0);
  });

  test('an unauthenticated request is refused', async () => {
    const res = await request(app).post('/drafts/compose').send({ text: FIXTURE });
    log('normal', `anonymous POST /drafts/compose → ${res.status}`);
    assert.equal(res.status, 401);
  });
});

describe('POST /drafts/compose bounds the draft', () => {
  test('a file declaring hundreds of services yields a draft of at most the item cap', async () => {
    // The file is well under MAX_COMPOSE_CHARS, so the character limit alone
    // never stopped this: one request could produce a draft no reviewer could
    // work through, having scanned every proposal against the whole roster.
    const text = ['services:', ...Array.from({ length: 300 }, (_, i) =>
      `  svc-${i + 1}:\n    image: example/svc-${i + 1}`)].join('\n');

    const res = await postCompose(architect, { text, filename: 'huge-compose.yml' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.status, 'ready');
    assert.equal(res.body.items.length, MAX_ITEMS);
    assert.equal(res.body.counts.proposed, MAX_ITEMS);
    assert.equal(res.body.counts.pending, MAX_ITEMS);
    assert.equal(res.body.counts.dropped, 1, 'the whole overflow is one drop, reported as one');
    assert.match(res.body.diagnostics.dropReasons[0], new RegExp(`^item cap of ${MAX_ITEMS} reached — 240 further entities`));

    const stored = await Draft.findById(res.body._id).lean();
    assert.equal(stored.items.length, MAX_ITEMS, 'the cap is what was written, not just what was returned');
  });
});
