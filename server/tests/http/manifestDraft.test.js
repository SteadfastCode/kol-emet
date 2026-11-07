/**
 * POST /drafts/manifest end to end: a package manifest becomes a draft, and
 * the draft lands in the graph through the same review and apply routes a
 * generated one uses.
 *
 * Same harness as sqlDraft.test.js: `createApp()` over supertest, real
 * `POST /auth/register` — so the Software Architecture types arrive through the
 * real seeder — and real mongod. No AI provider is configured in this process,
 * which is itself part of the test: a producer must never need one.
 *
 * What it defends:
 *   - the draft records its producer (`package-manifest`, `package-manifest@1`),
 *     a textHash computed exactly as POST /drafts computes it, the workspace's
 *     categories as its grounding, and `manifest` as what read the file;
 *   - no allowance is spent, and none is required — the quota is untouched
 *     either side of an import, which is what makes a deterministic producer
 *     safe to re-run;
 *   - the fixture's credentials reach neither `source.text`, nor an evidence
 *     quote, nor the database: a manifest carries them in a `repository` URL
 *     and in a publish script, which is exactly where they end up in life;
 *   - decide-clean + apply writes one Service for the module and an External
 *     Dependency plus a Depends on group per direct runtime dependency;
 *   - importing the same manifest again proposes nothing for the entities it
 *     already created, and updates to the groups it created;
 *   - each of the other three formats is read from its own content, with no
 *     filename to go on;
 *   - a body over the character cap is refused with the size it was;
 *   - a file that is no manifest at all is a 400, one that does not parse is a
 *     400 naming the line, a workspace without the types is a 400 naming them,
 *     and no workspace but the caller's own can be named.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_MANIFEST_DRAFT_LOG_LEVEL = off | light | normal | verbose (default light)
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
import { MAX_MANIFEST_CHARS } from '../../src/lib/producers/packageManifest.js';

// Environment before src/app.js is imported, for the reasons in tenancy.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.MANIFEST_LOG_LEVEL ??= 'off';
process.env.REDACT_LOG_LEVEL ??= 'off';
process.env.APPLY_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };
function log(level, msg) {
  const active = LEVELS[process.env.TEST_MANIFEST_DRAFT_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/manifestDraft:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';
const fixture = name => readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');
// Not called `package.json`: one inside the tests tree would change how Node
// resolves the modules beside it.
const FIXTURE = fixture('manifest-package.json');
const GOMOD = fixture('manifest-go.mod');
const PYPROJECT = fixture('manifest-pyproject.toml');
const CARGO = fixture('manifest-Cargo.toml');
// The credentials the fixture carries, asserted against by their literal text:
// a leak is "this string is somewhere it should not be", not "the line looks
// wrong". One in a `repository` URL, one in a publish script — the two places a
// real manifest leaks a token.
const SECRETS = ['hunter2-fixture-secret', 'sk-fixture-0123456789abcdef'];
// What the server stores: the manifest with those taken out, which is also what
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
  const res = await who.agent.post('/drafts/manifest').send(body);
  if (res.status === 201) {
    log('light', `draft ${res.body._id} created (source: POST /drafts/manifest as ${who.email}) with ${res.body.items.length} items`);
    for (const i of res.body.items) {
      log('verbose', `  ${i.localKey} ${i.kind} ${i.op} ${JSON.stringify(i.proposed.title ?? i.proposed.label)}`);
    }
  } else {
    log('normal', `${who.email} POST /drafts/manifest → ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res;
}

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });
  architect = await registerUser('manifest-architect@example.test', 'software-architecture');
  writer = await registerUser('manifest-writer@example.test');
});

after(async () => { await db.disconnect(); });

describe('POST /drafts/manifest', () => {
  let draft;
  let applied;
  let quotaBefore;

  test('turns the fixture into a ready draft recording its producer', async () => {
    const quota = await architect.agent.get('/drafts/quota');
    assert.equal(quota.status, 200);
    quotaBefore = quota.body;

    const res = await postManifest(architect, { text: FIXTURE, filename: 'package.json' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    draft = res.body;

    assert.equal(String(draft.workspaceId), architect.workspaceId);
    assert.equal(draft.status, 'ready');
    assert.equal(draft.title, 'package.json');
    assert.equal(draft.source.producer, 'package-manifest');
    assert.equal(draft.source.producerVersion, 'package-manifest@1');
    assert.equal(draft.source.text, REDACTED_FIXTURE);
    const expectedHash = `sha256:${crypto.createHash('sha256').update(REDACTED_FIXTURE).digest('hex')}`;
    assert.equal(draft.source.textHash, expectedHash, 'textHash is of the text that was stored');
    assert.deepEqual(draft.grounding.categories, ['Service', 'Data Store', 'API', 'Team', 'External Dependency']);
    assert.equal(draft.route.strategy, 'deterministic');
    assert.equal(draft.route.provider, null, 'no model was involved');
    assert.deepEqual(draft.diagnostics.parsedVia, ['manifest'], 'this producer reads four formats through its own readers');

    const entities = draft.items.filter(i => i.kind === 'entity');
    assert.deepEqual(entities.map(i => [i.proposed.title, i.proposed.category]), [
      ['@acme/billing', 'Service'],
      ['express', 'External Dependency'],
      ['pg', 'External Dependency'],
      ['ioredis', 'External Dependency'],
      ['bufferutil', 'External Dependency'],
      ['@acme/ledger-client', 'External Dependency'],
    ]);
    assert.equal(draft.items.filter(i => i.kind === 'relationship').length, 5);
    assert.deepEqual(draft.counts, { ...draft.counts, proposed: 11, pending: 11, dropped: 3 });
    assert.deepEqual(draft.diagnostics.dropReasons, [
      '3 dev dependencies in `devDependencies` were not proposed — a dev or test dependency is ' +
      'not part of what the module runs: eslint, jest, prettier',
    ], 'one reason for the group, and counts.dropped counts the packages');
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
    assert.equal(stored.source.redactedCount, 2, 'the repository URL and the publish script');
    assert.match(stored.source.text, /https:\/\/REDACTED@github\.com\/acme\/billing\.git/,
      'the host survives: it is not the secret');
    assert.match(stored.source.text, /NPM_TOKEN=REDACTED npm publish/);

    // Evidence offsets point into the text that was stored, not into the upload.
    for (const item of stored.items) {
      const { quote, charStart, charEnd } = item.input.evidence;
      assert.equal(stored.source.text.slice(charStart, charEnd), quote, `${item.localKey}'s offsets`);
    }
    log('light', `draft ${draft._id} stored ${stored.source.redactedCount} redactions (source: POST /drafts/manifest)`);
  });

  test('decide-clean then apply lands the module and its dependencies, with their links', async () => {
    const decided = await architect.agent.post(`/drafts/${draft._id}/decide-clean`);
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body.accepted, 11);
    assert.equal(decided.body.skippedFlagged, 0);

    const res = await architect.agent.post(`/drafts/${draft._id}/apply`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    log('light', `draft ${draft._id} applied (source: POST /drafts/:id/apply as ${architect.email}): ${JSON.stringify(res.body)}`);
    assert.equal(res.body.applied, 11);
    assert.equal(res.body.failed, 0);
    assert.equal(res.body.blocked, 0);
    assert.equal(res.body.status, 'applied');

    applied = await Entity.find({ workspaceId: architect.workspaceId, tags: 'package-manifest' }).lean();
    for (const e of applied) log('verbose', `  entity ${e._id} "${e.title}" (${e.category})`);
    const byTitle = Object.fromEntries(applied.map(e => [e.title, e]));
    assert.deepEqual(
      Object.fromEntries(applied.map(e => [e.title, e.category])),
      {
        '@acme/billing': 'Service',
        express: 'External Dependency',
        pg: 'External Dependency',
        ioredis: 'External Dependency',
        bufferutil: 'External Dependency',
        '@acme/ledger-client': 'External Dependency',
      },
    );
    assert.deepEqual(byTitle['@acme/billing'].blocks.map(b => [b.data.label ?? '(text)', b.data.value ?? b.data.markdown]), [
      ['Package', '@acme/billing'],
      ['Version', '1.4.2'],
      ['Runtime', 'Node.js >=20.11'],
      ['Manifest', 'package.json'],
      ['(text)', 'Invoices, dunning and the ledger feed.'],
    ]);
    assert.deepEqual(byTitle['@acme/ledger-client'].blocks.map(b => [b.data.label, b.data.value]), [
      ['Version constraint', '^2'],
      ['Ecosystem', 'npm'],
      ['Dependency kind', 'peer'],
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
      'Depends on: Dependent:@acme/billing → Dependency:@acme/ledger-client',
      'Depends on: Dependent:@acme/billing → Dependency:bufferutil',
      'Depends on: Dependent:@acme/billing → Dependency:express',
      'Depends on: Dependent:@acme/billing → Dependency:ioredis',
      'Depends on: Dependent:@acme/billing → Dependency:pg',
    ]);
    const module = await Entity.findById(byTitle['@acme/billing']._id).lean();
    assert.equal(module.relationships.length, 5, 'back-references are written on the members');
  });

  test('importing the same manifest again proposes nothing for the entities it already created', async () => {
    const res = await postManifest(architect, { text: FIXTURE });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.title, 'package-manifest', 'no filename, so a generic title');

    // Every entity matched the one the first import created and gives it no
    // attribute, tag or summary it does not already have, so applying it would write
    // a ChangeLog row with an empty diff. Each is dropped instead of queued as a
    // decision where accept and reject mean the same thing (lib/draftTarget.js).
    assert.deepEqual(res.body.items.filter(i => i.kind === 'entity'), []);
    const reasons = res.body.diagnostics.dropReasons;
    for (const entity of applied) {
      assert.ok(reasons.includes(`entity ${JSON.stringify(entity.title)} is already in this workspace and unchanged`),
        `${entity.title} should be named as a drop; the reasons were ${JSON.stringify(reasons)}`);
    }
    assert.equal(reasons.filter(r => / is already in this workspace and unchanged$/.test(r)).length, applied.length,
      'one drop per entity the first import created, and no more');
    // `dropped` is the whole count while the listed reasons are capped, and a
    // producer may report several drops as one reason, so it is only ever at
    // least the number of items this pass took out.
    assert.ok(res.body.counts.dropped >= applied.length, JSON.stringify(res.body.counts));

    // The edges are a separate question: a group update re-asserts the roles the
    // file names, and every member points at the entity it matched by id now
    // that the items naming it are gone.
    for (const item of res.body.items.filter(i => i.kind === 'relationship')) {
      assert.equal(item.op, 'update', `${item.proposed.label} should target the group it created`);
      assert.equal(item.matchedBy, 'same-members-and-label');
      assert.deepEqual(item.dependsOn, [], 'nothing depends on an item that was dropped');
      for (const m of item.proposed.members) {
        assert.equal(m.localKey, null, `${m.name} must not name a dropped item`);
        assert.ok(m.refId, `${m.name} carries the id of the entity in the graph`);
      }
    }
  });

  test('another workspace cannot read the draft', async () => {
    const res = await writer.agent.get(`/drafts/${draft._id}`);
    log('normal', `${writer.email} GET /drafts/${draft._id} → ${res.status}`);
    assert.equal(res.status, 404);
  });
});

describe('POST /drafts/manifest reads each format from its own content', () => {
  // No filename is sent for any of these: the format is the file's, not its
  // name's. The one shared route does the rest, so what is checked per format
  // is the mapping and the drop reasons.
  test('a go.mod becomes its module and its direct requires', async () => {
    const res = await postManifest(architect, { text: GOMOD });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.items.filter(i => i.kind === 'entity').map(i => i.proposed.title), [
      'ledger-feed', 'github.com/gin-gonic/gin', 'github.com/jackc/pgx/v5', 'github.com/redis/go-redis/v9',
    ]);
    assert.equal(res.body.counts.dropped, 2, 'the two `// indirect` requires');
    assert.match(res.body.diagnostics.dropReasons[0], /indirect/);
  });

  test('a pyproject.toml becomes its project and its requirement array', async () => {
    const res = await postManifest(architect, { text: PYPROJECT });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.items.filter(i => i.kind === 'entity').map(i => i.proposed.title), [
      'billing-reports', 'requests', 'httpx', 'SQLAlchemy', 'jinja2',
    ]);
    assert.equal(res.body.counts.dropped, 3, 'the dev and docs extras');
  });

  test('a Cargo.toml becomes its crate and its [dependencies]', async () => {
    const res = await postManifest(architect, { text: CARGO });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.items.filter(i => i.kind === 'entity').map(i => i.proposed.title), [
      'statement-renderer', 'serde', 'tokio', 'tracing', 'acme-shared', 'sqlx',
    ]);
    assert.equal(res.body.counts.dropped, 4, 'the optional, dev, build and platform ones');
  });
});

describe('POST /drafts/manifest refusals', () => {
  test('a file that is no manifest at all is a 400 saying so', async () => {
    const res = await postManifest(architect, { text: 'Some notes about our billing service.\n', filename: 'notes.txt' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Not a package manifest/);
  });

  test('a manifest that does not parse is a 400 naming the line', async () => {
    const res = await postManifest(architect, { text: '{\n  "name": "x",\n  "dependencies": {,}\n}\n', filename: 'package.json' });
    assert.equal(res.status, 400);
    assert.equal(res.body.line, 3);
    assert.match(res.body.error, /Invalid JSON/);
  });

  test('a manifest with no dependencies is a one-item draft, not a refusal', async () => {
    const res = await postManifest(architect, { text: '{"name": "leaf-service", "version": "1.0.0"}', filename: 'leaf.json' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.counts.proposed, 1);
    assert.equal(res.body.items[0].proposed.category, 'Service');
    assert.deepEqual(res.body.diagnostics.dropReasons, []);
  });

  test('a body over the character cap is refused with the size it was, and stores nothing', async () => {
    // Deliberately VALID: the cap is measured before the parse, so a file this
    // big is refused for its size rather than for its content.
    const before = (await architect.agent.get('/drafts')).body.length;
    const dependencies = {};
    // Grown until it is over rather than computed: the cap is the thing under
    // test, so the fixture must not depend on an arithmetic guess about it.
    for (let i = 0; JSON.stringify({ name: 'huge', dependencies }).length <= MAX_MANIFEST_CHARS; i++) {
      dependencies[`@acme/package-with-a-long-name-${String(i).padStart(4, '0')}`] = '^1.0.0';
    }
    const text = JSON.stringify({ name: 'huge', dependencies });
    assert.ok(text.length > MAX_MANIFEST_CHARS, 'the fixture for this test must be over the cap');

    const res = await postManifest(architect, { text, filename: 'huge.json' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, new RegExp(`^The file is ${text.length.toLocaleString()} characters; the limit is `));
    const after = (await architect.agent.get('/drafts')).body.length;
    assert.equal(after, before, 'nothing was stored for a request that was refused');
  });

  test('missing or non-string text is a 400', async () => {
    assert.equal((await postManifest(architect, {})).status, 400);
    assert.equal((await postManifest(architect, { text: '   ' })).status, 400);
    assert.equal((await postManifest(architect, { text: { name: 'x' } })).status, 400);
  });

  test('a workspace without the types the manifest needs is a 400 naming them, and creates no draft', async () => {
    const res = await postManifest(writer, { text: FIXTURE });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.missingCategories, ['Service', 'External Dependency']);
    assert.match(res.body.error, /a package manifest import needs/);
    const list = await writer.agent.get('/drafts');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 0);
  });

  test('a caller cannot name another workspace to import into', async () => {
    // The workspace is resolved from the session, never from the body: a
    // request naming someone else's lands in the caller's own or nowhere.
    const res = await postManifest(writer, {
      text: '{"name": "smuggled", "version": "1.0.0"}',
      workspaceId: architect.workspaceId,
    });
    log('normal', `${writer.email} POST /drafts/manifest naming another workspace → ${res.status}`);
    assert.ok(res.status === 201 || res.status === 400, `unexpected ${res.status}: ${JSON.stringify(res.body)}`);
    if (res.status === 201) {
      assert.equal(String(res.body.workspaceId), writer.workspaceId, 'the body cannot choose the workspace');
    }
    const architectDrafts = await Draft.find({ workspaceId: architect.workspaceId }).lean();
    for (const d of architectDrafts) {
      assert.ok(!JSON.stringify(d.items).includes('smuggled'), 'nothing of the writer\'s reached the architect\'s workspace');
    }
  });

  test('an unauthenticated request is refused', async () => {
    const res = await request(app).post('/drafts/manifest').send({ text: FIXTURE });
    log('normal', `anonymous POST /drafts/manifest → ${res.status}`);
    assert.equal(res.status, 401);
  });
});
