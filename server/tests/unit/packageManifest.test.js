/**
 * Unit tests for the package-manifest producer, src/lib/producers/packageManifest.js.
 *
 * The producer's contract is the other four producers' contract: its output is
 * indistinguishable, in shape, from what normalizeDraft emits for a braindump,
 * so the review UI, the decision routes and the applier take it without knowing
 * where it came from. So beyond the mapping itself (the module is a Service,
 * each direct runtime dependency an External Dependency joined by a `Depends
 * on` group) these tests hold it to that shape: every evidence quote is a real
 * line of the file at the offsets it claims, every relationship payload passes
 * the validator an edited item must, and a second parse against the entities
 * the first one created turns into updates.
 *
 * The other half is the four formats. One manifest per format is a fixture, and
 * each carries the shapes a real one has — a scoped npm name with optional and
 * peer dependencies beside the dev ones; a PEP 621 dependency array with a
 * comment, a trailing comma, extras and an environment marker in it; a go.mod
 * with a parenthesised require block, `// indirect` markers and directives this
 * producer does not read; a Cargo.toml with the inline-table, sub-table, git
 * and path dependency spellings, dev, build and platform tables, and an
 * array-of-tables that must not leak into the tree.
 *
 * Fixtures: tests/fixtures/manifest-package.json, -pyproject.toml, -go.mod and
 * -Cargo.toml. The npm one is NOT called `package.json`: a package.json inside
 * the tests tree would change how Node resolves the modules beside it.
 *
 * Falsification checks, run red by hand against a deliberately broken producer:
 *   - dev dependencies proposed      -> eslint/jest/criterion become entities
 *   - a dev group dropped silently   -> the drop reasons go empty while
 *                                       counts.dropped stays 3
 *   - `// indirect` ignored          -> testify and golang.org/x/sync become
 *                                       direct dependencies
 *   - the format read from a
 *     filename rather than content   -> every fixture but one refuses
 *   - the TOML comment skip removed  -> `# the only http client we ship` is
 *                                       read as part of a requirement
 *   - the multi-line array reader
 *     removed                        -> pyproject proposes no dependencies
 *   - `[dependencies.sqlx]` not read
 *     as a dependency                -> Cargo loses one edge
 *   - `[[bin]]` merged into the tree -> the crate is titled "statementd"
 *   - python/requires-python read as
 *     a dependency                   -> Python itself becomes an External
 *                                       Dependency
 *   - the no-dependency draft turned
 *     into a refusal                 -> a manifest with no dependencies 400s
 *   - the item cap removed           -> a 500-dependency manifest proposes
 *                                       1,001 items
 *   - existingByKey lookup removed   -> the re-import tests fail
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_MANIFEST_LOG_LEVEL = off | light | normal | verbose (default light)
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
  parseManifest, parseRequirement, detectFamily, ManifestParseError,
  PRODUCER, PRODUCER_VERSION, MAX_MANIFEST_CHARS, SERVICE, EXTERNAL_DEPENDENCY,
} from '../../src/lib/producers/packageManifest.js';
import { MAX_COMPOSE_CHARS } from '../../src/lib/producers/dockerCompose.js';
import { MAX_ITEMS } from '../../src/lib/draftNormalizer.js';
import { relationshipPayloadSchema } from '../../src/lib/draftItemSchema.js';

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };
function log(level, msg) {
  const active = LEVELS[process.env.TEST_MANIFEST_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/packageManifest:${level}] ${msg}`);
}

const fixture = name => readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');
const NPM = fixture('manifest-package.json');
const PYPROJECT = fixture('manifest-pyproject.toml');
const GOMOD = fixture('manifest-go.mod');
const CARGO = fixture('manifest-Cargo.toml');

function parse(text, opts, source) {
  const out = parseManifest(text, opts);
  log('light', `parsed ${source} (source: parseManifest, ${opts?.existingEntities?.length ?? 0} existing entities) → ${out.items.length} items, ${out.dropped} dropped`);
  for (const i of out.items) {
    log('normal', `  ${i.localKey} ${i.kind} ${i.op} ${JSON.stringify(i.proposed.title ?? i.proposed.label)} ← ${JSON.stringify(i.input.evidence.quote)}`);
    log('verbose', `  ${JSON.stringify(i)}`);
  }
  for (const reason of out.dropReasons) log('normal', `  dropped: ${reason}`);
  return out;
}

const entities = items => items.filter(i => i.kind === 'entity');
const relationships = items => items.filter(i => i.kind === 'relationship');
const titles = items => entities(items).map(i => i.proposed.title);
const entityNamed = (items, title) => {
  const hit = entities(items).find(i => i.proposed.title === title);
  assert.ok(hit, `expected an entity "${title}"; got ${titles(items).join(', ')}`);
  return hit;
};
/** The error a refusal threw, which `assert.throws` does not hand back. */
function refusal(fn) {
  try { fn(); } catch (err) {
    assert.ok(err instanceof ManifestParseError, `expected a ManifestParseError; got ${err.name}: ${err.message}`);
    return err;
  }
  assert.fail('expected a refusal, and nothing was thrown');
}

const attribute = (item, label) =>
  item.proposed.blocks.find(b => b.type === 'attribute' && b.data.label === label)?.data.value;

/** "Dependent:billing → Dependency:express" for each relationship. */
function edges(items, label = 'Depends on') {
  const titleOf = new Map(entities(items).map(i => [i.localKey, i.proposed.title]));
  return relationships(items)
    .filter(r => r.proposed.label === label)
    .map(r => r.proposed.members.map(m => `${m.label}:${titleOf.get(m.localKey) ?? m.name}`).join(' → '))
    .sort();
}

/** The one item of a given category, asserted to be the only one. */
function theService(items) {
  const services = entities(items).filter(i => i.proposed.category === SERVICE);
  assert.equal(services.length, 1, `expected exactly one Service; got ${services.map(i => i.proposed.title).join(', ')}`);
  return services[0];
}

describe('the producer plugs into the file-producer seam', () => {
  test('names itself, and shares the other producers\' character cap', () => {
    assert.equal(PRODUCER, 'package-manifest');
    assert.equal(PRODUCER_VERSION, 'package-manifest@1');
    assert.equal(MAX_MANIFEST_CHARS, MAX_COMPOSE_CHARS, 'one cap across the producers, not five');
  });

  test('chooses the format from the content, never from a name it is not given', () => {
    // parseManifest is handed text and nothing else: the route reads a filename
    // for the draft's TITLE, and the producer never sees it.
    assert.equal(detectFamily(NPM), 'package.json');
    assert.equal(detectFamily(GOMOD), 'go.mod');
    assert.equal(detectFamily(PYPROJECT), 'toml');
    assert.equal(detectFamily(CARGO), 'toml');
    assert.equal(detectFamily('Just some prose about a module.\n'), null);
    // `module = "x"` is a TOML assignment, not go.mod's `module` directive.
    assert.equal(detectFamily('module = "x"\n[package]\nname = "y"\n'), 'toml');
  });

  test('every item carries evidence at the offsets it claims', () => {
    for (const [name, text] of [['package.json', NPM], ['pyproject.toml', PYPROJECT], ['go.mod', GOMOD], ['Cargo.toml', CARGO]]) {
      const { items } = parse(text, {}, name);
      for (const item of items) {
        const { quote, charStart, charEnd } = item.input.evidence;
        assert.equal(text.slice(charStart, charEnd), quote, `${name} ${item.localKey}'s offsets`);
        assert.ok(quote.length, `${name} ${item.localKey} has an empty quote`);
        assert.equal(quote, quote.trim(), `${name} ${item.localKey}'s quote is not trimmed`);
      }
    }
  });

  test('every relationship payload is one an edited item could be saved as', async () => {
    for (const [name, text] of [['package.json', NPM], ['Cargo.toml', CARGO]]) {
      for (const item of relationships(parse(text, {}, name).items)) {
        const parsed = relationshipPayloadSchema.safeParse(item.proposed);
        assert.ok(parsed.success, `${name} ${item.localKey}: ${JSON.stringify(parsed.error?.issues)}`);
      }
    }
  });

  test('a line offset moves the line a refusal names', () => {
    const broken = '{\n  "name": "x",\n  "dependencies": {,}\n}\n';
    const flat = refusal(() => parseManifest(broken));
    const shifted = refusal(() => parseManifest(broken, { lineOffset: 4 }));
    assert.equal(flat.line, 3);
    assert.equal(shifted.line, 7, 'the caller trimmed four lines off the top');
  });
});

describe('package.json', () => {
  const { items, dropReasons, dropped } = parse(NPM, {}, 'manifest-package.json');

  test('the module becomes one Service, with its name, version and runtime', () => {
    const service = theService(items);
    assert.equal(service.proposed.title, '@acme/billing');
    assert.equal(service.op, 'create');
    assert.deepEqual(service.proposed.tags, ['package-manifest']);
    assert.equal(attribute(service, 'Package'), '@acme/billing');
    assert.equal(attribute(service, 'Version'), '1.4.2');
    assert.equal(attribute(service, 'Runtime'), 'Node.js >=20.11');
    assert.equal(attribute(service, 'Manifest'), 'package.json');
    assert.deepEqual(
      service.proposed.blocks.filter(b => b.type === 'text').map(b => b.data.markdown),
      ['Invoices, dunning and the ledger feed.'],
      'the manifest\'s own description is the text block',
    );
    assert.match(service.proposed.summary, /^The npm package declared in package\.json, with 5 direct runtime dependencies/);
  });

  test('each direct runtime dependency becomes an External Dependency with its constraint', () => {
    assert.deepEqual(titles(items), [
      '@acme/billing', 'express', 'pg', 'ioredis', 'bufferutil', '@acme/ledger-client',
    ]);
    for (const title of ['express', 'pg', 'ioredis', 'bufferutil', '@acme/ledger-client']) {
      assert.equal(entityNamed(items, title).proposed.category, EXTERNAL_DEPENDENCY);
      assert.equal(attribute(entityNamed(items, title), 'Ecosystem'), 'npm');
    }
    assert.equal(attribute(entityNamed(items, 'express'), 'Version constraint'), '^4.18.2');
    assert.equal(attribute(entityNamed(items, 'pg'), 'Version constraint'), '8.11.3');
    // An optional or a peer dependency is a real runtime edge, and says which it is.
    assert.equal(attribute(entityNamed(items, 'express'), 'Dependency kind'), undefined);
    assert.equal(attribute(entityNamed(items, 'bufferutil'), 'Dependency kind'), 'optional');
    assert.equal(attribute(entityNamed(items, '@acme/ledger-client'), 'Dependency kind'), 'peer');
  });

  test('a Depends on group joins the module to each of them', () => {
    assert.deepEqual(edges(items), [
      'Dependent:@acme/billing → Dependency:@acme/ledger-client',
      'Dependent:@acme/billing → Dependency:bufferutil',
      'Dependent:@acme/billing → Dependency:express',
      'Dependent:@acme/billing → Dependency:ioredis',
      'Dependent:@acme/billing → Dependency:pg',
    ]);
    for (const r of relationships(items)) {
      assert.equal(r.op, 'create');
      assert.equal(r.proposed.targetGroupId, null);
      // Both ends are proposals of this same draft, so the link waits for both.
      assert.deepEqual(r.dependsOn, r.proposed.members.map(m => m.localKey),
        'the link is applied after the entities it joins');
      assert.equal(r.dependsOn[0], theService(items).localKey);
    }
  });

  test('dev dependencies are dropped with a reason, and counted', () => {
    assert.deepEqual(dropReasons, [
      '3 dev dependencies in `devDependencies` were not proposed — a dev or test dependency is ' +
      'not part of what the module runs: eslint, jest, prettier',
    ]);
    assert.equal(dropped, 3, 'one reason, three packages: the count is the packages');
    assert.ok(!titles(items).some(t => ['eslint', 'jest', 'prettier'].includes(t)));
  });

  test('scripts, repository and the rest of the manifest become nothing', () => {
    // A manifest holds a great deal this producer has no reading for. The
    // narrow mapping is the point: an architecture graph is not a mirror of
    // package.json.
    assert.ok(!JSON.stringify(items).includes('src/index.js'), 'a script is not an entity');
    assert.ok(!titles(items).some(t => t.includes('github.com/acme/billing')), 'the repository is not a dependency');
  });
});

describe('pyproject.toml (PEP 621)', () => {
  const { items, dropReasons, dropped } = parse(PYPROJECT, {}, 'manifest-pyproject.toml');

  test('the project becomes one Service, with requires-python as its runtime', () => {
    const service = theService(items);
    assert.equal(service.proposed.title, 'billing-reports');
    assert.equal(attribute(service, 'Version'), '2.0.0');
    assert.equal(attribute(service, 'Runtime'), 'Python >=3.11');
    assert.equal(attribute(service, 'Manifest'), 'pyproject.toml');
    assert.deepEqual(
      service.proposed.blocks.filter(b => b.type === 'text').map(b => b.data.markdown),
      ['Monthly statements,\nrendered from the ledger.'],
      'a multi-line basic string is one description',
    );
  });

  test('a multi-line requirement array becomes one dependency per requirement', () => {
    assert.deepEqual(titles(items), ['billing-reports', 'requests', 'httpx', 'SQLAlchemy', 'jinja2']);
    assert.equal(attribute(entityNamed(items, 'requests'), 'Version constraint'), '>=2.31');
    // The extras are read off the name: an extra is a feature set of the
    // dependency, not an edge of its own.
    assert.equal(attribute(entityNamed(items, 'httpx'), 'Version constraint'), '~=0.27');
    // The environment marker goes the same way, and the constraint survives it.
    assert.equal(attribute(entityNamed(items, 'SQLAlchemy'), 'Version constraint'), '>=2,<3');
    assert.equal(attribute(entityNamed(items, 'jinja2'), 'Version constraint'), '(any version)');
    assert.equal(attribute(entityNamed(items, 'requests'), 'Ecosystem'), 'PyPI');
    assert.equal(edges(items).length, 4);
  });

  test('the comment inside the array is not read as a requirement', () => {
    assert.ok(!titles(items).some(t => /http client/.test(t)));
    assert.ok(!attribute(entityNamed(items, 'requests'), 'Version constraint').includes('#'));
  });

  test('every extra is dropped with a reason naming its group', () => {
    assert.deepEqual(dropReasons, [
      '2 dependencies in `project.optional-dependencies.dev` were not proposed — an extra or a ' +
      'dev group is not part of what the module runs: pytest, ruff',
      '1 dependency in `project.optional-dependencies.docs` was not proposed — an extra or a ' +
      'dev group is not part of what the module runs: mkdocs',
    ]);
    assert.equal(dropped, 3);
  });

  test('neither Python itself nor a [tool.*] table becomes an entity', () => {
    assert.ok(!titles(items).some(t => /^python$/i.test(t)), 'the interpreter is the runtime, not a dependency');
    assert.ok(!titles(items).includes('ruff'), '[tool.ruff] is configuration, not a dependency');
    assert.ok(!titles(items).includes('hatchling'), 'the build backend is not a runtime dependency');
  });

  test('Poetry\'s spelling of the same manifest reads the same way', () => {
    const poetry = [
      '[tool.poetry]',
      'name = "billing-reports"',
      'version = "2.0.0"',
      '',
      '[tool.poetry.dependencies]',
      'python = "^3.12"',
      'requests = "^2.31"',
      'pydantic = { version = "^2.6", extras = ["email"] }',
      'boto3 = { version = "^1.34", optional = true }',
      '',
      '[tool.poetry.group.dev.dependencies]',
      'pytest = "^8.0"',
      '',
    ].join('\n');
    const out = parse(poetry, {}, 'a Poetry pyproject');
    assert.deepEqual(titles(out.items), ['billing-reports', 'requests', 'pydantic']);
    assert.equal(attribute(theService(out.items), 'Runtime'), 'Python ^3.12');
    assert.equal(attribute(entityNamed(out.items, 'pydantic'), 'Version constraint'), '^2.6');
    assert.equal(out.dropped, 2, 'the optional dependency and the dev group');
    assert.match(out.dropReasons[0], /^1 optional dependency in `tool\.poetry\.dependencies`/);
    assert.match(out.dropReasons[1], /^1 dependency in `tool\.poetry\.group\.dev\.dependencies`/);
  });

  test('a requirement string is read as PEP 508 names it', () => {
    assert.deepEqual(parseRequirement('requests>=2.31'), { name: 'requests', constraint: '>=2.31' });
    assert.deepEqual(parseRequirement('httpx[http2] ~= 0.27'), { name: 'httpx', constraint: '~= 0.27' });
    assert.deepEqual(parseRequirement('jinja2'), { name: 'jinja2', constraint: null });
    assert.deepEqual(parseRequirement('pkg ; python_version < "3.9"'), { name: 'pkg', constraint: null });
    assert.deepEqual(parseRequirement('pkg @ https://example.test/pkg.whl'),
      { name: 'pkg', constraint: '@ https://example.test/pkg.whl' });
    assert.equal(parseRequirement('   '), null);
  });
});

describe('go.mod', () => {
  const { items, dropReasons, dropped } = parse(GOMOD, {}, 'manifest-go.mod');

  test('the module becomes one Service titled by its last path segment', () => {
    const service = theService(items);
    assert.equal(service.proposed.title, 'ledger-feed', 'what a person calls the module');
    assert.equal(attribute(service, 'Module'), 'github.com/acme/ledger-feed', 'the whole path is kept');
    assert.equal(attribute(service, 'Runtime'), 'Go 1.22');
    assert.equal(attribute(service, 'Version'), undefined, 'a go.mod declares no version of its own');
    assert.deepEqual(service.proposed.blocks.filter(b => b.type === 'text'), [], 'and no description');
  });

  test('requires become dependencies, in a block or on their own line', () => {
    assert.deepEqual(titles(items), [
      'ledger-feed', 'github.com/gin-gonic/gin', 'github.com/jackc/pgx/v5', 'github.com/redis/go-redis/v9',
    ]);
    assert.equal(attribute(entityNamed(items, 'github.com/gin-gonic/gin'), 'Version constraint'), 'v1.9.1');
    assert.equal(attribute(entityNamed(items, 'github.com/redis/go-redis/v9'), 'Version constraint'), 'v9.3.0',
      'a single-line require is read too');
    assert.equal(edges(items).length, 3);
  });

  test('`// indirect` requires are dropped with a reason', () => {
    assert.deepEqual(dropReasons, [
      '2 indirect dependencies marked `// indirect` were not proposed — a transitive dependency ' +
      'is not one the module chose: github.com/stretchr/testify, golang.org/x/sync',
    ]);
    assert.equal(dropped, 2);
  });

  test('replace, exclude and toolchain declare nothing', () => {
    assert.ok(!titles(items).includes('github.com/acme/shared'), 'a replace is not a dependency');
    assert.ok(!titles(items).includes('github.com/old/thing'), 'an exclude is the opposite of one');
    assert.ok(!JSON.stringify(items).includes('go1.22.3'), 'the toolchain is not the runtime');
  });
});

describe('Cargo.toml', () => {
  const { items, dropReasons, dropped } = parse(CARGO, {}, 'manifest-Cargo.toml');

  test('the crate becomes one Service, with rust-version as its runtime', () => {
    const service = theService(items);
    assert.equal(service.proposed.title, 'statement-renderer');
    assert.equal(attribute(service, 'Version'), '0.3.1');
    assert.equal(attribute(service, 'Runtime'), 'Rust 1.75');
    assert.equal(attribute(service, 'Manifest'), 'Cargo.toml');
  });

  test('every dependency spelling is read, including the sub-table one', () => {
    assert.deepEqual(titles(items), [
      'statement-renderer', 'serde', 'tokio', 'tracing', 'acme-shared', 'sqlx',
    ]);
    assert.equal(attribute(entityNamed(items, 'serde'), 'Version constraint'), '1.0', 'an inline table');
    assert.equal(attribute(entityNamed(items, 'tokio'), 'Version constraint'), '1.35', 'a bare string');
    assert.equal(attribute(entityNamed(items, 'sqlx'), 'Version constraint'), '0.7', '[dependencies.sqlx]');
    assert.equal(attribute(entityNamed(items, 'tracing'), 'Version constraint'), 'git https://github.com/tokio-rs/tracing');
    assert.equal(attribute(entityNamed(items, 'acme-shared'), 'Version constraint'), 'path ../shared');
    assert.equal(attribute(entityNamed(items, 'serde'), 'Ecosystem'), 'crates.io');
    assert.equal(edges(items).length, 5);
  });

  test('dev, build, optional and platform dependencies are each dropped with a reason', () => {
    assert.deepEqual(dropReasons.map(r => r.replace(/:.*$/, '')), [
      '1 optional dependency in `[dependencies]` was not proposed — an optional crate is pulled in by a feature, not by the crate itself',
      '1 dependency in `[dev-dependencies]` was not proposed — a dev or test dependency is not part of what the crate runs',
      '1 dependency in `[build-dependencies]` was not proposed — a build-time dependency is not part of what the crate runs',
      '1 platform-specific dependency under `[target.*]` was not proposed — a dependency that exists on only some platforms is not one the crate always runs',
    ]);
    assert.equal(dropped, 4);
    for (const title of ['criterion', 'cc', 'nix', 'reqwest']) {
      assert.ok(!titles(items).includes(title), `${title} should not be proposed`);
    }
  });

  test('an array-of-tables does not leak into the module', () => {
    // `[[bin]] name = "statementd"` is a build target. Reading it as part of
    // the tree would retitle the crate, which is why it is discarded.
    assert.ok(!titles(items).includes('statementd'));
  });
});

describe('refusals', () => {
  test('a file that is none of the four formats is refused, with no line to name', () => {
    const err = refusal(() => parseManifest('A paragraph about our billing service.\n'));
    assert.match(err.message, /Not a package manifest/);
    assert.match(err.message, /A lockfile is not one of them/, 'the near miss a person will reach for first');
    assert.equal(err.line, null);
  });

  test('a manifest that does not parse is refused with the line it broke on', () => {
    const json = refusal(() => parseManifest('{\n  "name": "x",\n  "dependencies": {,}\n}\n'));
    assert.equal(json.line, 3);
    assert.match(json.message, /Invalid JSON/);
    assert.match(json.message, /line 3/, 'the message names the line too, for a client that shows only it');

    const toml = refusal(() => parseManifest('[package]\nname = "x"\n[dependencies\nserde = "1"\n'));
    assert.equal(toml.line, 3);
    assert.match(toml.message, /table header that is not closed/);

    const unterminated = refusal(() => parseManifest('[package]\nname = "x\nversion = "1"\n'));
    assert.equal(unterminated.line, 2);
  });

  test('a TOML file that is neither manifest is refused for being neither', () => {
    const err = refusal(() => parseManifest('[servers]\nhost = "db.internal"\n'));
    assert.match(err.message, /neither a `pyproject\.toml` nor a `Cargo\.toml`/);
  });

  test('a manifest that declares no name is refused, because the Service has no title', () => {
    const err = refusal(() => parseManifest('{"dependencies": {"express": "^4"}}'));
    assert.match(err.message, /declares no name/);
    assert.equal(err.line, 1);
  });

  test('a manifest that names no dependencies is a one-item draft, not a refusal', () => {
    // The module is still worth proposing: this is a leaf service, and its
    // place in the graph is the thing the import is for.
    for (const [name, text] of [
      ['package.json', '{"name": "leaf", "version": "1.0.0"}'],
      ['go.mod', 'module github.com/acme/leaf\n\ngo 1.22\n'],
      ['Cargo.toml', '[package]\nname = "leaf"\nversion = "0.1.0"\n'],
      ['pyproject.toml', '[project]\nname = "leaf"\nversion = "0.1.0"\n'],
    ]) {
      const { items, dropped } = parse(text, {}, `a ${name} with no dependencies`);
      assert.equal(items.length, 1, `${name} should be a one-item draft`);
      assert.equal(items[0].proposed.category, SERVICE);
      assert.match(items[0].proposed.summary, /with 0 direct runtime dependencies/);
      assert.equal(dropped, 0, 'nothing was dropped: there was nothing there');
    }
  });

  test('an empty file is refused rather than becoming an empty draft', () => {
    refusal(() => parseManifest(''));
    refusal(() => parseManifest('   \n\n'));
  });
});

describe('the item cap', () => {
  test('a manifest with 500 dependencies stops at MAX_ITEMS and says so', () => {
    const dependencies = {};
    for (let i = 0; i < 500; i++) dependencies[`@acme/pkg-${String(i).padStart(3, '0')}`] = `^1.${i}.0`;
    const text = JSON.stringify({ name: 'kitchen-sink', version: '1.0.0', dependencies }, null, 2);
    assert.ok(text.length < MAX_MANIFEST_CHARS, 'this fixture must be under the character cap to reach the item cap');

    const { items, dropReasons, dropped } = parse(text, {}, '500 dependencies');
    assert.equal(items.length, MAX_ITEMS, 'the cap is the cap');
    // The module is proposed first, so what the cap costs is dependencies —
    // and, the entities having filled the budget, every link after them.
    assert.equal(entities(items).length, MAX_ITEMS);
    assert.equal(relationships(items).length, 0);
    assert.equal(theService(items).proposed.title, 'kitchen-sink');
    assert.deepEqual(dropReasons, [
      `item cap of ${MAX_ITEMS} reached — ${501 - MAX_ITEMS} further dependencies in the file were not proposed`,
      `item cap of ${MAX_ITEMS} reached — 500 further dependency links in the file were not proposed`,
    ]);
    assert.equal(dropped, 2, 'a cap is one decision, however many items it costs');
  });
});

describe('a second import of the same manifest', () => {
  test('entities of the same titles become updates targeting them', () => {
    const first = parse(NPM, {}, 'package.json (first import)');
    const updatedAt = new Date('2026-10-01T00:00:00Z');
    const existing = entities(first.items).map(i => ({
      _id: new mongoose.Types.ObjectId(),
      // Case differs on purpose: the match is on the normalized title.
      title: i.proposed.title.toUpperCase(),
      updatedAt,
    }));

    const second = parse(NPM, { existingEntities: existing }, 'package.json (second import)');
    assert.equal(entities(second.items).length, existing.length);
    for (const item of entities(second.items)) {
      const target = existing.find(e => e.title === item.proposed.title.toUpperCase());
      assert.equal(item.op, 'update', `${item.proposed.title} should be an update`);
      assert.equal(String(item.targetEntityId), String(target._id));
      assert.equal(item.matchedBy, 'exact-normalized-title');
      assert.equal(item.baseUpdatedAt, updatedAt);
      assert.deepEqual(item.flags, [], 'an exact match is not also a duplicate candidate');
    }
    assert.equal(edges(second.items).length, 5, 'the links still point at the proposals');
  });

  test('an unchanged manifest proposes no new blocks', () => {
    const first = parse(NPM, {}, 'package.json (for its blocks)');
    const existing = entities(first.items).map(i => ({
      _id: new mongoose.Types.ObjectId(),
      title: i.proposed.title,
      updatedAt: new Date(),
      blocks: i.proposed.blocks,
    }));
    const { items } = parse(NPM, { existingEntities: existing }, 'package.json (already imported)');
    for (const item of entities(items)) {
      assert.deepEqual(item.proposed.blocks, [],
        `${item.proposed.title} already carries everything this manifest gives it`);
    }
  });

  test('a bumped version is the one block a re-import proposes', () => {
    const first = parse(NPM, {}, 'package.json (for its blocks)');
    const existing = entities(first.items).map(i => ({
      _id: new mongoose.Types.ObjectId(),
      title: i.proposed.title,
      updatedAt: new Date(),
      blocks: i.proposed.blocks,
    }));
    const bumped = NPM.replace('"version": "1.4.2"', '"version": "1.5.0"');
    const { items } = parse(bumped, { existingEntities: existing }, 'package.json (version bumped)');
    assert.deepEqual(entityNamed(items, '@acme/billing').proposed.blocks, [
      { type: 'attribute', order: 0, data: { label: 'Version', value: '1.5.0' } },
    ], 'the new version, and nothing the entity already had');
  });

  test('the groups the first import created become updates to them', () => {
    const first = parse(NPM, {}, 'package.json (first import)').items;
    const ids = new Map(entities(first).map(i => [i.localKey, new mongoose.Types.ObjectId()]));
    const existingEntities = entities(first).map(i => ({
      _id: ids.get(i.localKey), title: i.proposed.title, updatedAt: new Date('2026-10-01T00:00:00Z'), blocks: i.proposed.blocks,
    }));
    const existingGroups = relationships(first).map(i => ({
      _id: new mongoose.Types.ObjectId(),
      label: i.proposed.label,
      members: i.proposed.members.map(m => ({ refId: ids.get(m.localKey) ?? m.refId, refModel: 'Entity', label: m.label })),
    }));

    const { items } = parse(NPM, { existingEntities, existingGroups }, 'package.json (entities and groups already imported)');
    const second = relationships(items);
    assert.equal(second.length, existingGroups.length, 'the same links are found');
    for (const r of second) {
      assert.equal(r.op, 'update', `${r.proposed.label} should be an update`);
      assert.equal(r.matchedBy, 'same-members-and-label');
      assert.ok(existingGroups.some(g => String(g._id) === r.proposed.targetGroupId), 'targets a group that exists');
    }
    assert.equal(new Set(second.map(r => r.proposed.targetGroupId)).size, second.length, 'one group per link');
  });

  test('a dependency the workspace already has as an entity is linked, not duplicated', () => {
    const existing = [{ _id: new mongoose.Types.ObjectId(), title: 'express', updatedAt: new Date() }];
    const { items } = parse(NPM, { existingEntities: existing }, 'package.json (express already in the graph)');
    const express = entityNamed(items, 'express');
    assert.equal(express.op, 'update');
    assert.equal(String(express.targetEntityId), String(existing[0]._id));
    assert.equal(titles(items).filter(t => t === 'express').length, 1);
  });

  test('a near-miss title is flagged as a duplicate candidate, never merged', () => {
    const existing = [{ _id: new mongoose.Types.ObjectId(), title: 'expres', updatedAt: new Date() }];
    const { items } = parse(NPM, { existingEntities: existing }, 'package.json (near-miss "expres")');
    const express = entityNamed(items, 'express');
    assert.equal(express.op, 'create', 'a near miss is never silently merged into the entity it resembles');
    assert.ok(express.flags.includes('duplicate_candidate'));
    assert.equal(String(express.duplicateOf), String(existing[0]._id));
  });
});

describe('a dependency named twice', () => {
  test('is one entity, and the second mention is a drop reason', () => {
    const text = JSON.stringify({
      name: 'twice', version: '1.0.0',
      dependencies: { react: '^18.2.0' },
      peerDependencies: { react: '>=17' },
    });
    const { items, dropReasons, dropped } = parse(text, {}, 'react in two groups');
    assert.deepEqual(titles(items), ['twice', 'react']);
    assert.equal(attribute(entityNamed(items, 'react'), 'Version constraint'), '^18.2.0',
      'the runtime dependency wins over the peer one');
    assert.equal(attribute(entityNamed(items, 'react'), 'Dependency kind'), undefined);
    assert.deepEqual(dropReasons, ['duplicate entity "react" within the same file']);
    assert.equal(dropped, 1);
    assert.equal(relationships(items).length, 1, 'and one link, not two');
  });

  test('a module that depends on itself proposes no self-link', () => {
    const text = JSON.stringify({ name: 'ouroboros', version: '1.0.0', dependencies: { ouroboros: '^1' } });
    const { items } = parse(text, {}, 'a module depending on itself');
    assert.equal(relationships(items).length, 0);
    assert.equal(entities(items).length, 1, 'the dependency is the module, so it is one entity');
  });
});
