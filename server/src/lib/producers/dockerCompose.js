/**
 * docker-compose.yml -> draft items. The first vertical-ingestion producer.
 *
 * Deterministic on purpose: no model call, so no budget check and no
 * generation lock. The same file against the same graph always yields the same
 * draft, which is what makes it a producer a person can trust to re-run.
 *
 * The output is exactly the item shape normalizeDraft emits — server-assigned
 * localKeys, `proposed` in the shape draftItemSchema validates, the same
 * exact-normalized-title dedup — so the review UI, the decision routes, the
 * applier and the exporter handle a compose draft without knowing it is one.
 *
 * Mapping (Software Architecture vocabulary, config/templates.js):
 *
 *   services.<name>                       -> Service, or Data Store for a known image
 *   depends_on / links                    -> "Depends on" (Dependent, Dependency)
 *   env URL whose host is another service -> "Calls" (Caller, Callee)
 *   env URL whose host is not a service   -> External Dependency + "Depends on"
 *
 * Every item's evidence quote is the YAML line that produced it, with offsets
 * into the source text, so the review UI can say where each proposal came from.
 */

import { parseDocument, LineCounter, visit, isAlias, isMap, isScalar, isSeq } from 'yaml';
import { normalizeTitle, nearestTitle } from '../similarity.js';
import { DUPLICATE_THRESHOLD, MAX_ITEMS, relationshipGroupMatcher, relationshipTarget } from '../draftNormalizer.js';
import { entityTarget } from '../draftTarget.js';

export const PRODUCER = 'docker-compose';
export const PRODUCER_VERSION = 'docker-compose@1';

export const SERVICE = 'Service';
export const DATA_STORE = 'Data Store';
export const EXTERNAL_DEPENDENCY = 'External Dependency';

const TAG = 'docker-compose';

/**
 * No model reads this text, so the limit is not a cost one: it keeps the
 * request under express.json's 100KB body cap once JSON-escaped, and a draft
 * reviewable by a person. Real compose files are rarely a tenth of it.
 */
export const MAX_COMPOSE_CHARS = 60_000;

/**
 * Drop reasons are stored on the draft and read by a person, so they are
 * bounded the way the items are. A file whose service names all normalize to
 * one title — `x-1`, `x--1`, `x---1` — drops every one of them without ever
 * reaching the item cap, and 60,000 characters hold thousands. Past this the
 * drops are still counted, and the count is reported as one closing line.
 */
export const MAX_DROP_REASONS = 50;

/**
 * Images treated as data stores, matched on the image's own name — registry,
 * namespace, tag and digest stripped — so `bitnami/redis:7` and
 * `docker.io/library/postgres:16-alpine` both match. Exact names only:
 * `mongo-express` and `redis-commander` are admin UIs, i.e. services.
 * `postgresql` and `mongodb` are the vendors' own spellings of listed names.
 */
const DATA_STORE_IMAGES = new Set([
  'postgres', 'postgresql', 'mysql', 'mariadb', 'mongo', 'mongodb',
  'redis', 'memcached', 'elasticsearch', 'rabbitmq', 'kafka', 'minio',
]);

// Hosts a URL can name that are this machine, not a dependency.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'host.docker.internal']);

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>,;]+/gi;

/** A file that could not be read as compose. `line` is 1-based, or null. */
export class ComposeParseError extends Error {
  constructor(message, line = null) {
    super(message);
    this.name = 'ComposeParseError';
    this.line = line;
  }
}

/** `postgres` for `registry:5000/library/postgres:16@sha256:…`. */
export function imageName(image) {
  const withoutDigest = String(image ?? '').split('@')[0];
  const last = withoutDigest.split('/').pop() ?? '';
  return last.split(':')[0].toLowerCase();
}

export const isDataStoreImage = image => DATA_STORE_IMAGES.has(imageName(image));

const isMergeKey = key =>
  isScalar(key) && (key.source === '<<' || key.value === '<<' ||
    (typeof key.value === 'symbol' && key.value.description === '<<'));

/**
 * @param {string} text  the compose file
 * @param {object} opts
 * @param {object[]} [opts.existingEntities]  [{ _id, title, updatedAt, blocks? }] — the workspace's
 *   graph. `blocks`, when present, lets an update skip attributes the entity already has.
 * @param {object[]} [opts.existingGroups]  [{ _id, label, members: [{ refId, label }] }] — the
 *   workspace's relationship groups, so a re-import updates the links it created last time
 *   rather than stacking a second copy of each (draftNormalizer.relationshipGroupMatcher)
 * @param {number} [opts.lineOffset]  added to every line number an error names, for a caller
 *   that trimmed leading blank lines off the file before passing it in
 * @returns {{ items: object[], dropReasons: string[], dropped: number }}  `dropped`
 *   counts every drop, the ones past MAX_DROP_REASONS that are not listed included
 * @throws {ComposeParseError}
 */
export function parseCompose(text, { existingEntities = [], existingGroups = [], lineOffset = 0 } = {}) {
  const source = String(text ?? '');
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines, merge: true, prettyErrors: false });

  const lineAt = offset => (typeof offset === 'number' ? lines.linePos(offset).line + lineOffset : null);
  const onLine = line => (line ? ` on line ${line}` : '');

  if (doc.errors.length) {
    const err = doc.errors[0];
    const line = lineAt(err.pos?.[0]);
    throw new ComposeParseError(`Invalid YAML${onLine(line)}: ${err.message}`, line);
  }

  // An alias naming an anchor that is not defined above it is not a parse
  // error to the yaml package, only a throw later when the value is read.
  let unresolved = null;
  visit(doc, { Alias(_, node) { if (!unresolved && !node.resolve(doc)) unresolved = node; } });
  if (unresolved) {
    const line = lineAt(unresolved.range?.[0]);
    throw new ComposeParseError(`Invalid YAML${onLine(line)}: alias *${unresolved.source} has no anchor above it`, line);
  }

  const deref = node => {
    let n = node;
    for (let i = 0; isAlias(n) && i < 16; i++) n = n.resolve(doc);
    return n ?? null;
  };

  /** The `name` pair of a mapping, following `<<` merge keys the way compose does. */
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
      throw new ComposeParseError(`Invalid YAML${onLine(line)}: ${err.message}`, line);
    }
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

  const scalarString = node => {
    const v = toJS(node);
    return v == null || typeof v === 'object' ? null : String(v);
  };

  // ── top level ──────────────────────────────────────────────────────────────
  const root = doc.contents;
  const servicesPair = isMap(root) ? pairOf(root, 'services') : null;
  const servicesNode = deref(servicesPair?.value);
  if (!isMap(servicesNode) || !servicesNode.items.some(p => !isMergeKey(p.key))) {
    const line = lineAt(servicesPair?.key?.range?.[0]);
    throw new ComposeParseError(
      `No services found${onLine(line)} — a docker-compose file needs a top-level \`services:\` mapping.`,
      line
    );
  }

  const dropReasons = [];
  let dropped = 0;
  const drop = reason => {
    dropped++;
    if (dropReasons.length < MAX_DROP_REASONS) dropReasons.push(reason);
  };

  const existingByKey = new Map(existingEntities.map(e => [normalizeTitle(e.title), e]));
  // Built once for the whole file rather than per proposed entity: the
  // near-miss scan is every proposal against every entity in the workspace.
  const nearest = nearestTitle(existingEntities);

  // ── pass 1: read every service ─────────────────────────────────────────────
  const services = [];
  for (const pair of servicesNode.items) {
    if (isMergeKey(pair.key) || !isScalar(pair.key)) continue;
    const name = String(pair.key.value).trim();
    if (!name) { drop('service with an empty name'); continue; }
    services.push({ name, keyOffset: pair.key.range?.[0], node: deref(pair.value) });
  }

  // Service names are also DNS names on the compose network, and so are an
  // explicit hostname or container_name.
  const hostToService = new Map();
  for (const svc of services) hostToService.set(svc.name.toLowerCase(), svc.name);
  for (const svc of services) {
    for (const field of ['hostname', 'container_name']) {
      const v = scalarString(pairOf(svc.node, field)?.value);
      if (v && !v.includes('$') && !hostToService.has(v.toLowerCase())) hostToService.set(v.toLowerCase(), svc.name);
    }
  }

  // ── pass 2: entities and raw edges ─────────────────────────────────────────
  const entities = [];            // { title, category, summary, blocks, offset }
  const externals = [];           // same shape; listed after every service
  const entityByTitle = new Map();
  const edges = [];               // { label, from, to, roles, offset }
  const edgeKeys = new Set();

  const addEdge = (label, roles, from, to, offset) => {
    const key = `${label}\u0000${from}\u0000${to}`;
    if (from === to || edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ label, roles, from, to, offset });
  };
  const DEPENDS = ['Dependent', 'Dependency'];
  const CALLS = ['Caller', 'Callee'];

  for (const svc of services) {
    const image = scalarString(pairOf(svc.node, 'image')?.value);
    const build = toJS(pairOf(svc.node, 'build')?.value);
    const buildContext = typeof build === 'string' ? build : (build && typeof build.context === 'string' ? build.context : null);
    const category = image && isDataStoreImage(image) ? DATA_STORE : SERVICE;

    const blocks = [];
    if (image) blocks.push({ type: 'attribute', order: blocks.length, data: { label: 'Image', value: image } });
    const ports = toJS(pairOf(svc.node, 'ports')?.value);
    const portList = (Array.isArray(ports) ? ports : []).map(formatPort).filter(Boolean);
    if (portList.length) blocks.push({ type: 'attribute', order: blocks.length, data: { label: 'Ports', value: portList.join(', ') } });

    const entity = {
      title: svc.name,
      category,
      summary: image ? `Runs the ${image} image (docker-compose).`
        : buildContext ? `Built from ${buildContext} (docker-compose).`
        : 'Defined in docker-compose.',
      blocks,
      offset: svc.keyOffset,
    };
    entities.push(entity);
    entityByTitle.set(svc.name, entity);

    // depends_on: a list of names, or a map of name -> { condition, … }.
    const dependsNode = deref(pairOf(svc.node, 'depends_on')?.value);
    if (isSeq(dependsNode)) {
      for (const item of dependsNode.items) {
        const dep = scalarString(item);
        if (dep) addEdge('Depends on', DEPENDS, svc.name, dep, deref(item)?.range?.[0]);
      }
    } else if (isMap(dependsNode)) {
      for (const p of dependsNode.items) {
        if (isScalar(p.key) && !isMergeKey(p.key)) addEdge('Depends on', DEPENDS, svc.name, String(p.key.value), p.key.range?.[0]);
      }
    }

    // links: "service" or "service:alias".
    const linksNode = deref(pairOf(svc.node, 'links')?.value);
    if (isSeq(linksNode)) {
      for (const item of linksNode.items) {
        const link = scalarString(item);
        if (link) addEdge('Depends on', DEPENDS, svc.name, link.split(':')[0].trim(), deref(item)?.range?.[0]);
      }
    }

    // environment: URLs in values.
    for (const { key, value, offset } of envEntries(pairOf(svc.node, 'environment')?.value)) {
      for (const host of urlHosts(value)) {
        const target = hostToService.get(host);
        if (target) {
          addEdge('Calls', CALLS, svc.name, target, offset);
        } else if (!LOCAL_HOSTS.has(host) && !host.startsWith('127.')) {
          if (!entityByTitle.has(host)) {
            const external = {
              title: host,
              category: EXTERNAL_DEPENDENCY,
              summary: `External host referenced by ${svc.name} (${key}).`,
              blocks: [],
              offset,
            };
            externals.push(external);
            entityByTitle.set(host, external);
          }
          addEdge('Depends on', DEPENDS, svc.name, host, offset);
        }
      }
    }
  }

  entities.push(...externals);

  /** environment as a map ({KEY: value}) or a list (["KEY=value"]), merges followed. */
  function envEntries(node, seen = new Set(), depth = 0) {
    const n = deref(node);
    const out = [];
    if (isSeq(n)) {
      for (const item of n.items) {
        const raw = scalarString(item);
        if (!raw) continue;
        const i = raw.indexOf('=');
        const key = (i === -1 ? raw : raw.slice(0, i)).trim();
        if (i === -1 || seen.has(key)) continue;
        seen.add(key);
        out.push({ key, value: raw.slice(i + 1), offset: deref(item)?.range?.[0] });
      }
    } else if (isMap(n) && depth <= 16) {
      // Direct keys win over merged ones, so read them first.
      for (const p of n.items) {
        if (isMergeKey(p.key) || !isScalar(p.key)) continue;
        const key = String(p.key.value);
        if (seen.has(key)) continue;
        seen.add(key);
        const value = scalarString(p.value);
        if (value != null) out.push({ key, value, offset: p.key.range?.[0] });
      }
      for (const p of n.items) {
        if (!isMergeKey(p.key)) continue;
        const merged = deref(p.value);
        for (const src of isSeq(merged) ? merged.items : [merged]) out.push(...envEntries(src, seen, depth + 1));
      }
    }
    return out;
  }

  // ── entity items ───────────────────────────────────────────────────────────
  const items = [];
  const titleToLocal = new Map();   // exact title -> localKey
  const keyToLocal = new Map();     // normalized title -> localKey
  const localToTarget = new Map();  // localKey -> the entity id an update item targets
  const matchGroup = relationshipGroupMatcher(existingGroups);
  let e = 0;

  for (let i = 0; i < entities.length; i++) {
    // The same cap normalizeDraft puts on a generated draft, for the same two
    // reasons: a draft has to be reviewable by a person, and everything below
    // this line — the near-miss scan above all — is work per item.
    if (items.length >= MAX_ITEMS) {
      drop(`item cap of ${MAX_ITEMS} reached — ${entities.length - i} further entities in the file were not proposed`);
      break;
    }
    const ent = entities[i];
    const key = normalizeTitle(ent.title);
    if (!key) { drop(`entity "${ent.title}" has no usable title`); continue; }
    if (keyToLocal.has(key)) {
      // "api.stripe.com" and a service called "apistripecom" are one title.
      titleToLocal.set(ent.title, keyToLocal.get(key));
      drop(`duplicate entity "${ent.title}" within the same file`);
      continue;
    }

    const localKey = `e${++e}`;
    const existing = existingByKey.get(key);
    // One shared decision for every producer, and the blocks an update's target
    // already carries come off here when the caller has them — see lib/draftTarget.js.
    const { op, targetEntityId, baseUpdatedAt, matchedBy, blocks } = entityTarget(existing, ent.blocks);

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
  // A dependency on a service this file does not define can still land on an
  // entity the workspace already has; otherwise the edge is dropped, and said so.
  let r = 0;
  for (let i = 0; i < edges.length; i++) {
    if (items.length >= MAX_ITEMS) {
      drop(`item cap of ${MAX_ITEMS} reached — ${edges.length - i} further relationships in the file were not proposed`);
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
        drop(`"${edge.label}" from ${edge.from} to "${name}" dropped — no service or entity by that name`);
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

/** Short syntax ("8080:80", 5432) as written; long syntax as host_ip:published:target/protocol. */
function formatPort(port) {
  if (port == null) return null;
  if (typeof port !== 'object') return String(port).trim() || null;
  if (port.target == null) return null;
  const hostSide = [port.host_ip, port.published].filter(v => v != null && v !== '').join(':');
  return `${hostSide ? `${hostSide}:` : ''}${port.target}${port.protocol ? `/${port.protocol}` : ''}`;
}

/** Lower-cased hosts of every URL in `value`; interpolated hosts are skipped. */
function urlHosts(value) {
  const hosts = [];
  for (const match of String(value ?? '').matchAll(URL_RE)) {
    const authority = match[0].split('://')[1]?.split(/[/?#]/)[0] ?? '';
    if (authority.includes('$')) continue;
    let host;
    try { host = new URL(match[0]).hostname; } catch { continue; }
    host = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}
