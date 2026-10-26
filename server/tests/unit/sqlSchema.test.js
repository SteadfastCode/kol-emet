/**
 * Unit tests for the SQL schema producer, src/lib/producers/sqlSchema.js.
 *
 * The producer's contract is the other three producers' contract: its output is
 * indistinguishable, in shape, from what normalizeDraft emits for a braindump,
 * so the review UI, the decision routes and the applier take it without knowing
 * where it came from. So beyond the mapping itself (a table is a Data Store,
 * its columns are attribute blocks, a foreign key is a Depends on link) these
 * tests hold it to that shape: every evidence quote is a real line of the file
 * at the offsets it claims, every relationship payload passes the validator an
 * edited item must, and a second parse against the entities the first one
 * created turns into updates.
 *
 * Most of what is hard about a real dump is lexical, so most of these are about
 * the lexer: a comment or a string literal that holds the word REFERENCES, a
 * semicolon or a bracket; identifiers quoted three ways; and a Postgres
 * function body delimited by `$$`, which a split on `;` would tear apart.
 *
 * Fixture: tests/fixtures/schema.sql — a pg_dump-shaped schema: four tables
 * across two schemas (two of them sharing a name), an inline foreign key, a
 * table-level one, a composite primary key, a dollar-quoted function body, a
 * `CREATE TABLE … AS SELECT` with no column list, and a trailing `ALTER TABLE …
 * ADD CONSTRAINT … FOREIGN KEY` naming a table the dump does not declare.
 *
 * Falsification checks, run red by hand against a deliberately broken producer:
 *   - comments not skipped            -> the "REFERENCES customers" in a comment
 *                                        becomes an edge
 *   - strings not one token           -> a COMMENT holding `;` and `)` tears the
 *                                        statement apart
 *   - `$$` bodies not one token       -> everything after the function vanishes
 *   - quoted identifiers not unquoted -> `"display name"` keeps its quotes
 *   - the ALTER TABLE reading removed -> a pg_dump's foreign keys all vanish
 *   - the no-column-list drop turned
 *     into a throw                    -> `CREATE TABLE … AS SELECT` refuses the
 *                                        file
 *   - the refusal turned into an empty
 *     draft                           -> a file of INSERTs becomes an empty draft
 *   - the same-name qualification
 *     removed                         -> `audit.customers` is dropped as a
 *                                        duplicate of `public.customers`
 *   - resolveTable's own-schema
 *     preference removed              -> `REFERENCES customers(id)` inside
 *                                        `public.orders` goes ambiguous
 *   - existingByKey lookup removed    -> the re-import test fails
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * TEST_SQL_SCHEMA_LOG_LEVEL = off | light | normal | verbose (default light)
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
  parseSqlSchema, tokenize, SqlParseError,
  PRODUCER, PRODUCER_VERSION, MAX_SQL_CHARS, MAX_COLUMNS, DATA_STORE,
} from '../../src/lib/producers/sqlSchema.js';
import { MAX_COMPOSE_CHARS } from '../../src/lib/producers/dockerCompose.js';
import { MAX_ITEMS } from '../../src/lib/draftNormalizer.js';
import { relationshipPayloadSchema } from '../../src/lib/draftItemSchema.js';

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };
function log(level, msg) {
  const active = LEVELS[process.env.TEST_SQL_SCHEMA_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tests/sqlSchema:${level}] ${msg}`);
}

const FIXTURE = readFileSync(fileURLToPath(new URL('../fixtures/schema.sql', import.meta.url)), 'utf8');

function parse(text, opts, source) {
  const out = parseSqlSchema(text, opts);
  log('light', `parsed ${source} (source: parseSqlSchema, ${opts?.existingEntities?.length ?? 0} existing entities) → ${out.items.length} items, ${out.dropReasons.length} dropped`);
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

/** "Dependent:orders → Dependency:customers" for each relationship of that label. */
function edges(items, label = 'Depends on') {
  const titleOf = new Map(entities(items).map(i => [i.localKey, i.proposed.title]));
  return relationships(items)
    .filter(r => r.proposed.label === label)
    .map(r => r.proposed.members.map(m => `${m.label}:${titleOf.get(m.localKey) ?? m.name}`).join(' → '))
    .sort();
}

const attribute = (item, label) =>
  item.proposed.blocks.find(b => b.type === 'attribute' && b.data.label === label)?.data.value;

/** Every column attribute of an item, in order, as "name = value". */
const columns = item => item.proposed.blocks
  .filter(b => b.data.label !== 'Schema')
  .map(b => `${b.data.label} = ${b.data.value}`);

describe('schema.sql fixture', () => {
  const { items, dropReasons } = parse(FIXTURE, {}, 'tests/fixtures/schema.sql');

  test('exports the producer identity the draft records', () => {
    assert.equal(PRODUCER, 'sql-schema');
    assert.equal(PRODUCER_VERSION, 'sql-schema@1');
    // One cap for every producer: the point of it is express.json's body limit,
    // which does not care which file is in the body.
    assert.equal(MAX_SQL_CHARS, MAX_COMPOSE_CHARS);
  });

  test('every table is a Data Store, and only a name shared across schemas is qualified', () => {
    assert.deepEqual(entities(items).map(i => [i.proposed.title, i.proposed.category]), [
      ['public.customers', DATA_STORE],
      ['orders', DATA_STORE],
      ['order_items', DATA_STORE],
      ['audit.customers', DATA_STORE],
    ]);
    // `orders` and `order_items` are in `public` too, and stay bare: the schema
    // is in the blocks either way, and a title nobody shares needs no prefix.
    assert.equal(attribute(entityNamed(items, 'orders'), 'Schema'), 'public');
    for (const item of entities(items)) assert.deepEqual(item.proposed.tags, ['sql-schema']);
  });

  test('a statement with no reading is a drop reason, not a refusal of the file', () => {
    assert.deepEqual(dropReasons, [
      'CREATE TABLE "public.monthly_totals" on line 57 was skipped — it declares no column list',
      '"Depends on" from order_items to "public.skus" dropped — no table or entity by that name',
    ]);
    // SET, CREATE SCHEMA, CREATE FUNCTION and CREATE INDEX are passed over in
    // silence: a dump is mostly those, and a reason each would bury these two.
    assert.equal(dropReasons.length, 2);
  });

  test('each column is an attribute block carrying its type and key markers', () => {
    assert.deepEqual(columns(entityNamed(items, 'public.customers')), [
      'id = bigint PRIMARY KEY NOT NULL',
      'email = character varying(255) NOT NULL UNIQUE',
      // A quoted identifier is the name without its quotes.
      'display name = text',
      // The DEFAULT is not carried: it is where a dump keeps a credential, and
      // redactSecrets has already taken this one out.
      'api_token = text',
      'created_at = timestamp with time zone NOT NULL',
    ]);
    assert.equal(entityNamed(items, 'public.customers').proposed.summary,
      'A table of 5 columns in schema `public` (SQL schema).');
  });

  test('a composite primary key says so on each of its columns', () => {
    // A column that is one of two in a key is not a key on its own, and a
    // reviewer who cannot tell those apart is reading the wrong schema.
    assert.deepEqual(columns(entityNamed(items, 'order_items')), [
      'order_id = integer PRIMARY KEY (composite) NOT NULL',
      'sku = text PRIMARY KEY (composite) NOT NULL',
      'quantity = integer NOT NULL',
    ]);
  });

  test('an inline REFERENCES and a table-level FOREIGN KEY are both Depends on links', () => {
    assert.deepEqual(edges(items), [
      // Inline, from a column definition. `REFERENCES customers(id)` is read in
      // the referencing table's own schema, which is where SQL looks first.
      'Dependent:order_items → Dependency:orders',
      'Dependent:orders → Dependency:public.customers',
    ]);
    for (const r of relationships(items)) {
      assert.equal(r.op, 'create');
      assert.deepEqual(r.proposed.members.map(m => m.label), ['Dependent', 'Dependency']);
      // The Software Architecture template's own vocabulary, not a new label.
      assert.equal(r.proposed.label, 'Depends on');
    }
  });

  test('each item quotes the source line that produced it, at the offsets it claims', () => {
    for (const item of items) {
      const { quote, charStart, charEnd } = item.input.evidence;
      assert.equal(FIXTURE.slice(charStart, charEnd), quote, `${item.localKey}'s offsets`);
      assert.ok(quote.length, `${item.localKey} has an evidence quote`);
      assert.ok(!quote.includes('\n'), `${item.localKey}'s quote is one line`);
    }
    assert.match(entityNamed(items, 'orders').input.evidence.quote, /^CREATE TABLE IF NOT EXISTS public\.orders/);
    assert.match(relationships(items)[0].input.evidence.quote, /REFERENCES customers\(id\)/);
  });

  test('every relationship payload passes the validator an edited item must', () => {
    for (const r of relationships(items)) {
      const parsed = relationshipPayloadSchema.safeParse(r.proposed);
      assert.ok(parsed.success, `${r.localKey}: ${JSON.stringify(parsed.error?.issues)}`);
    }
  });

  test('the same file parsed twice gives the same draft', () => {
    // Determinism is what makes a producer safe to re-run, and what lets
    // `textHash` mean "this exact file was imported before".
    const second = parse(FIXTURE, {}, 'fixture (second parse)');
    assert.deepEqual(second.items, parse(FIXTURE, {}, 'fixture (first parse)').items);
    assert.deepEqual(second.dropReasons, dropReasons);
  });
});

describe('the lexer', () => {
  test('a comment cannot declare a table or a foreign key', () => {
    const sql = [
      '-- CREATE TABLE ghosts (id int);',
      '# CREATE TABLE mysql_ghosts (id int);',
      '/* CREATE TABLE block_ghosts (id int);',
      '   REFERENCES ghosts (id) */',
      'CREATE TABLE real_one (',
      '  id int PRIMARY KEY  -- REFERENCES ghosts(id)',
      ');',
    ].join('\n');
    const { items } = parse(sql, {}, 'a file whose comments hold DDL');
    assert.deepEqual(entities(items).map(i => i.proposed.title), ['real_one']);
    assert.deepEqual(relationships(items), []);
  });

  test('a string literal holding a semicolon, a bracket or REFERENCES is one value', () => {
    const sql = [
      'CREATE TABLE notes (',
      "  id int PRIMARY KEY,",
      "  body text DEFAULT 'half a statement; REFERENCES ghosts (id) )',",
      "  label text NOT NULL",
      ');',
    ].join('\n');
    const { items } = parse(sql, {}, 'a file with an awkward string literal');
    assert.deepEqual(columns(entityNamed(items, 'notes')), [
      'id = int PRIMARY KEY',
      'body = text',
      'label = text NOT NULL',
    ]);
    assert.deepEqual(relationships(items), []);
  });

  test('a dollar-quoted function body does not end the statement it sits in', () => {
    // The thing a split on `;` gets wrong, and the reason there is a lexer here:
    // everything after the body would otherwise be read as fragments.
    const sql = [
      'CREATE FUNCTION touch() RETURNS trigger AS $body$',
      'BEGIN',
      "  NEW.x = 1; -- a semicolon, and a CREATE TABLE decoy (id int);",
      '  RETURN NEW;',
      'END;',
      '$body$ LANGUAGE plpgsql;',
      'CREATE TABLE after_the_body (id int PRIMARY KEY);',
    ].join('\n');
    const { items } = parse(sql, {}, 'a file with a dollar-quoted body');
    assert.deepEqual(entities(items).map(i => i.proposed.title), ['after_the_body']);
  });

  test('identifiers quoted three ways read as the same name', () => {
    const { tokens } = tokenize('"public"."user ""x""" `back` [bracketed] plain integer[]');
    assert.deepEqual(tokens.filter(t => t.type === 'ident').map(t => t.value),
      ['public', 'user "x"', 'back', 'bracketed']);
    // `[` glued to a word is Postgres' array suffix, not a name — so `integer[]`
    // stays two words and a pair of punctuation, and reads back as a type.
    assert.deepEqual(tokens.filter(t => t.type === 'word').map(t => t.value), ['plain', 'integer']);
  });

  test('an unterminated quote or comment is a drop reason naming its line', () => {
    const sql = [
      'CREATE TABLE readable (id int PRIMARY KEY);',
      "CREATE TABLE broken (note text DEFAULT 'never closed",
      'CREATE TABLE unreachable (id int);',
    ].join('\n');
    const { items, dropReasons } = parse(sql, {}, 'a file with an unterminated string');
    assert.deepEqual(entities(items).map(i => i.proposed.title), ['readable'],
      'the tables before the bad quote are still proposed');
    assert.deepEqual(dropReasons, [
      'unterminated string on line 2 — nothing after it was read',
      // The statement the quote swallowed is reported on its own terms too.
      'CREATE TABLE "broken" on line 2 was skipped — its column list is not closed',
    ]);
  });
});

describe('MySQL and SQL Server spellings', () => {
  const MYSQL = [
    '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;',
    'DROP TABLE IF EXISTS `customers`;',
    'CREATE TABLE `customers` (',
    '  `id` int(11) NOT NULL AUTO_INCREMENT,',
    '  `email` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,',
    "  `key` varchar(50) DEFAULT NULL,",
    "  `status` enum('new','paid','void') NOT NULL DEFAULT 'new',",
    '  PRIMARY KEY (`id`),',
    '  UNIQUE KEY `uq_email` (`email`),',
    '  KEY `idx_status` (`status`)',
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;',
    'CREATE TABLE `invoices` (',
    '  `id` int(11) NOT NULL AUTO_INCREMENT,',
    '  `customer_id` int(11) NOT NULL,',
    '  `tenant_id` int(11) NOT NULL,',
    '  PRIMARY KEY (`id`),',
    '  UNIQUE KEY `uq_tenant_customer` (`tenant_id`,`customer_id`),',
    '  CONSTRAINT `fk_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE',
    ') ENGINE=InnoDB;',
  ].join('\n');

  const { items } = parse(MYSQL, {}, 'a mysqldump --no-data shape');

  test('backtick identifiers, a CHARACTER SET and an ENUM type all read', () => {
    assert.deepEqual(columns(entityNamed(items, 'customers')), [
      // PRIMARY KEY (`id`) is the table-level form, and lands on the column.
      'id = int(11) PRIMARY KEY NOT NULL',
      // The type stops at CHARACTER SET, which is a modifier, not part of it.
      'email = varchar(191) NOT NULL UNIQUE',
      // A column called `key` is a column, not MySQL's inline index.
      'key = varchar(50)',
      "status = enum('new','paid','void') NOT NULL",
    ]);
  });

  test("MySQL's inline KEY and UNIQUE KEY are constraints, not columns", () => {
    assert.ok(!columns(entityNamed(items, 'customers')).some(c => c.startsWith('idx_status')));
    assert.ok(!columns(entityNamed(items, 'invoices')).some(c => c.startsWith('uq_tenant_customer')));
    // A composite UNIQUE marks each of its columns as part of one, as a
    // composite primary key does.
    assert.deepEqual(columns(entityNamed(items, 'invoices')), [
      'id = int(11) PRIMARY KEY NOT NULL',
      'customer_id = int(11) NOT NULL UNIQUE (composite)',
      'tenant_id = int(11) NOT NULL UNIQUE (composite)',
    ]);
  });

  test('a named CONSTRAINT … FOREIGN KEY is a Depends on link', () => {
    assert.deepEqual(edges(items), ['Dependent:invoices → Dependency:customers']);
  });

  test('bracketed identifiers and a qualified reference read as one table', () => {
    const sql = [
      'CREATE TABLE [dbo].[Customers] ([Id] int NOT NULL PRIMARY KEY);',
      'CREATE TABLE [dbo].[Sessions] (',
      '  [Id] uniqueidentifier NOT NULL PRIMARY KEY,',
      '  [CustomerId] int NOT NULL,',
      '  CONSTRAINT [FK_Sessions_Customers] FOREIGN KEY ([CustomerId]) REFERENCES [dbo].[Customers] ([Id])',
      ');',
    ].join('\n');
    const { items: sqlServer } = parse(sql, {}, 'a SQL Server script');
    assert.deepEqual(entities(sqlServer).map(i => i.proposed.title), ['Customers', 'Sessions']);
    assert.deepEqual(edges(sqlServer), ['Dependent:Sessions → Dependency:Customers']);
  });
});

describe('foreign keys', () => {
  test('the trailing ALTER TABLE form a pg_dump emits is read', () => {
    // pg_dump writes no inline foreign key at all: every one of them is a
    // trailing ALTER. Without this reading a Postgres dump has no edges.
    const sql = [
      'CREATE TABLE users (id bigint PRIMARY KEY);',
      'CREATE TABLE sessions (id bigint PRIMARY KEY, user_id bigint NOT NULL);',
      'ALTER TABLE ONLY public.sessions',
      '    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;',
    ].join('\n');
    const { items, dropReasons } = parse(sql, {}, 'a dump whose keys are all ALTERs');
    assert.deepEqual(edges(items), ['Dependent:sessions → Dependency:users']);
    assert.deepEqual(dropReasons, []);
    assert.match(relationships(items)[0].input.evidence.quote, /^ADD CONSTRAINT sessions_user_id_fkey/);
  });

  test('a composite foreign key is one link, not one per column', () => {
    const sql = [
      'CREATE TABLE tenants_users (tenant_id int, user_id int, PRIMARY KEY (tenant_id, user_id));',
      'CREATE TABLE memberships (',
      '  tenant_id int NOT NULL,',
      '  user_id int NOT NULL,',
      '  role text,',
      '  FOREIGN KEY (tenant_id, user_id) REFERENCES tenants_users (tenant_id, user_id)',
      ');',
    ].join('\n');
    const { items } = parse(sql, {}, 'a composite foreign key');
    assert.deepEqual(edges(items), ['Dependent:memberships → Dependency:tenants_users']);
  });

  test('two foreign keys between the same tables are one link', () => {
    const sql = [
      'CREATE TABLE people (id int PRIMARY KEY);',
      'CREATE TABLE messages (',
      '  id int PRIMARY KEY,',
      '  sender_id int REFERENCES people(id),',
      '  recipient_id int REFERENCES people(id)',
      ');',
    ].join('\n');
    const { items } = parse(sql, {}, 'two keys to one table');
    assert.deepEqual(edges(items), ['Dependent:messages → Dependency:people']);
  });

  test('a self-referencing key proposes no link', () => {
    const sql = 'CREATE TABLE nodes (id int PRIMARY KEY, parent_id int REFERENCES nodes(id));';
    const { items } = parse(sql, {}, 'a self-referencing key');
    assert.deepEqual(relationships(items), []);
    assert.deepEqual(entities(items).map(i => i.proposed.title), ['nodes']);
  });

  test('a reference the file declares in several schemas, and in none of its own, is dropped', () => {
    // The file holds candidates, so choosing one of them would be a guess —
    // the same reading the manifest producer gives an ambiguous host.
    const sql = [
      'CREATE TABLE a.users (id int PRIMARY KEY);',
      'CREATE TABLE b.users (id int PRIMARY KEY);',
      'CREATE TABLE c.orders (id int PRIMARY KEY, user_id int REFERENCES users(id));',
    ].join('\n');
    const { items, dropReasons } = parse(sql, {}, 'an ambiguous reference');
    assert.deepEqual(relationships(items), []);
    assert.deepEqual(dropReasons, [
      'a foreign key on "orders" names table "users", which this file declares in `a` and `b` — nothing was proposed for it',
    ]);
  });

  test('a reference to a table the file does not declare can still land on an entity the workspace has', () => {
    const existing = [{ _id: new mongoose.Types.ObjectId(), title: 'archived_users', updatedAt: new Date() }];
    const sql = 'CREATE TABLE logs (id int PRIMARY KEY, user_id int REFERENCES archived_users(id));';
    const { items, dropReasons } = parse(sql, { existingEntities: existing }, 'a reference to an existing entity');
    assert.deepEqual(dropReasons, []);
    assert.deepEqual(edges(items), ['Dependent:logs → Dependency:archived_users']);
    const member = relationships(items)[0].proposed.members.find(m => m.name === 'archived_users');
    assert.equal(String(member.refId), String(existing[0]._id), 'the link points at the entity that exists');
  });
});

describe('refusals and caps', () => {
  test('a file with no readable CREATE TABLE is refused, with nothing stored', () => {
    for (const text of [
      "INSERT INTO users (id, email) VALUES (1, 'a@b.test');",
      'SELECT * FROM users;',
      'ALTER TABLE users ADD COLUMN nickname text;',
      '-- just a comment\n',
      '',
    ]) {
      assert.throws(() => parseSqlSchema(text), err => {
        assert.ok(err instanceof SqlParseError, `expected a SqlParseError for ${JSON.stringify(text)}`);
        assert.match(err.message, /Not a SQL schema/);
        return true;
      }, `expected ${JSON.stringify(text)} to be refused`);
    }
  });

  test('a refusal whose only CREATE TABLE was unreadable says why', () => {
    assert.throws(() => parseSqlSchema('CREATE TABLE half (\n  id int\n'), err => {
      assert.match(err.message, /its column list is not closed/);
      return true;
    });
  });

  test('a table past the column cap is proposed, and the columns left out are said out loud', () => {
    const wide = ['CREATE TABLE wide ('];
    for (let i = 0; i < MAX_COLUMNS + 5; i++) wide.push(`  col_${i} text,`);
    wide.push('  last_one text');
    wide.push(');');
    const { items, dropReasons } = parse(wide.join('\n'), {}, `a table of ${MAX_COLUMNS + 6} columns`);
    const table = entityNamed(items, 'wide');
    assert.equal(table.proposed.blocks.length, MAX_COLUMNS);
    assert.deepEqual(dropReasons, [
      `table "wide" has ${MAX_COLUMNS + 6} columns — the 6 past the first ${MAX_COLUMNS} were not proposed`,
    ]);
    assert.equal(table.proposed.summary, `A table of ${MAX_COLUMNS} columns (SQL schema).`);
  });

  test('a schema past the item cap stops there, and says how many tables were left', () => {
    const many = [];
    for (let i = 0; i < MAX_ITEMS + 4; i++) many.push(`CREATE TABLE t_${i} (id int PRIMARY KEY);`);
    const { items, dropReasons } = parse(many.join('\n'), {}, `a schema of ${MAX_ITEMS + 4} tables`);
    assert.equal(items.length, MAX_ITEMS);
    assert.deepEqual(dropReasons, [
      `item cap of ${MAX_ITEMS} reached — 4 further tables in the file were not proposed`,
    ]);
  });

  test('a duplicate table name within one file is dropped once, not proposed twice', () => {
    const sql = 'CREATE TABLE users (id int);\nCREATE TABLE users (id int, email text);';
    const { items, dropReasons } = parse(sql, {}, 'a file declaring one table twice');
    assert.equal(entities(items).length, 1);
    assert.deepEqual(dropReasons, ['duplicate table "users" within the same file']);
  });

  test('a line number names the line in the file as the user sent it', () => {
    // The route trims leading blank lines before parsing and passes on how many
    // it took, so a drop reason names the line the person sees in their editor.
    const sql = 'CREATE TABLE ok (id int);\nCREATE TABLE nope AS SELECT 1;';
    const { dropReasons } = parse(sql, { lineOffset: 3 }, 'a file the caller trimmed');
    assert.deepEqual(dropReasons, ['CREATE TABLE "nope" on line 5 was skipped — it declares no column list']);
  });
});

describe('a second import of the same schema', () => {
  test('entities of the same titles become updates targeting them', () => {
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
    assert.deepEqual(edges(second.items), [
      'Dependent:order_items → Dependency:orders',
      'Dependent:orders → Dependency:public.customers',
    ], 'the links still point at the proposals, so applying joins what already exists');
  });

  test('an update leaves out the columns the target already carries', () => {
    const orders = entityNamed(parse(FIXTURE, {}, 'fixture (for its blocks)').items, 'orders');
    const existing = [{
      _id: new mongoose.Types.ObjectId(),
      title: 'orders',
      updatedAt: new Date(),
      // Everything the dump gives it except one column, which was added since.
      blocks: orders.proposed.blocks.filter(b => b.data.label !== 'status'),
    }];
    const { items } = parse(FIXTURE, { existingEntities: existing }, 'fixture (orders already imported)');
    assert.deepEqual(entityNamed(items, 'orders').proposed.blocks, [
      { type: 'attribute', order: 0, data: { label: 'status', value: 'text NOT NULL' } },
    ], 'a re-import must not stack a second copy of every column');
  });

  test('the groups the first import created become updates to them', () => {
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
    const existing = [{ _id: new mongoose.Types.ObjectId(), title: 'order_item', updatedAt: new Date() }];
    const { items } = parse(FIXTURE, { existingEntities: existing }, 'fixture (near-miss "order_item")');
    const table = entityNamed(items, 'order_items');
    assert.equal(table.op, 'create', 'a near miss is never silently merged into the entity it resembles');
    assert.ok(table.flags.includes('duplicate_candidate'));
    assert.equal(String(table.duplicateOf), String(existing[0]._id));
  });
});
