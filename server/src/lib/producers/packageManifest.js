/**
 * A package manifest -> draft items. The fifth vertical-ingestion producer, and
 * the last of the five the roadmap names.
 *
 * Deterministic, exactly as the compose, OpenAPI, Kubernetes and SQL producers
 * are (lib/producers/dockerCompose.js, openApi.js, kubernetes.js, sqlSchema.js):
 * no model call, so no allowance check and no generation lock, and the same
 * file against the same graph always yields the same draft — the property that
 * makes a producer safe to re-run. The output is in the shape normalizeDraft
 * emits — server-assigned localKeys, `proposed` as draftItemSchema validates
 * it, the same exact-normalized-title dedup — so the review UI, the decision
 * routes, the applier and the exporter handle a manifest draft without knowing
 * it is one.
 *
 * "Point it at your repo" needs a Git credential. The part of a repo a person
 * can hand over as a FILE needs none, and that is what this reads: one
 * dependency manifest, in one of four formats —
 *
 *   package.json    npm          pyproject.toml   PyPI (PEP 621 or Poetry)
 *   go.mod          Go           Cargo.toml       crates.io
 *
 * — chosen from the file's own CONTENT rather than its name, the way the
 * OpenAPI producer chooses between OpenAPI 3.x and Swagger 2.0. A `.toml` is
 * read as a pyproject or a Cargo manifest by which tables it declares; a
 * file that is none of the four is the refusal.
 *
 * Mapping (Software Architecture vocabulary, config/templates.js):
 *
 *   the module the manifest     -> Service, with its declared name, version and
 *   declares                       runtime as attribute blocks and its own
 *                                  description as a text block
 *   each direct runtime         -> External Dependency, with its version
 *   dependency                     constraint and ecosystem as attributes
 *   each of those               -> "Depends on" (Dependent, Dependency)
 *
 * DIRECT and RUNTIME only:
 *   - a lockfile's transitive closure is hundreds of entities and would spend
 *     the whole MAX_ITEMS budget on packages nobody chose. `go.mod`'s
 *     `// indirect` requires are the one transitive set a manifest itself
 *     carries, and they go the same way;
 *   - a dev or test dependency is not part of what the module RUNS, so it is
 *     not an edge in an architecture graph. `devDependencies`, Cargo's
 *     `[dev-dependencies]` and `[build-dependencies]`, Poetry's groups and
 *     PEP 621's extras are all read, counted and dropped.
 * Dropped with a REASON rather than silently, so a reviewer who expected to see
 * `jest` can find out where it went. One reason per GROUP rather than per
 * package: a typical package.json has twenty devDependencies, and twenty lines
 * each saying the same thing would bury the drop that matters. `counts.dropped`
 * still counts every package.
 *
 * An optional or a peer dependency IS proposed, with a `Dependency kind`
 * attribute saying which it is: `npm install --omit=dev` installs the first, and
 * the second is a runtime requirement the host is expected to satisfy. Neither
 * is a dev dependency, and dropping them would lose real edges.
 *
 * Every item's evidence quote is the source line that produced it, with offsets
 * into the source text, so the review UI can say where each proposal came from.
 *
 * Out of scope, deliberately (see the Decision Log): anything that reads a Git
 * remote or a checkout, lockfiles and transitive trees, monorepo workspace
 * globs, parsing source for call graphs, and license or vulnerability data.
 */

import { parseDocument, isMap, isScalar } from 'yaml';
import { normalizeTitle, nearestTitle } from '../similarity.js';
import { DUPLICATE_THRESHOLD, MAX_ITEMS, relationshipGroupMatcher, relationshipTarget } from '../draftNormalizer.js';
import { MAX_COMPOSE_CHARS, MAX_DROP_REASONS, withoutKnownBlocks } from './dockerCompose.js';

export const PRODUCER = 'package-manifest';
export const PRODUCER_VERSION = 'package-manifest@1';

export const SERVICE = 'Service';
export const EXTERNAL_DEPENDENCY = 'External Dependency';

const TAG = 'package-manifest';

/**
 * No model reads this text, so the limit is not a cost one: it keeps the
 * request under express.json's 100KB body cap once JSON-escaped, and a draft
 * reviewable by a person. The same cap the other four producers carry, shared
 * rather than re-declared so they cannot drift into refusing files of
 * different sizes.
 */
export const MAX_MANIFEST_CHARS = MAX_COMPOSE_CHARS;

/** A description longer than this is truncated into the Service's text block. */
export const MAX_DESCRIPTION_CHARS = 2_000;

/** A version constraint longer than this is truncated in its attribute. */
const MAX_CONSTRAINT_CHARS = 200;

/** Entity titles are capped by draftItemSchema; a Go module path can be long. */
const MAX_TITLE_CHARS = 200;

const DEPENDS = ['Dependent', 'Dependency'];

/** A file that could not be read as a package manifest. `line` is 1-based, or null. */
export class ManifestParseError extends Error {
  constructor(message, line = null) {
    super(message);
    this.name = 'ManifestParseError';
    this.line = line;
  }
}

/**
 * Which of the four a file is, by its content.
 *
 * The three families are told apart by their first non-blank character and by
 * the directives only one of them has: a JSON object is npm's, a `module`
 * directive at the start of a line is Go's, and a TOML table header or a
 * `key = value` line is one of the two `.toml` manifests. Which of those two
 * is decided after it is read, by the tables it declares (`tomlFormat`).
 *
 * @returns {'package.json'|'go.mod'|'toml'|null} null when it is none of them
 */
export function detectFamily(text) {
  const source = String(text ?? '');
  const trimmed = source.trimStart();
  if (trimmed.startsWith('{')) return 'package.json';
  // A `module` directive at column zero, which is the only place go.mod puts
  // one. Checked before TOML because `module = "x"` is not a go.mod line.
  if (/^module[ \t]+[^\s=]/m.test(source)) return 'go.mod';
  // A table header or a bare key assignment, either at column zero. TOML's
  // own grammar allows leading whitespace; manifests in the wild do not use it,
  // and requiring column zero is what keeps a stray `[` in a text file from
  // being read as a manifest.
  if (/^\[\[?[A-Za-z0-9_"'-]/m.test(source) || /^[A-Za-z0-9_"'-][^\n=]*=/m.test(source)) return 'toml';
  return null;
}

/**
 * @param {string} text  the manifest
 * @param {object} opts
 * @param {object[]} [opts.existingEntities]  [{ _id, title, updatedAt, blocks? }] — the
 *   workspace's graph. `blocks`, when present, lets an update skip attributes the entity has.
 * @param {object[]} [opts.existingGroups]  [{ _id, label, members: [{ refId, label }] }] — the
 *   workspace's relationship groups, so a re-import updates the links it created last time
 *   rather than stacking a second copy of each (draftNormalizer.relationshipGroupMatcher)
 * @param {number} [opts.lineOffset]  added to every line number an error names, for a caller
 *   that trimmed leading blank lines off the file before passing it in
 * @returns {{ items: object[], dropReasons: string[], dropped: number }}  `dropped`
 *   counts every drop, the ones past MAX_DROP_REASONS that are not listed included
 * @throws {ManifestParseError}
 */
export function parseManifest(text, { existingEntities = [], existingGroups = [], lineOffset = 0 } = {}) {
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

  /** A refusal naming the line the person sees in their editor. */
  const fail = (message, offset) => new ManifestParseError(
    typeof offset === 'number' ? `${message} (line ${lineAt(offset)})` : message,
    typeof offset === 'number' ? lineAt(offset) : null,
  );

  const dropReasons = [];
  let dropped = 0;
  let unlisted = 0;
  /**
   * One reason, `count` drops. The count is what `counts.dropped` reports and
   * the reason is what a reviewer reads, and a group of dev dependencies is one
   * decision taken once — hence one line for the twenty of them.
   *
   * `unlisted` is counted rather than derived from `dropped - dropReasons.length`
   * the way the other producers derive it: here one reason can speak for twenty
   * drops, so the difference between the two is not what went unsaid.
   */
  const dropMany = (count, reason) => {
    if (count <= 0) return;
    dropped += count;
    if (dropReasons.length < MAX_DROP_REASONS) dropReasons.push(reason);
    else unlisted += count;
  };
  const drop = reason => dropMany(1, reason);

  // ── read the manifest ──────────────────────────────────────────────────────
  const family = detectFamily(source);
  if (!family) {
    throw new ManifestParseError(
      'Not a package manifest — this producer reads one dependency manifest: a `package.json`, ' +
      'a `pyproject.toml`, a `go.mod` or a `Cargo.toml`. A lockfile is not one of them: it is a ' +
      'transitive tree, not what the module declares.'
    );
  }
  const read =
    family === 'package.json' ? readPackageJson(source, fail, dropMany) :
    family === 'go.mod'       ? readGoMod(source, fail, dropMany) :
                                readToml(source, fail, dropMany);

  const { format, ecosystem, moduleNoun, module, deps } = read;
  if (!module.name) {
    throw fail(`This ${format} declares no name — the module it describes has nothing to be titled`, module.offset ?? 0);
  }

  // ── entities and edges ─────────────────────────────────────────────────────
  // A Go module is known by its path and called by its last segment, which is
  // what a person would title the Service; the full path rides along as the
  // `Module` attribute. Every other format's declared name IS the title.
  const moduleTitle = (family === 'go.mod' ? module.name.split('/').filter(Boolean).pop() : module.name)
    .slice(0, MAX_TITLE_CHARS);

  const runtimeCount = deps.length;
  const moduleBlocks = [];
  const push = (label, value) => {
    if (value) moduleBlocks.push({ type: 'attribute', order: moduleBlocks.length, data: { label, value: String(value).slice(0, MAX_CONSTRAINT_CHARS) } });
  };
  push(module.nameLabel, module.name);
  push('Version', module.version);
  push('Runtime', module.runtime);
  push('Manifest', format);
  if (module.description) {
    moduleBlocks.push({
      type: 'text',
      order: moduleBlocks.length,
      data: { markdown: module.description.slice(0, MAX_DESCRIPTION_CHARS) },
    });
  }

  // One edge per dependency NAME, so a package listed in two groups — `react`
  // as both a dependency and a peer one — is one link rather than two copies of
  // the same link. Its entity is deduped downstream, by normalized title; this
  // is the edge half of the same rule.
  const edgeKeys = new Set();

  const entities = [{
    title: moduleTitle,
    category: SERVICE,
    summary: `The ${moduleNoun} declared in ${format}, with ${runtimeCount} direct runtime ` +
      `dependenc${runtimeCount === 1 ? 'y' : 'ies'} (package manifest).`,
    blocks: moduleBlocks,
    offset: module.offset,
  }];
  const edges = [];

  for (const dep of deps) {
    const blocks = [
      { type: 'attribute', order: 0, data: { label: 'Version constraint', value: (dep.constraint ?? '(any version)').slice(0, MAX_CONSTRAINT_CHARS) } },
      { type: 'attribute', order: 1, data: { label: 'Ecosystem', value: ecosystem } },
    ];
    if (dep.kind !== 'runtime') {
      blocks.push({ type: 'attribute', order: blocks.length, data: { label: 'Dependency kind', value: dep.kind } });
    }
    entities.push({
      title: dep.name.slice(0, MAX_TITLE_CHARS),
      category: EXTERNAL_DEPENDENCY,
      summary: `A direct ${dep.kind === 'runtime' ? '' : `${dep.kind} `}${ecosystem} dependency of ` +
        `${moduleTitle}${dep.constraint ? ` (${dep.constraint})` : ''} (package manifest).`,
      blocks,
      offset: dep.offset,
    });
    const to = dep.name.slice(0, MAX_TITLE_CHARS);
    const edgeKey = `Depends on\u0000${normalizeTitle(moduleTitle)}\u0000${normalizeTitle(to)}`;
    if (!edgeKeys.has(edgeKey)) {
      edgeKeys.add(edgeKey);
      edges.push({ label: 'Depends on', roles: DEPENDS, from: moduleTitle, to, offset: dep.offset });
    }
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

  for (let i = 0; i < entities.length; i++) {
    // The same cap normalizeDraft and the other four producers put on a draft,
    // for the same two reasons: a draft has to be reviewable by a person, and
    // everything below this line — the near-miss scan above all — is work per
    // item. The module is the first entity, so the cap costs dependencies.
    if (items.length >= MAX_ITEMS) {
      drop(`item cap of ${MAX_ITEMS} reached — ${entities.length - i} further dependencies in the file were not proposed`);
      break;
    }
    const ent = entities[i];
    const key = normalizeTitle(ent.title);
    if (!key) { drop(`entity "${ent.title}" has no usable title`); continue; }
    if (keyToLocal.has(key)) {
      // `react` listed in both `dependencies` and `peerDependencies`, and also
      // `node-fetch` vs. `node fetch`: normalizeTitle makes those one title.
      titleToLocal.set(ent.title, keyToLocal.get(key));
      drop(`duplicate entity "${ent.title}" within the same file`);
      continue;
    }

    const localKey = `e${++e}`;
    const existing = existingByKey.get(key);
    let op = 'create', targetEntityId = null, baseUpdatedAt = null, matchedBy = 'none';
    let blocks = ent.blocks;
    if (existing) {
      op = 'update';
      targetEntityId = existing._id;
      baseUpdatedAt = existing.updatedAt ?? null;
      matchedBy = 'exact-normalized-title';
      if (Array.isArray(existing.blocks)) blocks = withoutKnownBlocks(blocks, existing.blocks);
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
    titleToLocal.set(ent.title, localKey);
    if (targetEntityId) localToTarget.set(localKey, targetEntityId);

    items.push({
      localKey,
      seq: items.length,
      kind: 'entity',
      op,
      input: { evidence: evidenceAt(ent.offset), contextEntityIds: [] },
      proposed: {
        title: ent.title,
        category: ent.category,
        normalizedCategory: ent.category,
        summary: ent.summary.slice(0, 400),
        tags: [TAG],
        blocks,
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
  // A dependency whose entity did not fit under the item cap can still land on
  // one the workspace already has; otherwise the edge is dropped, and said so.
  let r = 0;
  for (let i = 0; i < edges.length; i++) {
    if (items.length >= MAX_ITEMS) {
      drop(`item cap of ${MAX_ITEMS} reached — ${edges.length - i} further dependency links in the file were not proposed`);
      break;
    }
    const edge = edges[i];
    if (normalizeTitle(edge.from) === normalizeTitle(edge.to)) continue;   // a module that depends on itself
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
        drop(`"${edge.label}" from ${edge.from} to "${name}" dropped — no module or entity by that name`);
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

  if (unlisted > 0) dropReasons.push(`…and ${unlisted} further drops, not listed`);

  return { items, dropReasons, dropped };
}

/** `dependenc(y|ies)`, because every drop reason needs it. */
const plural = n => `dependenc${n === 1 ? 'y' : 'ies'}`;

// ─── package.json ────────────────────────────────────────────────────────────

/**
 * npm's manifest, read with the `yaml` package rather than `JSON.parse`.
 *
 * JSON is YAML, which is what the OpenAPI producer already relies on for a
 * `.json` document, and it is the only way to get both the parse and the OFFSET
 * of every key out of one pass — a `JSON.parse` failure gives a character
 * position and nothing else, and its successes give no positions at all. The
 * evidence quote for a dependency has to be the line it is written on.
 */
function readPackageJson(source, fail, dropMany) {
  const doc = parseDocument(source, { prettyErrors: false });
  if (doc.errors.length) {
    const err = doc.errors[0];
    throw fail(`Invalid JSON: ${err.message.replace(/\s+at line \d+.*$/s, '')}`, err.pos?.[0] ?? 0);
  }
  const root = doc.contents;
  if (!isMap(root)) throw fail('This file is not a JSON object, so it is not a package.json', 0);

  const pairOf = (map, name) =>
    (isMap(map) ? map.items.find(p => isScalar(p.key) && String(p.key.value) === name) : null) ?? null;
  const scalarOf = node => (isScalar(node) && node.value != null && typeof node.value !== 'object' ? String(node.value) : null);
  const stringAt = (map, name) => scalarOf(pairOf(map, name)?.value);

  const engines = pairOf(root, 'engines')?.value;
  const nodeEngine = stringAt(engines, 'node');

  const namePair = pairOf(root, 'name');
  const module = {
    nameLabel: 'Package',
    name: stringAt(root, 'name'),
    version: stringAt(root, 'version'),
    description: stringAt(root, 'description'),
    runtime: nodeEngine ? `Node.js ${nodeEngine}` : 'Node.js',
    offset: namePair?.key?.range?.[0] ?? root.range?.[0] ?? 0,
  };

  const deps = [];
  let unreadable = 0;
  // Order matters only for which copy of a name listed twice wins, and a plain
  // runtime dependency should win over the same name as a peer.
  for (const [group, kind] of [['dependencies', 'runtime'], ['optionalDependencies', 'optional'], ['peerDependencies', 'peer']]) {
    const node = pairOf(root, group)?.value;
    if (!isMap(node)) continue;
    for (const pair of node.items) {
      if (!isScalar(pair.key)) { unreadable++; continue; }
      const name = String(pair.key.value).trim();
      const constraint = scalarOf(pair.value);
      if (!name) { unreadable++; continue; }
      deps.push({ name, constraint, kind, offset: pair.key.range?.[0] });
    }
  }
  if (unreadable) dropMany(unreadable, `${unreadable} dependency entr${unreadable === 1 ? 'y' : 'ies'} could not be read — a name and a version constraint are what this producer needs`);

  const devNode = pairOf(root, 'devDependencies')?.value;
  if (isMap(devNode) && devNode.items.length) {
    const names = devNode.items.filter(p => isScalar(p.key)).map(p => String(p.key.value));
    dropMany(devNode.items.length,
      `${devNode.items.length} dev ${plural(devNode.items.length)} in \`devDependencies\` ${devNode.items.length === 1 ? 'was' : 'were'} not proposed — ` +
      `a dev or test dependency is not part of what the module runs: ${listNames(names)}`);
  }

  return { format: 'package.json', ecosystem: 'npm', moduleNoun: 'npm package', module, deps };
}

/** `a, b, c and 4 more` — enough for a reviewer to recognise the group. */
function listNames(names, limit = 6) {
  const shown = names.slice(0, limit);
  const rest = names.length - shown.length;
  return `${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`;
}

// ─── go.mod ──────────────────────────────────────────────────────────────────

/**
 * go.mod, which is line-oriented and needs no parser: a directive per line, or
 * a directive followed by a parenthesised block of one argument list per line.
 *
 * `// indirect` is the only marker a manifest in any of these four formats
 * carries for a transitive dependency, and it is read: those requires are
 * counted and dropped. `replace`, `exclude`, `retract` and `toolchain` are
 * passed over — none of them adds an edge the module declares.
 */
function readGoMod(source, fail, dropMany) {
  const module = { nameLabel: 'Module', name: null, version: null, description: null, runtime: 'Go', offset: 0 };
  const deps = [];
  const indirect = [];
  let block = null;
  let offset = 0;

  for (const raw of source.split('\n')) {
    const at = offset;
    offset += raw.length + 1;
    const commentAt = raw.indexOf('//');
    const comment = commentAt === -1 ? '' : raw.slice(commentAt + 2);
    const body = (commentAt === -1 ? raw : raw.slice(0, commentAt)).trim();
    if (!body) continue;
    // The offset of the line's first non-blank character, so the evidence quote
    // and the line number both point at the require itself.
    const bodyAt = at + raw.indexOf(body[0]);

    if (block) {
      if (body.startsWith(')')) { block = null; continue; }
      if (block === 'require') addRequire(body, comment, bodyAt);
      continue;
    }

    const parts = body.split(/\s+/);
    const directive = parts[0];
    const rest = parts.slice(1);
    if (rest.length === 1 && rest[0] === '(') { block = directive; continue; }

    if (directive === 'module') { module.name = unquote(rest.join(' ')); module.offset = bodyAt; }
    else if (directive === 'go' && rest[0]) module.runtime = `Go ${unquote(rest[0])}`;
    else if (directive === 'require') addRequire(rest.join(' '), comment, bodyAt);
    // Anything else — toolchain, replace, exclude, retract, godebug — declares
    // no dependency of its own, and is passed over in silence.
  }

  function addRequire(text, comment, at) {
    const [name, version] = text.split(/\s+/);
    if (!name) return;
    // `\b` rather than a whitespace fence: `// indirect; pulled in by pgx` is
    // a comment a person writes, and it says the same thing.
    if (/\bindirect\b/.test(comment)) { indirect.push(unquote(name)); return; }
    deps.push({ name: unquote(name), constraint: version ? unquote(version) : null, kind: 'runtime', offset: at });
  }

  if (indirect.length) {
    dropMany(indirect.length,
      `${indirect.length} indirect ${plural(indirect.length)} marked \`// indirect\` ${indirect.length === 1 ? 'was' : 'were'} not proposed — ` +
      `a transitive dependency is not one the module chose: ${listNames(indirect)}`);
  }

  return { format: 'go.mod', ecosystem: 'Go', moduleNoun: 'Go module', module, deps };
}

const unquote = value => String(value ?? '').replace(/^["'`]|["'`]$/g, '').trim();

// ─── pyproject.toml and Cargo.toml ───────────────────────────────────────────

/**
 * The TOML these two need, read by hand.
 *
 * There is no TOML parser among the server's dependencies, and the subset a
 * manifest uses is small: table headers, keys (bare, quoted or dotted),
 * strings (all four forms), arrays — multi-line, commented and
 * trailing-comma'd, because that is how a real pyproject writes its
 * dependencies — inline tables, booleans, and everything else kept as the text
 * it is. Nothing here ever compares a manifest value to a number, so a date or
 * a float needs no reading beyond "the characters up to the delimiter".
 *
 * An array-of-tables (`[[bin]]`, `[[tool.poetry.source]]`) is read and
 * discarded: no dependency is declared in one, and keeping the last of several
 * under the same path would make the tree a lie.
 *
 * @returns {{tables: {path: string[], entries: object[], offset: number, repeated: boolean}[]}}
 */
function readTomlTables(source, fail) {
  let i = 0;
  const tables = [];
  let current = { path: [], entries: [], offset: 0, repeated: false };
  tables.push(current);

  const skipSpace = () => { while (i < source.length && (source[i] === ' ' || source[i] === '\t' || source[i] === '\r')) i++; };
  const skipToEol = () => { while (i < source.length && source[i] !== '\n') i++; };
  const skipGaps = () => {
    for (;;) {
      while (i < source.length && /\s/.test(source[i])) i++;
      if (source[i] === '#') { skipToEol(); continue; }
      return;
    }
  };

  /** `\n`, `\t`, `\"`, `\uXXXX`, and the line-ending backslash of a multi-line string. */
  const escapeAt = at => {
    const c = source[at + 1];
    const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
    if (c in simple) return { text: simple[c], next: at + 2 };
    if (c === 'u' || c === 'U') {
      const width = c === 'u' ? 4 : 8;
      const hex = source.slice(at + 2, at + 2 + width);
      if (new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) {
        return { text: String.fromCodePoint(parseInt(hex, 16)), next: at + 2 + width };
      }
    }
    if (c === '\n' || c === '\r' || c === ' ' || c === '\t') {
      let j = at + 1;
      while (j < source.length && /\s/.test(source[j])) j++;
      return { text: '', next: j };
    }
    // An unknown escape is the character it is: a manifest value is text here,
    // and refusing a whole file over one backslash would be the wrong trade.
    return { text: c ?? '', next: at + 2 };
  };

  const readString = () => {
    const q = source[i];
    const start = i;
    const triple = q.repeat(3);
    if (source.startsWith(triple, i)) {
      i += 3;
      if (source[i] === '\n') i++;
      else if (source.startsWith('\r\n', i)) i += 2;
      let out = '';
      while (i < source.length) {
        if (source.startsWith(triple, i)) { i += 3; return out; }
        if (q === '"' && source[i] === '\\') { const { text, next } = escapeAt(i); out += text; i = next; continue; }
        out += source[i++];
      }
      throw fail('An unterminated multi-line string', start);
    }
    i++;
    let out = '';
    while (i < source.length && source[i] !== '\n') {
      if (source[i] === q) { i++; return out; }
      if (q === '"' && source[i] === '\\') { const { text, next } = escapeAt(i); out += text; i = next; continue; }
      out += source[i++];
    }
    throw fail('An unterminated string', start);
  };

  /** A key: bare, quoted, or dotted (`a.b."c"`). Returns its parts. */
  const readKey = () => {
    const parts = [];
    for (;;) {
      skipSpace();
      const c = source[i];
      if (c === '"' || c === "'") parts.push(readString());
      else {
        const start = i;
        while (i < source.length && /[A-Za-z0-9_-]/.test(source[i])) i++;
        if (i === start) throw fail('A key that could not be read', start);
        parts.push(source.slice(start, i));
      }
      skipSpace();
      if (source[i] === '.') { i++; continue; }
      return parts;
    }
  };

  const assign = (obj, parts, value) => {
    let node = obj;
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== 'object' || node[part] === null || Array.isArray(node[part])) node[part] = {};
      node = node[part];
    }
    node[parts[parts.length - 1]] = value;
  };

  const readValue = () => {
    skipSpace();
    const c = source[i];
    if (c === '"' || c === "'") return readString();
    if (c === '[') {
      const start = i++;
      const out = [];
      for (;;) {
        skipGaps();
        if (i >= source.length) throw fail('An unclosed array', start);
        if (source[i] === ']') { i++; return out; }
        out.push(readValue());
        skipGaps();
        if (source[i] === ',') { i++; continue; }
        if (source[i] === ']') { i++; return out; }
        throw fail('An array missing a comma', i);
      }
    }
    if (c === '{') {
      const start = i++;
      const out = {};
      for (;;) {
        skipGaps();
        if (i >= source.length) throw fail('An unclosed inline table', start);
        if (source[i] === '}') { i++; return out; }
        const key = readKey();
        skipSpace();
        if (source[i] !== '=') throw fail('An inline table entry with no `=`', i);
        i++;
        assign(out, key, readValue());
        skipGaps();
        if (source[i] === ',') { i++; continue; }
        if (source[i] === '}') { i++; return out; }
        throw fail('An inline table missing a comma', i);
      }
    }
    const start = i;
    while (i < source.length && !'\n,]}#'.includes(source[i])) i++;
    const raw = source.slice(start, i).trim();
    if (!raw) throw fail('A key with no value', start);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  };

  for (;;) {
    skipGaps();
    if (i >= source.length) break;

    if (source[i] === '[') {
      const offset = i++;
      const arrayOfTables = source[i] === '[';
      if (arrayOfTables) i++;
      const path = readKey();
      skipSpace();
      if (source[i] !== ']') throw fail('A table header that is not closed', offset);
      i++;
      if (arrayOfTables) {
        if (source[i] !== ']') throw fail('A table header that is not closed', offset);
        i++;
      }
      current = { path, entries: [], offset, repeated: arrayOfTables };
      tables.push(current);
      skipSpace();
      if (source[i] === '#') skipToEol();
      continue;
    }

    const offset = i;
    const key = readKey();
    skipSpace();
    if (source[i] !== '=') throw fail('A line that is neither a table header nor a `key = value`', offset);
    i++;
    const value = readValue();
    current.entries.push({ key, value, offset });
    skipSpace();
    if (source[i] === '#') skipToEol();
  }

  return tables;
}

/**
 * The tables as one tree, plus where each path was written.
 *
 * A tree is what lets `[project.optional-dependencies]` and an inline
 * `optional-dependencies = { … }` be read by the same lookup, which is the
 * whole reason not to work off the table list directly.
 */
function tomlTree(tables) {
  const root = {};
  const offsets = new Map();
  const assign = (parts, value) => {
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== 'object' || node[part] === null || Array.isArray(node[part])) node[part] = {};
      node = node[part];
    }
    node[parts[parts.length - 1]] = value;
  };
  for (const table of tables) {
    if (table.repeated) continue;
    if (table.path.length) {
      if (!offsets.has(table.path.join('\u0000'))) offsets.set(table.path.join('\u0000'), table.offset);
      // The header alone declares the table, so `[tool.poetry.dependencies]`
      // with no entries is still an empty object rather than nothing.
      if (get(table.path) === undefined) assign(table.path, {});
    }
    for (const entry of table.entries) {
      const path = [...table.path, ...entry.key];
      assign(path, entry.value);
      offsets.set(path.join('\u0000'), entry.offset);
    }
  }
  function get(path) {
    let node = root;
    for (const part of path) {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined;
      node = node[part];
      if (node === undefined) return undefined;
    }
    return node;
  }
  /** The offset of `path`, or of the nearest ancestor that has one. */
  function offsetOf(path) {
    for (let p = [...path]; p.length; p.pop()) {
      const at = offsets.get(p.join('\u0000'));
      if (typeof at === 'number') return at;
    }
    return 0;
  }
  const paths = tables.filter(t => !t.repeated).map(t => t.path.join('.'));
  return { get, offsetOf, paths };
}

/** A `.toml` is a pyproject or a Cargo manifest by the tables it declares. */
function tomlFormat({ paths, get }) {
  if (paths.includes('project') || paths.includes('build-system') || paths.some(p => p === 'tool' || p.startsWith('tool.'))) {
    return 'pyproject.toml';
  }
  if (paths.includes('package') || paths.includes('dependencies') || paths.includes('workspace')) return 'Cargo.toml';
  // A dotted-key manifest declares no table headers at all.
  if (get(['project']) !== undefined || get(['tool']) !== undefined) return 'pyproject.toml';
  if (get(['package']) !== undefined) return 'Cargo.toml';
  return null;
}

function readToml(source, fail, dropMany) {
  const tree = tomlTree(readTomlTables(source, fail));
  const format = tomlFormat(tree);
  if (!format) {
    throw new ManifestParseError(
      'This TOML file is neither a `pyproject.toml` nor a `Cargo.toml` — one needs a `[project]`, ' +
      '`[build-system]` or `[tool.*]` table, the other a `[package]` or `[dependencies]` table.'
    );
  }
  return format === 'pyproject.toml' ? readPyproject(source, tree, fail, dropMany) : readCargo(tree, dropMany);
}

/** A version-ish value: `"^2.1"`, or `{ version = "^2.1", … }`. */
const constraintOf = value => {
  if (value == null || typeof value === 'boolean') return null;
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return null;
  if (value.version != null) return String(value.version);
  if (value.path != null) return `path ${value.path}`;
  if (value.git != null) return `git ${value.git}`;
  if (value.url != null) return `url ${value.url}`;
  if (value.workspace === true) return '(from the workspace)';
  return null;
};

/**
 * pyproject.toml, in both spellings that matter: PEP 621 (`[project]`, an array
 * of PEP 508 requirement strings) and Poetry (`[tool.poetry.dependencies]`, a
 * table of name -> constraint). A file with both is read as both; a package
 * named twice is deduped by title downstream.
 *
 * `python` is the runtime, not a dependency: Poetry declares it in the same
 * table as everything else, and PEP 621 declares it as `requires-python`.
 *
 * Extras and groups are dropped: `[project.optional-dependencies]` and Poetry's
 * groups are not installed by a plain install, which is the line this producer
 * draws between a runtime dependency and a dev one.
 */
function readPyproject(source, tree, fail, dropMany) {
  const { get, offsetOf } = tree;
  const first = (...paths) => {
    for (const path of paths) {
      const value = get(path);
      if (value != null && typeof value !== 'object') return { value: String(value), path };
    }
    return { value: null, path: null };
  };

  const name = first(['project', 'name'], ['tool', 'poetry', 'name']);
  const version = first(['project', 'version'], ['tool', 'poetry', 'version']);
  const description = first(['project', 'description'], ['tool', 'poetry', 'description']);
  const python = constraintOf(get(['project', 'requires-python']) ?? get(['tool', 'poetry', 'dependencies', 'python']));

  const module = {
    nameLabel: 'Package',
    name: name.value,
    version: version.value,
    description: description.value,
    runtime: python ? `Python ${python}` : 'Python',
    offset: name.path ? offsetOf(name.path) : 0,
  };

  const deps = [];
  // PEP 621: an array of requirement strings. The elements have no offsets of
  // their own — an array is one value — so each is located by searching from
  // the `dependencies` key, which is the line it was written on in every
  // manifest a person would hand over.
  const pep621 = get(['project', 'dependencies']);
  if (Array.isArray(pep621)) {
    const from = offsetOf(['project', 'dependencies']);
    let unreadable = 0;
    for (const entry of pep621) {
      const requirement = typeof entry === 'string' ? parseRequirement(entry) : null;
      if (!requirement) { unreadable++; continue; }
      deps.push({ ...requirement, kind: 'runtime', offset: locate(source, String(entry), from) });
    }
    if (unreadable) dropMany(unreadable, `${unreadable} entr${unreadable === 1 ? 'y' : 'ies'} in \`project.dependencies\` could not be read as a requirement`);
  }

  // Poetry: a table of name -> constraint.
  const poetry = get(['tool', 'poetry', 'dependencies']);
  if (poetry && typeof poetry === 'object' && !Array.isArray(poetry)) {
    const optional = [];
    for (const [depName, value] of Object.entries(poetry)) {
      if (depName === 'python') continue;
      if (value && typeof value === 'object' && !Array.isArray(value) && value.optional === true) { optional.push(depName); continue; }
      deps.push({
        name: depName,
        constraint: constraintOf(value),
        kind: 'runtime',
        offset: offsetOf(['tool', 'poetry', 'dependencies', depName]),
      });
    }
    if (optional.length) {
      dropMany(optional.length,
        `${optional.length} optional ${plural(optional.length)} in \`tool.poetry.dependencies\` ${optional.length === 1 ? 'was' : 'were'} not proposed — ` +
        `an optional Poetry dependency belongs to an extra, which a plain install does not take: ${listNames(optional)}`);
    }
  }

  // Extras and groups, dropped with one reason each.
  for (const [path, label] of [
    [['project', 'optional-dependencies'], 'project.optional-dependencies'],
    [['tool', 'poetry', 'dev-dependencies'], 'tool.poetry.dev-dependencies'],
  ]) {
    const node = get(path);
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) continue;
    // `optional-dependencies` is group -> array; `dev-dependencies` is name -> constraint.
    const groups = path.at(-1) === 'optional-dependencies'
      ? Object.entries(node).map(([group, list]) => [`${label}.${group}`, Array.isArray(list) ? list.map(r => parseRequirement(String(r))?.name ?? String(r)) : []])
      : [[label, Object.keys(node)]];
    for (const [where, names] of groups) {
      if (!names.length) continue;
      dropMany(names.length,
        `${names.length} ${plural(names.length)} in \`${where}\` ${names.length === 1 ? 'was' : 'were'} not proposed — ` +
        `an extra or a dev group is not part of what the module runs: ${listNames(names)}`);
    }
  }

  const poetryGroups = get(['tool', 'poetry', 'group']);
  if (poetryGroups && typeof poetryGroups === 'object' && !Array.isArray(poetryGroups)) {
    for (const [group, body] of Object.entries(poetryGroups)) {
      const node = body?.dependencies;
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
      const names = Object.keys(node);
      if (!names.length) continue;
      dropMany(names.length,
        `${names.length} ${plural(names.length)} in \`tool.poetry.group.${group}.dependencies\` ${names.length === 1 ? 'was' : 'were'} not proposed — ` +
        `a Poetry group is not taken by a plain install: ${listNames(names)}`);
    }
  }

  return { format: 'pyproject.toml', ecosystem: 'PyPI', moduleNoun: 'Python project', module, deps };
}

/**
 * A PEP 508 requirement string: `httpx[http2]>=0.27,<1 ; python_version > "3.9"`.
 *
 * The extras and the environment marker are read off and discarded — an extra
 * names a feature set of the DEPENDENCY, not an edge of its own, and a marker
 * says on which interpreters the edge exists, which an architecture graph does
 * not model. The constraint is kept as written.
 */
export function parseRequirement(text) {
  const raw = String(text ?? '').trim();
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/s.exec(raw);
  if (!match) return null;
  const [, name, , rest] = match;
  const constraint = rest.split(';')[0].trim();
  return { name, constraint: constraint || null };
}

/** Where `needle` sits in `source` at or after `from`; `from` itself if it is not there. */
function locate(source, needle, from) {
  const at = needle ? source.indexOf(needle, from) : -1;
  return at === -1 ? from : at;
}

/**
 * Cargo.toml. `[dependencies]` is a table of name -> constraint, where the
 * constraint is either a version string or a table with `version`, `path`,
 * `git` or `workspace` in it; `[dependencies.serde]` is the same entry written
 * as its own table, and the tree reads both the same way.
 *
 * `[dev-dependencies]` and `[build-dependencies]` are dropped — neither is part
 * of what the crate runs — as are the `[target.*]` tables, whose dependencies
 * exist only on some platforms.
 */
function readCargo(tree, dropMany) {
  const { get, offsetOf } = tree;
  const pkg = get(['package']);
  const str = key => {
    const value = pkg && typeof pkg === 'object' ? pkg[key] : undefined;
    return value != null && typeof value !== 'object' ? String(value) : null;
  };
  const rustVersion = str('rust-version');
  const edition = str('edition');

  const module = {
    nameLabel: 'Package',
    name: str('name'),
    version: str('version'),
    description: str('description'),
    runtime: rustVersion ? `Rust ${rustVersion}` : edition ? `Rust (${edition} edition)` : 'Rust',
    offset: offsetOf(['package', 'name']),
  };

  const deps = [];
  const node = get(['dependencies']);
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const optional = [];
    for (const [name, value] of Object.entries(node)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && value.optional === true) { optional.push(name); continue; }
      deps.push({ name, constraint: constraintOf(value), kind: 'runtime', offset: offsetOf(['dependencies', name]) });
    }
    if (optional.length) {
      dropMany(optional.length,
        `${optional.length} optional ${plural(optional.length)} in \`[dependencies]\` ${optional.length === 1 ? 'was' : 'were'} not proposed — ` +
        `an optional crate is pulled in by a feature, not by the crate itself: ${listNames(optional)}`);
    }
  }

  for (const group of ['dev-dependencies', 'build-dependencies']) {
    const table = get([group]);
    if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
    const names = Object.keys(table);
    if (!names.length) continue;
    dropMany(names.length,
      `${names.length} ${plural(names.length)} in \`[${group}]\` ${names.length === 1 ? 'was' : 'were'} not proposed — ` +
      `a ${group === 'dev-dependencies' ? 'dev or test' : 'build-time'} dependency is not part of what the crate runs: ${listNames(names)}`);
  }

  const targets = get(['target']);
  if (targets && typeof targets === 'object' && !Array.isArray(targets)) {
    const names = [];
    for (const body of Object.values(targets)) {
      for (const group of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
        const table = body?.[group];
        if (table && typeof table === 'object' && !Array.isArray(table)) names.push(...Object.keys(table));
      }
    }
    if (names.length) {
      dropMany(names.length,
        `${names.length} platform-specific ${plural(names.length)} under \`[target.*]\` ${names.length === 1 ? 'was' : 'were'} not proposed — ` +
        `a dependency that exists on only some platforms is not one the crate always runs: ${listNames(names)}`);
    }
  }

  return { format: 'Cargo.toml', ecosystem: 'crates.io', moduleNoun: 'Rust crate', module, deps };
}
