/**
 * Unit tests for the OpenAPI producer, src/lib/producers/openApi.js.
 *
 * The producer's contract is the compose producer's contract: its output is
 * indistinguishable, in shape, from what normalizeDraft emits for a braindump,
 * so the review UI, the decision routes and the applier take it without knowing
 * where it came from. So beyond the mapping itself (which entity is a Service,
 * which an API, which an External Dependency, and which edge joins them) these
 * tests hold it to that shape: every `proposed` passes the same validators an
 * edited item must, every evidence quote is a real line of the document at the
 * offsets it claims, and a second parse against the entities the first one
 * created turns into updates.
 *
 * Fixture: tests/fixtures/openapi.yaml — two declared tags over three paths,
 * the last of them a local `$ref` into `#/components/pathItems`, and two
 * servers of which the second is a host of its own.
 *
 * Falsification checks, run red by hand against a deliberately broken producer:
 *   - the `$ref` branch removed              -> the Vets API and its Exposes group vanish
 *   - every server treated as external       -> the own-host assertion fails
 *   - existingByKey lookup removed           -> the re-import test fails (all creates)
 *   - the version gate removed               -> the refusal tests pass nothing
 *   - the operation list left uncapped       -> the MAX_OPERATIONS_LISTED test fails
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_OPENAPI_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per parse: the document it came from and what it produced
 *   normal  — light, plus each item's title or label and evidence line
 *   verbose — normal, plus every item as JSON
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import mongoose from 'mongoose';

import {
  parseOpenApi, OpenApiParseError, urlHost,
  PRODUCER, PRODUCER_VERSION, MAX_OPENAPI_CHARS, MAX_OPERATIONS_LISTED,
} from '../../src/lib/producers/openApi.js';
import { MAX_COMPOSE_CHARS } from '../../src/lib/producers/dockerCompose.js';
import { MAX_ITEMS } from '../../src/lib/draftNormalizer.js';
import { relationshipPayloadSchema } from '../../src/lib/draftItemSchema.js';

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };
function log(level, msg) {
  const active = LEVELS[process.env.TEST_OPENAPI_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/openApi:${level}] ${msg}`);
}

const FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/openapi.yaml', import.meta.url)), 'utf8');

function parse(text, opts, source) {
  const out = parseOpenApi(text, opts);
  log('light', `parsed ${source} (source: parseOpenApi, ${opts?.existingEntities?.length ?? 0} existing entities) → ${out.items.length} items, ${out.dropReasons.length} dropped`);
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

/** "Provider:Pet Store API → Endpoint:Pets" for each relationship of that label. */
function edges(items, label) {
  const titleOf = new Map(entities(items).map(i => [i.localKey, i.proposed.title]));
  return relationships(items)
    .filter(r => r.proposed.label === label)
    .map(r => r.proposed.members.map(m => `${m.label}:${titleOf.get(m.localKey) ?? m.name}`).join(' → '))
    .sort();
}

const attribute = (item, label) =>
  item.proposed.blocks.find(b => b.type === 'attribute' && b.data.label === label)?.data.value;

describe('openapi fixture', () => {
  const { items, dropReasons } = parse(FIXTURE, {}, 'tests/fixtures/openapi.yaml');

  test('exports the producer identity the draft records', () => {
    assert.equal(PRODUCER, 'openapi');
    assert.equal(PRODUCER_VERSION, 'openapi@1');
  });

  test('the whole document maps with nothing dropped', () => {
    assert.deepEqual(dropReasons, []);
    assert.deepEqual(entities(items).map(i => [i.proposed.title, i.proposed.category]), [
      ['Pet Store API', 'Service'],
      ['Pets', 'API'],
      ['Vets', 'API'],
      ['sandbox.partner.example', 'External Dependency'],
    ]);
  });

  test('info.title becomes the Service, carrying the API version, the spec version and the description', () => {
    const service = entityNamed(items, 'Pet Store API');
    assert.equal(service.proposed.category, 'Service');
    assert.equal(attribute(service, 'API version'), '2.4.0');
    assert.equal(attribute(service, 'Spec version'), 'OpenAPI 3.1.0');
    const text = service.proposed.blocks.find(b => b.type === 'text');
    assert.ok(text, 'info.description becomes a text block');
    assert.match(text.data.markdown, /^Pets, their owners, and the vets who see them\./);
    assert.match(text.data.markdown, /Writes are rate limited per clinic\.$/);
    assert.deepEqual(service.proposed.blocks.map(b => b.order), [0, 1, 2]);
    assert.deepEqual(service.proposed.tags, ['openapi']);
  });

  test('each declared tag becomes an API whose operations are one attribute block', () => {
    assert.equal(attribute(entityNamed(items, 'Pets'), 'Operations'), 'GET /pets, POST /pets, GET /pets/{petId}');
    // Behind a local $ref, so this one is also the proof the ref was followed.
    assert.equal(attribute(entityNamed(items, 'Vets'), 'Operations'), 'GET /vets');
    assert.equal(entityNamed(items, 'Pets').proposed.summary, 'Everything about the animals themselves.');
  });

  test('every tag is joined to the service by an Exposes group with Provider/Endpoint roles', () => {
    assert.deepEqual(edges(items, 'Exposes'), [
      'Provider:Pet Store API → Endpoint:Pets',
      'Provider:Pet Store API → Endpoint:Vets',
    ]);
  });

  test('a server host that is not the service\'s own becomes an External Dependency plus a Depends on group', () => {
    const external = entityNamed(items, 'sandbox.partner.example');
    assert.equal(external.proposed.category, 'External Dependency');
    assert.match(external.proposed.summary, /^Server listed by Pet Store API /);
    assert.deepEqual(edges(items, 'Depends on'), [
      'Dependent:Pet Store API → Dependency:sandbox.partner.example',
    ]);
    // The first server is where this API itself answers, so it is nobody's dependency.
    assert.equal(entities(items).find(i => i.proposed.title === 'api.petstore.example'), undefined);
  });

  test('items are in normalizeDraft\'s shape: server localKeys, sequential seq, members by localKey with dependsOn', () => {
    items.forEach((item, i) => assert.equal(item.seq, i));
    assert.deepEqual(entities(items).map(i => i.localKey), ['e1', 'e2', 'e3', 'e4']);
    assert.deepEqual(relationships(items).map(i => i.localKey), ['r1', 'r2', 'r3']);
    for (const e of entities(items)) {
      assert.equal(e.op, 'create');
      assert.equal(e.matchedBy, 'none');
      assert.equal(e.targetEntityId, null);
      assert.deepEqual(e.flags, [], 'unflagged, so decide-clean accepts it');
      assert.deepEqual(Object.keys(e.proposed).sort(), ['blocks', 'category', 'normalizedCategory', 'summary', 'tags', 'title']);
      assert.ok(e.proposed.summary, `${e.proposed.title} needs a summary`);
      assert.ok(e.proposed.summary.length <= 400);
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
    assert.equal(entityNamed(items, 'Pet Store API').input.evidence.quote, 'title: Pet Store API');
    assert.equal(entityNamed(items, 'Pets').input.evidence.quote, '- name: Pets');
    assert.equal(entityNamed(items, 'sandbox.partner.example').input.evidence.quote,
      '- url: https://sandbox.partner.example/petstore');
  });

  test('the same character cap as the compose producer, not a second one', () => {
    assert.equal(MAX_OPENAPI_CHARS, MAX_COMPOSE_CHARS);
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
      assert.deepEqual(item.flags, [], 'an exact match is not also a duplicate candidate');
    }
    // The relationships still point at the proposals, so applying the draft
    // joins the entities that already exist rather than making new ones.
    assert.deepEqual(edges(second.items, 'Exposes'), [
      'Provider:Pet Store API → Endpoint:Pets',
      'Provider:Pet Store API → Endpoint:Vets',
    ]);
  });

  test('an update skips the attribute AND text blocks the target already has, and keeps new ones', () => {
    const service = entityNamed(parse(FIXTURE, {}, 'fixture (for its blocks)').items, 'Pet Store API');
    const existing = [{
      _id: new mongoose.Types.ObjectId(),
      title: 'Pet Store API',
      updatedAt: new Date(),
      // Everything the document gives it except the API version, which moved on.
      blocks: service.proposed.blocks.filter(b => b.data.label !== 'API version'),
    }];
    const { items } = parse(FIXTURE, { existingEntities: existing }, 'fixture (service already imported)');
    assert.deepEqual(entityNamed(items, 'Pet Store API').proposed.blocks, [
      { type: 'attribute', order: 0, data: { label: 'API version', value: '2.4.0' } },
    ], 'the description must not be appended a second time');
  });

  test('a second parse against the groups the first import created yields updates to them', () => {
    // The same re-import problem the compose producer has, and the same fix:
    // without it every re-import adds a second "Exposes" group per tag, and
    // each API shows the link to its service twice. See
    // draftNormalizer.relationshipGroupMatcher and tests/unit/dockerCompose.test.js.
    const first = parse(FIXTURE, {}, 'fixture (first import)').items;
    const ids = new Map(entities(first).map(i => [i.localKey, new mongoose.Types.ObjectId()]));
    const existingEntities = entities(first).map(i => ({
      _id: ids.get(i.localKey), title: i.proposed.title, updatedAt: new Date('2026-09-01T00:00:00Z'), blocks: i.proposed.blocks,
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
    const existing = [{ _id: new mongoose.Types.ObjectId(), title: 'Pet Store APIs', updatedAt: new Date() }];
    const { items } = parse(FIXTURE, { existingEntities: existing }, 'fixture (near-miss "Pet Store APIs")');
    const service = entityNamed(items, 'Pet Store API');
    assert.equal(service.op, 'create', 'a near miss is never silently merged into the entity it resembles');
    assert.ok(service.flags.includes('duplicate_candidate'));
    assert.equal(String(service.duplicateOf), String(existing[0]._id));
  });
});

describe('other document shapes', () => {
  test('a JSON document is read exactly as a YAML one is', () => {
    const text = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Billing', version: '1.0.0', description: 'Invoices and credits.' },
      servers: [{ url: 'https://billing.example' }, { url: 'https://api.stripe.com/v1' }],
      tags: [{ name: 'Invoices' }],
      paths: { '/invoices': { get: { tags: ['Invoices'] }, post: { tags: ['Invoices'] } } },
    }, null, 2);
    const { items } = parse(text, {}, 'a JSON OpenAPI 3.0 document');
    assert.deepEqual(entities(items).map(i => [i.proposed.title, i.proposed.category]), [
      ['Billing', 'Service'],
      ['Invoices', 'API'],
      ['api.stripe.com', 'External Dependency'],
    ]);
    assert.equal(attribute(entityNamed(items, 'Billing'), 'Spec version'), 'OpenAPI 3.0.3');
    assert.equal(attribute(entityNamed(items, 'Invoices'), 'Operations'), 'GET /invoices, POST /invoices');
    assert.deepEqual(edges(items, 'Depends on'), ['Dependent:Billing → Dependency:api.stripe.com']);
    const quote = entityNamed(items, 'Billing').input.evidence;
    assert.equal(text.slice(quote.charStart, quote.charEnd), quote.quote, 'JSON gets real offsets too');
  });

  test('swagger 2.0 is accepted, and its single `host` is the service\'s own', () => {
    const text = [
      'swagger: "2.0"',
      'info:',
      '  title: Legacy Orders',
      '  version: 1.2.0',
      'host: legacy.example',
      'basePath: /v1',
      'paths:',
      '  /orders:',
      '    get:',
      '      tags: [Orders]',
    ].join('\n');
    const { items } = parse(text, {}, 'a Swagger 2.0 document');
    assert.deepEqual(entities(items).map(i => [i.proposed.title, i.proposed.category]), [
      ['Legacy Orders', 'Service'],
      ['Orders', 'API'],
    ]);
    assert.equal(attribute(entityNamed(items, 'Legacy Orders'), 'Spec version'), 'Swagger 2.0');
    assert.deepEqual(edges(items, 'Exposes'), ['Provider:Legacy Orders → Endpoint:Orders']);
  });

  test('a document that declares no tags groups its operations by first path segment', () => {
    const text = [
      'openapi: 3.1.0',
      'info:',
      '  title: Untagged',
      '  version: 0.1.0',
      'paths:',
      '  /pets:',
      '    get: {}',
      '  /pets/{petId}:',
      '    delete: {}',
      '  /health:',
      '    get: {}',
      '  /:',
      '    get: {}',
    ].join('\n');
    const { items } = parse(text, {}, 'a document with no tags');
    assert.deepEqual(entities(items).map(i => [i.proposed.title, i.proposed.category]), [
      ['Untagged', 'Service'],
      ['pets', 'API'],
      ['health', 'API'],
      ['root', 'API'],
    ]);
    assert.equal(attribute(entityNamed(items, 'pets'), 'Operations'), 'GET /pets, DELETE /pets/{petId}');
    assert.equal(entityNamed(items, 'pets').proposed.summary, '2 operations of Untagged.');
  });

  test('an operation that names a tag the document does not declare still lands on an API', () => {
    const text = [
      'openapi: 3.1.0',
      'info:',
      '  title: Mixed',
      '  version: 1',
      'tags:',
      '  - name: Declared',
      'paths:',
      '  /a:',
      '    get:',
      '      tags: [Declared]',
      '  /b:',
      '    get:',
      '      tags: [Undeclared]',
      '  /c:',
      '    get: {}',
    ].join('\n');
    const { items, dropReasons } = parse(text, {}, 'a document with an undeclared tag');
    assert.deepEqual(entities(items).map(i => i.proposed.title), ['Mixed', 'Declared', 'Undeclared', 'c']);
    assert.deepEqual(dropReasons, [], 'no operation is lost');
    assert.equal(attribute(entityNamed(items, 'Undeclared'), 'Operations'), 'GET /b');
  });

  test('local, templated and duplicate server hosts are skipped', () => {
    const text = [
      'openapi: 3.1.0',
      'info:',
      '  title: Hosts',
      '  version: 1',
      'servers:',
      '  - url: https://hosts.example',
      '  - url: http://localhost:8080',
      '  - url: "https://{region}.hosts.example"',
      '  - url: /v2',
      '  - url: https://hosts.example/other-path',
      '  - url: https://real.partner.example',
      '  - url: https://real.partner.example/again',
    ].join('\n');
    const { items } = parse(text, {}, 'a document with seven servers');
    assert.deepEqual(entities(items).map(i => i.proposed.title), ['Hosts', 'real.partner.example']);
  });

  test('urlHost reads a host out of the shapes a server url takes', () => {
    assert.equal(urlHost('https://api.example.test/v2'), 'api.example.test');
    assert.equal(urlHost('//api.example.test'), 'api.example.test');
    assert.equal(urlHost('HTTPS://API.Example.Test'), 'api.example.test');
    assert.equal(urlHost('/v2'), null, 'a relative server url names no host');
    assert.equal(urlHost('https://{region}.example.test'), null, 'a templated host is not a host');
    assert.equal(urlHost(''), null);
    assert.equal(urlHost(null), null);
  });

  test('YAML anchors and merge keys are followed', () => {
    const text = [
      'x-info: &info',
      '  title: Anchored',
      '  version: 9.9.9',
      'openapi: 3.1.0',
      'info:',
      '  <<: *info',
      '  description: Through a merge key.',
      'paths:',
      '  /thing:',
      '    get:',
      '      tags: [Things]',
    ].join('\n');
    const { items } = parse(text, {}, 'a document using an anchor and a merge key');
    const service = entityNamed(items, 'Anchored');
    assert.equal(attribute(service, 'API version'), '9.9.9');
    assert.equal(service.proposed.blocks.find(b => b.type === 'text').data.markdown, 'Through a merge key.');
  });
});

describe('$ref handling', () => {
  const base = [
    'openapi: 3.1.0',
    'info:',
    '  title: Refs',
    '  version: 1',
    'paths:',
  ];

  test('a local #/components ref is followed one level deep', () => {
    const { items, dropReasons } = parse([
      ...base,
      '  /a:',
      '    $ref: "#/components/pathItems/A"',
      'components:',
      '  pathItems:',
      '    A:',
      '      get:',
      '        tags: [Alpha]',
    ].join('\n'), {}, 'a resolvable local ref');
    assert.deepEqual(dropReasons, []);
    assert.equal(attribute(entityNamed(items, 'Alpha'), 'Operations'), 'GET /a');
  });

  test('a ref the document does not define is a drop reason, not an error', () => {
    const { items, dropReasons } = parse([
      ...base,
      '  /a:',
      '    $ref: "#/components/pathItems/Missing"',
      '  /b:',
      '    get:',
      '      tags: [Beta]',
    ].join('\n'), {}, 'an unresolvable local ref');
    assert.equal(dropReasons.length, 1);
    assert.match(dropReasons[0], /^path "\/a" was skipped — #\/components\/pathItems\/Missing is not defined/);
    assert.ok(entityNamed(items, 'Beta'), 'the rest of the document still maps');
  });

  test('an external ref and a ref to a ref are drop reasons too', () => {
    const { dropReasons } = parse([
      ...base,
      '  /a:',
      '    $ref: "other.yaml#/paths/~1a"',
      '  /b:',
      '    $ref: "#/components/pathItems/B"',
      'components:',
      '  pathItems:',
      '    B:',
      '      $ref: "#/components/pathItems/C"',
      '    C:',
      '      get:',
      '        tags: [Gamma]',
    ].join('\n'), {}, 'an external ref and a ref to a ref');
    assert.equal(dropReasons.length, 2);
    assert.match(dropReasons[0], /is not a local `#\/components\/…` reference/);
    assert.match(dropReasons[1], /resolves to another `\$ref`, which is not followed/);
  });
});

describe('refusals', () => {
  const refuse = (text, source) => {
    try {
      parseOpenApi(text, {});
    } catch (err) {
      log('normal', `refused ${source} (source: parseOpenApi): ${err.name} line ${err.line}: ${err.message}`);
      assert.ok(err instanceof OpenApiParseError, `expected an OpenApiParseError, got ${err.name}`);
      return err;
    }
    assert.fail(`${source} should have been refused`);
  };

  test('a file with no openapi or swagger key is refused, naming the keys it found instead', () => {
    const err = refuse('name: CI\non: push\njobs: {}\n', 'a GitHub Actions workflow');
    assert.match(err.message, /Not an OpenAPI document/);
    assert.match(err.message, /`name`, `on`, `jobs`/);
  });

  test('a docker-compose file is refused by name, pointing at its own producer', () => {
    const err = refuse('services:\n  web:\n    image: nginx\n', 'a docker-compose file');
    assert.match(err.message, /looks like a docker-compose file — import it as one/);
  });

  test('a version this producer does not read is refused, naming it', () => {
    const err = refuse('openapi: 4.0.0\ninfo:\n  title: Future\n  version: 1\n', 'OpenAPI 4.0.0');
    assert.match(err.message, /`openapi: 4\.0\.0` on line 1 is not supported/);
    assert.equal(err.line, 1);
    assert.match(refuse('swagger: "1.2"\ninfo:\n  title: Old\n', 'Swagger 1.2').message, /`swagger: 1\.2`/);
  });

  test('a document with no info.title is refused', () => {
    const err = refuse('openapi: 3.1.0\ninfo:\n  version: 1\n', 'a document with no info.title');
    assert.match(err.message, /no `info\.title`/);
    assert.equal(err.line, 2);
  });

  test('a top level that is not a mapping is refused', () => {
    assert.match(refuse('- a\n- b\n', 'a YAML list').message, /top level of the file is not a mapping/);
    assert.match(refuse('"just a string"\n', 'a bare string').message, /top level of the file is not a mapping/);
  });

  test('invalid JSON or YAML names the line, and the caller\'s trimmed lines still count', () => {
    const err = refuse('openapi: 3.1.0\ninfo:\n  title: X\n   version: 1\n', 'badly indented YAML');
    assert.match(err.message, /^Invalid JSON or YAML on line 3/);
    assert.equal(err.line, 3);

    let offsetErr;
    try {
      parseOpenApi('openapi: 3.1.0\ninfo:\n  title: X\n   version: 1\n', { lineOffset: 2 });
    } catch (e) { offsetErr = e; }
    assert.equal(offsetErr.line, 5, 'two blank lines the caller trimmed off the top still count');
  });

  test('malformed JSON is refused as a parse error, not as "not an OpenAPI document"', () => {
    const err = refuse('{"openapi": "3.1.0", "info": {"title": "X"', 'truncated JSON');
    assert.match(err.message, /^Invalid JSON or YAML/);
  });
});

describe('bounds', () => {
  test('one API\'s operation list is capped, and says how many it left out', () => {
    const paths = Array.from({ length: MAX_OPERATIONS_LISTED + 5 }, (_, i) =>
      `  /p${i + 1}:\n    get:\n      tags: [Everything]`);
    const { items } = parse([
      'openapi: 3.1.0', 'info:', '  title: Wide', '  version: 1', 'paths:', ...paths,
    ].join('\n'), {}, `a document with ${MAX_OPERATIONS_LISTED + 5} operations on one tag`);

    const value = attribute(entityNamed(items, 'Everything'), 'Operations');
    assert.equal(value.split(', ').length, MAX_OPERATIONS_LISTED + 1, 'the cap plus the closing phrase');
    assert.match(value, /, …and 5 more$/);
    assert.match(value, /^GET \/p1, GET \/p2,/);
  });

  test('a document declaring more tags than the item cap proposes exactly the cap, and says what it skipped', () => {
    const tags = Array.from({ length: MAX_ITEMS + 20 }, (_, i) => `  - name: tag-${i + 1}`);
    const { items, dropReasons, dropped } = parse([
      'openapi: 3.1.0', 'info:', '  title: Huge', '  version: 1', 'tags:', ...tags, 'paths: {}',
    ].join('\n'), {}, `a document with ${MAX_ITEMS + 20} tags`);

    assert.equal(items.length, MAX_ITEMS);
    assert.equal(entities(items).length, MAX_ITEMS, 'entities fill the cap first, as in normalizeDraft');
    // One drop for the entity overflow, one for the relationships that had no
    // room left, and the whole count is still reported.
    assert.match(dropReasons[0], new RegExp(`^item cap of ${MAX_ITEMS} reached — 21 further entities`));
    assert.match(dropReasons[1], new RegExp(`^item cap of ${MAX_ITEMS} reached — \\d+ further relationships`));
    assert.equal(dropped, 2);
  });

  test('a document under the cap is untouched by it', () => {
    const { items, dropped } = parse(FIXTURE, {}, 'fixture (well under the cap)');
    assert.ok(items.length < MAX_ITEMS);
    assert.equal(dropped, 0);
  });
});
