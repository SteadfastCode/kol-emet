/**
 * Unit tests for src/lib/producers/redactSecrets.js.
 *
 * The module is what stands between an uploaded docker-compose file and a
 * collection that has no TTL, an exporter that carries `source.text` and every
 * evidence quote out verbatim, and a verbose log tier that prints quotes. So
 * these tests hold it to four properties, in this order of importance:
 *
 *   1. **Nothing leaks.** No credential in the input survives anywhere in the
 *      output — checked as "this exact string is not in the text", not as
 *      "the line looks redacted".
 *   2. **The file still parses, and still means the same thing.** Same line
 *      count (a YAML error names the line the person sees), valid YAML after
 *      the splice, and hosts kept — a DSN's password goes, its host stays, so
 *      the producer still draws the edge that host is there for.
 *   3. **Nothing else is touched.** An image tag, a port, a PARTITION_KEY and
 *      an AUTHORS list are not credentials and must come through unchanged.
 *   4. **It is deterministic and idempotent**, so textHash still identifies a
 *      re-import of the same file.
 *
 * Falsification checks, run red by hand against a deliberately broken module:
 *   - ADDRESS_KEY_RE emptied              -> the DSN test fails (host redacted,
 *                                            and parseCompose loses the edge)
 *   - the anchor clip in valueRange cut   -> the anchors/merge test fails
 *                                            (alias with no anchor)
 *   - BLOCK_HEADER_RE never matching      -> the PEM test fails (invalid YAML)
 *   - the line-scanner fallback removed   -> the invalid-YAML test fails
 *   - the inline rule given a word list of   -> the map-vs-list test fails
 *     its own instead of looksSecret             (DB_PASS leaks in list form)
 *   - SECRET_WORD_GLUED given a left boundary -> the glued-key test fails
 *                                            (PGPASSWORD leaks in map form)
 *   - SECRET_WORD_BOUNDED's left boundary cut -> the looksSecret table fails
 *                                            (CACHE_BYPASS reads as a secret)
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_REDACT_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per redaction run: the case, and what it changed
 *   normal  — light, plus the key and rule behind each redaction
 *   verbose — normal, plus the redacted text
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';

process.env.REDACT_LOG_LEVEL ??= 'off';

const { redactSecrets, looksSecret, REDACTED } = await import('../../src/lib/producers/redactSecrets.js');
const { parseCompose } = await import('../../src/lib/producers/dockerCompose.js');

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };
function log(level, msg) {
  const active = LEVELS[process.env.TEST_REDACT_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/redactSecrets:${level}] ${msg}`);
}

/** Redact, log what happened, and assert the two structural invariants every case shares. */
function redact(text, label) {
  const out = redactSecrets(text, { label });
  log('light', `redacted ${label} (source: redactSecrets, ${text.length} chars) → ${out.count} values via the ${out.via} pass`);
  for (const r of out.redactions) log('normal', `  ${JSON.stringify(r.key)} on line ${r.line} by the ${r.rule} rule`);
  log('verbose', `  ${JSON.stringify(out.text)}`);
  assert.equal(
    out.text.split('\n').length, text.split('\n').length,
    `${label}: the line count must survive, or a YAML error names the wrong line`,
  );
  return out;
}

/** Assert none of `secrets` appears anywhere in the redacted text. */
function assertGone(out, secrets, label) {
  for (const secret of secrets) {
    assert.ok(!out.text.includes(secret), `${label}: ${JSON.stringify(secret)} survived redaction`);
  }
}

const parses = text => parseDocument(text, { merge: true, prettyErrors: false }).errors.length === 0;

describe('redactSecrets — credentials do not survive', () => {
  test('a secret-looking key loses its whole value, in map and list form', () => {
    const text = [
      'services:',
      '  db:',
      '    image: postgres:16',
      '    environment:',
      '      POSTGRES_PASSWORD: hunter2',
      '      JWT_SECRET: "s3cr3t value"',
      "      AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI'",
      '  worker:',
      '    environment:',
      '      - MYSQL_ROOT_PASSWORD=hunter2',
      '      - GITHUB_TOKEN=ghp_000111222333444555666777888999aaabbb',
    ].join('\n');

    const out = redact(text, 'secret keys');
    assertGone(out, ['hunter2', 's3cr3t value', 'wJalrXUtnFEMI', 'ghp_000111222333444555666777888999aaabbb'], 'secret keys');
    assert.equal(out.count, 5);
    assert.ok(parses(out.text), 'the redacted file is still YAML');

    const env = parseDocument(out.text).toJS().services;
    assert.equal(env.db.environment.POSTGRES_PASSWORD, REDACTED);
    assert.equal(env.db.environment.JWT_SECRET, REDACTED);
    assert.equal(env.db.image, 'postgres:16', 'the image is not a credential');
    assert.deepEqual(env.worker.environment, [`MYSQL_ROOT_PASSWORD=${REDACTED}`, `GITHUB_TOKEN=${REDACTED}`]);
  });

  test('a credential word glued onto the key is still a credential, in map and list form', () => {
    // PGPASSWORD is libpq's own variable, so it is what a postgres service is
    // most likely to be handed — and `PG` runs straight into `PASSWORD` with no
    // separator. The list form was always redacted (INLINE_ASSIGN_RE matches
    // left-open); the map form was not, which made the leak a question of which
    // compose syntax the file happened to use. Both forms here, same file.
    const text = [
      'services:',
      '  db:',
      '    image: postgres:16',
      '    environment:',
      '      PGPASSWORD: hunter2',
      '      MYAPPTOKEN: abcdef0123456789',
      '  worker:',
      '    environment:',
      '      - PGPASSWORD=hunter2',
    ].join('\n');

    const out = redact(text, 'glued keys');
    assertGone(out, ['hunter2', 'abcdef0123456789'], 'glued keys');
    assert.equal(out.count, 3);
    assert.ok(parses(out.text), 'the redacted file is still YAML');

    const services = parseDocument(out.text).toJS().services;
    assert.equal(services.db.environment.PGPASSWORD, REDACTED, 'the map form is redacted too');
    assert.equal(services.db.environment.MYAPPTOKEN, REDACTED);
    assert.deepEqual(services.worker.environment, [`PGPASSWORD=${REDACTED}`]);
    assert.equal(services.db.image, 'postgres:16', 'the image is not a credential');
  });

  test("a URL's userinfo goes and its host stays, so the producer still draws the edge", () => {
    const text = [
      'services:',
      '  web:',
      '    build: ./web',
      '    environment:',
      '      DATABASE_URL: postgres://app:tr0ub4dor@postgres:5432/app',
      '      SENTRY_DSN: https://abc123@sentry.io/42',
      '  postgres:',
      '    image: postgres:16',
    ].join('\n');

    const out = redact(text, 'dsn');
    assertGone(out, ['tr0ub4dor', 'app:tr0ub4dor', 'abc123'], 'dsn');
    assert.match(out.text, /postgres:\/\/REDACTED@postgres:5432\/app/, 'the host survives');
    assert.match(out.text, /https:\/\/REDACTED@sentry\.io\/42/);

    // The point of keeping the host: this is the edge the draft exists for.
    const { items } = parseCompose(out.text);
    const calls = items.filter(i => i.kind === 'relationship' && i.proposed.label === 'Calls');
    assert.equal(calls.length, 1, 'web still calls postgres after redaction');
    assert.deepEqual(calls[0].proposed.members.map(m => m.name), ['web', 'postgres']);
    assert.ok(items.some(i => i.proposed.title === 'sentry.io'), 'the external host survives as an entity');
    assert.ok(!calls[0].input.evidence.quote.includes('tr0ub4dor'), 'the evidence quote is of the redacted line');
  });

  test('a credential in an anchor a service merges keeps the anchor, and the merge still resolves', () => {
    const text = [
      'x-env: &env',
      '  POSTGRES_PASSWORD: hunter2',
      '  LOG_LEVEL: debug',
      'services:',
      '  web:',
      '    image: nginx',
      '    environment:',
      '      <<: *env',
      '      API_TOKEN: &tok abcdef0123456789',
      '  worker:',
      '    image: nginx',
      '    environment:',
      '      API_TOKEN: *tok',
    ].join('\n');

    const out = redact(text, 'anchors');
    assertGone(out, ['hunter2', 'abcdef0123456789'], 'anchors');
    assert.match(out.text, /API_TOKEN: &tok REDACTED/, 'the anchor name is not part of the value');
    assert.ok(parses(out.text), 'the redacted file is still YAML');

    const doc = parseDocument(out.text, { merge: true }).toJS();
    assert.equal(doc.services.web.environment.POSTGRES_PASSWORD, REDACTED, 'the merge still resolves');
    assert.equal(doc.services.web.environment.LOG_LEVEL, 'debug');
    assert.equal(doc.services.worker.environment.API_TOKEN, REDACTED, 'the alias still resolves');
  });

  test('a private key in a block scalar keeps its header, so the file still parses', () => {
    const text = [
      'services:',
      '  signer:',
      '    image: signer',
      '    environment:',
      '      TLS_PRIVATE_KEY: |',
      '        -----BEGIN RSA PRIVATE KEY-----',
      '        MIIEpAIBAAKCAQEAxyz',
      '        -----END RSA PRIVATE KEY-----',
      '      PORT: "8080"',
    ].join('\n');

    const out = redact(text, 'pem');
    assertGone(out, ['MIIEpAIBAAKCAQEAxyz', 'BEGIN RSA PRIVATE KEY'], 'pem');
    assert.ok(parses(out.text), 'the redacted file is still YAML');
    assert.match(out.text, /TLS_PRIVATE_KEY: \|/, 'the block header survives');
    assert.equal(parseDocument(out.text).toJS().services.signer.environment.PORT, '8080');
  });

  test('a credential wearing an innocent key is caught by its shape', () => {
    const text = [
      'services:',
      '  web:',
      '    image: nginx',
      '    environment:',
      '      SETTINGS: AKIAIOSFODNN7EXAMPLE',
      '      SESSION: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
      '    command: ["serve", "--password=hunter2", "--port=80"]',
    ].join('\n');

    const out = redact(text, 'shapes');
    assertGone(out, ['AKIAIOSFODNN7EXAMPLE', 'eyJhbGciOiJIUzI1NiJ9', 'hunter2'], 'shapes');
    assert.ok(parses(out.text), 'the redacted file is still YAML');
    assert.deepEqual(parseDocument(out.text).toJS().services.web.command, ['serve', `--password=${REDACTED}`, '--port=80']);
  });

  test('a key is a credential in both compose syntaxes, or in neither', () => {
    // The key rule and the inline rule once carried separate word lists, and
    // drifted apart in both directions: PGPASSWORD leaked in map form while
    // the list form caught it, and then DB_PASS, AUTH, SIGNING_SALT and
    // HTTP_AUTHORIZATION leaked in list form once the key rule learned them.
    // Either way the credential reached a collection with no TTL, an evidence
    // quote and a verbatim export path. So the table, not the rule, is the
    // invariant: the same file writes every key both ways, and which syntax
    // it used must not change what comes out. The innocents are half of it —
    // symmetry is trivial to get by redacting everything, and a redacted
    // PARTITION_KEY costs the draft the architecture it exists to capture.
    const CREDENTIALS = [
      'DB_PASS', 'AUTH', 'SIGNING_SALT', 'HTTP_AUTHORIZATION', 'API_BEARER', 'SSLCERTIFICATE',
      'PGPASSWORD', 'POSTGRES_PASSWORD', 'JWT_SECRET', 'MYAPIKEY', 'AWS_SECRET_ACCESS_KEY',
    ];
    const INNOCENTS = ['PARTITION_KEY', 'TOKENIZER', 'AUTHORS', 'DB_HOST', 'CACHE_BYPASS', 'PGPASSFILE'];
    const mapValue = key => `map-value-of-${key}`;
    const listValue = key => `list-value-of-${key}`;
    const innocent = key => `plain-${key}`;

    const text = [
      'services:',
      '  map_form:',
      '    image: nginx',
      '    environment:',
      ...CREDENTIALS.map(key => `      ${key}: ${mapValue(key)}`),
      ...INNOCENTS.map(key => `      ${key}: ${innocent(key)}`),
      '  list_form:',
      '    image: nginx',
      '    environment:',
      ...CREDENTIALS.map(key => `      - ${key}=${listValue(key)}`),
      ...INNOCENTS.map(key => `      - ${key}=${innocent(key)}`),
    ].join('\n');

    const out = redact(text, 'map vs list');
    assertGone(out, CREDENTIALS.flatMap(key => [mapValue(key), listValue(key)]), 'map vs list');
    assert.ok(parses(out.text), 'the redacted file is still YAML');

    const services = parseDocument(out.text).toJS().services;
    for (const key of CREDENTIALS) {
      assert.equal(services.map_form.environment[key], REDACTED, `${key} must lose its value in map form`);
      assert.ok(
        services.list_form.environment.includes(`${key}=${REDACTED}`),
        `${key} must lose its value in list form too, or the leak is a question of syntax`,
      );
    }
    for (const key of INNOCENTS) {
      assert.equal(services.map_form.environment[key], innocent(key), `${key} is not a credential in map form`);
      assert.ok(
        services.list_form.environment.includes(`${key}=${innocent(key)}`),
        `${key} is not a credential in list form either`,
      );
    }
    assert.equal(out.count, CREDENTIALS.length * 2, 'one redaction per credential, per syntax');
  });

  test('a file the parser rejects is still redacted, by the line scanner', () => {
    const text = [
      'services:',
      '  web:',
      '    environment:',
      '      POSTGRES_PASSWORD: hunter2',
      '      DATABASE_URL: postgres://app:tr0ub4dor@postgres:5432/app',
      '      - DB_PASS=c0rrecth0rse',
      '   ports: [80',
    ].join('\n');

    const out = redact(text, 'invalid yaml');
    assert.ok(!parses(text), 'the case is only meaningful if the input is genuinely broken');
    assert.equal(out.via, 'lines', 'the AST pass cannot run, so the line scanner does');
    assertGone(out, ['hunter2', 'tr0ub4dor', 'c0rrecth0rse'], 'invalid yaml');
    assert.match(out.text, /- DB_PASS=REDACTED/, 'the line scanner reads a list item too');
    assert.match(out.text, /postgres:\/\/REDACTED@postgres:5432\/app/, 'the host still survives');
  });
});

describe('redactSecrets — everything else is left alone', () => {
  test('values that are not credentials come through unchanged', () => {
    const text = [
      'services:',
      '  web:',
      '    image: docker.io/library/nginx:1.27-alpine',
      '    ports:',
      '      - "8080:80"',
      '    environment:',
      '      PARTITION_KEY: orders',
      '      TOKENIZER: bpe',
      '      AUTHORS: jim,sam',
      '      PAYMENTS_API: https://api.stripe.com/v1',
      '      DB_HOST: postgres',
    ].join('\n');

    const out = redact(text, 'innocents');
    assert.equal(out.count, 0, `nothing here is a credential; redacted ${JSON.stringify(out.redactions)}`);
    assert.equal(out.text, text);
  });

  test('a key is never rewritten, only its value', () => {
    const out = redact('password: hunter2\n', 'bare key');
    assert.equal(out.text, `password: ${REDACTED}\n`);
  });

  test('looksSecret separates an address key from a credential key', () => {
    // The glued cases (PGPASSWORD, MYAPPTOKEN, SSLCERTIFICATE) are the words
    // that cannot be made innocent from the left; the innocents below are the
    // reason the short words (pass, salt, cert, bearer) kept their boundary.
    for (const key of [
      'POSTGRES_PASSWORD', 'jwt_secret', 'AWS_SECRET_ACCESS_KEY', 'api-key', 'AUTH', 'SSH_PRIVATE_KEY', 'DB_PASS',
      'PGPASSWORD', 'MYAPPTOKEN', 'SSLCERTIFICATE', 'appcredentials', 'HTTP_AUTHORIZATION', 'MYAPIKEY',
    ]) {
      assert.ok(looksSecret(key), `${key} should be treated as a credential`);
    }
    for (const key of [
      'DATABASE_URL', 'SENTRY_DSN', 'REDIS_HOST', 'AUTH_ENDPOINT', 'PARTITION_KEY', 'AUTHORS', 'TOKENIZER', 'image', '',
      'CACHE_BYPASS', 'BASALT', 'CONCERT', 'ENCOMPASS', 'forbearer', 'PGPASSFILE',
    ]) {
      assert.ok(!looksSecret(key), `${key} should not be treated as a credential`);
    }
  });
});

describe('redactSecrets — the same file always redacts the same way', () => {
  const text = [
    'services:',
    '  web:',
    '    environment:',
    '      POSTGRES_PASSWORD: hunter2',
    '      DATABASE_URL: postgres://app:app@postgres:5432/app',
  ].join('\n');

  test('deterministic, so textHash still identifies a re-import', () => {
    const a = redact(text, 'determinism a');
    const b = redact(text, 'determinism b');
    assert.equal(a.text, b.text);
    assert.equal(a.count, b.count);
  });

  test('idempotent, so a redacted file re-imported does not drift', () => {
    const once = redact(text, 'idempotence 1');
    const twice = redactSecrets(once.text, { label: 'idempotence 2' });
    assert.equal(twice.text, once.text);
    assert.equal(twice.count, 0, 'there is nothing left to redact');
  });

  test('empty and non-string input are not a crash', () => {
    assert.deepEqual(redactSecrets('').text, '');
    assert.deepEqual(redactSecrets(null).text, '');
    assert.deepEqual(redactSecrets(undefined).count, 0);
  });
});
