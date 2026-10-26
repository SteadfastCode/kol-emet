/**
 * Unit tests for the Kubernetes producer, src/lib/producers/kubernetes.js.
 *
 * The producer's contract is the other two producers' contract: its output is
 * indistinguishable, in shape, from what normalizeDraft emits for a braindump,
 * so the review UI, the decision routes and the applier take it without knowing
 * where it came from. So beyond the mapping itself (which object is a Service,
 * which a Data Store, which an API, and which edge joins them) these tests hold
 * it to that shape: every `proposed` passes the same validators an edited item
 * must, every evidence quote is a real line of the file at the offsets it
 * claims, and a second parse against the entities the first one created turns
 * into updates.
 *
 * Fixture: tests/fixtures/kubernetes.yaml — a `---` stream of nine documents:
 * a Deployment and a StatefulSet, the Services in front of them, a claim, a
 * ConfigMap an `envFrom` pulls in, a Secret, and an Ingress this producer has
 * no reading for.
 *
 * Falsification checks, run red by hand against a deliberately broken producer:
 *   - parseDocument in place of parseAllDocuments -> every item but the first
 *                                                   Deployment's vanishes
 *   - the selector match removed                 -> the Exposes groups vanish
 *   - the Service-name host alias removed        -> web→postgres becomes an
 *                                                   External Dependency
 *   - isDataStoreImage ignored                   -> postgres maps as a Service
 *   - the unknown-kind drop turned into a throw  -> the Ingress refuses the file
 *   - existingByKey lookup removed               -> the re-import test fails
 *   - resolveHost back to one unconditional
 *     `.split('.')[0]`                           -> the three external-FQDN
 *                                                   collision tests fail
 *   - resolveHost's namespace branch removed     -> `cache.acme` stops being a
 *                                                   call
 *   - hostToEntity flattened back to a map of
 *     bare names                                 -> `cache.prod` resolves to a
 *                                                   `cache` in `team-b` again
 *   - titleFor's qualification removed           -> the second of two same-named
 *                                                   workloads is dropped as a
 *                                                   duplicate of the first
 *   - the selector's namespace check removed     -> a Service in `prod` claims a
 *                                                   workload in `team-b`
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_KUBERNETES_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per parse: the file it came from and what it produced
 *   normal  — light, plus each item's title or label and evidence line
 *   verbose — normal, plus every item as JSON
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import mongoose from 'mongoose';

import {
  parseKubernetes, KubernetesParseError,
  PRODUCER, PRODUCER_VERSION, MAX_KUBERNETES_CHARS,
} from '../../src/lib/producers/kubernetes.js';
import { MAX_COMPOSE_CHARS } from '../../src/lib/producers/dockerCompose.js';
import { redactSecrets } from '../../src/lib/producers/redactSecrets.js';
import { relationshipPayloadSchema } from '../../src/lib/draftItemSchema.js';

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };
function log(level, msg) {
  const active = LEVELS[process.env.TEST_KUBERNETES_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/kubernetes:${level}] ${msg}`);
}

const FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/kubernetes.yaml', import.meta.url)), 'utf8');

function parse(text, opts, source) {
  const out = parseKubernetes(text, opts);
  log('light', `parsed ${source} (source: parseKubernetes, ${opts?.existingEntities?.length ?? 0} existing entities) → ${out.items.length} items, ${out.dropReasons.length} dropped`);
  for (const i of out.items) {
    log('normal', `  ${i.localKey} ${i.kind} ${i.op} ${JSON.stringify(i.proposed.title ?? i.proposed.label)} ← ${JSON.stringify(i.input.evidence.quote)}`);
    log('verbose', `  ${JSON.stringify(i)}`);
  }
  for (const reason of out.dropReasons) log('normal', `  dropped: ${reason}`);
  return out;
}

const entities = items => items.filter(i => i.kind === 'entity');
const relationships = items => items.filter(i => i.kind === 'relationship');
const entityNamed = (items, title) => {
  const hit = entities(items).find(i => i.proposed.title === title);
  assert.ok(hit, `expected an entity "${title}"; got ${entities(items).map(i => i.proposed.title).join(', ')}`);
  return hit;
};

/** "Provider:web → Endpoint:web:80" for each relationship of that label. */
function edges(items, label) {
  const titleOf = new Map(entities(items).map(i => [i.localKey, i.proposed.title]));
  return relationships(items)
    .filter(r => r.proposed.label === label)
    .map(r => r.proposed.members.map(m => `${m.label}:${titleOf.get(m.localKey) ?? m.name}`).join(' → '))
    .sort();
}

const attribute = (item, label) =>
  item.proposed.blocks.find(b => b.type === 'attribute' && b.data.label === label)?.data.value;

describe('kubernetes fixture', () => {
  const { items, dropReasons } = parse(FIXTURE, {}, 'tests/fixtures/kubernetes.yaml');

  test('exports the producer identity the draft records', () => {
    assert.equal(PRODUCER, 'kubernetes');
    assert.equal(PRODUCER_VERSION, 'kubernetes@1');
  });

  test('every document in the stream is read, and only the Ingress is dropped', () => {
    // The point of the `---` iteration: nine documents, and items from the
    // first, second, third, fourth, fifth and sixth of them.
    assert.deepEqual(entities(items).map(i => [i.proposed.title, i.proposed.category]), [
      ['web', 'Service'],
      ['postgres', 'Data Store'],
      ['postgres-data', 'Data Store'],
      ['web:80', 'API'],
      ['postgres:5432', 'API'],
      ['api.stripe.com', 'External Dependency'],
      ['search.internal.example', 'External Dependency'],
    ]);
    assert.deepEqual(dropReasons, [
      'Ingress "web" was skipped — this producer has no reading for `kind: Ingress`',
    ]);
  });

  test('a Deployment is a Service carrying its kind, image and replica count', () => {
    const web = entityNamed(items, 'web');
    assert.equal(web.proposed.category, 'Service');
    assert.equal(attribute(web, 'Kind'), 'Deployment (apps/v1)');
    assert.equal(attribute(web, 'Image'), 'ghcr.io/acme/web:1.4.2');
    assert.equal(attribute(web, 'Replicas'), '3');
    assert.equal(web.proposed.summary, 'Runs the ghcr.io/acme/web:1.4.2 image (Kubernetes Deployment).');
    assert.deepEqual(web.proposed.tags, ['kubernetes']);
  });

  test('a workload whose image is a known data store is a Data Store, not a Service', () => {
    // The same list the compose producer matches on, imported rather than
    // copied: a `postgres:16-alpine` is a data store in either file.
    const postgres = entityNamed(items, 'postgres');
    assert.equal(postgres.proposed.category, 'Data Store');
    assert.equal(attribute(postgres, 'Kind'), 'StatefulSet (apps/v1)');
    assert.equal(attribute(postgres, 'Image'), 'postgres:16-alpine');
  });

  test('a PersistentVolumeClaim is a Data Store carrying its size, modes and class', () => {
    const claim = entityNamed(items, 'postgres-data');
    assert.equal(claim.proposed.category, 'Data Store');
    assert.equal(attribute(claim, 'Storage'), '20Gi');
    assert.equal(attribute(claim, 'Access modes'), 'ReadWriteOnce');
    assert.equal(attribute(claim, 'Storage class'), 'fast-ssd');
    assert.equal(claim.proposed.summary, 'Claims 20Gi of storage (Kubernetes PersistentVolumeClaim).');
  });

  test('a Service port is an API, exposed by the workload its selector matches', () => {
    const api = entityNamed(items, 'web:80');
    assert.equal(api.proposed.category, 'API');
    assert.equal(attribute(api, 'Port'), '80/TCP → 8080');
    assert.equal(attribute(api, 'Service type'), 'LoadBalancer');
    assert.equal(api.proposed.summary, 'The http port of Kubernetes Service web.');
    assert.equal(attribute(entityNamed(items, 'postgres:5432'), 'Service type'), 'ClusterIP',
      'a Service that names no type is a ClusterIP, as Kubernetes itself defaults it');
    assert.deepEqual(edges(items, 'Exposes'), [
      'Provider:postgres → Endpoint:postgres:5432',
      'Provider:web → Endpoint:web:80',
    ]);
  });

  test('an env URL naming a Service in the file is a Calls edge to the workload behind it', () => {
    // `postgres:5432` is the Service's DNS name, and the thing that answers it
    // is the StatefulSet the Service selects — which is the entity the edge
    // has to reach for the graph to say anything.
    assert.deepEqual(edges(items, 'Calls'), ['Caller:web → Callee:postgres']);
  });

  test('an env or envFrom URL naming nothing in the file is an External Dependency plus Depends on', () => {
    const stripe = entityNamed(items, 'api.stripe.com');
    assert.equal(stripe.proposed.category, 'External Dependency');
    assert.equal(stripe.proposed.summary, 'External host referenced by web (PAYMENTS_API).');
    // This one comes from the ConfigMap an `envFrom` pulls in, not from `env`.
    const search = entityNamed(items, 'search.internal.example');
    assert.equal(search.proposed.summary, 'External host referenced by web (SEARCH_ENDPOINT).');
    assert.deepEqual(edges(items, 'Depends on'), [
      'Dependent:web → Dependency:api.stripe.com',
      'Dependent:web → Dependency:search.internal.example',
    ]);
  });

  test('items are in normalizeDraft\'s shape: server localKeys, sequential seq, members by localKey with dependsOn', () => {
    items.forEach((item, i) => assert.equal(item.seq, i));
    assert.deepEqual(entities(items).map(i => i.localKey), ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
    assert.deepEqual(relationships(items).map(i => i.localKey), ['r1', 'r2', 'r3', 'r4', 'r5']);
    for (const e of entities(items)) {
      assert.equal(e.op, 'create');
      assert.equal(e.matchedBy, 'none');
      assert.equal(e.targetEntityId, null);
      assert.deepEqual(e.flags, [], 'unflagged, so decide-clean accepts it');
      assert.deepEqual(Object.keys(e.proposed).sort(), ['blocks', 'category', 'normalizedCategory', 'summary', 'tags', 'title']);
      assert.ok(e.proposed.summary, `${e.proposed.title} needs a summary`);
      assert.ok(e.proposed.summary.length <= 400);
      assert.deepEqual(e.proposed.blocks.map(b => b.order), e.proposed.blocks.map((_, i) => i));
    }
    for (const r of relationships(items)) {
      const check = relationshipPayloadSchema.safeParse(r.proposed);
      assert.ok(check.success, `r ${r.localKey} must pass the edit validator: ${JSON.stringify(check.error?.issues)}`);
      assert.deepEqual(r.dependsOn, r.proposed.members.map(m => m.localKey));
    }
  });

  test('every evidence quote is the line that produced the item, at the offsets it claims', () => {
    for (const item of items) {
      const { quote, charStart, charEnd } = item.input.evidence;
      assert.ok(quote, `${item.localKey} has evidence`);
      assert.equal(FIXTURE.slice(charStart, charEnd), quote, `${item.localKey}'s offsets must point at its quote`);
      assert.ok(FIXTURE.split('\n').some(l => l.trim() === quote), `${item.localKey}'s quote must be a whole line`);
    }
    // Offsets are into the whole file, not into the document they came from,
    // which is what a `---` stream makes easy to get wrong.
    assert.equal(entityNamed(items, 'web').input.evidence.quote, 'kind: Deployment');
    assert.equal(entityNamed(items, 'postgres').input.evidence.quote, 'kind: StatefulSet');
    assert.equal(entityNamed(items, 'postgres-data').input.evidence.quote, 'kind: PersistentVolumeClaim');
    assert.equal(entityNamed(items, 'postgres:5432').input.evidence.quote, '- port: 5432');
    assert.ok(entityNamed(items, 'postgres').input.evidence.charStart
      > entityNamed(items, 'web').input.evidence.charEnd, 'the second document is further into the file');
  });

  test('the same character cap as the other two producers, not a third one', () => {
    assert.equal(MAX_KUBERNETES_CHARS, MAX_COMPOSE_CHARS);
  });

  test('a Secret\'s values are not read, and do not survive the redaction the route runs first', () => {
    // The route redacts before the parse (routes/drafts.js), so the producer
    // only ever sees this. Asserted here as well as end to end because the
    // fixture is where the credentials live.
    const { text: redacted } = redactSecrets(FIXTURE.trim());
    for (const secret of ['hunter2-fixture-secret', 'plain-fixture-session-secret', 'appuser']) {
      assert.ok(!redacted.includes(secret), `${JSON.stringify(secret)} survived redaction`);
    }
    const { items: fromRedacted } = parse(redacted, {}, 'the fixture as the route stores it');
    const everywhere = JSON.stringify(fromRedacted);
    for (const secret of ['hunter2-fixture-secret', 'plain-fixture-session-secret', 'appuser']) {
      assert.ok(!everywhere.includes(secret), `${JSON.stringify(secret)} reached an item`);
    }
    // And the mapping still stands up without them: the DSN's host survives,
    // so the edge the password sat in front of is still proposed.
    assert.deepEqual(edges(fromRedacted, 'Calls'), ['Caller:web → Callee:postgres']);
  });
});

describe('re-importing the same file', () => {
  test('a second parse of the same text yields exactly the same items', () => {
    // Determinism is what makes a producer safe to re-run, and what makes
    // `textHash` mean "this exact file was imported before".
    const first = parse(FIXTURE, {}, 'fixture (first parse)');
    const second = parse(FIXTURE, {}, 'fixture (second parse)');
    assert.deepEqual(second.items, first.items);
    assert.deepEqual(second.dropReasons, first.dropReasons);
  });

  test('a second parse against entities of the same titles yields updates targeting them', () => {
    const first = parse(FIXTURE, {}, 'fixture (first import)');
    const updatedAt = new Date('2026-10-01T00:00:00Z');
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
      assert.deepEqual(item.flags, [], 'an exact match is not also a duplicate candidate');
    }
    // The relationships still point at the proposals, so applying the draft
    // joins the entities that already exist rather than making new ones.
    assert.deepEqual(edges(second.items, 'Exposes'), [
      'Provider:postgres → Endpoint:postgres:5432',
      'Provider:web → Endpoint:web:80',
    ]);
  });

  test('an update skips the attribute blocks the target already has, and keeps new ones', () => {
    const web = entityNamed(parse(FIXTURE, {}, 'fixture (for its blocks)').items, 'web');
    const existing = [{
      _id: new mongoose.Types.ObjectId(),
      title: 'web',
      updatedAt: new Date(),
      // Everything the file gives it except the replica count, which moved on.
      blocks: web.proposed.blocks.filter(b => b.data.label !== 'Replicas'),
    }];
    const { items } = parse(FIXTURE, { existingEntities: existing }, 'fixture (web already imported)');
    assert.deepEqual(entityNamed(items, 'web').proposed.blocks, [
      { type: 'attribute', order: 0, data: { label: 'Replicas', value: '3' } },
    ], 'the kind and image must not be appended a second time');
  });

  test('a second parse against the groups the first import created yields updates to them', () => {
    // Without this every re-import adds a second "Exposes" group per port, and
    // each API shows the link to its workload twice. Same fix as the other two
    // producers: draftNormalizer.relationshipGroupMatcher.
    const first = parse(FIXTURE, {}, 'fixture (first import)').items;
    const ids = new Map(entities(first).map(i => [i.localKey, new mongoose.Types.ObjectId()]));
    const existingEntities = entities(first).map(i => ({
      _id: ids.get(i.localKey), title: i.proposed.title, updatedAt: new Date('2026-10-01T00:00:00Z'), blocks: i.proposed.blocks,
    }));
    const existingGroups = relationships(first).map(i => ({
      _id: new mongoose.Types.ObjectId(),
      label: i.proposed.label,
      members: i.proposed.members.map(m => ({ refId: ids.get(m.localKey) ?? m.refId, refModel: 'Entity', label: m.label })),
    }));

    const { items } = parse(FIXTURE, { existingEntities, existingGroups }, 'fixture (entities and groups already imported)');
    const second = relationships(items);
    assert.equal(second.length, existingGroups.length, 'the same links are found');
    for (const r of second) {
      assert.equal(r.op, 'update', `${r.proposed.label} should be an update`);
      assert.equal(r.matchedBy, 'same-members-and-label');
      assert.ok(existingGroups.some(g => String(g._id) === r.proposed.targetGroupId), 'targets a group that exists');
    }
    assert.equal(new Set(second.map(r => r.proposed.targetGroupId)).size, second.length, 'one group per link');
  });

  test('a near-miss title is flagged as a duplicate candidate, never merged', () => {
    const existing = [{ _id: new mongoose.Types.ObjectId(), title: 'postgres-datas', updatedAt: new Date() }];
    const { items } = parse(FIXTURE, { existingEntities: existing }, 'fixture (near-miss "postgres-datas")');
    const claim = entityNamed(items, 'postgres-data');
    assert.equal(claim.op, 'create', 'a near miss is never silently merged into the entity it resembles');
    assert.ok(claim.flags.includes('duplicate_candidate'));
    assert.equal(String(claim.duplicateOf), String(existing[0]._id));
  });
});

describe('other manifest shapes', () => {
  const manifest = (...docs) => docs.join('\n---\n');
  const deployment = (name, image, labels = { app: name }, namespace = null) => [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    `  name: ${name}`,
    ...(namespace ? [`  namespace: ${namespace}`] : []),
    'spec:',
    '  template:',
    '    metadata:',
    '      labels:',
    ...Object.entries(labels).map(([k, v]) => `        ${k}: ${v}`),
    '    spec:',
    '      containers:',
    `        - name: ${name}`,
    `          image: ${image}`,
  ].join('\n');

  test('a DaemonSet is a workload like the other two kinds', () => {
    const text = manifest([
      'apiVersion: apps/v1',
      'kind: DaemonSet',
      'metadata:',
      '  name: log-collector',
      'spec:',
      '  template:',
      '    spec:',
      '      containers:',
      '        - name: fluent',
      '          image: fluent/fluent-bit:2.2',
    ].join('\n'));
    const { items } = parse(text, {}, 'a DaemonSet');
    assert.deepEqual(entities(items).map(i => [i.proposed.title, i.proposed.category]), [['log-collector', 'Service']]);
    assert.equal(attribute(entityNamed(items, 'log-collector'), 'Kind'), 'DaemonSet (apps/v1)');
  });

  test('a document whose kind is unrecognised is a drop reason, and the rest of the stream still maps', () => {
    const text = manifest(
      deployment('web', 'nginx:1.25'),
      ['apiVersion: autoscaling/v2', 'kind: HorizontalPodAutoscaler', 'metadata:', '  name: web'].join('\n'),
      ['apiVersion: batch/v1', 'kind: CronJob', 'metadata:', '  name: nightly'].join('\n'),
      deployment('worker', 'ghcr.io/acme/worker:2'),
    );
    const { items, dropReasons, dropped } = parse(text, {}, 'a stream with two unreadable kinds');
    assert.deepEqual(entities(items).map(i => i.proposed.title), ['web', 'worker']);
    assert.deepEqual(dropReasons, [
      'HorizontalPodAutoscaler "web" was skipped — this producer has no reading for `kind: HorizontalPodAutoscaler`',
      'CronJob "nightly" was skipped — this producer has no reading for `kind: CronJob`',
    ]);
    assert.equal(dropped, 2);
  });

  test('a ConfigMap, a Secret and a Namespace are read or passed over, never proposed', () => {
    const text = manifest(
      deployment('web', 'nginx:1.25'),
      ['apiVersion: v1', 'kind: Namespace', 'metadata:', '  name: acme'].join('\n'),
      ['apiVersion: v1', 'kind: ServiceAccount', 'metadata:', '  name: web'].join('\n'),
      ['apiVersion: v1', 'kind: Secret', 'metadata:', '  name: db', 'stringData:', '  PASSWORD: x'].join('\n'),
    );
    const { items, dropReasons } = parse(text, {}, 'a stream of supporting objects');
    assert.deepEqual(entities(items).map(i => i.proposed.title), ['web'],
      'a graph with one node per Namespace says nothing a reviewer wants');
    assert.deepEqual(dropReasons, [], 'and they are not drops either — there was nothing to drop');
  });

  test('a Service whose selector matches no workload is a drop reason, and its API is still proposed', () => {
    const text = manifest(
      deployment('web', 'nginx:1.25', { app: 'web' }),
      ['apiVersion: v1', 'kind: Service', 'metadata:', '  name: legacy', 'spec:', '  selector:',
        '    app: gone', '  ports:', '    - port: 443'].join('\n'),
    );
    const { items, dropReasons } = parse(text, {}, 'a Service selecting nothing');
    assert.deepEqual(entities(items).map(i => i.proposed.title), ['web', 'legacy:443']);
    assert.deepEqual(edges(items, 'Exposes'), [], 'nothing in the file provides it');
    assert.deepEqual(dropReasons, [
      'Service "legacy" selects app=gone, which no workload in namespace `default` carries',
    ]);
  });

  test('a Service with no selector and one with no ports each say so', () => {
    const text = manifest(
      deployment('web', 'nginx:1.25'),
      ['apiVersion: v1', 'kind: Service', 'metadata:', '  name: external', 'spec:',
        '  type: ExternalName', '  externalName: db.example', '  ports:', '    - port: 5432'].join('\n'),
      ['apiVersion: v1', 'kind: Service', 'metadata:', '  name: headless', 'spec:', '  selector:',
        '    app: web'].join('\n'),
    );
    const { dropReasons } = parse(text, {}, 'a Service with no selector and one with no ports');
    assert.deepEqual(dropReasons, [
      'Service "external" has no `spec.selector`, so no workload in this file provides it',
      'Service "headless" declares no ports, so it exposes no API',
    ]);
  });

  test('a Service selecting several workloads proposes one provider and says which', () => {
    const text = manifest(
      deployment('web-a', 'nginx:1.25', { app: 'web' }),
      deployment('web-b', 'nginx:1.25', { app: 'web' }),
      ['apiVersion: v1', 'kind: Service', 'metadata:', '  name: web', 'spec:', '  selector:',
        '    app: web', '  ports:', '    - port: 80'].join('\n'),
    );
    const { items, dropReasons } = parse(text, {}, 'a Service selecting two workloads');
    assert.deepEqual(edges(items, 'Exposes'), ['Provider:web-a → Endpoint:web:80']);
    assert.deepEqual(dropReasons, [
      'Service "web" selects 2 workloads (web-a, web-b); "web-a" is proposed as its provider',
    ]);
  });

  test('a cluster-DNS FQDN reaches the same workload a bare Service name does', () => {
    const text = manifest(
      [deployment('api', 'ghcr.io/acme/api:1'),
        '          env:',
        '            - name: CACHE_URL',
        '              value: redis://cache.acme.svc.cluster.local:6379/0',
        '            - name: QUEUE_URL',
        '              value: amqp://broker.acme.svc:5672',
      ].join('\n'),
      deployment('cache', 'redis:7', { app: 'cache' }),
      ['apiVersion: v1', 'kind: Service', 'metadata:', '  name: cache', 'spec:', '  selector:',
        '    app: cache', '  ports:', '    - port: 6379'].join('\n'),
    );
    const { items } = parse(text, {}, 'env URLs written as cluster FQDNs');
    assert.deepEqual(edges(items, 'Calls'), ['Caller:api → Callee:cache']);
    // `broker` is nothing in this file, so it is a dependency rather than a call.
    assert.deepEqual(edges(items, 'Depends on'), ['Dependent:api → Dependency:broker.acme.svc']);
  });

  test('an external FQDN whose first label names a workload is still an External Dependency', () => {
    // KOL-111. The first label of a host is only a candidate once a cluster-DNS
    // suffix has come off it; `api.stripe.com` carries none, so the `api`
    // Deployment standing beside `web` must not capture it.
    const text = manifest(
      [deployment('web', 'ghcr.io/acme/web:1'),
        '          env:',
        '            - name: PAYMENTS_API',
        '              value: https://api.stripe.com/v1',
      ].join('\n'),
      deployment('api', 'ghcr.io/acme/api:1'),
    );
    const { items } = parse(text, {}, 'an external FQDN colliding with a workload name');
    assert.deepEqual(edges(items, 'Calls'), [], 'stripe is not something in this cluster');
    assert.deepEqual(edges(items, 'Depends on'), ['Dependent:web → Dependency:api.stripe.com']);
    assert.equal(entityNamed(items, 'api.stripe.com').proposed.category, 'External Dependency');
  });

  test('an external FQDN whose first label is the workload reading it is proposed, not swallowed', () => {
    // The same collision on one workload: addEdge drops a self-edge, so the
    // old fallback resolved the host to `api`, declined to link it to itself,
    // and proposed nothing at all for the host.
    const text = manifest([
      deployment('api', 'ghcr.io/acme/api:1'),
      '          env:',
      '            - name: PAYMENTS_API',
      '              value: https://api.stripe.com/v1',
    ].join('\n'));
    const { items } = parse(text, {}, 'an external FQDN colliding with its own reader');
    assert.deepEqual(entities(items).map(i => i.proposed.title), ['api', 'api.stripe.com']);
    assert.deepEqual(edges(items, 'Depends on'), ['Dependent:api → Dependency:api.stripe.com']);
  });

  test('a `service.namespace` host resolves to the object in THAT namespace', () => {
    // Written without `.svc`, which resolves in-cluster off the pod's search
    // path. Three namespaces that line up three different ways: one both ends
    // declare (`acme`), the reading pod's own (`team-b`), and `default`, where
    // an object that declares no namespace lives.
    const text = manifest(
      deployment('cache', 'redis:7', { app: 'cache' }, 'acme'),
      ['apiVersion: v1', 'kind: Service', 'metadata:', '  name: cache', '  namespace: acme',
        'spec:', '  selector:', '    app: cache', '  ports:', '    - port: 6379'].join('\n'),
      deployment('db', 'postgres:16', { app: 'db' }, 'team-b'),
      deployment('queue', 'ghcr.io/acme/queue:1'),
      ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: api', '  namespace: team-b',
        'spec:', '  template:', '    metadata:', '      labels:', '        app: api',
        '    spec:', '      containers:', '        - name: api', '          image: ghcr.io/acme/api:1',
        '          env:',
        '            - name: CACHE_URL', '              value: redis://cache.acme:6379/0',
        '            - name: DB_URL', '              value: postgres://db.team-b:5432/x',
        '            - name: QUEUE_URL', '              value: amqp://queue.default:5672',
      ].join('\n'),
    );
    const { items } = parse(text, {}, 'env URLs written as service.namespace');
    assert.deepEqual(edges(items, 'Calls'), [
      'Caller:api → Callee:cache',
      'Caller:api → Callee:db',
      'Caller:api → Callee:queue',
    ]);
    assert.deepEqual(edges(items, 'Depends on'), []);
    // Each object declaring a namespace carries it, so the two ends of an edge
    // can be told apart in the review UI.
    assert.equal(attribute(entityNamed(items, 'db'), 'Namespace'), 'team-b');
    assert.equal(attribute(entityNamed(items, 'queue'), 'Namespace'), undefined,
      'an object that declares no namespace says nothing about one');
  });

  test('a `name.namespace` host does NOT reach a same-named workload in another namespace', () => {
    // KOL-118, the bug this file's namespace handling was built for: the second
    // label used to be checked only against the set of namespaces the stream
    // mentioned ANYWHERE, so `cache.prod` resolved to any workload called
    // `cache` — the one in `team-b` included. It names nothing in `prod`, so it
    // is an external host like any other.
    const text = manifest(
      [deployment('api', 'ghcr.io/acme/api:1', { app: 'api' }, 'prod'),
        '          env:',
        '            - name: CACHE_URL',
        '              value: redis://cache.prod:6379/0',
      ].join('\n'),
      deployment('cache', 'redis:7', { app: 'cache' }, 'team-b'),
    );
    const { items } = parse(text, {}, 'a two-label host naming a namespace its workload is not in');
    assert.deepEqual(edges(items, 'Calls'), [], 'the `cache` in team-b is a different object');
    assert.deepEqual(edges(items, 'Depends on'), ['Dependent:api → Dependency:cache.prod']);
    assert.equal(entityNamed(items, 'cache.prod').proposed.category, 'External Dependency');
    assert.deepEqual(entities(items).map(i => i.proposed.title), ['api', 'cache', 'cache.prod']);
  });

  test('two same-named workloads in two namespaces are both proposed, neither shadowing the other', () => {
    // `hostToEntity` and the title map were keyed by bare name, so the second
    // `cache` in a `kubectl get all -A` stream was dropped as a duplicate of the
    // first and every host that named it reached the first instead (KOL-118).
    const text = manifest(
      [deployment('cache', 'redis:7', { app: 'cache' }, 'prod'),
        '          env:',
        '            - name: PEER_URL',
        '              value: redis://cache.team-b:6379/0',
      ].join('\n'),
      deployment('cache', 'redis:7', { app: 'cache' }, 'team-b'),
    );
    const { items, dropReasons } = parse(text, {}, 'one name, two namespaces');
    assert.deepEqual(entities(items).map(i => [i.proposed.title, i.proposed.category]), [
      ['cache.prod', 'Data Store'],
      ['cache.team-b', 'Data Store'],
    ]);
    assert.deepEqual(dropReasons, [], 'neither is a duplicate of the other');
    assert.equal(attribute(entityNamed(items, 'cache.prod'), 'Namespace'), 'prod');
    assert.deepEqual(edges(items, 'Calls'), ['Caller:cache.prod → Callee:cache.team-b'],
      'and the edge reaches the one the host actually names');
  });

  test('a bare host that is a name in several namespaces, and in none of them the reader’s, resolves to nothing', () => {
    // A bare host is read the way Kubernetes reads it — the pod's own namespace
    // first. When the pod's namespace holds no such name and several others do,
    // the host names no one object: the file plainly contains candidates, so it
    // is not an External Dependency either, and picking one of them would be a
    // guess. Said out loud as a drop reason instead.
    const caches = [
      deployment('cache', 'redis:7', { app: 'cache' }, 'prod'),
      deployment('cache', 'redis:7', { app: 'cache' }, 'team-b'),
    ];
    const reader = namespace => [
      deployment('api', 'ghcr.io/acme/api:1', { app: 'api' }, namespace),
      '          env:',
      '            - name: CACHE_URL',
      '              value: redis://cache:6379/0',
    ].join('\n');

    const fromElsewhere = parse(manifest(reader('edge'), ...caches), {}, 'a bare ambiguous host');
    assert.deepEqual(edges(fromElsewhere.items, 'Calls'), []);
    assert.deepEqual(edges(fromElsewhere.items, 'Depends on'), [],
      'a name this file holds twice is not an external host');
    assert.deepEqual(entities(fromElsewhere.items).map(i => i.proposed.title),
      ['api', 'cache.prod', 'cache.team-b']);
    assert.deepEqual(fromElsewhere.dropReasons, [
      '"cache" in api\'s CACHE_URL names an object in `prod` and `team-b` and none in `edge`, '
      + 'so nothing was proposed for it',
    ]);

    // The same host from a pod that DOES sit beside one of them is not ambiguous
    // at all — that is the namespace Kubernetes' own search path would reach.
    const fromProd = parse(manifest(reader('prod'), ...caches), {}, 'the same host from inside prod');
    assert.deepEqual(edges(fromProd.items, 'Calls'), ['Caller:api → Callee:cache.prod']);
    assert.deepEqual(fromProd.dropReasons, []);
  });

  test('a Service’s selector does not reach a workload in another namespace', () => {
    // Kubernetes matches a selector against pods beside it and never across a
    // namespace boundary, so a Service in `prod` provides nothing here.
    const text = manifest(
      deployment('cache', 'redis:7', { app: 'cache' }, 'team-b'),
      ['apiVersion: v1', 'kind: Service', 'metadata:', '  name: cache', '  namespace: prod',
        'spec:', '  selector:', '    app: cache', '  ports:', '    - port: 6379'].join('\n'),
    );
    const { items, dropReasons } = parse(text, {}, 'a Service selecting across a namespace');
    assert.deepEqual(entities(items).map(i => i.proposed.title), ['cache.team-b', 'cache.prod:6379']);
    assert.deepEqual(edges(items, 'Exposes'), []);
    assert.deepEqual(dropReasons, [
      'Service "cache" selects app=cache, which no workload in namespace `prod` carries',
    ]);
  });

  test('a two-label external host is not resolved by a namespace this file never names', () => {
    const text = manifest(
      [deployment('web', 'ghcr.io/acme/web:1'),
        '          env:',
        '            - name: ERRORS_URL',
        '              value: https://sentry.io/api/1/store/',
      ].join('\n'),
      deployment('sentry', 'getsentry/sentry:24'),
    );
    const { items } = parse(text, {}, 'a two-label external host');
    assert.deepEqual(edges(items, 'Calls'), [], '`io` is not a namespace of this file');
    assert.deepEqual(edges(items, 'Depends on'), ['Dependent:web → Dependency:sentry.io']);
  });

  test('an env value whose host is Kubernetes\' own expansion names nothing, and is skipped', () => {
    const text = manifest([
      deployment('api', 'ghcr.io/acme/api:1'),
      '          env:',
      '            - name: SELF_URL',
      '              value: http://$(POD_IP):8080/healthz',
      '            - name: LOCAL_URL',
      '              value: http://localhost:9000/metrics',
    ].join('\n'));
    const { items } = parse(text, {}, 'templated and loopback env URLs');
    assert.deepEqual(entities(items).map(i => i.proposed.title), ['api']);
    assert.deepEqual(relationships(items), []);
  });

  test('a workload with no name, and one with no containers, each say so', () => {
    const text = manifest(
      ['apiVersion: apps/v1', 'kind: Deployment', 'spec: {}'].join('\n'),
      ['apiVersion: apps/v1', 'kind: StatefulSet', 'metadata:', '  name: empty', 'spec: {}'].join('\n'),
    );
    const { items, dropReasons } = parse(text, {}, 'a nameless workload and an empty one');
    assert.deepEqual(entities(items).map(i => [i.proposed.title, i.proposed.summary]),
      [['empty', 'Kubernetes StatefulSet.']]);
    assert.deepEqual(dropReasons, [
      'a Deployment has no `metadata.name`, so there is nothing to title it after',
      'StatefulSet "empty" declares no containers',
    ]);
  });

  test('a YAML anchor is followed within its own document', () => {
    const text = manifest([
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: web',
      'spec:',
      '  template:',
      '    spec:',
      '      containers:',
      '        - name: web',
      '          image: &img ghcr.io/acme/web:3',
      '        - name: sidecar',
      '          image: *img',
    ].join('\n'));
    const { items } = parse(text, {}, 'a Deployment using an anchor');
    assert.equal(attribute(entityNamed(items, 'web'), 'Image'),
      'ghcr.io/acme/web:3, ghcr.io/acme/web:3');
  });
});

describe('refusals', () => {
  test('a file in which no document declares apiVersion and kind is refused by name', () => {
    assert.throws(
      () => parseKubernetes('name: CI\non: push\njobs: {}\n'),
      err => {
        assert.ok(err instanceof KubernetesParseError);
        assert.match(err.message, /Not a Kubernetes manifest/);
        return true;
      });
  });

  test('a compose file is refused rather than read as one object', () => {
    assert.throws(
      () => parseKubernetes('services:\n  web:\n    image: nginx\n'),
      KubernetesParseError);
  });

  test('invalid YAML in the SECOND document names a line of the whole file, offset included', () => {
    // The whole reason one LineCounter spans the stream: a line number that
    // counted from the start of the broken document would be wrong by five.
    const text = [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: web',
      '---',
      'apiVersion: v1',
      'kind: Service',
      'metadata:',
      '  name: web',
      '   bad: indent',
    ].join('\n');
    assert.throws(
      () => parseKubernetes(text, { lineOffset: 2 }),
      err => {
        assert.ok(err instanceof KubernetesParseError);
        // Line 9 is the mapping the bad indent breaks out of, which is where
        // the parser reports it; plus the two lines the caller trimmed.
        assert.equal(err.line, 11);
        assert.match(err.message, /on line 11/);
        return true;
      });
  });

  test('an alias with no anchor above it is a refusal, not a throw from deep in the parse', () => {
    const text = [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: web',
      'spec: *missing',
    ].join('\n');
    assert.throws(
      () => parseKubernetes(text),
      err => {
        assert.ok(err instanceof KubernetesParseError);
        assert.match(err.message, /alias \*missing has no anchor above it/);
        return true;
      });
  });

  test('an empty file is refused', () => {
    assert.throws(() => parseKubernetes(''), KubernetesParseError);
    assert.throws(() => parseKubernetes('# just a comment\n'), KubernetesParseError);
  });
});
