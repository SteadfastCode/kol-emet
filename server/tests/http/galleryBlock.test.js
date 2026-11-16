/**
 * The gallery block's `data` shape, over every path that can write one (KOL-142).
 *
 * `gallery` has been in `BLOCK_TYPES` since the block migration and every write
 * path took it, because each validator only ever asked for "an object": a
 * gallery block could be created, generated, exported and re-imported carrying
 * literally anything, and the reader showed a dashed box reading "Image hosting
 * coming soon." This suite pins the shape the reader now renders —
 * `data.images` as `[{ url, caption }]`, http/https only — on the one axis that
 * matters for a rule like this: that **no write path is a side door**.
 *
 * So the same two documents (a good gallery, a `javascript:`/`data:` one) are
 * aimed at all four writers, each of which refuses in its own vocabulary:
 *
 *   - `POST /entities` and `PUT /entities/:id` → 400 whose `error` is the
 *     message, which is where "naming the block" is actually observable;
 *   - `POST /import` → 400 `MALFORMED_DOCUMENT`, writing nothing (the route
 *     answers with the code alone — the reason is in the importer's log, so the
 *     message itself is asserted on the routes above and on the applier below);
 *   - `applyDraft` → the item is recorded `failed` with an
 *     `APPLY_INVALID_BLOCKS` note naming the block, and no entity is written;
 *   - `create_entity` over MCP writes with `Entity.create` rather than through
 *     `POST /entities`, and its `BlockInput.data` is `z.record(z.unknown())`.
 *     That path is covered by `tests/http/mcp.test.js`'s harness, not here; the
 *     check it calls is the same exported leaf, pinned directly below.
 *
 * Two non-refusals are as important as the refusals:
 *
 *   - **a legacy `{ images: [] }` block still saves.** The editor seeded
 *     exactly that for months, and a shape rule that makes an existing entity
 *     unsaveable is worse than no shape rule. A gallery whose `data` has no
 *     `images` key at all saves too, for the same reason.
 *   - **an entity exported and re-imported keeps its images**, which is the
 *     only end-to-end proof that the new field survives the canonical document.
 *
 * Falsification check: remove the `blockDataError` call from
 * `routes/entities.js` and the create/update refusals fail; remove it from
 * `lib/graphImporter.js` and the import refusal fails; remove it from
 * `lib/draftApplier.js` and the generated-item refusal fails. Each group fails
 * only for its own writer, which is what makes "no side door" a real assertion
 * rather than one check observed four times.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_GALLERY_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per fixture document, naming the request that created it
 *   normal  — light, plus each write under test, its status and body
 *   verbose — normal, plus the blocks posted
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import session from 'express-session';

import { CLIENT_ORIGIN, originAgent } from '../helpers/origin.js';
import * as db from '../helpers/db.js';
import { SUITE_AUTH_LIMITS } from '../helpers/suiteLimits.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';

// Environment before src/app.js is imported, for the reasons in tenancy.test.js.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.CLIENT_ORIGIN = CLIENT_ORIGIN;
process.env.ORIGIN_GUARD_LOG_LEVEL ??= 'off';
// Unset on purpose: with no bearer token configured a stray Authorization
// header cannot resolve to the MCP user and quietly satisfy requireAuth.
delete process.env.BEARER_TOKEN;
process.env.SEED_LOG_LEVEL ??= 'off';
process.env.EXPORT_LOG_LEVEL ??= 'off';
process.env.IMPORT_LOG_LEVEL ??= 'off';
process.env.ENTITY_LIST_LOG_LEVEL ??= 'off';
process.env.ENTITY_TYPE_LOG_LEVEL ??= 'off';
process.env.WORKSPACE_LOG_LEVEL ??= 'off';
process.env.ERROR_LOG_LEVEL ??= 'off';
process.env.APPLY_LOG_LEVEL ??= 'off';
process.env.SSE_LOG_LEVEL ??= 'off';

const { createApp } = await import('../../src/app.js');
const { blockDataError, MAX_GALLERY_IMAGES } = await import('../../src/models/Entity.js');
const { applyDraft } = await import('../../src/lib/draftApplier.js');
const Draft = (await import('../../src/models/Draft.js')).default;
const Entity = (await import('../../src/models/Entity.js')).default;

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  const active = LEVELS[process.env.TEST_GALLERY_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/gallery:${level}] ${msg}`);
}

const PASSWORD = 'correct-horse-battery-staple';

/** The gallery a user would actually write: two images someone else hosts. */
const TWO_IMAGES = [
  { url: 'https://images.example.test/train/engine.jpg', caption: 'The engine, from the coupling' },
  { url: 'http://images.example.test/train/carriage.png', caption: '' },
];

const galleryBlock = (images, order = 0) => ({ type: 'gallery', order, data: { images } });
const textBlock = (markdown = 'A paragraph.', order = 0) => ({ type: 'text', order, data: { markdown } });

let app;
let alice;   // writes galleries through the routes, and exports them
let bob;     // an emptied workspace aimed at by refused imports
let carol;   // an emptied workspace that receives the good document

async function registerUser(email) {
  const agent = originAgent(app);
  const res = await agent.post('/auth/register').send({ email, password: PASSWORD });
  assert.equal(res.status, 201, `POST /auth/register (${email}) failed: ${res.status} ${JSON.stringify(res.body)}`);

  const user = await User.findOne({ email }).select('_id').lean();
  const workspace = await Workspace.findOne({ 'members.userId': user._id }).select('_id').lean();
  log('light', `registered ${email} (source: POST /auth/register) → workspace ${workspace._id}`);
  return { agent, email, userId: user._id, workspaceId: workspace._id };
}

/** POSTs an entity whose blocks are `blocks`, returning the response. */
async function postEntity(who, title, blocks) {
  const res = await who.agent.post('/entities').send({
    title,
    category: 'Characters',
    summary: `${title} — created for the gallery suite.`,
    blocks,
  });
  log('normal', `POST /entities "${title}" as ${who.email} → ${res.status} ${JSON.stringify(res.body?.error ?? res.body?._id)}`);
  log('verbose', JSON.stringify(blocks));
  return res;
}

/**
 * Deletes everything an import counts as content, through the API — the real
 * work an owner does before an import, since registration seeds a workspace.
 */
async function emptyWorkspace(who) {
  for (const route of ['/relationship-groups', '/open-questions', '/entities']) {
    const docs = (await who.agent.get(route)).body ?? [];
    for (const doc of docs) {
      const res = await who.agent.delete(`${route}/${doc._id}`);
      assert.ok(res.status < 300, `DELETE ${route}/${doc._id} failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
  }
  assert.deepEqual((await who.agent.get('/entities')).body, [], 'the workspace must be empty before an import');
  log('light', `emptied ${who.email}'s workspace (source: the DELETE routes)`);
}

/** The ids a workspace holds now — an unchanged set proves a refusal wrote nothing. */
async function entityIds(who) {
  return ((await who.agent.get('/entities')).body ?? []).map(e => String(e._id)).sort();
}

/** A one-item, already-accepted draft proposing an entity with these blocks. */
function galleryDraft(who, blocks) {
  const proposed = {
    title: 'Generated Gallery',
    category: 'Characters',
    normalizedCategory: 'Characters',
    summary: 'Proposed by the generator.',
    tags: [],
    blocks,
  };
  return Draft.create({
    workspaceId: who.workspaceId,
    createdBy: who.userId,
    title: 'gallery fixture',
    status: 'ready',
    source: { producer: 'braindump', text: 'fixture' },
    items: [{
      localKey: 'e1', seq: 0, kind: 'entity', op: 'create',
      proposed, accepted: proposed, decision: 'accepted',
    }],
  });
}

const actorOf = who => ({ userId: who.userId, type: 'user', label: who.email });

before(async () => {
  await db.connect();
  app = createApp({ sessionStore: new session.MemoryStore(), authLimits: SUITE_AUTH_LIMITS });
  alice = await registerUser('alice@example.test');
  bob = await registerUser('bob@example.test');
  carol = await registerUser('carol@example.test');
});

after(async () => {
  await db.disconnect();
});

describe('gallery blocks through the entity routes', () => {
  test('a gallery of two { url, caption } images is accepted and read back unchanged', async () => {
    const res = await postEntity(alice, 'Engine Room', [textBlock(), galleryBlock(TWO_IMAGES, 1)]);
    assert.equal(res.status, 201, JSON.stringify(res.body));

    // Read back through GET /entities/:id rather than trusting the create
    // response: the list path projects blocks away, and what a reader gets is
    // what this item is about.
    const read = await alice.agent.get(`/entities/${res.body._id}`);
    assert.equal(read.status, 200);
    const gallery = read.body.blocks.find(b => b.type === 'gallery');
    assert.ok(gallery, 'the gallery block survived the write');
    assert.deepEqual(
      gallery.data.images.map(({ url, caption }) => ({ url, caption })),
      TWO_IMAGES,
      'every url and caption round-trips, in order'
    );
  });

  test('a javascript: and a data: image url are refused, with a message naming the block', async () => {
    for (const url of ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'JAVASCRIPT:alert(1)']) {
      const res = await postEntity(alice, `Refused ${url.slice(0, 12)}`, [galleryBlock([{ url }])]);
      assert.equal(res.status, 400, `${url} must not be writable: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, /gallery block/, `the message must name the block: ${res.body.error}`);
      assert.match(res.body.error, /http: and https:/, `the message must say what is allowed: ${res.body.error}`);
    }
  });

  test('a url that is not a URL at all, and one past the length cap, are refused', async () => {
    for (const url of ['not a url', '//images.example.test/relative.jpg', `https://images.example.test/${'a'.repeat(2100)}.jpg`]) {
      const res = await postEntity(alice, `Refused ${url.slice(0, 10)}`, [galleryBlock([{ url }])]);
      assert.equal(res.status, 400, `${url.slice(0, 40)} must not be writable: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, /gallery block/);
    }
  });

  test('a non-array images, a non-object image, a missing url and a long caption are refused', async () => {
    const bad = [
      { images: 'https://images.example.test/one.jpg' },
      { images: { 0: { url: 'https://images.example.test/one.jpg' } } },
      { images: ['https://images.example.test/one.jpg'] },
      { images: [{ caption: 'no url at all' }] },
      { images: [{ url: 'https://images.example.test/one.jpg', caption: 'x'.repeat(400) }] },
      { images: [{ url: 'https://images.example.test/one.jpg', caption: 42 }] },
      { images: Array.from({ length: MAX_GALLERY_IMAGES + 1 }, (_, i) => ({ url: `https://images.example.test/${i}.jpg` })) },
    ];
    for (const [i, data] of bad.entries()) {
      const res = await postEntity(alice, `Refused shape ${i}`, [{ type: 'gallery', order: 0, data }]);
      assert.equal(res.status, 400, `shape ${i} must not be writable: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, /gallery block/, `shape ${i}: ${res.body.error}`);
    }
  });

  test('a legacy empty gallery still saves — on create, and on update of an existing entity', async () => {
    // What the editor seeded before this item, and what a workspace is full of.
    const created = await postEntity(alice, 'Legacy Gallery', [galleryBlock([])]);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // The round trip a person's save makes: read the entity, PUT it back.
    const read = await alice.agent.get(`/entities/${created.body._id}`);
    const put = await alice.agent.put(`/entities/${created.body._id}`).send({
      title: read.body.title,
      category: read.body.category,
      summary: 'Edited, with the empty gallery still on it.',
      blocks: read.body.blocks.map(({ type, order, data }) => ({ type, order, data })),
    });
    assert.equal(put.status, 200, `an existing entity must stay saveable: ${JSON.stringify(put.body)}`);

    // And a gallery stored with no `images` key at all — which the MCP schema's
    // z.record(z.unknown()) accepted — is an empty gallery, not a refusal.
    const bare = await postEntity(alice, 'Bare Gallery', [{ type: 'gallery', order: 0, data: {} }]);
    assert.equal(bare.status, 201, `a gallery with no images key must stay writable: ${JSON.stringify(bare.body)}`);

    // Deleted again rather than left in the workspace, and the reason is worth
    // recording: mongoose's `minimize` (on by default) strips an empty object
    // from a Mixed path on save, so this block is STORED with no `data` at all
    // — which `GET /export` writes as `data: null` and `POST /import` then
    // refuses as "data is missing". That is a pre-existing quirk of `{}` on any
    // block type, not a gallery rule, and it is out of this item's scope; here
    // it would otherwise poison the export fixture the import group needs.
    assert.ok((await alice.agent.delete(`/entities/${bare.body._id}`)).status < 300);
  });

  test('an updated entity may have a gallery added, and a bad one on update is refused', async () => {
    const created = await postEntity(alice, 'Updatable', [textBlock()]);
    assert.equal(created.status, 201);
    const id = created.body._id;

    const good = await alice.agent.put(`/entities/${id}`).send({ blocks: [textBlock(), galleryBlock(TWO_IMAGES, 1)] });
    assert.equal(good.status, 200, JSON.stringify(good.body));
    assert.equal((await alice.agent.get(`/entities/${id}`)).body.blocks.at(-1).data.images.length, 2);

    const bad = await alice.agent.put(`/entities/${id}`).send({ blocks: [galleryBlock([{ url: 'javascript:alert(1)' }])] });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.match(bad.body.error, /gallery block/);
    // The refused update left the good blocks in place.
    assert.equal((await alice.agent.get(`/entities/${id}`)).body.blocks.at(-1).data.images.length, 2);
  });

  test('the exported leaf itself: blockDataError only speaks about gallery blocks', () => {
    assert.equal(blockDataError(textBlock()), null, 'a text block has no shape rules yet');
    assert.equal(blockDataError({ type: 'quote', order: 0, data: { text: 'x' } }), null);
    assert.equal(blockDataError(galleryBlock(TWO_IMAGES)), null);
    assert.match(blockDataError(galleryBlock([{ url: 'javascript:alert(1)' }])), /^gallery block: /);
  });
});

describe('gallery blocks through POST /import', () => {
  let document;   // a real export of alice's workspace, gallery and all

  before(async () => {
    const created = await postEntity(alice, 'Exported Gallery', [galleryBlock(TWO_IMAGES)]);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const exported = await alice.agent.get('/export');
    assert.equal(exported.status, 200, 'the suite needs a real export to import');
    document = JSON.parse(exported.text);
    const entity = document.entities.find(e => e.title === 'Exported Gallery');
    assert.ok(entity, 'the export carries the entity with the gallery');
    assert.deepEqual(
      entity.blocks.find(b => b.type === 'gallery').data.images.map(({ url, caption }) => ({ url, caption })),
      TWO_IMAGES,
      'the export carries the images themselves'
    );
    log('light', `exported alice's workspace (source: GET /export), ${document.entities.length} entities`);
  });

  test('a document whose gallery holds a javascript: url is 400 MALFORMED_DOCUMENT and writes nothing', async () => {
    await emptyWorkspace(bob);
    const before = await entityIds(bob);

    for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
      const broken = structuredClone(document);
      const entity = broken.entities.find(e => e.title === 'Exported Gallery');
      entity.blocks.find(b => b.type === 'gallery').data.images[0].url = url;

      const res = await bob.agent.post('/import').send(broken);
      log('normal', `POST /import with ${url} → ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.status, 400, `${url} must not be importable: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, 'MALFORMED_DOCUMENT');
      assert.deepEqual(await entityIds(bob), before, 'a refused import writes nothing');
    }

    // A non-array images is refused on this path too.
    const nonArray = structuredClone(document);
    nonArray.entities.find(e => e.title === 'Exported Gallery')
      .blocks.find(b => b.type === 'gallery').data.images = 'https://images.example.test/one.jpg';
    const res = await bob.agent.post('/import').send(nonArray);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, 'MALFORMED_DOCUMENT');
    assert.deepEqual(await entityIds(bob), before);
  });

  test('an entity exported and re-imported keeps its images', async () => {
    await emptyWorkspace(carol);

    const res = await carol.agent.post('/import').send(document);
    assert.equal(res.status, 201, `the unedited document must import: ${JSON.stringify(res.body)}`);

    const list = (await carol.agent.get('/entities')).body ?? [];
    const imported = list.find(e => e.title === 'Exported Gallery');
    assert.ok(imported, `the imported workspace holds the entity: ${list.map(e => e.title).join(', ')}`);

    const read = await carol.agent.get(`/entities/${imported._id}`);
    assert.deepEqual(
      read.body.blocks.find(b => b.type === 'gallery').data.images.map(({ url, caption }) => ({ url, caption })),
      TWO_IMAGES,
      'the round trip is lossless for a gallery'
    );
  });
});

describe('gallery blocks through the draft applier', () => {
  test('a generated gallery with a good url is applied, images intact', async () => {
    const draft = await galleryDraft(alice, [galleryBlock(TWO_IMAGES)]);
    assert.deepEqual(await applyDraft(draft, { workspaceId: alice.workspaceId, actor: actorOf(alice) }),
      { applied: 1, failed: 0, blocked: 0, skipped: 0 });

    const written = await Entity.findById(draft.items[0].resultId).lean();
    assert.deepEqual(
      written.blocks.find(b => b.type === 'gallery').data.images.map(({ url, caption }) => ({ url, caption })),
      TWO_IMAGES
    );
  });

  test('a generated gallery with a javascript: url fails the item and writes no entity', async () => {
    const before = await Entity.countDocuments({ workspaceId: alice.workspaceId });
    const draft = await galleryDraft(alice, [galleryBlock([{ url: 'javascript:alert(1)', caption: 'Looks like a picture' }])]);

    assert.deepEqual(await applyDraft(draft, { workspaceId: alice.workspaceId, actor: actorOf(alice) }),
      { applied: 0, failed: 1, blocked: 0, skipped: 0 });

    const item = draft.items[0];
    assert.equal(item.applyState, 'failed');
    assert.match(item.applyError ?? '', /gallery block/, `the failure note names the block: ${item.applyError}`);
    assert.equal(item.resultId, null, 'nothing was written');
    assert.equal(await Entity.countDocuments({ workspaceId: alice.workspaceId }), before);
  });

  test('a generated gallery whose images is not an array fails the item too', async () => {
    const draft = await galleryDraft(alice, [{ type: 'gallery', order: 0, data: { images: { url: 'https://images.example.test/one.jpg' } } }]);
    assert.deepEqual(await applyDraft(draft, { workspaceId: alice.workspaceId, actor: actorOf(alice) }),
      { applied: 0, failed: 1, blocked: 0, skipped: 0 });
    assert.match(draft.items[0].applyError ?? '', /gallery block/);
  });
});
