/**
 * Kubernetes manifests -> draft items. The third vertical-ingestion producer.
 *
 * Deterministic, exactly as the compose and OpenAPI producers are
 * (lib/producers/dockerCompose.js, lib/producers/openApi.js): no model call,
 * so no allowance check and no generation lock, and the same file against the
 * same graph always yields the same draft — which is the property that makes a
 * producer safe to re-run. The output is in the shape normalizeDraft emits —
 * server-assigned localKeys, `proposed` as draftItemSchema validates it, the
 * same exact-normalized-title dedup — so the review UI, the decision routes,
 * the applier and the exporter handle a manifest draft without knowing it is one.
 *
 * Multi-document YAML is the normal shape of a manifest, so the DOCUMENT is
 * the unit of iteration: `kubectl kustomize`, `helm template` and every `-o
 * yaml` dump of a namespace emit one stream of `---`-separated objects, and a
 * producer that read only the first of them would read a Deployment and miss
 * the Service in front of it.
 *
 * Mapping (Software Architecture vocabulary, config/templates.js):
 *
 *   Deployment / StatefulSet / DaemonSet  -> Service, or Data Store when the
 *                                            image is one the compose producer
 *                                            already knows as a data store
 *   Service                               -> API per port + "Exposes"
 *                                            (Provider, Endpoint) from the
 *                                            workload its selector matches
 *   PersistentVolumeClaim                 -> Data Store
 *   env / envFrom URL host naming another
 *     workload (or a Service in front of
 *     one)                                -> "Calls" (Caller, Callee)
 *   env / envFrom URL host naming nothing
 *     in the file                         -> External Dependency + "Depends on"
 *
 * NAMESPACES: the input the header above invites is a whole cluster, and in one
 * of those a name is not unique — two teams run a `cache`, and a host that
 * carries a namespace means THAT namespace. So every object's namespace is
 * recorded (`default` when it declares none); a name that appears in more than
 * one of them is titled `name.namespace`, so both objects are proposed instead
 * of the second being dropped as a duplicate of the first; a Service's selector
 * reaches only its own namespace, as Kubernetes' does; and a host is resolved
 * against the namespace it names, or the reading pod's own (resolveHost).
 * KOL-118.
 *
 * A `kind` this mapping has no reading for — Ingress, HorizontalPodAutoscaler,
 * CustomResourceDefinition, anything a controller of its own owns — is a drop
 * reason naming the kind, not a refusal: a namespace dump is mostly objects
 * this producer has nothing to say about, and refusing the whole stream over
 * one of them would cost a reviewer every workload in it.
 *
 * SECRETS: a Secret's values are never read, and the route redacts before this
 * ever sees the text (routes/drafts.js -> lib/producers/redactSecrets.js). A
 * manifest's env values are the reason that redactor learned the Kubernetes
 * `{ name, value }` env shape and the `kind: Secret` rule: `Draft` has no TTL
 * and the exporter carries `source.text` and every evidence quote out verbatim.
 *
 * Every item's evidence quote is the source line that produced it, with offsets
 * into the source text, so the review UI can say where each proposal came from.
 *
 * NOTE ON DUPLICATION: the tail of this file — dedup against the roster, the
 * item cap, the near-miss scan, the relationship items — still follows the
 * other two producers line for line, because all three have to emit the same
 * shape. KOL-051 called extracting it this producer's job; it is not done here,
 * and the Decision Log entry for KOL-089 says why (the mapping is the third
 * SHAPE, but the tail is identical in all three only while none of them needs a
 * shape the others do not — the right time to generalise is a producer whose
 * items are not entities and two-member groups).
 */

import { parseAllDocuments, LineCounter, visit, isAlias, isMap, isScalar, isSeq } from 'yaml';
import { normalizeTitle, nearestTitle } from '../similarity.js';
import { DUPLICATE_THRESHOLD, MAX_ITEMS, relationshipGroupMatcher, relationshipTarget } from '../draftNormalizer.js';
import { MAX_COMPOSE_CHARS, MAX_DROP_REASONS, isDataStoreImage, withoutKnownBlocks } from './dockerCompose.js';

export const PRODUCER = 'kubernetes';
export const PRODUCER_VERSION = 'kubernetes@1';

export const SERVICE = 'Service';
export const DATA_STORE = 'Data Store';
export const API = 'API';
export const EXTERNAL_DEPENDENCY = 'External Dependency';

const TAG = 'kubernetes';

/**
 * The same character cap the other two producers carry, and for the same
 * reasons: no model reads this text, so the limit is not a cost one — it keeps
 * the request under express.json's 100KB body cap once JSON-escaped, and the
 * draft reviewable by a person. Shared rather than re-declared so the three
 * cannot drift into refusing files of different sizes.
 */
export const MAX_KUBERNETES_CHARS = MAX_COMPOSE_CHARS;

/** Workload kinds that run containers, i.e. the ones that become an entity. */
const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

/**
 * The namespace an object that declares none lives in, which is Kubernetes' own
 * default. It is a real namespace name, not a placeholder: `postgres.default` is
 * the DNS name of a `postgres` that declares no `metadata.namespace`.
 */
const DEFAULT_NAMESPACE = 'default';

/**
 * The kinds whose `metadata.name` becomes part of an entity title — a workload's
 * or a claim's title outright, a Service's the stem of one API title per port.
 * Which namespaces each of those names appears in is what decides whether the
 * title needs qualifying (KOL-118).
 */
const TITLED_KINDS = new Set([...WORKLOAD_KINDS, 'PersistentVolumeClaim', 'Service']);

/**
 * Kinds this mapping deliberately passes over without a drop reason: they
 * carry no architecture of their own, or they are read as part of something
 * else. A ConfigMap is read — its values are where an envFrom URL lives — but
 * it is not an entity: a graph with one node per ConfigMap says nothing a
 * reviewer wants. A Secret is never read at all.
 */
const QUIET_KINDS = new Set([
  'ConfigMap', 'Secret', 'Namespace', 'ServiceAccount', 'List',
]);

// Hosts a URL can name that are the pod itself, not a dependency.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>,;]+/gi;

/** The cluster-DNS suffixes a Service's own name hides behind. */
const CLUSTER_SUFFIX_RE = /\.svc(\.cluster\.local)?\.?$/;

/** A file that could not be read as Kubernetes manifests. `line` is 1-based, or null. */
export class KubernetesParseError extends Error {
  constructor(message, line = null) {
    super(message);
    this.name = 'KubernetesParseError';
    this.line = line;
  }
}

/**
 * @param {string} text  one or more Kubernetes manifests, as a `---` stream
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
 * @throws {KubernetesParseError}
 */
export function parseKubernetes(text, { existingEntities = [], existingGroups = [], lineOffset = 0 } = {}) {
  const source = String(text ?? '');
  const lines = new LineCounter();
  // Every document in the stream, against ONE line counter, so an offset is an
  // offset into the whole file and a line number is the line the person sees.
  const docs = parseAllDocuments(source, { lineCounter: lines, merge: true, prettyErrors: false });

  const lineAt = offset => (typeof offset === 'number' ? lines.linePos(offset).line + lineOffset : null);
  const onLine = line => (line ? ` on line ${line}` : '');

  for (const doc of docs) {
    if (!doc.errors.length) continue;
    const err = doc.errors[0];
    const line = lineAt(err.pos?.[0]);
    throw new KubernetesParseError(`Invalid YAML${onLine(line)}: ${err.message}`, line);
  }

  // An alias naming an anchor that is not defined above it is not a parse error
  // to the yaml package, only a throw later when the value is read.
  let unresolved = null;
  for (const doc of docs) {
    visit(doc, { Alias(_, node) { if (!unresolved && !node.resolve(doc)) unresolved = node; } });
  }
  if (unresolved) {
    const line = lineAt(unresolved.range?.[0]);
    throw new KubernetesParseError(
      `Invalid YAML${onLine(line)}: alias *${unresolved.source} has no anchor above it`, line);
  }

  // ── the per-document readers ───────────────────────────────────────────────
  // Each closes over the document it reads, because an alias resolves against
  // its own document and nothing else in the stream.
  const readerFor = doc => {
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

    /** `a.b.c` — the pair at the end of a path of mappings. */
    const pairAt = (map, path) => {
      let node = map, pair = null;
      for (const segment of path) {
        pair = pairOf(node, segment);
        if (!pair) return null;
        node = pair.value;
      }
      return pair;
    };
    const nodeAt = (map, path) => deref(pairAt(map, path)?.value);

    /** Plain JS for a node. maxAliasCount stops an alias bomb from expanding. */
    const toJS = node => {
      const n = deref(node);
      if (n == null) return null;
      try {
        return typeof n.toJS === 'function' ? n.toJS(doc, { maxAliasCount: 100 }) : n;
      } catch (err) {
        const line = lineAt(n.range?.[0]);
        throw new KubernetesParseError(`Invalid YAML${onLine(line)}: ${err.message}`, line);
      }
    };

    const scalarString = node => {
      const v = toJS(node);
      return v == null || typeof v === 'object' ? null : String(v);
    };

    const seqItems = node => {
      const n = deref(node);
      return isSeq(n) ? n.items.map(deref).filter(Boolean) : [];
    };

    return { deref, isMergeKey, pairOf, pairAt, nodeAt, toJS, scalarString, seqItems };
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

  // ── is this a manifest at all? ─────────────────────────────────────────────
  // An object in a stream is identified by `apiVersion` + `kind`, so a file in
  // which no document carries both is not a manifest and is refused by name.
  // Anything less — reading one Deployment out of a CI config that happens to
  // have a `kind:` in it — would propose nonsense from a file the person
  // picked by mistake.
  const objects = [];
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const read = readerFor(doc);
    const root = read.deref(doc.contents);
    if (!isMap(root)) continue;
    const kindPair = read.pairOf(root, 'kind');
    const kind = (read.scalarString(kindPair?.value) ?? '').trim();
    const apiVersion = (read.scalarString(read.pairOf(root, 'apiVersion')?.value) ?? '').trim();
    if (!kind || !apiVersion) continue;
    const name = (read.scalarString(read.nodeAt(root, ['metadata', 'name'])) ?? '').trim();
    // The namespace this object LIVES IN, kept per object rather than pooled
    // into one set of every namespace the file mentions. The pooled set could
    // only say that `prod` was a namespace somewhere in the stream, so a host
    // of `cache.prod` resolved to any workload named `cache` — one in `team-b`
    // included. Per object, `cache.prod` reaches the `cache` in `prod` and
    // nothing else, and two workloads called `cache` in two namespaces are two
    // objects rather than one that shadows the other (KOL-118).
    const declared = (read.scalarString(read.nodeAt(root, ['metadata', 'namespace'])) ?? '').trim();
    objects.push({
      index: i, read, root, kind, apiVersion, name,
      namespace: (declared || DEFAULT_NAMESPACE).toLowerCase(),
      declaredNamespace: declared || null,
      kindOffset: kindPair?.key?.range?.[0],
    });
  }

  if (!objects.length) {
    const only = docs.length === 1 ? 'the document' : `none of the ${docs.length} documents`;
    throw new KubernetesParseError(
      `Not a Kubernetes manifest — ${only} in this file declares both \`apiVersion\` and \`kind\`. ` +
      'This producer reads a `---` stream of Kubernetes objects.',
      lineAt(docs[0]?.contents?.range?.[0]));
  }

  const dropReasons = [];
  let dropped = 0;
  const drop = reason => {
    dropped++;
    if (dropReasons.length < MAX_DROP_REASONS) dropReasons.push(reason);
  };

  const where = obj => `${obj.kind}${obj.name ? ` "${obj.name}"` : ''}`;

  // Which namespaces each title-bearing name appears in. A name that appears in
  // one keeps it — which is every single-namespace file, i.e. nearly all of them
  // — and a name in two is two different objects, so each is titled
  // `name.namespace` and BOTH are proposed. Keyed on the bare name alone rather
  // than per kind, so a Deployment and the Service in front of it still agree on
  // whether the name needs qualifying.
  const namespacesOfName = new Map();
  for (const obj of objects) {
    if (!obj.name || !TITLED_KINDS.has(obj.kind)) continue;
    const key = obj.name.toLowerCase();
    if (!namespacesOfName.has(key)) namespacesOfName.set(key, new Set());
    namespacesOfName.get(key).add(obj.namespace);
  }
  const titleFor = obj => (namespacesOfName.get(obj.name.toLowerCase())?.size > 1
    ? `${obj.name}.${obj.namespace}`
    : obj.name);

  /** The namespace an object declares, as a block, so a reviewer can tell two same-named objects apart. */
  const namespaceBlock = (obj, blocks) => {
    if (obj.declaredNamespace) {
      blocks.push({ type: 'attribute', order: blocks.length, data: { label: 'Namespace', value: obj.declaredNamespace } });
    }
    return blocks;
  };

  // ── pass 1: workloads, claims, config maps ─────────────────────────────────
  const entities = [];            // { title, category, summary, blocks, offset }
  const externals = [];           // same shape; listed after everything in the file
  const entityByTitle = new Map();
  const workloads = [];           // { name, obj, labels, containers }
  const configMaps = new Map();   // name -> { values: [{ key, value, offset }] }
  const edges = [];               // { label, roles, from, to, offset }
  const edgeKeys = new Set();

  const addEdge = (label, roles, from, to, offset) => {
    const key = `${label}\u0000${from}\u0000${to}`;
    if (from === to || edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ label, roles, from, to, offset });
  };
  const DEPENDS = ['Dependent', 'Dependency'];
  const CALLS = ['Caller', 'Callee'];
  const EXPOSES = ['Provider', 'Endpoint'];

  const services = [];            // k8s Service objects, read in pass 2
  for (const obj of objects) {
    const { read, root, kind, name } = obj;

    if (kind === 'ConfigMap') {
      const values = [];
      const dataNode = read.nodeAt(root, ['data']);
      if (isMap(dataNode)) {
        for (const p of dataNode.items) {
          if (read.isMergeKey(p.key) || !isScalar(p.key)) continue;
          const value = read.scalarString(p.value);
          if (value != null) values.push({ key: String(p.key.value), value, offset: p.key.range?.[0] });
        }
      }
      if (name) configMaps.set(name, { values });
      continue;
    }

    if (kind === 'Service') { services.push(obj); continue; }

    if (QUIET_KINDS.has(kind)) continue;

    if (!name) {
      drop(`a ${kind} has no \`metadata.name\`, so there is nothing to title it after`);
      continue;
    }

    if (kind === 'PersistentVolumeClaim') {
      const blocks = [];
      const storage = read.scalarString(read.nodeAt(root, ['spec', 'resources', 'requests', 'storage']));
      if (storage) blocks.push({ type: 'attribute', order: blocks.length, data: { label: 'Storage', value: storage } });
      const modes = read.seqItems(read.nodeAt(root, ['spec', 'accessModes']))
        .map(n => read.scalarString(n)).filter(Boolean);
      if (modes.length) blocks.push({ type: 'attribute', order: blocks.length, data: { label: 'Access modes', value: modes.join(', ') } });
      const className = read.scalarString(read.nodeAt(root, ['spec', 'storageClassName']));
      if (className) blocks.push({ type: 'attribute', order: blocks.length, data: { label: 'Storage class', value: className } });
      namespaceBlock(obj, blocks);
      const title = titleFor(obj);
      const claim = {
        title,
        category: DATA_STORE,
        summary: storage
          ? `Claims ${storage} of storage (Kubernetes PersistentVolumeClaim).`
          : 'Kubernetes PersistentVolumeClaim.',
        blocks,
        offset: obj.kindOffset,
      };
      entities.push(claim);
      if (!entityByTitle.has(title)) entityByTitle.set(title, claim);
      continue;
    }

    if (!WORKLOAD_KINDS.has(kind)) {
      drop(`${where(obj)} was skipped — this producer has no reading for \`kind: ${kind}\``);
      continue;
    }

    // A workload's containers, and the pod labels a Service's selector matches.
    const podSpec = read.nodeAt(root, ['spec', 'template', 'spec']);
    const containers = [
      ...read.seqItems(read.nodeAt(podSpec, ['containers'])),
      ...read.seqItems(read.nodeAt(podSpec, ['initContainers'])),
    ];
    const labels = {};
    const labelsNode = read.nodeAt(root, ['spec', 'template', 'metadata', 'labels']);
    if (isMap(labelsNode)) {
      for (const p of labelsNode.items) {
        if (read.isMergeKey(p.key) || !isScalar(p.key)) continue;
        const value = read.scalarString(p.value);
        if (value != null) labels[String(p.key.value)] = value;
      }
    }

    const images = containers.map(c => read.scalarString(read.pairOf(c, 'image')?.value)).filter(Boolean);
    const image = images[0] ?? null;
    const category = image && isDataStoreImage(image) ? DATA_STORE : SERVICE;

    const blocks = [{ type: 'attribute', order: 0, data: { label: 'Kind', value: `${kind} (${obj.apiVersion})` } }];
    if (images.length) {
      blocks.push({ type: 'attribute', order: blocks.length, data: { label: 'Image', value: images.join(', ') } });
    }
    const replicas = read.scalarString(read.nodeAt(root, ['spec', 'replicas']));
    if (replicas != null) {
      blocks.push({ type: 'attribute', order: blocks.length, data: { label: 'Replicas', value: replicas } });
    }
    namespaceBlock(obj, blocks);

    const title = titleFor(obj);
    const entity = {
      title,
      category,
      summary: image
        ? `Runs the ${image} image (Kubernetes ${kind}).`
        : `Kubernetes ${kind}.`,
      blocks,
      offset: obj.kindOffset,
    };
    entities.push(entity);
    if (!entityByTitle.has(title)) entityByTitle.set(title, entity);
    workloads.push({ name, title, namespace: obj.namespace, obj, read, labels, containers });
    if (!containers.length) drop(`${where(obj)} declares no containers`);
  }

  // ── pass 2: Services -> an API per port, exposed by the workload they select ─
  // A host inside the cluster is a Service name, not a workload name, so this
  // pass is also what lets an env URL of `postgres:5432` reach the StatefulSet
  // behind the Service called `postgres`.
  // `name` -> `namespace` -> the entity title that pair resolves to. Nested
  // rather than one map keyed `name.namespace`, because the set of namespaces a
  // name appears in is exactly what decides whether a BARE host is readable:
  // one namespace and it names that object, several and it names whichever one
  // sits beside the reading pod — or nothing at all (resolveHost, KOL-118).
  const hostToEntity = new Map();
  const addHost = (name, namespace, title) => {
    const key = name.toLowerCase();
    let perNamespace = hostToEntity.get(key);
    if (!perNamespace) hostToEntity.set(key, perNamespace = new Map());
    // First binding of a (name, namespace) wins, which is how a workload's own
    // name keeps precedence over a Service alias onto something else.
    if (!perNamespace.has(namespace)) perNamespace.set(namespace, title);
  };
  for (const w of workloads) addHost(w.name, w.namespace, w.title);

  for (const obj of services) {
    const { read, root, name } = obj;
    if (!name) {
      drop('a Service has no `metadata.name`, so there is nothing to title its APIs after');
      continue;
    }

    const selector = {};
    const selectorPair = read.pairAt(root, ['spec', 'selector']);
    const selectorNode = read.deref(selectorPair?.value);
    if (isMap(selectorNode)) {
      for (const p of selectorNode.items) {
        if (read.isMergeKey(p.key) || !isScalar(p.key)) continue;
        const value = read.scalarString(p.value);
        if (value != null) selector[String(p.key.value)] = value;
      }
    }

    // All of the selector's labels have to match, AND the workload has to be in
    // the Service's own namespace, which is what Kubernetes itself does: a
    // selector reaches pods beside it and never across a namespace boundary. A
    // Service with no selector (ExternalName, or one whose Endpoints are managed
    // by hand) selects nothing by definition.
    const matches = Object.keys(selector).length
      ? workloads.filter(w => w.namespace === obj.namespace
        && Object.entries(selector).every(([k, v]) => w.labels[k] === v))
      : [];

    const provider = matches[0]?.title ?? null;
    if (!Object.keys(selector).length) {
      drop(`Service "${name}" has no \`spec.selector\`, so no workload in this file provides it`);
    } else if (!provider) {
      const described = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(', ');
      drop(`Service "${name}" selects ${described}, which no workload in namespace ` +
        `\`${obj.namespace}\` carries`);
    } else if (matches.length > 1) {
      drop(`Service "${name}" selects ${matches.length} workloads (${matches.map(w => w.title).join(', ')}); ` +
        `"${provider}" is proposed as its provider`);
    }

    // The Service's name is the DNS name every other pod reaches it on, so it
    // resolves to the workload behind it rather than to one of its APIs — and
    // only for pods that reach it by the namespace it is actually in.
    if (provider) addHost(name, obj.namespace, provider);

    const ports = read.seqItems(read.nodeAt(root, ['spec', 'ports']));
    if (!ports.length) {
      drop(`Service "${name}" declares no ports, so it exposes no API`);
      continue;
    }

    for (const port of ports) {
      const portPair = read.pairOf(port, 'port');
      const number = read.scalarString(portPair?.value);
      if (number == null) {
        drop(`a port of Service "${name}" has no \`port\`, so there is nothing to title an API after`);
        continue;
      }
      const title = `${titleFor(obj)}:${number}`;
      const protocol = read.scalarString(read.pairOf(port, 'protocol')?.value) ?? 'TCP';
      const target = read.scalarString(read.pairOf(port, 'targetPort')?.value);
      const portName = read.scalarString(read.pairOf(port, 'name')?.value);
      const type = read.scalarString(read.nodeAt(root, ['spec', 'type'])) ?? 'ClusterIP';
      const offset = portPair?.key?.range?.[0] ?? obj.kindOffset;

      const blocks = namespaceBlock(obj, [
        { type: 'attribute', order: 0, data: { label: 'Port', value: `${number}/${protocol}${target ? ` → ${target}` : ''}` } },
        { type: 'attribute', order: 1, data: { label: 'Service type', value: type } },
      ]);
      const api = {
        title,
        category: API,
        summary: portName
          ? `The ${portName} port of Kubernetes Service ${name}.`
          : `Port ${number} of Kubernetes Service ${name}.`,
        blocks,
        offset,
      };
      entities.push(api);
      if (!entityByTitle.has(title)) entityByTitle.set(title, api);
      if (provider) addEdge('Exposes', EXPOSES, provider, title, offset);
    }
  }

  // ── pass 3: env and envFrom URLs -> Calls, or an External Dependency ───────
  for (const w of workloads) {
    const { read } = w;
    for (const { key, value, offset } of envEntries(w, read, configMaps)) {
      for (const host of urlHosts(value)) {
        const { target, ambiguousIn } = resolveHost(host, hostToEntity, w.namespace);
        if (target) {
          addEdge('Calls', CALLS, w.title, target, offset);
        } else if (ambiguousIn) {
          // The file DOES name this host, in several namespaces and none of them
          // this pod's, so the External Dependency reading — "a host naming
          // nothing in the file" (see the mapping at the top) — is not true of
          // it, and picking one of the candidates would be a guess. So it is
          // said out loud and nothing is proposed, the same as any other
          // reference this producer cannot read (KOL-118).
          drop(`"${host}" in ${w.title}'s ${key} names an object in ` +
            `${ambiguousIn.map(ns => `\`${ns}\``).join(' and ')} and none in \`${w.namespace}\`, ` +
            'so nothing was proposed for it');
        } else if (!LOCAL_HOSTS.has(host) && !host.startsWith('127.')) {
          if (!entityByTitle.has(host)) {
            const external = {
              title: host,
              category: EXTERNAL_DEPENDENCY,
              summary: `External host referenced by ${w.title} (${key}).`,
              blocks: [],
              offset,
            };
            externals.push(external);
            entityByTitle.set(host, external);
          }
          addEdge('Depends on', DEPENDS, w.title, host, offset);
        }
      }
    }
  }

  entities.push(...externals);

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
    // The same cap normalizeDraft and the other two producers put on a draft,
    // for the same two reasons: a draft has to be reviewable by a person, and
    // everything below this line — the near-miss scan above all — is work per item.
    if (items.length >= MAX_ITEMS) {
      drop(`item cap of ${MAX_ITEMS} reached — ${entities.length - i} further entities in the file were not proposed`);
      break;
    }
    const ent = entities[i];
    const key = normalizeTitle(ent.title);
    if (!key) { drop(`entity "${ent.title}" has no usable title`); continue; }
    if (keyToLocal.has(key)) {
      // A Deployment and a PersistentVolumeClaim are free to share a name, and
      // "web:80" and "web-80" are one title.
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
  // An edge to a name this file does not define can still land on an entity the
  // workspace already has; otherwise it is dropped, and said so.
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
        drop(`"${edge.label}" from ${edge.from} to "${name}" dropped — no workload or entity by that name`);
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
 * Every environment value a workload's containers can be read from in this
 * file: `env[].value`, and the ConfigMap values an `envFrom[].configMapRef`
 * pulls in wholesale. `secretRef` is deliberately not followed — a Secret's
 * values are redacted before this producer runs, so there is nothing there to
 * read, and a graph edge is not worth asking for one.
 *
 * The first binding of a name wins, the way a container's own `env` overrides
 * what `envFrom` brought in.
 */
function envEntries(workload, read, configMaps) {
  const out = [];
  const seen = new Set();
  const add = (key, value, offset) => {
    if (!key || seen.has(key) || value == null) return;
    seen.add(key);
    out.push({ key, value, offset });
  };

  for (const container of workload.containers) {
    for (const entry of read.seqItems(read.pairOf(container, 'env')?.value)) {
      const namePair = read.pairOf(entry, 'name');
      const name = (read.scalarString(namePair?.value) ?? '').trim();
      // `valueFrom` is a reference to a key of a ConfigMap or Secret, which
      // names no host of its own; only a literal `value` is read.
      add(name, read.scalarString(read.pairOf(entry, 'value')?.value), namePair?.key?.range?.[0]);
    }
  }
  for (const container of workload.containers) {
    for (const entry of read.seqItems(read.pairOf(container, 'envFrom')?.value)) {
      const refPair = read.pairAt(entry, ['configMapRef', 'name']);
      const name = (read.scalarString(refPair?.value) ?? '').trim();
      const configMap = name ? configMaps.get(name) : null;
      if (!configMap) continue;
      for (const { key, value, offset } of configMap.values) add(key, value, offset);
    }
  }
  return out;
}

/**
 * What an env URL's host names: `{ target }` when it reaches one entity in this
 * file, `{ ambiguousIn: [namespace, …] }` when the name is in the file but in
 * several namespaces and none of them the reading pod's, and neither when it
 * names nothing here at all.
 *
 * `hostToEntity` is `name` -> `namespace` -> entity title, so the namespace a
 * host carries is CHECKED rather than thrown away. Four readings, in order:
 *
 *   `postgres`                            an exact name wins first, because a
 *                                         workload name may be a DNS subdomain
 *                                         and so may carry a dot of its own
 *   `postgres`                            else the `postgres` in the reading
 *                                         pod's own namespace — where Kubernetes
 *                                         looks first — and failing that the
 *                                         only `postgres` in the file
 *   `postgres.prod`                       the `postgres` in `prod`, and nothing
 *                                         else: a `postgres` in `team-b` is a
 *                                         different object and this host does
 *                                         not name it
 *   `postgres.prod.svc[.cluster.local]`   the `postgres` in `prod`; failing
 *                                         that the only `postgres` in the file,
 *                                         because the suffix is already proof
 *                                         the host is inside the cluster and a
 *                                         manifest is free to reach a namespace
 *                                         no document here declares
 *
 * What this refuses is as much the point as what it resolves. The first label of
 * a host is NOT a candidate on its own: the fallback used to apply
 * `.split('.')[0]` to every host, whether or not a cluster suffix had just come
 * off it, so any external FQDN whose first label happened to collide with a
 * workload or Service name in the same file became an internal `Calls` edge — a
 * stream carrying a Deployment called `api` beside a `web` whose env holds
 * `https://api.stripe.com/v1` proposed `Calls web → api` and never proposed
 * `api.stripe.com` as a dependency at all, and had the env been on `api` itself,
 * addEdge's self-edge guard would have dropped the host without proposing
 * anything (KOL-111). And a NAMESPACE is not a candidate on its own either: a
 * two-label host used to resolve on nothing more than its second label being a
 * namespace named somewhere in the stream, so in `kubectl get all -A` output —
 * the input this producer's own header invites — `cache.prod` reached a `cache`
 * in `team-b` and proposed a `Calls` edge to the wrong object (KOL-118).
 */
function resolveHost(host, hostToEntity, readerNamespace) {
  const exact = readIn(hostToEntity.get(host), readerNamespace);
  if (exact.target || exact.ambiguousIn) return exact;

  if (CLUSTER_SUFFIX_RE.test(host)) {
    // `postgres.prod.svc.cluster.local` -> the `postgres` in `prod`, or the only
    // `postgres` there is. Matching the namespace is preferred but not required
    // here, which is the one place a cluster name is read more loosely than a
    // bare `name.namespace`: the suffix says the host is in-cluster, and the
    // namespace it names may belong to no document in the file.
    const labels = host.replace(CLUSTER_SUFFIX_RE, '').split('.');
    const perNamespace = hostToEntity.get(labels[0]);
    if (labels.length === 2 && perNamespace?.has(labels[1])) {
      return { target: perNamespace.get(labels[1]), ambiguousIn: null };
    }
    return readIn(perNamespace, readerNamespace);
  }

  const labels = host.split('.');
  if (labels.length === 2) {
    const perNamespace = hostToEntity.get(labels[0]);
    if (perNamespace?.has(labels[1])) return { target: perNamespace.get(labels[1]), ambiguousIn: null };
  }
  return { target: null, ambiguousIn: null };
}

/**
 * One name's `namespace` -> title map, read the way a pod in `readerNamespace`
 * reads a bare host: its own namespace first, because that is where Kubernetes'
 * search path looks; then, when the name is in exactly one namespace, that one,
 * so a file whose manifests are vague about namespaces still resolves the way it
 * always did. A name in SEVERAL namespaces, none of them the reader's, names no
 * one thing — it reports the candidates rather than picking one of them.
 */
function readIn(perNamespace, readerNamespace) {
  if (!perNamespace?.size) return { target: null, ambiguousIn: null };
  if (perNamespace.has(readerNamespace)) {
    return { target: perNamespace.get(readerNamespace), ambiguousIn: null };
  }
  if (perNamespace.size === 1) return { target: [...perNamespace.values()][0], ambiguousIn: null };
  return { target: null, ambiguousIn: [...perNamespace.keys()].sort() };
}

/** Lower-cased hosts of every URL in `value`; templated hosts are skipped. */
function urlHosts(value) {
  const hosts = [];
  for (const match of String(value ?? '').matchAll(URL_RE)) {
    const authority = match[0].split('://')[1]?.split(/[/?#]/)[0] ?? '';
    // `$(VAR)` is Kubernetes' own expansion, `${VAR}` and `{{ … }}` a
    // templating tool's: none of them names a host this file can resolve.
    if (/[${}]/.test(authority)) continue;
    let host;
    try { host = new URL(match[0]).hostname; } catch { continue; }
    host = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}
