/**
 * Unit tests for the docker-compose producer, src/lib/producers/dockerCompose.js.
 *
 * The producer's contract is that its output is indistinguishable, in shape,
 * from what normalizeDraft emits for a braindump — the review UI, the decision
 * routes and the applier all take it without knowing where it came from. So
 * beyond the mapping itself (which service is a Data Store, which edge is a
 * Calls and which a Depends on), these tests hold it to that shape: every
 * `proposed` passes the same validators an edited item must, every evidence
 * quote is a real line of the file at the offsets it claims, and a second
 * import against the entities the first one created turns into updates.
 *
 * Fixture: tests/fixtures/docker-compose.yml — web and worker, both built from
 * source, depending on postgres and redis images; web's DATABASE_URL names the
 * postgres service and its PAYMENTS_API an external https host.
 *
 * Falsification checks, run red by hand against a deliberately broken producer:
 *   - DATA_STORE_IMAGES emptied                -> the Data Store assertions fail
 *   - hostToService lookup removed             -> DATABASE_URL becomes an External
 *                                                 Dependency "postgres" and the Calls test fails
 *   - existingByKey lookup removed             -> the re-import test fails (all creates)
 *   - evidenceAt returning the key's column    -> the evidence test fails
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_COMPOSE_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per parse: the fixture it came from and what it produced
 *   normal  — light, plus each item's title or label and evidence line
 *   verbose — normal, plus every item as JSON
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import mongoose from 'mongoose';

import {
  parseCompose, ComposeParseError, imageName, isDataStoreImage,
  PRODUCER, PRODUCER_VERSION,
} from '../../src/lib/producers/dockerCompose.js';
import { relationshipPayloadSchema } from '../../src/lib/draftItemSchema.js';

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };
function log(level, msg) {
  const active = LEVELS[process.env.TEST_COMPOSE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/dockerCompose:${level}] ${msg}`);
}

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/docker-compose.yml', import.meta.url));
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

function parse(text, opts, source) {
  const out = parseCompose(text, opts);
  log('light', `parsed ${source} (source: parseCompose, ${opts?.existingEntities?.length ?? 0} existing entities) → ${out.items.length} items, ${out.dropReasons.length} dropped`);
  for (const i of out.items) {
    log('normal', `  ${i.localKey} ${i.kind} ${i.op} ${JSON.stringify(i.proposed.title ?? i.proposed.label)} ← ${JSON.stringify(i.input.evidence.quote)}`);
    log('verbose', `  ${JSON.stringify(i)}`);
  }
  return out;
}

const entities = items => items.filter(i => i.kind === 'entity');
const relationships = items => items.filter(i => i.kind === 'relationship');
const entityNamed = (items, title) => {
  const hit = entities(items).find(i => i.proposed.title === title);
  assert.ok(hit, `expected an entity "${title}"; got ${entities(items).map(i => i.proposed.title).join(', ')}`);
  return hit;
};

/** "Depends on web→postgres" for each relationship, resolving localKeys to titles. */
function edges(items, label) {
  const titleOf = new Map(entities(items).map(i => [i.localKey, i.proposed.title]));
  return relationships(items)
    .filter(r => r.proposed.label === label)
    .map(r => r.proposed.members.map(m => `${m.label}:${titleOf.get(m.localKey) ?? m.name}`).join(' → '))
    .sort();
}

describe('docker-compose fixture', () => {
  const { items, dropReasons } = parse(FIXTURE, {}, 'tests/fixtures/docker-compose.yml');

  test('exports the producer identity the draft records', () => {
    assert.equal(PRODUCER, 'docker-compose');
    assert.equal(PRODUCER_VERSION, 'docker-compose@1');
  });

  test('every service becomes an entity: built services are Service, postgres and redis images are Data Store', () => {
    assert.deepEqual(dropReasons, []);
    assert.equal(entityNamed(items, 'web').proposed.category, 'Service');
    assert.equal(entityNamed(items, 'worker').proposed.category, 'Service');
    assert.equal(entityNamed(items, 'postgres').proposed.category, 'Data Store');
    assert.equal(entityNamed(items, 'redis').proposed.category, 'Data Store');
    for (const e of entities(items)) {
      assert.equal(e.proposed.normalizedCategory, e.proposed.category, `${e.proposed.title}: nothing was coerced`);
    }
  });

  test('image and ports each become an attribute block', () => {
    assert.deepEqual(entityNamed(items, 'postgres').proposed.blocks, [
      { type: 'attribute', order: 0, data: { label: 'Image', value: 'postgres:16-alpine' } },
      { type: 'attribute', order: 1, data: { label: 'Ports', value: '5432:5432' } },
    ]);
    assert.deepEqual(entityNamed(items, 'redis').proposed.blocks, [
      { type: 'attribute', order: 0, data: { label: 'Image', value: 'redis:7' } },
    ]);
    assert.deepEqual(entityNamed(items, 'web').proposed.blocks, [
      { type: 'attribute', order: 0, data: { label: 'Ports', value: '8080:80' } },
    ], 'a built service has no image attribute');
  });

  test('depends_on, in both list and map form, becomes Depends on groups with Dependent/Dependency roles', () => {
    const dependsOn = edges(items, 'Depends on');
    for (const expected of [
      'Dependent:web → Dependency:postgres',
      'Dependent:web → Dependency:redis',        // list form
      'Dependent:worker → Dependency:postgres',  // map form
      'Dependent:worker → Dependency:redis',
    ]) {
      assert.ok(dependsOn.includes(expected), `missing "${expected}" in ${JSON.stringify(dependsOn)}`);
    }
  });

  test('an env URL whose host is another service becomes a Calls group', () => {
    assert.deepEqual(edges(items, 'Calls'), [
      'Caller:web → Callee:postgres',     // DATABASE_URL (map form)
      'Caller:worker → Callee:redis',     // REDIS_URL (list form)
    ]);
    assert.ok(!entities(items).some(i => i.proposed.category === 'External Dependency' && i.proposed.title === 'postgres'),
      'a service host must not also be proposed as an external dependency');
  });

  test('an env URL whose host is not a service becomes one External Dependency plus a Depends on group', () => {
    const externals = entities(items).filter(i => i.proposed.category === 'External Dependency');
    assert.deepEqual(externals.map(i => i.proposed.title), ['api.stripe.com']);
    assert.ok(edges(items, 'Depends on').includes('Dependent:web → Dependency:api.stripe.com'));
    assert.equal(entities(items).length, 5, 'four services and one external host');
    assert.equal(relationships(items).length, 7);
  });

  test('items are in normalizeDraft\'s shape: server localKeys, sequential seq, members by localKey with dependsOn', () => {
    items.forEach((item, i) => assert.equal(item.seq, i));
    assert.deepEqual(entities(items).map(i => i.localKey), ['e1', 'e2', 'e3', 'e4', 'e5']);
    assert.deepEqual(relationships(items).map(i => i.localKey), ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
    for (const e of entities(items)) {
      assert.equal(e.op, 'create');
      assert.equal(e.matchedBy, 'none');
      assert.equal(e.targetEntityId, null);
      assert.deepEqual(e.flags, [], 'unflagged, so decide-clean accepts it');
      assert.deepEqual(Object.keys(e.proposed).sort(), ['blocks', 'category', 'normalizedCategory', 'summary', 'tags', 'title']);
      assert.ok(e.proposed.summary, `${e.proposed.title} needs a summary`);
    }
    for (const r of relationships(items)) {
      const check = relationshipPayloadSchema.safeParse(r.proposed);
      assert.ok(check.success, `r ${r.localKey} must pass the edit validator: ${JSON.stringify(check.error?.issues)}`);
      assert.deepEqual(r.dependsOn, r.proposed.members.map(m => m.localKey));
    }
  });

  test('every evidence quote is the YAML line that produced the item, at the offsets it claims', () => {
    for (const item of items) {
      const { quote, charStart, charEnd } = item.input.evidence;
      assert.ok(quote, `${item.localKey} has evidence`);
      assert.equal(FIXTURE.slice(charStart, charEnd), quote, `${item.localKey}'s offsets must point at its quote`);
      assert.ok(FIXTURE.split('\n').some(l => l.trim() === quote), `${item.localKey}'s quote must be a whole line`);
    }
    assert.equal(entityNamed(items, 'web').input.evidence.quote, 'web:');
    assert.equal(entityNamed(items, 'api.stripe.com').input.evidence.quote, 'PAYMENTS_API: https://api.stripe.com/v1');
    const calls = relationships(items).find(r => r.proposed.label === 'Calls' && r.proposed.members[0].name === 'web');
    assert.equal(calls.input.evidence.quote, 'DATABASE_URL: postgres://app:app@postgres:5432/app');
  });
});

describe('re-importing against existing entities', () => {
  test('a second parse against entities of the same titles yields updates targeting them', () => {
    const first = parse(FIXTURE, {}, 'fixture (first import)');
    const updatedAt = new Date('2026-09-01T00:00:00Z');
    const existing = entities(first.items).map(i => ({
      _id: new mongoose.Types.ObjectId(),
      // Case differs on purpose: the match is on the normalized title.
      title: i.proposed.title.toUpperCase(),
      updatedAt,
    }));

    const second = parse(FIXTURE, { existingEntities: existing }, 'fixture (second import)');
    assert.equal(entities(second.items).length, existing.length);
    for (const item of entities(second.items)) {
      const target = existing.find(e => e.title === item.proposed.title.toUpperCase());
      assert.equal(item.op, 'update', `${item.proposed.title} should be an update`);
      assert.equal(String(item.targetEntityId), String(target._id));
      assert.equal(item.matchedBy, 'exact-normalized-title');
      assert.equal(item.baseUpdatedAt, updatedAt);
    }
  });

  test('an update skips attribute blocks the target already has, and keeps new ones', () => {
    const existing = [{
      _id: new mongoose.Types.ObjectId(),
      title: 'postgres',
      updatedAt: new Date(),
      blocks: [{ type: 'attribute', order: 0, data: { label: 'Image', value: 'postgres:16-alpine' } }],
    }];
    const { items } = parse(FIXTURE, { existingEntities: existing }, 'fixture (postgres already imported)');
    assert.deepEqual(entityNamed(items, 'postgres').proposed.blocks, [
      { type: 'attribute', order: 0, data: { label: 'Ports', value: '5432:5432' } },
    ]);
  });

  test('a near-miss title is flagged as a duplicate candidate, never merged', () => {
    const existing = [{ _id: new mongoose.Types.ObjectId(), title: 'workers', updatedAt: new Date() }];
    const { items } = parse(FIXTURE, { existingEntities: existing }, 'fixture (near-miss "workers")');
    const worker = entityNamed(items, 'worker');
    assert.equal(worker.op, 'create');
    assert.ok(worker.flags.includes('duplicate_candidate'));
    assert.equal(String(worker.duplicateOf), String(existing[0]._id));
  });
});

describe('other compose shapes', () => {
  test('links, merge keys, long-syntax ports and local or interpolated hosts', () => {
    const text = [
      'x-base: &base',
      '  image: bitnami/mongodb:7',
      'services:',
      '  db:',
      '    <<: *base',
      '    ports:',
      '      - target: 27017',
      '        published: 27018',
      '        protocol: tcp',
      '  api:',
      '    image: example/api',
      '    container_name: api-main',
      '    links:',
      '      - "db:database"',
      '    environment:',
      '      SELF: http://api-main:3000',
      '      LOCAL: http://localhost:9000',
      '      TEMPLATED: http://${UPSTREAM_HOST}/v1',
      '  admin:',
      '    image: mongo-express',
      '    environment:',
      '      - API=http://api-main:3000',
    ].join('\n');
    const { items, dropReasons } = parse(text, {}, 'inline links/merge fixture');

    assert.deepEqual(dropReasons, []);
    assert.equal(entityNamed(items, 'db').proposed.category, 'Data Store', 'image inherited through the merge key');
    assert.deepEqual(entityNamed(items, 'db').proposed.blocks.map(b => b.data.value), ['bitnami/mongodb:7', '27018:27017/tcp']);
    assert.equal(entityNamed(items, 'db').input.evidence.quote, 'db:');
    assert.equal(entityNamed(items, 'admin').proposed.category, 'Service', 'mongo-express is a UI, not a data store');
    assert.deepEqual(edges(items, 'Depends on'), ['Dependent:api → Dependency:db']);
    assert.deepEqual(edges(items, 'Calls'), ['Caller:admin → Callee:api'], 'container_name resolves to its service; a self-call is skipped');
    assert.equal(entities(items).filter(i => i.proposed.category === 'External Dependency').length, 0,
      'localhost and an interpolated host are not external dependencies');
  });

  test('image names match on the image itself, not its registry, namespace or tag', () => {
    assert.equal(imageName('registry.example.com:5000/library/postgres:16@sha256:abc'), 'postgres');
    assert.ok(isDataStoreImage('docker.elastic.co/elasticsearch/elasticsearch:8.15.0'));
    assert.ok(isDataStoreImage('minio/minio'));
    assert.ok(!isDataStoreImage('redis-commander'));
    assert.ok(!isDataStoreImage('nginx:1.27'));
  });
});

describe('errors', () => {
  const rejects = (text, pattern, line, opts) => assert.throws(() => parseCompose(text, opts), err => {
    log('normal', `rejected (source: parseCompose): ${err.message}`);
    assert.ok(err instanceof ComposeParseError, `expected a ComposeParseError, got ${err.name}`);
    assert.match(err.message, pattern);
    assert.equal(err.line, line);
    return true;
  });

  test('invalid YAML names the line', () => {
    rejects('services:\n  web:\n    image: nginx\n   ports: [80\n', /^Invalid YAML on line 4:/, 4);
  });

  test('line numbers account for lines the caller trimmed off the top', () => {
    rejects('services:\n  web:\n    image: nginx\n   ports: [80\n', /on line 6:/, 6, { lineOffset: 2 });
  });

  test('a duplicate key names the line', () => {
    rejects('services:\n  web:\n    image: a\n    image: b\n', /on line 4:/, 4);
  });

  test('an alias with no anchor names the line', () => {
    rejects('services:\n  web:\n    environment: *missing\n', /on line 3: alias \*missing has no anchor/, 3);
  });

  test('a YAML file that is not compose is refused', () => {
    rejects('name: CI\non: push\n', /No services found/, null);
    rejects('services:\n  - web\n', /No services found on line 1/, 1);
  });

  test('a depends_on naming no service is dropped with a reason, not an error', () => {
    const { items, dropReasons } = parseCompose('services:\n  web:\n    depends_on: [ghost]\n');
    assert.equal(relationships(items).length, 0);
    assert.equal(dropReasons.length, 1);
    assert.match(dropReasons[0], /"ghost"/);
  });
});
