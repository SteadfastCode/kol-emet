/**
 * An OpenAPI document -> draft items. The second vertical-ingestion producer.
 *
 * Deterministic, exactly as the compose producer is (lib/producers/dockerCompose.js):
 * no model call, so no budget check and no generation lock, and the same file
 * against the same graph always yields the same draft. The output is in the
 * shape normalizeDraft emits — server-assigned localKeys, `proposed` as
 * draftItemSchema validates it, the same exact-normalized-title dedup — so the
 * review UI, the decision routes, the applier and the exporter handle an
 * OpenAPI draft without knowing it is one.
 *
 * Accepts JSON and YAML (JSON is YAML, so one parser reads both and both get
 * line numbers), OpenAPI 3.x and Swagger 2.0. Anything else is refused with a
 * message naming what was found at the top level instead.
 *
 * Mapping (Software Architecture vocabulary, config/templates.js):
 *
 *   info.title                      -> Service, with the API version, the spec
 *                                      version and info.description on it
 *   each tag the document uses      -> API + "Exposes" (Provider, Endpoint),
 *                                      with its operations as an attribute
 *   a servers[] host that is not
 *   the service's own               -> External Dependency + "Depends on"
 *
 * "Each tag the document uses" is the declared `tags[]` first, in declaration
 * order, then any further tag an operation names; an operation that names no
 * tag at all is grouped under its first path segment, which is what makes a
 * spec that declares no tags map to one API entity per path prefix. Every
 * operation therefore lands on exactly one API entity, which is the property
 * worth having — a document is free to tag operations without declaring the
 * tags, and dropping those would lose the paths the import is for.
 *
 * Only local `#/components/...` `$ref`s are followed, one level deep, and only
 * where a `$ref` can change the mapping — a path item. An unresolvable ref is
 * a drop reason rather than a 400: one broken reference should not cost a
 * reviewer the rest of a 60-path document. Request and response schemas are
 * not read at all (see "out of scope" in the Decision Log).
 *
 * Every item's evidence quote is the source line that produced it, with
 * offsets into the source text, so the review UI can say where each proposal
 * came from.
 *
 * NOTE ON DUPLICATION: the tail of this file — dedup against the roster, the
 * item cap, the near-miss scan, the relationship items — follows the compose
 * producer line for line because both have to emit the same shape, and the two
 * copies are deliberate for now. The third producer extracts it; see the
 * Decision Log entry for KOL-051.
 */

import { parseDocument, LineCounter, visit, isAlias, isMap, isScalar, isSeq } from 'yaml';
import { normalizeTitle, nearestTitle } from '../similarity.js';
import { DUPLICATE_THRESHOLD, MAX_ITEMS } from '../draftNormalizer.js';
import { MAX_COMPOSE_CHARS, MAX_DROP_REASONS, withoutKnownBlocks } from './dockerCompose.js';

export const PRODUCER = 'openapi';
export const PRODUCER_VERSION = 'openapi@1';

export const SERVICE = 'Service';
export const API = 'API';
export const EXTERNAL_DEPENDENCY = 'External Dependency';

const TAG = 'openapi';

/**
 * The same character cap the compose producer carries, and for the same
 * reasons: no model reads this text, so the limit is not a cost one — it keeps
 * the request under express.json's 100KB body cap once JSON-escaped, and the
 * draft reviewable by a person. Shared rather than re-declared so the two
 * producers cannot drift into refusing files of different sizes.
 */
export const MAX_OPENAPI_CHARS = MAX_COMPOSE_CHARS;

/**
 * How many operations one API entity's attribute block lists before it says
 * how many more there are. Operations do not become items, so MAX_ITEMS does
 * not bound them: a 400-operation tag would otherwise put a 12KB string in one
 * attribute that no one can read.
 */
export const MAX_OPERATIONS_LISTED = 40;

/** Methods a path item can carry. `parameters`, `servers`, `summary` etc. are not operations. */
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

// Hosts a server URL can name that are the developer's own machine, not a dependency.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'host.docker.internal']);

/** A file that could not be read as an OpenAPI document. `line` is 1-based, or null. */
export class OpenApiParseError extends Error {
  constructor(message, line = null) {
    super(message);
    this.name = 'OpenApiParseError';
    this.line = line;
  }
}

/**
 * @param {string} text  the OpenAPI document, as JSON or YAML
 * @param {object} opts
 * @param {object[]} [opts.existingEntities]  [{ _id, title, updatedAt, blocks? }] — the
 *   workspace's graph. `blocks`, when present, lets an update skip attributes the entity has.
 * @param {number} [opts.lineOffset]  added to every line number an error names, for a caller
 *   that trimmed leading blank lines off the file before passing it in
 * @returns {{ items: object[], dropReasons: string[], dropped: number }}  `dropped`
 *   counts every drop, the ones past MAX_DROP_REASONS that are not listed included
 * @throws {OpenApiParseError}
 */
export function parseOpenApi(text, { existingEntities = [], lineOffset = 0 } = {}) {
  const source = String(text ?? '');
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines, merge: true, prettyErrors: false });

  const lineAt = offset => (typeof offset === 'number' ? lines.linePos(offset).line + lineOffset : null);
  const onLine = line => (line ? ` on line ${line}` : '');

  if (doc.errors.length) {
    const err = doc.errors[0];
    const line = lineAt(err.pos?.[0]);
    throw new OpenApiParseError(`Invalid JSON or YAML${onLine(line)}: ${err.message}`, line);
  }

  // An alias naming an anchor that is not defined above it is not a parse error
  // to the yaml package, only a throw later when the value is read.
  let unresolved = null;
  visit(doc, { Alias(_, node) { if (!unresolved && !node.resolve(doc)) unresolved = node; } });
  if (unresolved) {
    const line = lineAt(unresolved.range?.[0]);
    throw new OpenApiParseError(
      `Invalid JSON or YAML${onLine(line)}: alias *${unresolved.source} has no anchor above it`, line);
  }

  const deref = node => {
    let n = node;
    for (let i = 0; isAlias(n) && i < 16; i++) n = n.resolve(doc);
    return n ?? null;
  };

  const isMergeKey = key =>
    isScalar(key) && (key.source === '<<' || key.value === '<<' ||
      (typeof key.value === 'symbol' && key.value.description === '<<'));

  /** The `name` pair of a mapping, following `<<` merge keys. */
  const pairOf = (map, name, depth = 0) => {
    const m = deref(map);
    if (!isMap(m) || depth > 16) return null;
    const direct = m.items.find(p => !isMergeKey(p.key) && isScalar(p.key) && String(p.key.value) === name);
    if (direct) return direct;
    for (const p of m.items) {
      if (!isMergeKey(p.key)) continue;
      const merged = deref(p.value);
      for (const src of isSeq(merged) ? merged.items : [merged]) {
        const hit = pairOf(src, name, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };

  /** Plain JS for a node. maxAliasCount stops an alias bomb from expanding. */
  const toJS = node => {
    const n = deref(node);
    if (n == null) return null;
    try {
      return typeof n.toJS === 'function' ? n.toJS(doc, { maxAliasCount: 100 }) : n;
    } catch (err) {
      const line = lineAt(n.range?.[0]);
      throw new OpenApiParseError(`Invalid JSON or YAML${onLine(line)}: ${err.message}`, line);
    }
  };

  const scalarString = node => {
    const v = toJS(node);
    return v == null || typeof v === 'object' ? null : String(v);
  };

  /** The whole source line holding `offset`, trimmed, with its span. */
  const evidenceAt = offset => {
    if (typeof offset !== 'number') return { quote: '', charStart: null, charEnd: null, chunkIndex: 0 };
    const { line } = lines.linePos(offset);
    let start = lines.lineStarts[line - 1] ?? 0;
    const next = lines.lineStarts[line];
    let end = next === undefined ? source.length : next - 1;
    while (start < end && /\s/.test(source[start])) start++;
    while (end > start && /\s/.test(source[end - 1])) end--;
    return { quote: source.slice(start, end), charStart: start, charEnd: end, chunkIndex: 0 };
  };

  // ── is this an OpenAPI document at all? ────────────────────────────────────
  const root = doc.contents;
  if (!isMap(root)) {
    throw new OpenApiParseError(
      'Not an OpenAPI document — the top level of the file is not a mapping of keys. ' +
      'This producer reads OpenAPI 3.x and Swagger 2.0, as JSON or YAML.');
  }

  const topKeys = root.items
    .filter(p => !isMergeKey(p.key) && isScalar(p.key))
    .map(p => String(p.key.value));

  const openapiPair = pairOf(root, 'openapi');
  const swaggerPair = pairOf(root, 'swagger');
  const declared = scalarString(openapiPair?.value ?? swaggerPair?.value);
  const which = openapiPair ? 'openapi' : swaggerPair ? 'swagger' : null;

  if (!which) {
    const found = topKeys.length
      ? `found ${topKeys.slice(0, 6).map(k => `\`${k}\``).join(', ')}${topKeys.length > 6 ? ', …' : ''}`
      : 'the file declares no top-level keys';
    const hint = topKeys.includes('services')
      ? ' This looks like a docker-compose file — import it as one.'
      : '';
    throw new OpenApiParseError(
      `Not an OpenAPI document — no top-level \`openapi:\` or \`swagger:\` version (${found}).${hint}`,
      lineAt(root.range?.[0]));
  }

  // 3.x and 2.0 only. A version this producer has not read is refused by name
  // rather than parsed hopefully: the mapping below is written against these
  // two documents' shapes, and guessing at a future one would propose nonsense.
  const supported = which === 'openapi' ? /^3\./.test(declared ?? '') : /^2\./.test(declared ?? '');
  if (!supported) {
    const line = lineAt((openapiPair ?? swaggerPair)?.key?.range?.[0]);
    throw new OpenApiParseError(
      `\`${which}: ${declared ?? '(empty)'}\`${onLine(line)} is not supported — ` +
      'this producer reads OpenAPI 3.x and Swagger 2.0.', line);
  }
  const specLabel = `${which === 'openapi' ? 'OpenAPI' : 'Swagger'} ${declared}`;

  const infoPair = pairOf(root, 'info');
  const serviceTitlePair = pairOf(infoPair?.value, 'title');
  const serviceTitle = (scalarString(serviceTitlePair?.value) ?? '').trim();
  if (!serviceTitle) {
    throw new OpenApiParseError(
      `This ${specLabel} document has no \`info.title\`, so there is nothing to name the service after.`,
      lineAt(infoPair?.key?.range?.[0]));
  }

  const dropReasons = [];
  let dropped = 0;
  const drop = reason => {
    dropped++;
    if (dropReasons.length < MAX_DROP_REASONS) dropReasons.push(reason);
  };

  // ── the service ────────────────────────────────────────────────────────────
  const apiVersion = (scalarString(pairOf(infoPair?.value, 'version')?.value) ?? '').trim();
  const description = (scalarString(pairOf(infoPair?.value, 'description')?.value) ?? '').trim();
  const infoSummary = (scalarString(pairOf(infoPair?.value, 'summary')?.value) ?? '').trim();

  const serviceBlocks = [];
  if (apiVersion) {
    serviceBlocks.push({ type: 'attribute', order: serviceBlocks.length, data: { label: 'API version', value: apiVersion } });
  }
  serviceBlocks.push({ type: 'attribute', order: serviceBlocks.length, data: { label: 'Spec version', value: specLabel } });
  if (description) {
    serviceBlocks.push({ type: 'text', order: serviceBlocks.length, data: { markdown: description } });
  }

  const entities = [{
    title: serviceTitle,
    category: SERVICE,
    summary: infoSummary || `Service described by ${specLabel}.`,
    blocks: serviceBlocks,
    offset: serviceTitlePair?.key?.range?.[0] ?? infoPair?.key?.range?.[0],
  }];

  const edges = [];
  const edgeKeys = new Set();
  const addEdge = (label, roles, from, to, offset) => {
    const key = `${label} ${from} ${to}`;
    if (from === to || edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ label, roles, from, to, offset });
  };
  const EXPOSES = ['Provider', 'Endpoint'];
  const DEPENDS = ['Dependent', 'Dependency'];

  // ── tags, declared and used ────────────────────────────────────────────────
  // Declared first and in order, so the draft reads in the order the document
  // is written; a tag only an operation names is appended as it is met.
  const apis = new Map();   // title -> { title, summary, operations: string[], offset }
  const apiFor = (title, offset, summary = null) => {
    const existing = apis.get(title);
    if (existing) {
      if (summary && !existing.summary) existing.summary = summary;
      return existing;
    }
    const api = { title, summary, operations: [], offset };
    apis.set(title, api);
    return api;
  };

  const tagsNode = deref(pairOf(root, 'tags')?.value);
  if (isSeq(tagsNode)) {
    for (const item of tagsNode.items) {
      const tag = deref(item);
      const namePair = pairOf(tag, 'name');
      const name = (scalarString(namePair?.value) ?? '').trim();
      if (!name) { drop('a declared tag has no name'); continue; }
      const tagDescription = (scalarString(pairOf(tag, 'description')?.value) ?? '').trim();
      apiFor(name, namePair?.key?.range?.[0] ?? tag?.range?.[0], tagDescription || null);
    }
  }

  // ── paths -> operations, grouped onto those tags ───────────────────────────
  /**
   * One level of local `#/components/...` indirection, which is all a path item
   * is allowed in practice and all this producer follows. Returns the node, or
   * a string naming why it could not be resolved.
   */
  const resolveLocalRef = ref => {
    if (typeof ref !== 'string' || !ref.startsWith('#/components/')) {
      return `${JSON.stringify(ref)} is not a local \`#/components/…\` reference`;
    }
    let node = root;
    for (const raw of ref.slice(2).split('/')) {
      const segment = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      const pair = pairOf(node, segment);
      if (!pair) return `${ref} is not defined in this document`;
      node = deref(pair.value);
    }
    if (!isMap(node)) return `${ref} does not resolve to an object`;
    // One level deep: a ref to a ref is where a cycle starts, and following it
    // buys nothing a flattened document would not already give.
    if (pairOf(node, '$ref')) return `${ref} resolves to another \`$ref\`, which is not followed`;
    return node;
  };

  const pathsNode = deref(pairOf(root, 'paths')?.value);
  if (isMap(pathsNode)) {
    for (const pathPair of pathsNode.items) {
      if (isMergeKey(pathPair.key) || !isScalar(pathPair.key)) continue;
      const path = String(pathPair.key.value);
      let pathItem = deref(pathPair.value);
      const pathOffset = pathPair.key.range?.[0];

      const refPair = pairOf(pathItem, '$ref');
      if (refPair) {
        const resolved = resolveLocalRef(scalarString(refPair.value));
        if (typeof resolved === 'string') {
          drop(`path "${path}" was skipped — ${resolved}`);
          continue;
        }
        pathItem = resolved;
      }
      if (!isMap(pathItem)) { drop(`path "${path}" is not an object`); continue; }

      // The segment every untagged operation under this path is grouped by.
      const segment = path.split('/').filter(Boolean)[0] || 'root';

      let operations = 0;
      for (const opPair of pathItem.items) {
        if (isMergeKey(opPair.key) || !isScalar(opPair.key)) continue;
        const method = String(opPair.key.value).toLowerCase();
        if (!HTTP_METHODS.includes(method)) continue;
        operations++;

        const operation = `${method.toUpperCase()} ${path}`;
        const opOffset = opPair.key.range?.[0] ?? pathOffset;
        const opTags = (toJS(pairOf(opPair.value, 'tags')?.value) ?? [])
          .filter(t => typeof t === 'string' && t.trim())
          .map(t => t.trim());

        for (const title of opTags.length ? [...new Set(opTags)] : [segment]) {
          const api = apiFor(title, opOffset);
          if (!api.operations.includes(operation)) api.operations.push(operation);
          // The evidence for a tag only operations name is the first operation
          // that named it, which is the line that made the proposal.
          if (api.offset === undefined) api.offset = opOffset;
        }
      }
      if (!operations) drop(`path "${path}" declares no operations`);
    }
  }

  for (const api of apis.values()) {
    const listed = api.operations.slice(0, MAX_OPERATIONS_LISTED);
    const over = api.operations.length - listed.length;
    const blocks = listed.length
      ? [{
          type: 'attribute',
          order: 0,
          data: {
            label: 'Operations',
            value: listed.join(', ') + (over ? `, …and ${over} more` : ''),
          },
        }]
      : [];
    entities.push({
      title: api.title,
      category: API,
      summary: api.summary
        || (api.operations.length
          ? `${api.operations.length} operation${api.operations.length === 1 ? '' : 's'} of ${serviceTitle}.`
          : `Declared by ${serviceTitle}, with no operations in this document.`),
      blocks,
      offset: api.offset,
    });
    addEdge('Exposes', EXPOSES, serviceTitle, api.title, api.offset);
  }

  // ── servers -> external dependencies ───────────────────────────────────────
  // The first server is where this API itself answers, so its host is the
  // service's own and not a dependency; every other host is something this
  // document says the service talks to.
  const serversNode = deref(pairOf(root, 'servers')?.value);
  const swaggerHost = which === 'swagger' ? (scalarString(pairOf(root, 'host')?.value) ?? '').trim() : '';
  const serverUrls = [];
  if (isSeq(serversNode)) {
    for (const item of serversNode.items) {
      const server = deref(item);
      const urlPair = pairOf(server, 'url');
      const url = (scalarString(urlPair?.value) ?? '').trim();
      if (!url) { drop('a `servers[]` entry has no `url`'); continue; }
      serverUrls.push({ url, offset: urlPair?.key?.range?.[0] ?? server?.range?.[0] });
    }
  } else if (swaggerHost) {
    // Swagger 2.0 names one host rather than a servers array, so there is never
    // a second one — it is the service's own by definition.
    serverUrls.push({ url: `//${swaggerHost}`, offset: pairOf(root, 'host')?.key?.range?.[0] });
  }

  const ownHost = serverUrls.length ? urlHost(serverUrls[0].url) : null;
  const seenHosts = new Set([ownHost, normalizeTitle(serviceTitle)].filter(Boolean));
  for (const { url, offset } of serverUrls.slice(1)) {
    const host = urlHost(url);
    if (!host) {
      drop(`server ${JSON.stringify(url)} was skipped — no host could be read from it`);
      continue;
    }
    if (LOCAL_HOSTS.has(host) || host.startsWith('127.')) continue;
    if (seenHosts.has(host) || seenHosts.has(normalizeTitle(host))) continue;
    seenHosts.add(host);
    entities.push({
      title: host,
      category: EXTERNAL_DEPENDENCY,
      summary: `Server listed by ${serviceTitle} (${url}).`,
      blocks: [],
      offset,
    });
    addEdge('Depends on', DEPENDS, serviceTitle, host, offset);
  }

  // ── entity items ───────────────────────────────────────────────────────────
  const existingByKey = new Map(existingEntities.map(e => [normalizeTitle(e.title), e]));
  // Built once for the whole document rather than per proposed entity: the
  // near-miss scan is every proposal against every entity in the workspace.
  const nearest = nearestTitle(existingEntities);

  const items = [];
  const titleToLocal = new Map();   // exact title -> localKey
  const keyToLocal = new Map();     // normalized title -> localKey
  let e = 0;

  for (let i = 0; i < entities.length; i++) {
    // The same cap normalizeDraft and the compose producer put on a draft, for
    // the same two reasons: a draft has to be reviewable by a person, and
    // everything below this line — the near-miss scan above all — is work per item.
    if (items.length >= MAX_ITEMS) {
      drop(`item cap of ${MAX_ITEMS} reached — ${entities.length - i} further entities in the document were not proposed`);
      break;
    }
    const ent = entities[i];
    const key = normalizeTitle(ent.title);
    if (!key) { drop(`entity "${ent.title}" has no usable title`); continue; }
    if (keyToLocal.has(key)) {
      // A tag and the service, or two tags, can be one title: "Pets" and "pets".
      titleToLocal.set(ent.title, keyToLocal.get(key));
      drop(`duplicate entity "${ent.title}" within the same document`);
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
  let r = 0;
  for (let i = 0; i < edges.length; i++) {
    if (items.length >= MAX_ITEMS) {
      drop(`item cap of ${MAX_ITEMS} reached — ${edges.length - i} further relationships in the document were not proposed`);
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
        drop(`"${edge.label}" from ${edge.from} to "${name}" dropped — no proposal or entity by that name`);
      }
    }
    if (members.length < 2) continue;

    items.push({
      localKey: `r${++r}`,
      seq: items.length,
      kind: 'relationship',
      op: 'create',
      input: { evidence: evidenceAt(edge.offset), contextEntityIds: [] },
      proposed: { label: edge.label, members },
      dependsOn,
      flags: [],
    });
  }

  if (dropped > dropReasons.length) dropReasons.push(`…and ${dropped - dropReasons.length} further drops, not listed`);

  return { items, dropReasons, dropped };
}

/**
 * The lower-cased host of a server URL. Server URLs are allowed to be relative
 * (`/v2`) and to carry `{variable}` templating, neither of which names a host.
 * @returns {string|null}
 */
export function urlHost(url) {
  const raw = String(url ?? '').trim();
  if (!raw || raw.includes('{')) return null;
  try {
    // `//host/x` and `host/x` are both written in the wild; a base makes the
    // first absolute and the second stays relative, i.e. hostless.
    const parsed = new URL(raw, 'https://relative.invalid');
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return !host || host === 'relative.invalid' ? null : host;
  } catch {
    return null;
  }
}
