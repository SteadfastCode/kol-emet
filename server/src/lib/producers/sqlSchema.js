/**
 * A SQL schema -> draft items. The fourth vertical-ingestion producer.
 *
 * Deterministic, exactly as the compose, OpenAPI and Kubernetes producers are
 * (lib/producers/dockerCompose.js, openApi.js, kubernetes.js): no model call,
 * so no allowance check and no generation lock, and the same file against the
 * same graph always yields the same draft — the property that makes a producer
 * safe to re-run. The output is in the shape normalizeDraft emits — server-
 * assigned localKeys, `proposed` as draftItemSchema validates it, the same
 * exact-normalized-title dedup — so the review UI, the decision routes, the
 * applier and the exporter handle a schema draft without knowing it is one.
 *
 * The one producer that needs no credential of any kind: a `.sql` dump is a
 * file the customer already has. `pg_dump --schema-only`, `mysqldump
 * --no-data`, a migration directory concatenated — all the same input.
 *
 * Mapping (Software Architecture vocabulary, config/templates.js):
 *
 *   CREATE TABLE                     -> Data Store titled the table's name, one
 *                                       `attribute` block per column
 *   a column's inline REFERENCES     -> "Depends on" (Dependent, Dependency)
 *   a table-level FOREIGN KEY        -> the same, one edge per constraint
 *                                       however many columns it spans
 *   ALTER TABLE … ADD CONSTRAINT …
 *     FOREIGN KEY … REFERENCES       -> the same; this is the spelling pg_dump
 *                                       actually emits, so a dump whose foreign
 *                                       keys are all in trailing ALTERs still
 *                                       maps its edges
 *   ALTER TABLE … ADD CONSTRAINT …
 *     PRIMARY KEY / UNIQUE           -> the marker on each column it names, as
 *                                       the inline form gets; pg_dump emits
 *                                       these as trailing ALTERs too, and
 *                                       nothing else in a dump declares them
 *
 * A statement this file cannot read — an unclosed column list, a `CREATE TABLE
 * … AS SELECT` that declares no columns — is a **drop reason** surfaced in the
 * review UI, not a refusal of the file, exactly as an unreadable `kind` is in
 * the manifest producer. A file with no readable `CREATE TABLE` at all is the
 * refusal: there is nothing in it this producer can map. Everything that is
 * neither a CREATE TABLE nor an ALTER TABLE … ADD CONSTRAINT is passed over in
 * silence — a dump is mostly `SET`, `CREATE INDEX`, `COMMENT ON` and (with
 * data) thousands of INSERTs, and a drop reason each would bury the ones that
 * matter.
 *
 * Why a tokenizer and not a regex: the things that make a real dump hard are
 * all lexical. A `--` or `#` comment, or a `/* … *\/` one, can hold the word
 * REFERENCES; an identifier can be quoted `"like this"`, `` `like this` `` or
 * `[like this]` and so can carry a comma, a semicolon or a bracket; a string
 * literal can hold any of them too; and a Postgres function body is delimited
 * by `$$ … $$` and routinely contains semicolons, which a split on `;` would
 * tear into nonsense. So the file is lexed once — comments dropped, strings and
 * quoted identifiers each one token, every token carrying its source offsets —
 * and the statements are read off that token stream.
 *
 * Every item's evidence quote is the source line that produced it, with offsets
 * into the source text, so the review UI can say where each proposal came from.
 */

import { normalizeTitle, nearestTitle } from '../similarity.js';
import { DUPLICATE_THRESHOLD, MAX_ITEMS, relationshipGroupMatcher, relationshipTarget } from '../draftNormalizer.js';
import { withoutKnownBlocks } from './dockerCompose.js';

export const PRODUCER = 'sql-schema';
export const PRODUCER_VERSION = 'sql-schema@1';

/** Every table is a Data Store. The only entity type this producer proposes. */
export const DATA_STORE = 'Data Store';

const TAG = 'sql-schema';

/**
 * No model reads this text, so the limit is not a cost one: it keeps the
 * request under express.json's 100KB body cap once JSON-escaped, and a draft
 * reviewable by a person. The same cap the other three producers carry.
 */
export const MAX_SQL_CHARS = 60_000;

/** As in the sibling producers: the reasons are capped, the count is not. */
export const MAX_DROP_REASONS = 50;

/**
 * Columns proposed per table, as `attribute` blocks. A wide reporting table can
 * carry hundreds of columns, and a draft nobody can read through is a draft
 * nobody reviews — the same reason the OpenAPI producer caps an API's operation
 * list. What is left out is said out loud as a drop reason, per table.
 */
export const MAX_COLUMNS = 80;

/** A file that could not be read as a SQL schema. `line` is 1-based, or null. */
export class SqlParseError extends Error {
  constructor(message, line = null) {
    super(message);
    this.name = 'SqlParseError';
    this.line = line;
  }
}

// ─── lexer ───────────────────────────────────────────────────────────────────

/** Opening identifier quote -> its closing one. `[` is SQL Server's. */
const IDENT_CLOSE = { '"': '"', '`': '`', '[': ']' };

const isWordChar = ch => ch !== undefined && /[A-Za-z0-9_$\]]/.test(ch);

/**
 * `{ tokens, unterminated }` for `text`.
 *
 * Comments are dropped. A string, a dollar-quoted string and a quoted
 * identifier are each one token; an identifier token's `value` is its content
 * with the quotes off and any doubled quote collapsed, so `"user ""x"""` is the
 * identifier `user "x"` and compares equal to the same name written elsewhere.
 * Every token carries `offset` and `end` into the source, which is what lets
 * the parser quote a line and name a line number without re-scanning.
 *
 * `unterminated` names each construct that runs off the end of the file — an
 * unclosed `/*`, quote or `$$` swallows everything after it, so the parser
 * reports it rather than silently reading half a schema.
 */
export function tokenize(text) {
  const source = String(text ?? '');
  const n = source.length;
  const tokens = [];
  const unterminated = [];
  let i = 0;

  const push = (type, value, offset, end) => tokens.push({ type, value, upper: type === 'word' ? value.toUpperCase() : '', offset, end });

  while (i < n) {
    const ch = source[i];

    // ── comments ───────────────────────────────────────────────────────────
    if ((ch === '-' && source[i + 1] === '-') || ch === '#') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close === -1) { unterminated.push({ what: 'block comment', offset: i }); i = n; continue; }
      i = close + 2;
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }

    // ── string literal ─────────────────────────────────────────────────────
    if (ch === "'") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        // MySQL's backslash escape. Harmless in Postgres, where a backslash in
        // a standard-conforming string is just a backslash: skipping two
        // characters can only skip over a non-quote, and `\''` would be an
        // unterminated string in either dialect anyway.
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === "'") {
          if (source[j + 1] === "'") { j += 2; continue; }
          closed = true; j++; break;
        }
        j++;
      }
      if (!closed) { unterminated.push({ what: 'string', offset: i }); i = n; continue; }
      push('string', source.slice(i, j), i, j);
      i = j;
      continue;
    }

    // ── dollar-quoted string (Postgres function bodies) ────────────────────
    if (ch === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(source.slice(i, i + 70));
      if (tag) {
        const close = source.indexOf(tag[0], i + tag[0].length);
        if (close === -1) { unterminated.push({ what: 'dollar-quoted string', offset: i }); i = n; continue; }
        const end = close + tag[0].length;
        push('string', source.slice(i, end), i, end);
        i = end;
        continue;
      }
    }

    // ── quoted identifier ──────────────────────────────────────────────────
    // `[` opens one only where an identifier can start: glued to the right of a
    // word it is Postgres' array suffix (`integer[]`), not a name.
    const close = ch === '[' && isWordChar(source[i - 1]) ? undefined : IDENT_CLOSE[ch];
    if (close) {
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < n) {
        if (source[j] === close) {
          // A doubled closing quote is one literal character of the name. Not
          // true of `]`, which SQL Server escapes as `]]` — same rule, and
          // treating it so costs nothing for the quotes that do not double.
          if (source[j + 1] === close) { value += close; j += 2; continue; }
          closed = true; j++; break;
        }
        value += source[j];
        j++;
      }
      if (!closed) { unterminated.push({ what: 'quoted identifier', offset: i }); i = n; continue; }
      push('ident', value, i, j);
      i = j;
      continue;
    }

    // ── word ───────────────────────────────────────────────────────────────
    if (/[A-Za-z_@]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$@#]/.test(source[j])) j++;
      push('word', source.slice(i, j), i, j);
      i = j;
      continue;
    }

    // ── number ─────────────────────────────────────────────────────────────
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(source[j])) j++;
      push('number', source.slice(i, j), i, j);
      i = j;
      continue;
    }

    push('punct', ch, i, i + 1);
    i++;
  }

  return { tokens, unterminated };
}

/**
 * The token stream cut into statements on a top-level `;`.
 *
 * Depth is tracked so a `;` inside parentheses cannot end a statement; a `;`
 * inside a string or a `$$` body cannot either, because the lexer already made
 * each of those one token.
 */
function statements(tokens) {
  const out = [];
  let current = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.type === 'punct') {
      if (t.value === '(') depth++;
      else if (t.value === ')') depth = Math.max(0, depth - 1);
      else if (t.value === ';' && depth === 0) {
        if (current.length) out.push(current);
        current = [];
        continue;
      }
    }
    current.push(t);
  }
  if (current.length) out.push(current);
  return out;
}

// ─── grammar helpers ─────────────────────────────────────────────────────────

const isWord = (t, w) => Boolean(t) && t.type === 'word' && t.upper === w;
const isPunct = (t, p) => Boolean(t) && t.type === 'punct' && t.value === p;
const isName = t => Boolean(t) && (t.type === 'ident' || t.type === 'word');
const collapse = s => String(s).replace(/\s+/g, ' ').trim();

/** Words between CREATE and TABLE that do not change the reading. */
const CREATE_MODIFIERS = new Set(['OR', 'REPLACE', 'GLOBAL', 'LOCAL', 'TEMP', 'TEMPORARY', 'UNLOGGED', 'FOREIGN', 'EXTERNAL', 'VIRTUAL']);

/** Words that end a column's type and begin its constraints. */
const COLUMN_CONSTRAINTS = new Set([
  'NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'CONSTRAINT',
  'GENERATED', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'IDENTITY', 'COLLATE', 'COMMENT',
  'ON', 'AS', 'STORAGE', 'DEFERRABLE', 'VISIBLE', 'INVISIBLE', 'ENFORCED', 'ENCODE',
]);

/**
 * Words that open a table-level constraint rather than a column.
 *
 * Postgres and MySQL both reserve CONSTRAINT, PRIMARY, UNIQUE, FOREIGN, CHECK
 * and LIKE, so an unquoted one of those cannot be a column's name and the bare
 * word is enough to read it as a constraint. EXCLUDE, FULLTEXT, SPATIAL and
 * PERIOD are reserved in neither, so a bare word there is just as likely a
 * column called `period` or `exclude` — those go through CONSTRAINT_SHAPES,
 * which wants the constraint's own shape before it claims the definition.
 */
const TABLE_CONSTRAINTS = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'EXCLUDE', 'FULLTEXT', 'SPATIAL', 'PERIOD', 'LIKE']);

/**
 * Type words, used for one thing only: telling an index declaration
 * (`KEY idx_user (user_id)`, `FULLTEXT KEY ft_body (body)`) from a column that
 * happens to be called `key`, `index`, `fulltext` or `spatial`
 * (`key VARCHAR(50)`). Both are a word, a word and a `(`.
 */
const TYPE_WORDS = new Set([
  'VARCHAR', 'VARCHAR2', 'NVARCHAR', 'CHAR', 'NCHAR', 'CHARACTER', 'TEXT', 'TINYTEXT', 'MEDIUMTEXT',
  'LONGTEXT', 'CLOB', 'INT', 'INT2', 'INT4', 'INT8', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT',
  'MEDIUMINT', 'DECIMAL', 'NUMERIC', 'NUMBER', 'FLOAT', 'DOUBLE', 'REAL', 'MONEY', 'BIT', 'BOOL',
  'BOOLEAN', 'DATE', 'DATETIME', 'DATETIME2', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'YEAR', 'INTERVAL',
  'BLOB', 'TINYBLOB', 'MEDIUMBLOB', 'LONGBLOB', 'BYTEA', 'BINARY', 'VARBINARY', 'JSON', 'JSONB',
  'XML', 'UUID', 'SERIAL', 'BIGSERIAL', 'SMALLSERIAL', 'ENUM', 'SET', 'GEOMETRY', 'POINT', 'ARRAY',
  'CITEXT', 'HSTORE', 'INET', 'CIDR', 'MACADDR', 'TSVECTOR',
]);

/** `{ schema, name }` for the dotted parts of a name; a database qualifier is dropped. */
const qualify = parts => ({
  schema: parts.length > 1 ? parts[parts.length - 2] : null,
  name: parts[parts.length - 1],
});

/** A possibly-qualified name at `i`: `{ parts, next }`, `parts` empty when there is none. */
function readName(tokens, i) {
  const parts = [];
  while (i < tokens.length && isName(tokens[i])) {
    parts.push(tokens[i].value);
    i++;
    if (isPunct(tokens[i], '.')) { i++; continue; }
    break;
  }
  return { parts, next: i };
}

/** The index of the `)` closing the `(` at `open`, or -1 when it is not closed. */
function closingParen(tokens, open, to) {
  if (!isPunct(tokens[open], '(')) return -1;
  let depth = 0;
  for (let i = open; i < to; i++) {
    if (isPunct(tokens[i], '(')) depth++;
    else if (isPunct(tokens[i], ')') && --depth === 0) return i;
  }
  return -1;
}

/** `[from, to)` cut into ranges on commas at depth 0. */
function splitTop(tokens, from, to) {
  const out = [];
  let start = from;
  let depth = 0;
  for (let i = from; i < to; i++) {
    if (isPunct(tokens[i], '(')) depth++;
    else if (isPunct(tokens[i], ')')) depth--;
    else if (isPunct(tokens[i], ',') && depth === 0) { out.push([start, i]); start = i + 1; }
  }
  if (start < to) out.push([start, to]);
  return out;
}

/** The column names of a `( a, b )` list at `i`, lower-cased; null when there is no list. */
function readColumnList(tokens, i, to) {
  const close = closingParen(tokens, i, to);
  if (close === -1) return null;
  const names = [];
  for (const [from] of splitTop(tokens, i + 1, close)) {
    if (isName(tokens[from])) names.push(tokens[from].value.toLowerCase());
  }
  return names;
}

/** Whether `t` is a type word rather than a name — the VARCHAR of `key VARCHAR(50)`. */
const isTypeWord = t => Boolean(t) && t.type === 'word' && TYPE_WORDS.has(t.upper);

/**
 * An inline index declaration at `from`: a keyword, an optional `KEY`/`INDEX`,
 * an optional index name and then the `(` of its column list — `KEY (col)`,
 * `KEY idx_user (user_id)`, `FULLTEXT KEY ft_body (body)`, `SPATIAL (geom)`.
 *
 * The index name must not be a type word, because that is the only thing
 * telling `KEY idx_user (user_id)` from a column called `key VARCHAR(50)`:
 * both are a word, a word and a `(`.
 */
function looksLikeIndex(tokens, from, to) {
  let i = from + 1;
  if (isWord(tokens[i], 'KEY') || isWord(tokens[i], 'INDEX')) i++;
  if (isPunct(tokens[i], '(') && i < to) return true;
  if (!isName(tokens[i]) || isTypeWord(tokens[i])) return false;
  return isPunct(tokens[i + 1], '(') && i + 1 < to;
}

/**
 * What a table-level constraint looks like, for the keywords no dialect here
 * reserves — so a bare one of them could equally be a column's name. Without
 * this a column called `period`, `exclude`, `fulltext`, `spatial`, `key` or
 * `index` is taken for a constraint and then vanishes, because
 * readTableConstraint has no reading for any of these to return.
 */
const CONSTRAINT_SHAPES = new Map([
  // MariaDB/SQL:2011 periods: `PERIOD FOR SYSTEM_TIME (start, end)`.
  ['PERIOD', (tokens, from) => isWord(tokens[from + 1], 'FOR')],
  // Postgres: `EXCLUDE (c WITH =)`, or `EXCLUDE USING gist (c WITH &&)`.
  ['EXCLUDE', (tokens, from) => isPunct(tokens[from + 1], '(') || isWord(tokens[from + 1], 'USING')],
  // MySQL's index forms, each of them a word, an optional name and a `(`.
  ['FULLTEXT', looksLikeIndex],
  ['SPATIAL', looksLikeIndex],
  ['KEY', looksLikeIndex],
  ['INDEX', looksLikeIndex],
]);

/** Whether `[from, to)` is a table-level constraint rather than a column definition. */
function looksLikeTableConstraint(tokens, from, to) {
  const t = tokens[from];
  if (!t || t.type !== 'word') return false;          // a quoted name is always a column
  const shape = CONSTRAINT_SHAPES.get(t.upper);
  if (shape) return shape(tokens, from, to);          // not reserved: it has to look like one
  return TABLE_CONSTRAINTS.has(t.upper);
}

/**
 * One column definition, or null when `[from, to)` does not start with a name.
 *
 * The type is taken from the source rather than rebuilt from tokens, so
 * `character varying(255)`, `TIMESTAMP WITH TIME ZONE` and `ENUM('a','b')` all
 * read back as the dump wrote them — only whitespace is normalised, which is
 * what keeps a re-import of the same file proposing the same attribute value.
 */
function readColumn(tokens, from, to, source) {
  const nameTok = tokens[from];
  if (!isName(nameTok)) return null;

  let i = from + 1;
  let depth = 0;
  let typeLast = -1;
  while (i < to) {
    const t = tokens[i];
    if (depth === 0 && t.type === 'word' &&
      (COLUMN_CONSTRAINTS.has(t.upper) || (t.upper === 'CHARACTER' && isWord(tokens[i + 1], 'SET')))) break;
    if (isPunct(t, '(')) depth++;
    else if (isPunct(t, ')')) depth--;
    typeLast = i;
    i++;
  }
  const type = typeLast >= 0 ? collapse(source.slice(tokens[from + 1].offset, tokens[typeLast].end)) : '';

  let primary = false, unique = false, notNull = false, ref = null;
  for (let j = i, d = 0; j < to; j++) {
    const t = tokens[j];
    if (isPunct(t, '(')) { d++; continue; }
    if (isPunct(t, ')')) { d--; continue; }
    if (d !== 0 || t.type !== 'word') continue;
    if (t.upper === 'PRIMARY' && isWord(tokens[j + 1], 'KEY')) primary = true;
    else if (t.upper === 'UNIQUE') unique = true;
    else if (t.upper === 'NOT' && isWord(tokens[j + 1], 'NULL')) notNull = true;
    else if (t.upper === 'REFERENCES' && !ref) {
      const { parts } = readName(tokens, j + 1);
      if (parts.length) ref = { ...qualify(parts), offset: t.offset };
    }
  }

  return { name: nameTok.value, type, primary, unique, notNull, ref, offset: nameTok.offset };
}

/**
 * One table-level constraint: `{ kind: 'primary'|'unique', columns }`, or
 * `{ kind: 'foreign', ref, offset }`. Null for a CHECK, an index, an EXCLUDE —
 * anything with no reading here.
 */
function readTableConstraint(tokens, from, to) {
  let i = from;
  if (isWord(tokens[i], 'CONSTRAINT')) {
    i++;
    // The constraint's own name, when it has one. A bare `CONSTRAINT PRIMARY
    // KEY (…)` is legal, so a keyword here is not a name.
    if (isName(tokens[i]) && !(tokens[i].type === 'word' && TABLE_CONSTRAINTS.has(tokens[i].upper))) i++;
  }
  const t = tokens[i];
  if (!t || t.type !== 'word') return null;

  if (t.upper === 'PRIMARY' && isWord(tokens[i + 1], 'KEY')) {
    const columns = readColumnList(tokens, i + 2, to);
    return columns ? { kind: 'primary', columns } : null;
  }
  if (t.upper === 'UNIQUE') {
    let k = i + 1;
    if (isWord(tokens[k], 'KEY') || isWord(tokens[k], 'INDEX')) k++;
    if (isName(tokens[k])) k++;                      // MySQL's index name
    const columns = readColumnList(tokens, k, to);
    return columns ? { kind: 'unique', columns } : null;
  }
  if (t.upper === 'FOREIGN' && isWord(tokens[i + 1], 'KEY')) {
    const close = closingParen(tokens, i + 2, to);
    if (close === -1) return null;
    if (!isWord(tokens[close + 1], 'REFERENCES')) return null;
    const { parts } = readName(tokens, close + 2);
    if (!parts.length) return null;
    // One edge per constraint, whatever its arity: a two-column foreign key is
    // one dependency on one table, not two.
    return { kind: 'foreign', ref: { ...qualify(parts), offset: t.offset }, offset: t.offset };
  }
  return null;
}

/** `CREATE [modifiers] TABLE [IF NOT EXISTS] name` at the head of a statement. */
function readCreateTable(stmt) {
  if (!isWord(stmt[0], 'CREATE')) return null;
  let i = 1;
  while (stmt[i]?.type === 'word' && CREATE_MODIFIERS.has(stmt[i].upper)) i++;
  if (!isWord(stmt[i], 'TABLE')) return null;
  i++;
  if (isWord(stmt[i], 'IF') && isWord(stmt[i + 1], 'NOT') && isWord(stmt[i + 2], 'EXISTS')) i += 3;
  const { parts, next } = readName(stmt, i);
  return { parts, next, offset: stmt[0].offset };
}

/**
 * `ALTER TABLE [ONLY] [IF EXISTS] name ADD [CONSTRAINT c] …`, as
 * `{ parts, refs, keys }`: the foreign keys it adds, and the primary-key and
 * unique constraints it adds.
 *
 * This is the shape that matters most in practice: `pg_dump` writes no inline
 * key of any kind. Every foreign key, every primary key and every unique
 * constraint it emits is a trailing ALTER against the table — `ALTER TABLE ONLY
 * public.customers ADD CONSTRAINT customers_pkey PRIMARY KEY (id);` — so a
 * reading that mined these for FOREIGN KEY alone proposed every column of a
 * Postgres dump unmarked, with no `PRIMARY KEY` or `UNIQUE` on any of them.
 *
 * The statement is cut into its actions on top-level commas, so a MySQL `ALTER
 * TABLE x ADD CONSTRAINT … , ADD CONSTRAINT …` with several constraints in one
 * statement yields all of them, and each action is read from its first `ADD`
 * — which is what lets SQL Server's `ALTER TABLE x WITH CHECK ADD CONSTRAINT
 * …` read, and what keeps `ADD COLUMN flag boolean PRIMARY KEY` (a column, not
 * a table constraint) and `ALTER COLUMN id SET NOT NULL` from being mined for
 * keys at all.
 */
function readAlterTableConstraints(stmt) {
  if (!isWord(stmt[0], 'ALTER') || !isWord(stmt[1], 'TABLE')) return null;
  let i = 2;
  while (isWord(stmt[i], 'ONLY') || isWord(stmt[i], 'IF') || isWord(stmt[i], 'EXISTS')) i++;
  const { parts, next } = readName(stmt, i);
  if (!parts.length) return null;
  const refs = [];
  const keys = [];
  for (const [from, to] of splitTop(stmt, next, stmt.length)) {
    for (let k = from, depth = 0; k < to; k++) {
      if (isPunct(stmt[k], '(')) { depth++; continue; }
      if (isPunct(stmt[k], ')')) { depth--; continue; }
      if (depth !== 0 || !isWord(stmt[k], 'ADD')) continue;
      const constraint = readTableConstraint(stmt, k + 1, to);
      if (constraint?.kind === 'foreign') refs.push(constraint);
      else if (constraint) keys.push(constraint);
      break;                                         // one constraint per action
    }
  }
  return { parts, refs, keys };
}

// ─── parse ───────────────────────────────────────────────────────────────────

/**
 * @param {string} text  the SQL schema
 * @param {object} opts
 * @param {object[]} [opts.existingEntities]  [{ _id, title, updatedAt, blocks? }] — the workspace's
 *   graph. `blocks`, when present, lets an update skip attributes the entity already has.
 * @param {object[]} [opts.existingGroups]  [{ _id, label, members: [{ refId, label }] }] — the
 *   workspace's relationship groups, so a re-import updates the links it created last time rather
 *   than stacking a second copy of each (draftNormalizer.relationshipGroupMatcher)
 * @param {number} [opts.lineOffset]  added to every line number this names, for a caller that
 *   trimmed leading blank lines off the file before passing it in
 * @returns {{ items: object[], dropReasons: string[], dropped: number }}  `dropped` counts every
 *   drop, the ones past MAX_DROP_REASONS that are not listed included
 * @throws {SqlParseError}  when the file holds no readable `CREATE TABLE`
 */
export function parseSqlSchema(text, { existingEntities = [], existingGroups = [], lineOffset = 0 } = {}) {
  const source = String(text ?? '');

  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
  /** The 1-based index into `lineStarts` of the line holding `offset`. */
  const lineIndex = offset => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const lineAt = offset => (typeof offset === 'number' ? lineIndex(offset) + lineOffset : null);

  /** The whole source line holding `offset`, trimmed, with its span. */
  const evidenceAt = offset => {
    if (typeof offset !== 'number') return { quote: '', charStart: null, charEnd: null, chunkIndex: 0 };
    const line = lineIndex(offset);
    let start = lineStarts[line - 1] ?? 0;
    const next = lineStarts[line];
    let end = next === undefined ? source.length : next - 1;
    while (start < end && /\s/.test(source[start])) start++;
    while (end > start && /\s/.test(source[end - 1])) end--;
    return { quote: source.slice(start, end), charStart: start, charEnd: end, chunkIndex: 0 };
  };

  const dropReasons = [];
  let dropped = 0;
  const drop = reason => {
    dropped++;
    if (dropReasons.length < MAX_DROP_REASONS) dropReasons.push(reason);
  };

  const { tokens, unterminated } = tokenize(source);
  for (const u of unterminated) {
    drop(`unterminated ${u.what} on line ${lineAt(u.offset)} — nothing after it was read`);
  }

  // ── pass 1: read every statement ───────────────────────────────────────────
  const tables = [];        // { schema, name, columns, byLowerName, offset, title }
  const rawEdges = [];      // { from: {schema,name}, ref: {schema,name}, offset }
  const rawKeys = [];       // { from: {schema,name}, kind: 'primary'|'unique', columns }

  for (const stmt of statements(tokens)) {
    const created = readCreateTable(stmt);
    if (created) {
      const at = `line ${lineAt(created.offset)}`;
      if (!created.parts.length) { drop(`a CREATE TABLE on ${at} was skipped — its table name could not be read`); continue; }
      const { schema, name } = qualify(created.parts);
      const label = created.parts.join('.');
      if (!isPunct(stmt[created.next], '(')) {
        // `CREATE TABLE … AS SELECT`, `… LIKE other`, `… PARTITION OF parent`:
        // a table whose columns are somewhere else. There is nothing to read
        // here, and refusing the file over it would cost every other table.
        drop(`CREATE TABLE "${label}" on ${at} was skipped — it declares no column list`);
        continue;
      }
      const close = closingParen(stmt, created.next, stmt.length);
      if (close === -1) { drop(`CREATE TABLE "${label}" on ${at} was skipped — its column list is not closed`); continue; }

      const columns = [];
      const byLowerName = new Map();
      const foreignKeys = [];
      for (const [from, to] of splitTop(stmt, created.next + 1, close)) {
        if (from >= to) continue;
        if (looksLikeTableConstraint(stmt, from, to)) {
          const constraint = readTableConstraint(stmt, from, to);
          if (!constraint) continue;
          if (constraint.kind === 'foreign') { foreignKeys.push(constraint); continue; }
          // A composite key is a property of the table, so each of its columns
          // is marked as being PART of one rather than as being one.
          const kind = constraint.columns.length > 1 ? 'composite' : 'single';
          for (const columnName of constraint.columns) {
            const column = byLowerName.get(columnName);
            if (!column) continue;
            if (constraint.kind === 'primary') column.primaryKind ??= kind;
            else column.uniqueKind ??= kind;
          }
          continue;
        }
        const column = readColumn(stmt, from, to, source);
        if (!column) continue;
        if (column.primary) column.primaryKind = 'single';
        if (column.unique) column.uniqueKind = 'single';
        columns.push(column);
        if (!byLowerName.has(column.name.toLowerCase())) byLowerName.set(column.name.toLowerCase(), column);
        if (column.ref) foreignKeys.push({ ref: column.ref, offset: column.ref.offset });
      }

      tables.push({ schema, name, columns, byLowerName, offset: created.offset });
      for (const fk of foreignKeys) rawEdges.push({ from: { schema, name }, ref: fk.ref, offset: fk.offset });
      continue;
    }

    const altered = readAlterTableConstraints(stmt);
    if (altered) {
      const from = qualify(altered.parts);
      for (const fk of altered.refs) rawEdges.push({ from, ref: fk.ref, offset: fk.offset });
      // Not applied here: an ALTER names a table the file may not have read
      // yet, so the keys wait until every CREATE TABLE is in.
      for (const key of altered.keys) rawKeys.push({ from, kind: key.kind, columns: key.columns });
    }
    // Anything else — SET, CREATE INDEX, CREATE FUNCTION, COMMENT ON, INSERT —
    // is passed over in silence. See the header.
  }

  if (!tables.length) {
    // The one refusal. A file of INSERTs, a migration that only alters tables,
    // a file of queries: nothing this producer can map. The first drop reason
    // rides along, so a file whose only CREATE TABLE was unreadable says why.
    const detail = dropReasons.length ? ` ${dropReasons[0]}.` : '';
    throw new SqlParseError(
      'Not a SQL schema — no readable `CREATE TABLE` statement was found. This producer reads a ' +
      `schema dump: the DDL, as \`pg_dump --schema-only\` or \`mysqldump --no-data\` writes it.${detail}`
    );
  }

  // ── titles ─────────────────────────────────────────────────────────────────
  // A bare name is the title, because that is what a person calls the table.
  // It is qualified only when the file declares the same name under more than
  // one schema — a `public.users` beside an `audit.users` — so a multi-schema
  // dump proposes both rather than the second being dropped as a duplicate of
  // the first. The same rule the manifest producer uses for namespaces.
  const sharedNames = new Map();
  for (const t of tables) sharedNames.set(t.name.toLowerCase(), (sharedNames.get(t.name.toLowerCase()) ?? 0) + 1);
  for (const t of tables) {
    t.title = sharedNames.get(t.name.toLowerCase()) > 1 && t.schema ? `${t.schema}.${t.name}` : t.name;
  }

  const byKey = new Map();        // "schema.name", lower-cased -> table
  const byBareName = new Map();   // "name" -> [table, …]
  for (const t of tables) {
    const key = `${(t.schema ?? '').toLowerCase()}.${t.name.toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, t);
    const bare = t.name.toLowerCase();
    if (!byBareName.has(bare)) byBareName.set(bare, []);
    byBareName.get(bare).push(t);
  }

  /**
   * What a foreign key's target names in this file. Four readings, in order:
   * the exact `schema.name`; a reference with a schema the file does not
   * declare, falling back to the one table of that name there is; a bare name
   * in the referencing table's OWN schema, where SQL's search path looks first;
   * and a bare name that is unique in the file. A bare name the file declares
   * in several schemas, none of them the referencing table's, names no one
   * thing — it reports the candidates rather than picking one.
   */
  const resolveTable = (ref, fromSchema) => {
    const bare = byBareName.get(ref.name.toLowerCase()) ?? [];
    if (ref.schema) {
      const exact = byKey.get(`${ref.schema.toLowerCase()}.${ref.name.toLowerCase()}`);
      if (exact) return { table: exact };
      return bare.length === 1 ? { table: bare[0] } : { ambiguousIn: schemasOf(bare) };
    }
    if (!bare.length) return {};
    const own = bare.find(t => (t.schema ?? '').toLowerCase() === (fromSchema ?? '').toLowerCase());
    if (own) return { table: own };
    if (bare.length === 1) return { table: bare[0] };
    return { ambiguousIn: schemasOf(bare) };
  };
  const schemasOf = list => [...new Set(list.map(t => t.schema ?? '(no schema)'))].sort();

  // ── pass 2: the keys a trailing ALTER declares ─────────────────────────────
  // Marked exactly as the inline table-level form is, by the same rule: a
  // column that is one of two in a key is marked as being PART of one. Done
  // after pass 1 rather than in it, because pg_dump emits every one of these
  // after the whole file's CREATE TABLEs — statement order cannot matter.
  //
  // A constraint naming a table this file does not declare, or a column that
  // table does not have, is passed over in silence: there is no proposal for
  // it to mark, so a drop reason would name something the draft never had.
  for (const raw of rawKeys) {
    const table = resolveTable(raw.from, raw.from.schema).table;
    if (!table) continue;
    const kind = raw.columns.length > 1 ? 'composite' : 'single';
    for (const columnName of raw.columns) {
      const column = table.byLowerName.get(columnName);
      if (!column) continue;
      // An inline declaration wins: it was read first, and says the same thing.
      if (raw.kind === 'primary') column.primaryKind ??= kind;
      else column.uniqueKind ??= kind;
    }
  }

  // ── pass 3: edges ──────────────────────────────────────────────────────────
  const edges = [];
  const edgeKeys = new Set();
  const DEPENDS = ['Dependent', 'Dependency'];
  for (const raw of rawEdges) {
    const fromTable = resolveTable(raw.from, raw.from.schema).table;
    // A foreign key on a table this file does not declare — a trailing ALTER
    // against a table defined in another dump — can still land on an entity the
    // workspace already has, so the name is carried through as written.
    const fromTitle = fromTable?.title ?? [raw.from.schema, raw.from.name].filter(Boolean).join('.');
    const target = resolveTable(raw.ref, raw.from.schema);
    if (!target.table && target.ambiguousIn?.length) {
      drop(`a foreign key on "${fromTitle}" names table "${raw.ref.name}", which this file declares in ` +
        `${target.ambiguousIn.map(s => `\`${s}\``).join(' and ')} — nothing was proposed for it`);
      continue;
    }
    const toTitle = target.table?.title ?? [raw.ref.schema, raw.ref.name].filter(Boolean).join('.');
    const key = `${fromTitle}\u0000${toTitle}`;
    // One edge per pair of tables, however many foreign keys join them: the
    // graph says "orders depends on users" once.
    if (fromTitle === toTitle || edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({ label: 'Depends on', roles: DEPENDS, from: fromTitle, to: toTitle, offset: raw.offset });
  }

  // ── entity items ───────────────────────────────────────────────────────────
  const existingByKey = new Map(existingEntities.map(e => [normalizeTitle(e.title), e]));
  // Built once for the whole file rather than per proposed entity: the
  // near-miss scan is every proposal against every entity in the workspace.
  const nearest = nearestTitle(existingEntities);

  const items = [];
  const titleToLocal = new Map();   // exact title -> localKey
  const keyToLocal = new Map();     // normalized title -> localKey
  const localToTarget = new Map();  // localKey -> the entity id an update item targets
  const matchGroup = relationshipGroupMatcher(existingGroups);
  let e = 0;

  for (let i = 0; i < tables.length; i++) {
    // The same cap normalizeDraft and the other three producers put on a draft,
    // for the same two reasons: a draft has to be reviewable by a person, and
    // everything below this line — the near-miss scan above all — is work per item.
    if (items.length >= MAX_ITEMS) {
      drop(`item cap of ${MAX_ITEMS} reached — ${tables.length - i} further tables in the file were not proposed`);
      break;
    }
    const table = tables[i];
    const key = normalizeTitle(table.title);
    if (!key) { drop(`table "${table.title}" has no usable title`); continue; }
    if (keyToLocal.has(key)) {
      // A dump that declares the same table twice, and also `order_items` vs.
      // `order items`: normalizeTitle makes those one title.
      titleToLocal.set(table.title, keyToLocal.get(key));
      drop(`duplicate table "${table.title}" within the same file`);
      continue;
    }

    const blocks = [];
    if (table.schema) blocks.push({ type: 'attribute', order: blocks.length, data: { label: 'Schema', value: table.schema } });
    for (const column of table.columns.slice(0, MAX_COLUMNS)) {
      blocks.push({ type: 'attribute', order: blocks.length, data: { label: column.name, value: columnValue(column) } });
    }
    if (table.columns.length > MAX_COLUMNS) {
      drop(`table "${table.title}" has ${table.columns.length} columns — the ${table.columns.length - MAX_COLUMNS} past the first ${MAX_COLUMNS} were not proposed`);
    }

    const localKey = `e${++e}`;
    const existing = existingByKey.get(key);
    let op = 'create', targetEntityId = null, baseUpdatedAt = null, matchedBy = 'none';
    let proposedBlocks = blocks;
    if (existing) {
      op = 'update';
      targetEntityId = existing._id;
      baseUpdatedAt = existing.updatedAt ?? null;
      matchedBy = 'exact-normalized-title';
      if (Array.isArray(existing.blocks)) proposedBlocks = withoutKnownBlocks(blocks, existing.blocks);
    }

    const flags = [];
    let duplicateOf = null, duplicateScore = null;
    if (!existing) {
      const { match, score } = nearest(key);
      if (match && score >= DUPLICATE_THRESHOLD) {
        duplicateOf = match._id;
        duplicateScore = Number(score.toFixed(3));
        flags.push('duplicate_candidate');
      }
    }

    keyToLocal.set(key, localKey);
    titleToLocal.set(table.title, localKey);
    if (targetEntityId) localToTarget.set(localKey, targetEntityId);

    const columnCount = Math.min(table.columns.length, MAX_COLUMNS);
    items.push({
      localKey,
      seq: items.length,
      kind: 'entity',
      op,
      input: { evidence: evidenceAt(table.offset), contextEntityIds: [] },
      proposed: {
        title: table.title,
        category: DATA_STORE,
        normalizedCategory: DATA_STORE,
        summary: `A table of ${columnCount} column${columnCount === 1 ? '' : 's'}` +
          `${table.schema ? ` in schema \`${table.schema}\`` : ''} (SQL schema).`.slice(0, 400),
        tags: [TAG],
        blocks: proposedBlocks,
      },
      targetEntityId,
      baseUpdatedAt,
      matchedBy,
      duplicateOf,
      duplicateScore,
      dependsOn: [],
      flags,
    });
  }

  // ── relationship items ─────────────────────────────────────────────────────
  // A foreign key to a table this file does not declare can still land on an
  // entity the workspace already has; otherwise it is dropped, and said so.
  let r = 0;
  for (let i = 0; i < edges.length; i++) {
    if (items.length >= MAX_ITEMS) {
      drop(`item cap of ${MAX_ITEMS} reached — ${edges.length - i} further foreign keys in the file were not proposed`);
      break;
    }
    const edge = edges[i];
    const members = [];
    const dependsOn = [];
    for (const [name, role] of [[edge.from, edge.roles[0]], [edge.to, edge.roles[1]]]) {
      const local = titleToLocal.get(name) ?? keyToLocal.get(normalizeTitle(name));
      const existing = existingByKey.get(normalizeTitle(name));
      if (local) {
        members.push({ localKey: local, refId: null, refModel: 'Entity', name, label: role, notes: null });
        if (!dependsOn.includes(local)) dependsOn.push(local);
      } else if (existing) {
        members.push({ localKey: null, refId: existing._id, refModel: 'Entity', name, label: role, notes: null });
      } else {
        drop(`"${edge.label}" from ${edge.from} to "${name}" dropped — no table or entity by that name`);
      }
    }
    if (members.length < 2) continue;

    // A link the workspace already holds is an update to that group, not a
    // second copy of it — the whole point of re-running an import.
    const { op, targetGroupId, matchedBy } = relationshipTarget(matchGroup, edge.label, members, localToTarget);

    items.push({
      localKey: `r${++r}`,
      seq: items.length,
      kind: 'relationship',
      op,
      input: { evidence: evidenceAt(edge.offset), contextEntityIds: [] },
      proposed: { label: edge.label, members, targetGroupId },
      matchedBy,
      dependsOn,
      flags: [],
    });
  }

  if (dropped > dropReasons.length) dropReasons.push(`…and ${dropped - dropReasons.length} further drops, not listed`);

  return { items, dropReasons, dropped };
}

/**
 * A column's attribute value: its type, then the key markers in a fixed order
 * so the same column always renders the same string (which is what lets a
 * re-import recognise the block it wrote last time).
 *
 * A composite key says so on each of its columns — `PRIMARY KEY (composite)` —
 * because a column that is one of two in a key is not a key on its own, and a
 * reviewer who cannot tell the two apart is reading the wrong schema.
 */
function columnValue(column) {
  const marks = [];
  if (column.primaryKind) marks.push(column.primaryKind === 'composite' ? 'PRIMARY KEY (composite)' : 'PRIMARY KEY');
  if (column.notNull) marks.push('NOT NULL');
  if (column.uniqueKind) marks.push(column.uniqueKind === 'composite' ? 'UNIQUE (composite)' : 'UNIQUE');
  return [column.type, ...marks].filter(Boolean).join(' ') || '(no type declared)';
}
