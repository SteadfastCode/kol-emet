/**
 * Strips credentials out of an uploaded file BEFORE anything keeps a copy of it.
 *
 * A docker-compose file is not notes. The client sends it straight to
 * POST /drafts/compose without ever showing it in the textarea, so the person
 * importing one never sees, let alone edits, what is uploaded — and compose
 * files routinely carry POSTGRES_PASSWORD, API tokens and a DSN with its
 * password in the authority. Everything downstream of ingestion keeps text
 * forever and on purpose: Draft has no TTL because it is the training corpus,
 * the exporter allowlists `$.source.text` and every evidence quote as verbatim
 * (unpseudonymised) export paths, and the verbose log tier prints quotes.
 *
 * So the redaction happens at the seam, once: the caller redacts, then hashes,
 * parses, stores and logs the REDACTED text and nothing else. Storing the file
 * and scrubbing on the way out would put the secret in the database anyway,
 * where a backup, an export or a log line reaches it.
 *
 * Two properties the callers depend on:
 *
 *   - **Structure survives.** Replacements are spliced over value ranges only,
 *     never over a key, and they preserve the line count — so a YAML error
 *     still names the line the person sees in their editor, and evidence
 *     offsets computed against the redacted text are offsets into the text
 *     that was actually stored.
 *   - **Hosts survive.** `postgres://app:app@postgres:5432/app` becomes
 *     `postgres://REDACTED@postgres:5432/app`, not `REDACTED`. The host is the
 *     whole point of the producer — it is what makes the edge to the postgres
 *     service — and it is not the secret. Only the userinfo is.
 *
 * Deterministic, like the producer it feeds: same file in, same file out, so
 * `textHash` still means "this exact file was imported before".
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * REDACT_LOG_LEVEL = off | light | normal | verbose (default light)
 *   off     — nothing
 *   light   — one line per call: what was redacted, and by which pass
 *   normal  — light, plus the key and the rule behind each redaction
 *   verbose — normal, plus the line each one landed on
 *
 * No tier ever logs a redacted value, or the text around it. That is the point
 * of the file.
 */

import { parseDocument, visit, isScalar } from 'yaml';

/** What a redacted value is replaced with. A plain YAML scalar: no indicators. */
export const REDACTED = 'REDACTED';

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };
function log(level, msg) {
  const active = LEVELS[process.env.REDACT_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[redact:${level}] ${msg}`);
}

/**
 * Keys whose value is an address, not a credential. Checked FIRST, so
 * `DATABASE_URL`, `AUTH_ENDPOINT` and `SENTRY_DSN` keep their host and lose
 * only their userinfo — a fully redacted URL would cost the graph an edge and
 * hide nothing that the userinfo rule does not already remove. A DSN belongs
 * here for exactly that reason: the secret in one is the userinfo, or a
 * `password=` the inline rule takes, and the rest is where the service talks to.
 */
const ADDRESS_KEY_RE = /(url|uri|urls|endpoint|host|hostname|addr|address|server|origin|dsn)$/;

/**
 * Credential words that mean the same thing however the key runs into them
 * from the left, so they match glued onto a letter run: `PGPASSWORD` — libpq's
 * own variable, and the one a postgres service is most likely to be handed —
 * is a password, and so is `MYAPPTOKEN`. INLINE_ASSIGN_RE already matches this
 * way, which is why the list form `- PGPASSWORD=hunter2` was redacted while
 * the map form `PGPASSWORD: hunter2` was not; which compose syntax a file
 * happens to use must not decide whether a credential leaks.
 */
const SECRET_WORD_GLUED =
  'password|passwd|passphrase|secret|token|credentials?|authorization|apikey|certificate';

/**
 * Credential words short enough that letters to their left make an innocent
 * word out of them — byPASS, baSALT, conCERT, forBEARER — so these keep the
 * boundary on the left that the words above give up. A bare `KEY` is
 * deliberately in neither list — `PARTITION_KEY` is a column name — so it is
 * matched only behind a word that makes it a credential.
 */
const SECRET_WORD_BOUNDED = 'pass|pwd|salt|auth|bearer|cert';

/**
 * Keys whose value is a credential. Bounded on the right in both cases, so
 * `AUTHORS` and `TOKENIZER` are not credentials while `MYSQL_ROOT_PASSWORD`,
 * `JWT_SECRET` and `AWS_SECRET_ACCESS_KEY` are.
 */
const SECRET_WORD_RE = new RegExp(
  `(?:(?:${SECRET_WORD_GLUED})|(?:^|[^a-z])(?:${SECRET_WORD_BOUNDED}))(?:[^a-z]|$)`,
);
const SECRET_KEY_SUFFIX_RE = /(api|access|secret|private|public|signing|encryption|license|client|app|ssh|gpg)[_.-]?keys?([^a-z]|$)/;

/** A URL's userinfo — `user:pass@`, and also a bare `token@`, which is a credential too. */
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@"'<>]+)@/gi;

/**
 * `KEY=value` inside a single scalar. This is how compose's list form of
 * `environment` is written (`- POSTGRES_PASSWORD=hunter2`), and also how a
 * password reaches a `command:` (`--password=hunter2`) or an ODBC-style
 * connection string. The suffix group only spans separator-joined words, so
 * `TOKEN_FILE=` matches and `TOKENIZER=` does not.
 */
const INLINE_ASSIGN_RE =
  /([A-Za-z0-9_.-]*?(?:password|passwd|passphrase|pwd|secret|token|credentials?|apikey|api[_.-]key|access[_.-]key|private[_.-]key|auth[_.-]?token)(?:[_.-][A-Za-z0-9]+)*)(\s*=\s*)([^\s;&"']+)/gi;

/**
 * Values that are a credential whatever they are called: a JWT, an OpenAI or
 * GitHub or Slack token, an AWS access key id, a Google API key. High
 * confidence only — a shape that a non-secret realistically shares is worse
 * than useless here, because it redacts architecture the draft needs.
 */
const SECRET_SHAPE_RE = new RegExp([
  'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]+',   // JWT
  'sk-[A-Za-z0-9_-]{16,}',                                        // OpenAI-style
  'gh[pousr]_[A-Za-z0-9]{20,}',                                   // GitHub
  'xox[baprs]-[A-Za-z0-9-]{10,}',                                 // Slack
  'AKIA[0-9A-Z]{16}',                                             // AWS access key id
  'AIza[0-9A-Za-z_-]{30,}',                                       // Google API key
].join('|'), 'g');

/** A PEM block anywhere in a value makes the whole value a private key. */
const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

/** `|`, `>-`, `|2` … — a block scalar's header line, which must survive the splice. */
const BLOCK_HEADER_RE = /^[|>][-+]?\d*(\s+#.*)?$/;

/**
 * Whether a key's value should be redacted whole.
 * @param {string} key
 * @returns {boolean}
 */
export function looksSecret(key) {
  const k = String(key ?? '').trim().toLowerCase();
  if (!k) return false;
  if (ADDRESS_KEY_RE.test(k)) return false;
  return SECRET_WORD_RE.test(k) || SECRET_KEY_SUFFIX_RE.test(k);
}

/**
 * Redact every credential in `text`.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.label]  what the text is, for the log line only
 * @returns {{ text: string, count: number, redactions: {line: number, key: string, rule: string}[], via: string }}
 */
export function redactSecrets(text, { label = 'text' } = {}) {
  const source = String(text ?? '');
  if (!source) return { text: source, count: 0, redactions: [], via: 'empty' };

  let spans = null;
  let via = 'yaml';
  try {
    spans = astSpans(source);
  } catch (err) {
    // A throw here is a bug in this file, not in the user's file. Falling back
    // is right either way: the one thing that must not happen is the raw text
    // going through unredacted because the clever pass failed.
    log('light', `AST pass threw (source: redactSecrets on ${label}): ${err.message}`);
    spans = null;
  }
  if (spans === null) {
    via = 'lines';
    spans = lineSpans(source);
  }

  let out = applySpans(source, spans);

  // The splice must not have broken the file. If it did — a shape this file
  // does not know how to cut cleanly — fall back to the line scanner, which
  // only ever rewrites the tail of a line, and keep its result even if that
  // does not parse either. Redacted and unparseable beats parseable and leaked.
  if (via === 'yaml' && spans.length && !parses(out.text)) {
    log('light', `splice left invalid YAML (source: redactSecrets on ${label}); re-running the line scanner`);
    via = 'lines-after-splice';
    out = applySpans(source, lineSpans(source));
  }

  log('light',
    `redacted ${out.redactions.length} value${out.redactions.length === 1 ? '' : 's'} from ${label} ` +
    `(source: redactSecrets via the ${via} pass, ${source.length} chars)`);
  for (const r of out.redactions) log('normal', `  ${JSON.stringify(r.key)} redacted by the ${r.rule} rule`);
  for (const r of out.redactions) log('verbose', `  ${JSON.stringify(r.key)} on line ${r.line}`);

  return { text: out.text, count: out.redactions.length, redactions: out.redactions, via };
}

/** Whether `text` is YAML the parser accepts. */
function parses(text) {
  try {
    return parseDocument(text, { merge: true, prettyErrors: false }).errors.length === 0;
  } catch {
    return false;
  }
}

/**
 * Spans from the parsed document: precise, because it can tell a key from a
 * value and a quoted scalar from its quotes.
 *
 * @returns {object[]|null} null when the text is not parseable, so the caller
 *   falls back to the line scanner rather than passing an unredacted file on
 */
function astSpans(source) {
  const doc = parseDocument(source, { merge: true, prettyErrors: false });
  if (doc.errors.length) return null;

  const spans = [];
  const push = (start, end, replacement, key, rule) => {
    if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return;
    spans.push({ start, end, replacement, key, rule });
  };

  visit(doc, {
    Pair(_, pair) {
      if (!isScalar(pair.key) || !isScalar(pair.value)) return;
      const key = String(pair.key.value ?? '');
      const [start, end] = valueRange(pair.value, source);
      if (looksSecret(key)) {
        push(start, end, blockedReplacement(source.slice(start, end)), key, 'key');
        return;
      }
      if (typeof pair.value.value === 'string' && PEM_RE.test(pair.value.value)) {
        push(start, end, blockedReplacement(source.slice(start, end)), key, 'pem');
        return;
      }
      // Scanned here rather than in the Scalar visitor below so a log line can
      // name the key the credential sat under — DATABASE_URL, not `postgres`.
      for (const span of inlineSpans(source.slice(start, end), start, key)) spans.push(span);
    },
    // Scalars that are not a pair's value: a sequence item, which is how
    // compose's list form of `environment` writes KEY=value.
    Scalar(key, node) {
      if (key === 'key' || key === 'value' || typeof node.value !== 'string') return;
      const [start, end] = valueRange(node, source);
      for (const span of inlineSpans(source.slice(start, end), start)) spans.push(span);
    },
  });

  return spans;
}

/**
 * The source range of a scalar node, clipped to the value itself. `range[0]`
 * is the start of the token, which for `&anchor value` is the anchor — and
 * cutting an anchor out would leave every alias to it dangling.
 */
function valueRange(node, source) {
  let start = node.range?.[0];
  const end = node.range?.[1];
  if (typeof start !== 'number' || typeof end !== 'number') return [null, null];
  const raw = source.slice(start, end);
  const anchored = raw.match(/^&\S+\s+/);
  if (anchored) start += anchored[0].length;
  return [start, end];
}

/**
 * The credential spans inside one scalar's raw source, offset into the file.
 * `under` is the key the scalar hangs off, for the log line only.
 */
function inlineSpans(raw, offset, under = null) {
  const spans = [];
  for (const m of raw.matchAll(URL_USERINFO_RE)) {
    const start = offset + m.index + m[1].length;
    spans.push({ start, end: start + m[2].length, replacement: REDACTED, key: under ?? m[1].replace('://', ''), rule: 'url-userinfo' });
  }
  for (const m of raw.matchAll(INLINE_ASSIGN_RE)) {
    const start = offset + m.index + m[1].length + m[2].length;
    spans.push({ start, end: start + m[3].length, replacement: REDACTED, key: m[1], rule: 'inline-assign' });
  }
  for (const m of raw.matchAll(SECRET_SHAPE_RE)) {
    spans.push({ start: offset + m.index, end: offset + m.index + m[0].length, replacement: REDACTED, key: under ?? '(value)', rule: 'shape' });
  }
  return spans;
}

/**
 * The replacement for a whole value, preserving the line count and a block
 * scalar's header — so `PASSWORD: |` keeps its `|` and its indented body
 * becomes indented REDACTEDs rather than a scalar with orphaned lines under it.
 */
function blockedReplacement(segment) {
  const lines = segment.split('\n');
  if (lines.length === 1) return REDACTED;
  return lines
    .map((line, i) => {
      if (i === 0) return BLOCK_HEADER_RE.test(line.trim()) ? line : REDACTED;
      const indent = line.match(/^[ \t]*/)[0];
      return line.trim() ? indent + REDACTED : line;
    })
    .join('\n');
}

/**
 * Spans from a line scan, for a file the parser rejected. It never rewrites
 * anything but the tail of a single line, so it cannot make a broken file
 * worse, and it leaves a block scalar's header alone (its body is then caught
 * by the inline rules, or not at all — an unparseable file is refused anyway).
 */
function lineSpans(source) {
  const spans = [];
  let offset = 0;
  for (const line of source.split('\n')) {
    const m = line.match(/^(\s*(?:-\s+)?)(["']?)([A-Za-z0-9_.-]+)\2(\s*:\s+)(\S.*)$/);
    if (m && looksSecret(m[3]) && !BLOCK_HEADER_RE.test(m[5].trim())) {
      const start = offset + m[1].length + m[2].length * 2 + m[3].length + m[4].length;
      spans.push({ start, end: offset + line.length, replacement: REDACTED, key: m[3], rule: 'key-line' });
    } else {
      for (const span of inlineSpans(line, offset)) spans.push(span);
    }
    offset += line.length + 1;
  }
  return spans;
}

/** Splice the spans into the source, left to right, dropping any that overlap one already taken. */
function applySpans(source, spans) {
  const ordered = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const redactions = [];
  let out = '';
  let cursor = 0;
  let line = 1;
  let counted = 0;

  for (const span of ordered) {
    if (span.start < cursor) continue;                       // inside one already redacted
    if (source.slice(span.start, span.end) === span.replacement) continue;   // nothing to hide
    out += source.slice(cursor, span.start);
    out += span.replacement;
    // Line numbers are for the log alone, so they are counted forward with the
    // cursor rather than by re-slicing the file once per span.
    for (let i = counted; i < span.start; i++) if (source[i] === '\n') line++;
    counted = span.start;
    redactions.push({ line, key: span.key, rule: span.rule });
    cursor = span.end;
  }

  return { text: out + source.slice(cursor), redactions };
}
