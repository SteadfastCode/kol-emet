import Workspace from '../models/Workspace.js';
import Entity from '../models/Entity.js';
import EntityType from '../models/EntityType.js';
import RelationshipType from '../models/RelationshipType.js';
import RelationshipGroup from '../models/RelationshipGroup.js';
import OpenQuestion from '../models/OpenQuestion.js';

/**
 * The canonical serializable form of one workspace's graph (KOL-070).
 *
 * This is the shape a user leaving the product takes with them, and the shape a
 * Git connector will have to round-trip — "give the graph a canonical
 * serializable form" is step one of the repo-resident graph on the roadmap, and
 * nothing can round-trip a form that does not exist. `lib/draftExporter.js`
 * next door exports *decision records* as JSONL training data; this exports
 * content.
 *
 * Two properties are the whole design:
 *
 *   **Deterministic.** The same graph exported twice is byte-identical, because
 *   diffability is the point: a Git connector commits this file, and an export
 *   that reshuffled its own rows would show every line as changed on every
 *   sync. So every collection is sorted here, in JavaScript, by a stable key —
 *   entities by `title` then `_id`, types by `order` then `name` then `_id`,
 *   groups and questions by `_id` — rather than left in Mongo's natural order
 *   or sorted by the database, whose result depends on index availability and
 *   collation. String comparison is `<`/`>` on the raw strings and never
 *   `localeCompare`, whose answer depends on the host's ICU data. Object keys
 *   are written by the literals below, so `JSON.stringify` emits them in one
 *   fixed order. The *only* field that is not a function of the data is
 *   `exportedAt`, which is therefore injected rather than read from the clock
 *   in here: a caller that needs byte-identity (a test, a Git connector that
 *   does not want a no-op commit) passes the timestamp it wants.
 *
 *   **An allowlist, not a redaction.** Every document is rebuilt field by field
 *   below. Nothing reaches the output because it was on the document — so a
 *   schema field added later (a per-entity owner, a cached secret, a billing
 *   flag) cannot leak into a user-facing file by default, which is the failure
 *   mode a `delete doc.workspaceId` pass has. Deliberately absent: the user and
 *   their credentials, the session store, the workspace's `aiBudget` and
 *   members, `workspaceId` on every document (an export is one workspace, so
 *   the key says nothing and importing it elsewhere would be wrong), `__v`,
 *   `RelationshipGroup.entityId` (a dead legacy field), and ChangeLog and Draft
 *   entirely — history is out of scope until KOL-019 settles whether it is
 *   permanent, and a draft is a review artefact, not graph content.
 *
 * Array order *within* a document is left exactly as stored wherever position
 * carries meaning — a relationship group's `members` are ordered by a reorder
 * route, and blocks carry an explicit `order` they are sorted by. The two id
 * arrays that are sets rather than sequences (`relationships`,
 * `open_questions`, `entry_ids`) are sorted, because otherwise two identical
 * graphs would export differently depending on which edge was added first.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * EXPORT_LOG_LEVEL = off | light | normal | verbose (default light)
 * An export that silently omits a collection leaves a count as its only trace,
 * so the counts are on by default and every line names its source — this
 * route, or a script that calls the same function.
 *   off     — nothing
 *   light   — one line per export: the workspace, the per-collection counts and
 *             the source; the route adds the byte size it sent
 *   normal  — light, plus the sort keys the ordering came out as
 *   verbose — normal, plus every exported title and id
 */

/** The schema identifier written into every export. Bump it on a shape change. */
export const EXPORT_VERSION = 'kol-emet/workspace-export@1';

/** The collections an export carries, in the order they appear in the document. */
export const EXPORT_COLLECTIONS = Object.freeze([
  'entityTypes', 'relationshipTypes', 'entities', 'relationshipGroups', 'openQuestions',
]);

/** Longest slug an export filename's name part may be, before the date. */
const MAX_SLUG = 60;

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

/**
 * The tiered logger for everything export — exported so `routes/export.js` and
 * any later script log under the one `EXPORT_LOG_LEVEL` rather than each
 * growing a level of its own.
 */
export function exportLog(level, msg) {
  // Resolved per call, not at module load, so a test can change it.
  const active = LEVELS[process.env.EXPORT_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[export:${level}] ${msg}`);
}

/** An ObjectId (or anything id-shaped) as a string; null stays null. */
const asId = (value) => (value == null ? null : String(value));

/** A Date as an ISO-8601 string; null/undefined stay null. */
const asDate = (value) => (value == null ? null : new Date(value).toISOString());

/** Byte-order string compare. Not `localeCompare`: its result depends on ICU data. */
function cmpString(a, b) {
  const left = a ?? '';
  const right = b ?? '';
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A set of ids, stringified and sorted — position in these arrays means nothing. */
const asIdSet = (values) => (values ?? []).map(asId).filter(Boolean).sort(cmpString);

const byId = (a, b) => cmpString(a._id, b._id);
const byTitleThenId = (a, b) => cmpString(a.title, b.title) || cmpString(a._id, b._id);

/**
 * Types sort by display order, then name, then id. `order` is read with a
 * default because `RelationshipType` has no such field — its vocabulary sorts
 * by name, and giving it a key it does not have would be a lie in the document.
 */
const byOrderThenName = (a, b) =>
  (Number(a.order ?? 0) - Number(b.order ?? 0)) || cmpString(a.name, b.name) || cmpString(a._id, b._id);

function exportBlock(block) {
  return {
    _id: asId(block._id),
    type: block.type ?? null,
    order: Number(block.order ?? 0),
    data: block.data ?? null,
  };
}

function exportEntity(doc) {
  return {
    _id: asId(doc._id),
    title: doc.title ?? null,
    category: doc.category ?? null,
    summary: doc.summary ?? null,
    tags: [...(doc.tags ?? [])],
    // Blocks carry an explicit `order`, so that — not array position — is the
    // canonical sequence; `_id` breaks a tie the route's densify should prevent.
    blocks: (doc.blocks ?? [])
      .map(exportBlock)
      .sort((a, b) => (a.order - b.order) || cmpString(a._id, b._id)),
    relationships: asIdSet(doc.relationships),
    open_questions: asIdSet(doc.open_questions),
    createdAt: asDate(doc.createdAt),
    updatedAt: asDate(doc.updatedAt),
  };
}

function exportEntityType(doc) {
  return {
    _id: asId(doc._id),
    name: doc.name ?? null,
    icon: doc.icon ?? null,
    color: { bg: doc.color?.bg ?? null, text: doc.color?.text ?? null },
    order: Number(doc.order ?? 0),
    createdAt: asDate(doc.createdAt),
    updatedAt: asDate(doc.updatedAt),
  };
}

function exportRelationshipType(doc) {
  return {
    _id: asId(doc._id),
    name: doc.name ?? null,
    scope: doc.scope ?? null,
    sourceCategory: doc.sourceCategory ?? null,
    targetCategory: doc.targetCategory ?? null,
    createdAt: asDate(doc.createdAt),
    updatedAt: asDate(doc.updatedAt),
  };
}

function exportRelationshipGroup(doc) {
  return {
    _id: asId(doc._id),
    label: doc.label ?? null,
    // Member order is meaningful — PATCH /:id/members/reorder writes it — so it
    // is kept exactly as stored rather than sorted.
    members: (doc.members ?? []).map(member => ({
      refId: asId(member.refId),
      refModel: member.refModel ?? null,
      label: member.label ?? null,
      notes: member.notes ?? null,
    })),
    createdAt: asDate(doc.createdAt),
  };
}

function exportOpenQuestion(doc) {
  return {
    _id: asId(doc._id),
    question: doc.question ?? null,
    status: doc.status ?? null,
    entry_ids: asIdSet(doc.entry_ids),
    createdAt: asDate(doc.createdAt),
    updatedAt: asDate(doc.updatedAt),
  };
}

/**
 * The slug an export filename uses for a workspace name.
 *
 * ASCII only, and never empty: the value goes into a `Content-Disposition`
 * header, where a quote, a newline, a `/` or a `;` in a user-chosen name would
 * at best break the filename and at worst smuggle a header parameter. A name
 * with no ASCII letters at all (a Hebrew or Japanese workspace name) therefore
 * falls back to `workspace` — the honest limit of a plain `filename=` parameter;
 * an RFC 6266 `filename*=UTF-8''…` alongside it is the follow-up.
 */
export function workspaceSlug(name) {
  const slug = String(name ?? '')
    .normalize('NFKD')               // "Café" → "Cafe" + a combining mark the next step drops
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
  return slug || 'workspace';
}

/**
 * The download filename for an export: `<workspace>-<YYYY-MM-DD>.json`.
 * The date is UTC, from the export's own `exportedAt`, so the name matches the
 * document rather than the reader's timezone.
 */
export function exportFilename(workspaceName, exportedAt) {
  const day = new Date(exportedAt).toISOString().slice(0, 10);
  return `${workspaceSlug(workspaceName)}-${day}.json`;
}

/**
 * One workspace's graph as a single canonical JSON document.
 *
 * @param {import('mongoose').Types.ObjectId|string} workspaceId
 * @param {object}      [options]
 * @param {Date|string} [options.exportedAt] the export timestamp. Injected, not
 *   read from the clock, so two exports of the same graph can be byte-identical.
 * @param {string}      [options.source] what asked for this export, for the log
 *   line — `'GET /export'`, a script's name.
 * @returns {Promise<object>} `{ version, exportedAt, workspace: { name },
 *   entityTypes, relationshipTypes, entities, relationshipGroups, openQuestions }`
 * @throws {Error & { code: 'WORKSPACE_NOT_FOUND' }} when no such workspace exists.
 */
export async function exportWorkspace(workspaceId, { exportedAt = new Date(), source = 'unknown' } = {}) {
  const workspace = await Workspace.findById(workspaceId).select('name').lean();
  if (!workspace) {
    exportLog('light', `export of workspace ${workspaceId} refused — no such workspace (source: ${source})`);
    throw Object.assign(new Error('No such workspace'), { code: 'WORKSPACE_NOT_FOUND' });
  }

  // Every query is scoped on workspaceId — the same clause every other tenant
  // route filters on. An export is the one response that carries a whole
  // workspace, so a missing clause here would hand one tenant every other
  // tenant's graph in a single file.
  const scope = { workspaceId };
  const [entityTypes, relationshipTypes, entities, relationshipGroups, openQuestions] = await Promise.all([
    EntityType.find(scope).lean(),
    RelationshipType.find(scope).lean(),
    Entity.find(scope).lean(),
    RelationshipGroup.find(scope).lean(),
    OpenQuestion.find(scope).lean(),
  ]);

  const doc = {
    version: EXPORT_VERSION,
    exportedAt: asDate(exportedAt),
    workspace: { name: workspace.name ?? null },
    entityTypes: entityTypes.map(exportEntityType).sort(byOrderThenName),
    relationshipTypes: relationshipTypes.map(exportRelationshipType).sort(byOrderThenName),
    entities: entities.map(exportEntity).sort(byTitleThenId),
    relationshipGroups: relationshipGroups.map(exportRelationshipGroup).sort(byId),
    openQuestions: openQuestions.map(exportOpenQuestion).sort(byId),
  };

  const counts = EXPORT_COLLECTIONS.map(key => `${key} ${doc[key].length}`).join(', ');
  exportLog('light', `exported workspace ${workspaceId} "${doc.workspace.name}": ${counts} (source: ${source})`);
  exportLog('normal', `ordering: entities by title then _id, types by order then name, groups and questions by _id (source: ${source})`);
  exportLog('verbose', `entities: ${doc.entities.map(e => `${e._id} "${e.title}"`).join(', ') || '(none)'} (source: ${source})`);

  return doc;
}

export default exportWorkspace;
