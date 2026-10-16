import mongoose from 'mongoose';
import Entity, { BLOCK_TYPES } from '../models/Entity.js';
import EntityType from '../models/EntityType.js';
import RelationshipType from '../models/RelationshipType.js';
import RelationshipGroup from '../models/RelationshipGroup.js';
import OpenQuestion from '../models/OpenQuestion.js';
import { CATEGORIES } from '../config/categories.js';
import { EXPORT_VERSION, EXPORT_COLLECTIONS } from './graphExporter.js';

/**
 * The other half of the canonical workspace form: reading one back (KOL-077).
 *
 * KOL-070 shipped `GET /export` and `lib/graphExporter.js` — one deterministic
 * JSON document stamped `kol-emet/workspace-export@1` — and nothing read it
 * back, which left the export a file nobody could prove was complete and left
 * the Git-native track with no round trip to connect. This module is the
 * function from a parsed export document plus a workspace id to the documents
 * it writes. `routes/import.js` is the HTTP skin on it, as `routes/export.js`
 * is on the exporter.
 *
 * Four properties carry the design:
 *
 *   **It imports into an empty workspace only.** No entities, no relationship
 *   groups, no open questions, or it is `WORKSPACE_NOT_EMPTY` and writes
 *   nothing. The refusal is the point rather than a limitation worked around:
 *   merging a graph into a workspace that already holds one needs an
 *   id-collision policy (does a colliding id mean "the same thing" or "a
 *   different thing with a reused name"?), and that is a product decision this
 *   item deliberately does not make. Refusing is what lets the round trip ship
 *   without one. The *type registries* are exempt: registration seeds them
 *   (config/templates.js), so a freshly created workspace is never empty of
 *   types and a rule that counted them could never import anything.
 *
 *   **Every id is new, and every reference is rewritten.** Entity types,
 *   relationship types, entities, relationship groups and open questions each
 *   get a fresh `ObjectId`, and every reference to them — a group's
 *   `members[].refId`, a question's `entry_ids`, an entity's `relationships`
 *   and `open_questions` — is rewritten through the maps built here. Nothing
 *   from the file reaches the database as an id. An id that resolves to
 *   nothing in those maps is **dropped**, not kept: a file edited to point a
 *   member at some other tenant's entity id must not be able to write that id,
 *   and a reference to a row the file does not carry cannot be honoured anyway.
 *   New ids are minted in document order, so the re-export of an imported
 *   graph sorts the way the original did — an ObjectId is monotonic within a
 *   process, and `relationshipGroups` and `openQuestions` sort by `_id`.
 *
 *   **The workspace comes from the caller, never from the file.** An export
 *   carries no `workspaceId` (the exporter's allowlist leaves it out), but a
 *   hand-edited document can carry anything, so every document written here is
 *   rebuilt field by field with `workspaceId` set from the argument. A planted
 *   `workspaceId`, `members`, `ownerId` or `__v` is not stripped — it is never
 *   read. Same allowlist discipline as the exporter, in the other direction.
 *
 *   **Nothing is written until everything has been checked.** The version, the
 *   shape of every row, the per-collection caps and the emptiness of the
 *   workspace are all settled before the first insert, so a refusal leaves the
 *   workspace exactly as it was. (There is no transaction: the deployment is a
 *   single mongod, and `routes/import.js` documents what a failure mid-write
 *   leaves behind.)
 *
 * `Entity.relationships` and `Entity.open_questions` are **rebuilt** from the
 * groups and questions rather than copied from the file: they are a
 * back-reference cache (docs/data-model.md), so the groups and the questions
 * are the truth and a file whose cache disagreed with them would import a graph
 * that disagreed with itself.
 *
 * Block `_id`s are *not* carried over — Mongoose mints them. Nothing
 * references a block, so the file's values buy nothing, and a hand-edited file
 * with two blocks sharing an `_id` cannot produce an entity whose blocks cannot
 * be addressed.
 *
 * Out of scope, deliberately: merging into a non-empty workspace and the
 * id-collision policy that needs; `ChangeLog` and `Draft` (KOL-019 has to
 * settle whether history is permanent first); YAML or Markdown input; the Git
 * connector itself; and streaming, so a document is parsed in one go.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * IMPORT_LOG_LEVEL = off | light | normal | verbose (default light)
 * An import is one request that writes a whole graph, and afterwards the only
 * trace of what came in is the graph itself — so the counts are on by default
 * and every line names its source (this route, a script) and, for a refusal,
 * the reason rather than only the code the caller saw.
 *   off     — nothing
 *   light   — one line per import: the document's version, the per-collection
 *             counts and the source; one line per refusal, with its reason
 *   normal  — light, plus the emptiness check, the types skipped as already
 *             present, and each reference dropped for want of a target
 *   verbose — normal, plus every imported title and the old id → new id map
 */

/** The export versions this importer understands. Widen it when @2 exists. */
export const IMPORT_VERSIONS = Object.freeze([EXPORT_VERSION]);

/**
 * The most rows one upload may carry, per collection, so a single request
 * cannot write an unbounded graph. Each is overridable per deployment with
 * `IMPORT_MAX_<COLLECTION>` — see importCaps().
 */
export const IMPORT_CAPS = Object.freeze({
  entityTypes: 200,
  relationshipTypes: 1000,
  entities: 5000,
  relationshipGroups: 10000,
  openQuestions: 5000,
});

/** The env var that overrides the cap on `collection`. */
const CAP_ENV = Object.freeze({
  entityTypes: 'IMPORT_MAX_ENTITY_TYPES',
  relationshipTypes: 'IMPORT_MAX_RELATIONSHIP_TYPES',
  entities: 'IMPORT_MAX_ENTITIES',
  relationshipGroups: 'IMPORT_MAX_RELATIONSHIP_GROUPS',
  openQuestions: 'IMPORT_MAX_OPEN_QUESTIONS',
});

/** The collections whose presence makes a workspace non-empty for an import. */
export const CONTENT_COLLECTIONS = Object.freeze(['entities', 'relationshipGroups', 'openQuestions']);

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

/**
 * The tiered logger for everything import — exported so `routes/import.js` and
 * any later script log under the one `IMPORT_LOG_LEVEL`.
 */
export function importLog(level, msg) {
  // Resolved per call, not at module load, so a test can change it.
  const active = LEVELS[process.env.IMPORT_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[import:${level}] ${msg}`);
}

/**
 * The caps in force, defaults overridden by `IMPORT_MAX_*` where the
 * environment names a positive integer. Read per call rather than at import,
 * like every other tunable here.
 *
 * @param {object} [env] defaults to `process.env`
 */
export function importCaps(env = process.env) {
  const caps = { ...IMPORT_CAPS };
  for (const [collection, name] of Object.entries(CAP_ENV)) {
    const configured = Number(env[name]);
    if (Number.isInteger(configured) && configured > 0) caps[collection] = configured;
  }
  return caps;
}

/**
 * A refusal the route turns into a status. `code` is what the caller sees;
 * `reason` is the sentence the log keeps and the response never carries.
 */
function refusal(code, reason, fields) {
  const err = new Error(reason);
  err.code = code;
  err.reason = reason;
  if (fields?.length) err.fields = fields;
  return err;
}

const HEX_ID = /^[0-9a-f]{24}$/i;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * A field the schemas hold as a nullable `String`: absent, null, or a string.
 *
 * Checked here rather than left to Mongoose (KOL-097) because these are the
 * fields nothing else looks at — a group's `label`, a member's `label` and
 * `notes`, an entity type's `icon` and colours are copied straight from the
 * file into the document — and Mongoose's string cast refuses a plain object
 * or an array with a `CastError` *at insert time*. For a group's label that is
 * the fourth of five inserts, so a hand-edited `relationshipGroups[0].label =
 * {}` used to pass every check here and then take down a request that had
 * already written the types and the entities: a 500 over a half-written graph
 * which the emptiness rule then refuses to let the owner retry, against this
 * module's promise that nothing is written until everything has been checked.
 *
 * A number or a boolean is refused too, though it would cast without
 * complaint: `7` stored as `"7"` means the re-export of an imported graph no
 * longer matches the file it came from, and a round trip that quietly rewrites
 * a value is the one thing this module cannot do.
 */
const isNullableString = (value) => value == null || typeof value === 'string';

/** Refuses `value` unless it is absent, null, or a string. @see isNullableString */
function checkNullableString(value, at) {
  if (!isNullableString(value)) {
    throw refusal('MALFORMED_DOCUMENT', `${at} is ${Array.isArray(value) ? 'an array' : typeof value}, not a string or null`, [at]);
  }
}

/** A name as the unique indexes see it: trimmed (both schemas trim) and case-folded. */
const nameKey = (value) => String(value ?? '').trim().toLowerCase();

/**
 * Checks a parsed export document — version, shape, caps — without touching
 * the database, and returns the collections it carries.
 *
 * Separate from `importWorkspace` and exported so the rules can be asserted
 * directly, and so every refusal that can be known from the file alone happens
 * before any write.
 *
 * @param {unknown} doc a parsed export document
 * @param {object} [options]
 * @param {object} [options.caps] the caps to enforce; defaults to importCaps()
 * @returns {{ version: string, collections: Record<string, object[]> }}
 * @throws {Error & { code: 'MALFORMED_DOCUMENT'|'UNSUPPORTED_VERSION'|'IMPORT_TOO_LARGE' }}
 */
export function readImportDocument(doc, { caps = importCaps() } = {}) {
  if (!isPlainObject(doc)) {
    throw refusal('MALFORMED_DOCUMENT', `the document is ${Array.isArray(doc) ? 'an array' : typeof doc}, not an export object`);
  }

  // Version first, and before the shape: a @2 document may legitimately have a
  // shape this code cannot read, and "unsupported version" is the honest answer
  // to it rather than a complaint about some field.
  if (!IMPORT_VERSIONS.includes(doc.version)) {
    throw refusal(
      'UNSUPPORTED_VERSION',
      `version ${JSON.stringify(doc.version ?? null)} is not one this server reads (${IMPORT_VERSIONS.join(', ')})`,
      ['version'],
    );
  }

  const collections = {};
  for (const key of EXPORT_COLLECTIONS) {
    // Absent is empty: a workspace with no open questions exports an empty
    // array, and a hand-written document that simply omits the key means the
    // same thing. Present-but-not-an-array does not.
    const value = doc[key] ?? [];
    if (!Array.isArray(value)) throw refusal('MALFORMED_DOCUMENT', `${key} is ${typeof value}, not an array`, [key]);
    collections[key] = value;
  }

  // Caps before per-row validation, so an oversized document is refused in one
  // comparison rather than after walking every row of it.
  for (const key of EXPORT_COLLECTIONS) {
    if (collections[key].length > caps[key]) {
      throw refusal(
        'IMPORT_TOO_LARGE',
        `${key} carries ${collections[key].length} rows, over the cap of ${caps[key]} (${CAP_ENV[key]})`,
        [key],
      );
    }
  }

  return { version: doc.version, collections };
}

/**
 * Every row's shape, and every id in the file, checked before the first write.
 *
 * Mongoose would catch most of this on insert, but as a `ValidationError`
 * halfway through the graph — with the entity types already written. Checking
 * here is what makes "a refused document wrote nothing" true.
 *
 * @returns {{ entityIds: Map, groupIds: Map, questionIds: Map }} old id → new ObjectId
 */
function planIds(collections, canonicalByKey) {
  /** Collects `_id`s for a referenced collection, minting one new id per row. */
  const mapIds = (key) => {
    const map = new Map();
    collections[key].forEach((row, index) => {
      const where = `${key}[${index}]`;
      if (!isPlainObject(row)) throw refusal('MALFORMED_DOCUMENT', `${where} is not an object`, [where]);
      const id = row._id;
      if (!HEX_ID.test(String(id ?? ''))) {
        throw refusal('MALFORMED_DOCUMENT', `${where}._id is ${JSON.stringify(id ?? null)}, not an ObjectId`, [`${where}._id`]);
      }
      if (map.has(String(id))) {
        throw refusal('MALFORMED_DOCUMENT', `${where}._id ${id} appears twice in ${key}`, [`${where}._id`]);
      }
      // Minted in document order — see the monotonicity note in the header.
      map.set(String(id), new mongoose.Types.ObjectId());
    });
    return map;
  };

  const entityIds = mapIds('entities');
  const groupIds = mapIds('relationshipGroups');
  const questionIds = mapIds('openQuestions');

  collections.entities.forEach((row, index) => {
    const where = `entities[${index}]`;
    for (const field of ['title', 'category', 'summary']) {
      if (!isNonEmptyString(row[field])) {
        throw refusal('MALFORMED_DOCUMENT', `${where}.${field} is not a non-empty string`, [`${where}.${field}`]);
      }
    }
    if (!canonicalByKey.has(nameKey(row.category))) {
      throw refusal(
        'MALFORMED_DOCUMENT',
        `${where}.category "${row.category}" names no entity type this import creates or this workspace has`,
        [`${where}.category`],
      );
    }
    if (row.tags != null && (!Array.isArray(row.tags) || row.tags.some(tag => typeof tag !== 'string'))) {
      throw refusal('MALFORMED_DOCUMENT', `${where}.tags is not an array of strings`, [`${where}.tags`]);
    }
    if (row.blocks != null && !Array.isArray(row.blocks)) {
      throw refusal('MALFORMED_DOCUMENT', `${where}.blocks is not an array`, [`${where}.blocks`]);
    }
    (row.blocks ?? []).forEach((block, blockIndex) => {
      const at = `${where}.blocks[${blockIndex}]`;
      if (!isPlainObject(block)) throw refusal('MALFORMED_DOCUMENT', `${at} is not an object`, [at]);
      if (!BLOCK_TYPES.includes(block.type)) {
        throw refusal('MALFORMED_DOCUMENT', `${at}.type ${JSON.stringify(block.type ?? null)} is not one of ${BLOCK_TYPES.join(', ')}`, [`${at}.type`]);
      }
      if (!Number.isFinite(Number(block.order))) {
        throw refusal('MALFORMED_DOCUMENT', `${at}.order is not a number`, [`${at}.order`]);
      }
      if (block.data == null) throw refusal('MALFORMED_DOCUMENT', `${at}.data is missing`, [`${at}.data`]);
    });
  });

  collections.relationshipGroups.forEach((row, index) => {
    const where = `relationshipGroups[${index}]`;
    checkNullableString(row.label, `${where}.label`);
    if (row.members != null && !Array.isArray(row.members)) {
      throw refusal('MALFORMED_DOCUMENT', `${where}.members is not an array`, [`${where}.members`]);
    }
    (row.members ?? []).forEach((member, memberIndex) => {
      const at = `${where}.members[${memberIndex}]`;
      if (!isPlainObject(member)) throw refusal('MALFORMED_DOCUMENT', `${at} is not an object`, [at]);
      if (!['Entity', 'RelationshipGroup'].includes(member.refModel)) {
        throw refusal('MALFORMED_DOCUMENT', `${at}.refModel ${JSON.stringify(member.refModel ?? null)} is neither Entity nor RelationshipGroup`, [`${at}.refModel`]);
      }
      if (!HEX_ID.test(String(member.refId ?? ''))) {
        throw refusal('MALFORMED_DOCUMENT', `${at}.refId is ${JSON.stringify(member.refId ?? null)}, not an ObjectId`, [`${at}.refId`]);
      }
      // Checked even on a member about to be dropped for a dangling refId: the
      // shape of the file is the question here, not which rows survive it.
      checkNullableString(member.label, `${at}.label`);
      checkNullableString(member.notes, `${at}.notes`);
    });
  });

  collections.openQuestions.forEach((row, index) => {
    const where = `openQuestions[${index}]`;
    if (!isNonEmptyString(row.question)) {
      throw refusal('MALFORMED_DOCUMENT', `${where}.question is not a non-empty string`, [`${where}.question`]);
    }
    if (row.status != null && !['open', 'resolved'].includes(row.status)) {
      throw refusal('MALFORMED_DOCUMENT', `${where}.status ${JSON.stringify(row.status)} is neither open nor resolved`, [`${where}.status`]);
    }
    if (row.entry_ids != null && !Array.isArray(row.entry_ids)) {
      throw refusal('MALFORMED_DOCUMENT', `${where}.entry_ids is not an array`, [`${where}.entry_ids`]);
    }
    (row.entry_ids ?? []).forEach((id, idIndex) => {
      if (!HEX_ID.test(String(id ?? ''))) {
        throw refusal('MALFORMED_DOCUMENT', `${where}.entry_ids[${idIndex}] is ${JSON.stringify(id ?? null)}, not an ObjectId`, [`${where}.entry_ids[${idIndex}]`]);
      }
    });
  });

  for (const key of ['entityTypes', 'relationshipTypes']) {
    collections[key].forEach((row, index) => {
      const where = `${key}[${index}]`;
      if (!isPlainObject(row)) throw refusal('MALFORMED_DOCUMENT', `${where} is not an object`, [where]);
      if (!isNonEmptyString(row.name)) {
        throw refusal('MALFORMED_DOCUMENT', `${where}.name is not a non-empty string`, [`${where}.name`]);
      }
    });
  }

  // The same class of field on an entity type. Its insert is the first one, so
  // a CastError there writes nothing — but the caller still deserves the path
  // and a 400 rather than a 500 (KOL-097). `color` itself is read with `?.`,
  // so a `color` that is not an object simply carries no colours.
  collections.entityTypes.forEach((row, index) => {
    const where = `entityTypes[${index}]`;
    checkNullableString(row.icon, `${where}.icon`);
    checkNullableString(row.color?.bg, `${where}.color.bg`);
    checkNullableString(row.color?.text, `${where}.color.text`);
  });

  collections.relationshipTypes.forEach((row, index) => {
    const where = `relationshipTypes[${index}]`;
    if (row.scope != null && !['group', 'member'].includes(row.scope)) {
      throw refusal('MALFORMED_DOCUMENT', `${where}.scope ${JSON.stringify(row.scope)} is neither group nor member`, [`${where}.scope`]);
    }
    for (const field of ['sourceCategory', 'targetCategory']) {
      const value = row[field];
      if (value != null && !canonicalByKey.has(nameKey(value))) {
        throw refusal('MALFORMED_DOCUMENT', `${where}.${field} "${value}" names no entity type this import creates or this workspace has`, [`${where}.${field}`]);
      }
    }
  });

  return { entityIds, groupIds, questionIds };
}

/**
 * How full the workspace is, in the three collections that decide whether an
 * import may proceed. Exported so the route and a later merge item can ask the
 * question without duplicating the rule.
 */
export async function workspaceContentCounts(workspaceId) {
  const [entities, relationshipGroups, openQuestions] = await Promise.all([
    Entity.countDocuments({ workspaceId }),
    RelationshipGroup.countDocuments({ workspaceId }),
    OpenQuestion.countDocuments({ workspaceId }),
  ]);
  return { entities, relationshipGroups, openQuestions };
}

/** A date from the file, or `fallback` when it carries none or an unreadable one. */
function asDate(value, fallback) {
  if (value == null) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

/**
 * Writes one export document into `workspaceId`, which must be empty of
 * entities, relationship groups and open questions.
 *
 * @param {object} doc a parsed export document (`JSON.parse` of a `GET /export` body)
 * @param {import('mongoose').Types.ObjectId|string} workspaceId the caller's
 *   own workspace. Any `workspaceId` in `doc` is ignored — see the header.
 * @param {object} [options]
 * @param {string} [options.source] what asked for this import, for the log line
 * @param {object} [options.caps] the caps to enforce; defaults to importCaps()
 * @returns {Promise<{ version: string, imported: object, skipped: object, dropped: object }>}
 * @throws {Error & { code: 'MALFORMED_DOCUMENT'|'UNSUPPORTED_VERSION'|'IMPORT_TOO_LARGE'|'WORKSPACE_NOT_EMPTY' }}
 */
export async function importWorkspace(doc, workspaceId, { source = 'unknown', caps = importCaps() } = {}) {
  const fail = (err) => {
    importLog('light', `import into workspace ${workspaceId} refused ${err.code} (source: ${source}): ${err.reason ?? err.message}`);
    throw err;
  };

  let version;
  let collections;
  try {
    ({ version, collections } = readImportDocument(doc, { caps }));
  } catch (err) {
    fail(err);
  }

  // The emptiness rule, before any shape work: it is the cheaper question and
  // the more likely refusal, and a caller aiming an import at the wrong
  // workspace should not first be told about a field.
  const present = await workspaceContentCounts(workspaceId);
  const occupied = CONTENT_COLLECTIONS.filter(key => present[key] > 0);
  if (occupied.length) {
    fail(refusal(
      'WORKSPACE_NOT_EMPTY',
      `workspace ${workspaceId} already holds ${occupied.map(key => `${present[key]} ${key}`).join(', ')}; an import only writes into an empty workspace`,
      occupied,
    ));
  }
  importLog('normal', `workspace ${workspaceId} is empty of ${CONTENT_COLLECTIONS.join(', ')} (source: ${source})`);

  // ─── Types first: inserted unless the workspace already names one ─────────
  // Registration seeds both registries, so most imports land on a workspace
  // that already has "Characters". The unique index on (workspaceId, name) is
  // case-insensitive, so a second one is not merely redundant but a write
  // error; and nothing references a type by id — `Entity.category` holds a
  // *name* — so keeping the existing row loses nothing.
  //
  // Which makes the registry a *name* rewrite, the same kind of job as the id
  // rewrite: a workspace whose seeded type is "worlds" and a file whose type is
  // "Worlds" end up as one type, and every `category` naming it has to come out
  // as the name the registry actually holds — `Entity.category` is checked
  // against the registry exactly (lib/entityTypeRegistry.js), so an entity left
  // naming the file's casing would be refused on insert. `canonicalByKey` is
  // that map: case-folded name → the exact name this workspace will hold.
  const existingTypes = await EntityType.find({ workspaceId }).select('name').lean();
  const canonicalByKey = new Map(existingTypes.map(type => [nameKey(type.name), type.name]));

  const entityTypeDocs = [];
  let skippedEntityTypes = 0;
  for (const row of collections.entityTypes) {
    const name = String(row.name ?? '').trim();
    const key = nameKey(name);
    if (canonicalByKey.has(key)) {
      skippedEntityTypes += 1;
      importLog('normal', `kept the existing entity type "${canonicalByKey.get(key)}" in workspace ${workspaceId} rather than importing "${name}" a second time (source: ${source})`);
      continue;
    }
    canonicalByKey.set(key, name);
    entityTypeDocs.push({
      _id: new mongoose.Types.ObjectId(),
      name,
      icon: row.icon ?? null,
      color: { bg: row.color?.bg ?? null, text: row.color?.text ?? null },
      order: Number.isFinite(Number(row.order)) ? Number(row.order) : 0,
      workspaceId,
      createdAt: asDate(row.createdAt, new Date()),
      updatedAt: asDate(row.updatedAt, new Date()),
    });
  }

  // A workspace with no types at all, importing a document with none either:
  // the registry falls back to the built-in names (lib/entityTypeRegistry.js),
  // so the same names are what an entity may be filed under here.
  if (!canonicalByKey.size) for (const name of CATEGORIES) canonicalByKey.set(nameKey(name), name);

  /** A category name as this workspace holds it; undefined if it holds no such type. */
  const canonicalCategory = (value) => (value == null ? null : canonicalByKey.get(nameKey(value)));

  // Every row's shape, now that what counts as a category is settled. Still
  // before the first write: a refused document must write nothing.
  let ids;
  try {
    ids = planIds(collections, canonicalByKey);
  } catch (err) {
    fail(err);
  }
  const { entityIds, groupIds, questionIds } = ids;

  const existingRelationshipTypes = await RelationshipType.find({ workspaceId }).select('name scope').lean();
  // (name, scope) rather than name alone: the two scopes are different
  // vocabularies — a group label and a member label — and "Affiliation" can
  // honestly be in both (models/RelationshipType.js).
  const haveRelationshipType = new Set(existingRelationshipTypes.map(type => `${type.scope}:${nameKey(type.name)}`));
  const relationshipTypeDocs = [];
  let skippedRelationshipTypes = 0;
  for (const row of collections.relationshipTypes) {
    const scope = row.scope ?? 'member';
    const key = `${scope}:${nameKey(row.name)}`;
    if (haveRelationshipType.has(key)) {
      skippedRelationshipTypes += 1;
      importLog('normal', `kept the existing ${scope} relationship type "${row.name}" in workspace ${workspaceId} rather than importing a second (source: ${source})`);
      continue;
    }
    haveRelationshipType.add(key);
    relationshipTypeDocs.push({
      _id: new mongoose.Types.ObjectId(),
      name: String(row.name).trim(),
      scope,
      sourceCategory: canonicalCategory(row.sourceCategory) ?? null,
      targetCategory: canonicalCategory(row.targetCategory) ?? null,
      workspaceId,
      createdAt: asDate(row.createdAt, new Date()),
      updatedAt: asDate(row.updatedAt, new Date()),
    });
  }

  // ─── Groups and questions: every reference rewritten, order kept ──────────
  let droppedMembers = 0;
  const groupDocs = collections.relationshipGroups.map(row => ({
    _id: groupIds.get(String(row._id)),
    label: row.label ?? null,
    // Array position is what encodes order here — PATCH /:id/members/reorder
    // writes it — so members are mapped in place and never sorted. A member
    // whose refId resolves to nothing is dropped rather than carried: an id
    // this import did not mint could name another tenant's row.
    members: (row.members ?? []).flatMap(member => {
      const map = member.refModel === 'Entity' ? entityIds : groupIds;
      const refId = map.get(String(member.refId));
      if (!refId) {
        droppedMembers += 1;
        importLog('normal', `dropped a ${member.refModel} member of group ${row._id}: refId ${member.refId} is not in this document (source: ${source})`);
        return [];
      }
      return [{
        refId,
        refModel: member.refModel,
        label: member.label ?? null,
        notes: member.notes ?? null,
      }];
    }),
    workspaceId,
    createdAt: asDate(row.createdAt, new Date()),
  }));

  let droppedQuestionEntries = 0;
  const questionDocs = collections.openQuestions.map(row => ({
    _id: questionIds.get(String(row._id)),
    question: row.question,
    status: row.status ?? 'open',
    entry_ids: (row.entry_ids ?? []).flatMap(id => {
      const mapped = entityIds.get(String(id));
      if (!mapped) {
        droppedQuestionEntries += 1;
        importLog('normal', `dropped entry_id ${id} of question ${row._id}: not an entity in this document (source: ${source})`);
        return [];
      }
      return [mapped];
    }),
    workspaceId,
    createdAt: asDate(row.createdAt, new Date()),
    updatedAt: asDate(row.updatedAt, new Date()),
  }));

  // ─── Entity back-references, rebuilt from the groups and the questions ────
  // Not copied from the file: `relationships` and `open_questions` are a cache
  // of what the groups and questions say (docs/data-model.md), so deriving them
  // is the only way an imported graph cannot disagree with itself. Built before
  // the entities are inserted, which is possible only because every new id was
  // minted above.
  const relationshipsByEntity = new Map();
  for (const group of groupDocs) {
    for (const member of group.members) {
      if (member.refModel !== 'Entity') continue;
      const key = String(member.refId);
      const list = relationshipsByEntity.get(key) ?? [];
      // A group that names the same entity twice is one back-reference.
      if (!list.some(id => String(id) === String(group._id))) list.push(group._id);
      relationshipsByEntity.set(key, list);
    }
  }
  const questionsByEntity = new Map();
  for (const question of questionDocs) {
    for (const entityId of question.entry_ids) {
      const key = String(entityId);
      const list = questionsByEntity.get(key) ?? [];
      if (!list.some(id => String(id) === String(question._id))) list.push(question._id);
      questionsByEntity.set(key, list);
    }
  }

  const entityDocs = collections.entities.map(row => {
    const _id = entityIds.get(String(row._id));
    return {
      _id,
      title: row.title,
      category: canonicalCategory(row.category),
      summary: row.summary,
      tags: [...(row.tags ?? [])],
      // Block `_id`s are Mongoose's, not the file's — see the header.
      blocks: (row.blocks ?? []).map(block => ({
        type: block.type,
        order: Number(block.order),
        data: block.data,
      })),
      relationships: relationshipsByEntity.get(String(_id)) ?? [],
      open_questions: questionsByEntity.get(String(_id)) ?? [],
      workspaceId,
      createdAt: asDate(row.createdAt, new Date()),
      updatedAt: asDate(row.updatedAt, new Date()),
    };
  });

  importLog('verbose', `id map: ${[...entityIds].map(([was, now]) => `${was}→${now}`).join(', ') || '(no entities)'} (source: ${source})`);

  // ─── The writes ───────────────────────────────────────────────────────────
  // `timestamps: false` so the dates above are the ones stored: an imported
  // graph that re-dated every row would not round-trip, and "created six months
  // ago" is content, not bookkeeping. Types first, because `Entity.category` is
  // validated against the registry on insert. Validation stays on: this module
  // checked the shapes it knows about, and the schemas are the backstop.
  const insert = (model, docs) => (docs.length ? model.insertMany(docs, { timestamps: false }) : Promise.resolve([]));
  await insert(EntityType, entityTypeDocs);
  await insert(RelationshipType, relationshipTypeDocs);
  await insert(Entity, entityDocs);
  await insert(RelationshipGroup, groupDocs);
  await insert(OpenQuestion, questionDocs);

  const result = {
    version,
    imported: {
      entityTypes: entityTypeDocs.length,
      relationshipTypes: relationshipTypeDocs.length,
      entities: entityDocs.length,
      relationshipGroups: groupDocs.length,
      openQuestions: questionDocs.length,
    },
    skipped: { entityTypes: skippedEntityTypes, relationshipTypes: skippedRelationshipTypes },
    dropped: { members: droppedMembers, questionEntries: droppedQuestionEntries },
  };

  const counts = EXPORT_COLLECTIONS.map(key => `${key} ${result.imported[key]}`).join(', ');
  importLog('light', `imported ${version} into workspace ${workspaceId}: ${counts}; skipped ${skippedEntityTypes} entity type(s) and ${skippedRelationshipTypes} relationship type(s) already present; dropped ${droppedMembers} member(s) and ${droppedQuestionEntries} question entry/entries with no target (source: ${source})`);
  importLog('verbose', `entities: ${entityDocs.map(e => `${e._id} "${e.title}"`).join(', ') || '(none)'} (source: ${source})`);

  return result;
}

export default importWorkspace;
