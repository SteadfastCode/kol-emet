/**
 * Write, then check the owner: the writer's half of account deletion's promise
 * that nothing it removes comes back.
 *
 * deleteAccount() removes a user's UserMemory and Conversation rows, then the
 * User, then sweeps both collections again. Checking the user *before* writing
 * cannot close the gap, because the check and the write are apart in time:
 * memory extraction reads the user, spends seconds on a model call, then
 * inserts. So the check comes *after* the write. Each side writes, then reads
 * what the other wrote:
 *
 *   deleter: delete the User          → sweep the collection by userId
 *   writer:  insert the document       → look the User up; gone → delete it
 *
 * Whichever reads second sees the other's write. An insert that lands before
 * the final sweep is swept. One that lands after it also comes after the User
 * delete, so its own lookup finds no user and it deletes itself. No ordering
 * leaves a row behind.
 *
 * It only works if the check runs on every insert, whichever code path does
 * it, so it is a schema plugin and not a helper each writer has to remember to
 * call. It runs on inserts only (`save` of a new document, `insertMany`). An
 * update to an existing document cannot bring back one that was deleted:
 * `save()` on it throws DocumentNotFoundError, and a plain updateOne matches
 * nothing.
 *
 * A discarded write rejects with OwnerGoneError instead of resolving, so no
 * caller reports a save that did not stick.
 *
 * ─── Tiered debug logging ────────────────────────────────────────────────────
 * ACCOUNT_DELETE_LOG_LEVEL = off | light | normal | verbose (default light).
 * This shares the deleter's setting so one knob traces the whole deletion path.
 * Ids only, never content: a discarded memory is personal data about an
 * account that no longer exists.
 *   off     — nothing
 *   light   — every write discarded because its owner was gone, and every
 *             check that could not run
 *   normal  — light, plus one line per guarded insert: model, owner, outcome
 *   verbose — normal, plus the ids of documents that passed the check
 */

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  // Resolved per call, not at module load, so it can't depend on import order.
  const active = LEVELS[process.env.ACCOUNT_DELETE_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[ownerGuard:${level}] ${msg}`);
}

export class OwnerGoneError extends Error {
  constructor(modelName, ownerName, missing, ids) {
    super(`discarded ${ids.length} ${modelName} document(s): ${ownerName} ${missing.join(', ')} no longer exists`);
    this.name = 'OwnerGoneError';
    this.missing = missing;
    this.ids = ids;
  }
}

/** Deletes those of `docs` whose owner is gone, then throws; resolves if every owner is present. */
async function discardIfOwnerGone(model, docs, { path, owner }, op) {
  const where = `${model.modelName}.${op}`;
  const ownerIds = [...new Set(docs.map((d) => d[path]).filter(Boolean).map(String))];
  if (!ownerIds.length) return;

  let missing;
  try {
    const present = await owner.find({ _id: { $in: ownerIds } }).select('_id').lean();
    const live = new Set(present.map((o) => String(o._id)));
    missing = ownerIds.filter((o) => !live.has(o));
  } catch (err) {
    log('light', `${where}: could not check ${owner.modelName} ${ownerIds.join(', ')}; write kept: ${err.message} (source: owner guard)`);
    throw err;
  }

  log('normal', `${where}: ${docs.length} document(s), ${owner.modelName} ${ownerIds.join(', ')} ${missing.length ? `gone: ${missing.join(', ')}` : 'present'}`);
  if (!missing.length) {
    log('verbose', `${where}: kept ${docs.map((d) => d._id).join(', ')}`);
    return;
  }

  const ids = docs.filter((d) => missing.includes(String(d[path]))).map((d) => d._id);
  const { deletedCount } = await model.deleteMany({ _id: { $in: ids } });
  log('light', `${where}: discarded ${deletedCount} of ${ids.length} document(s) ${ids.join(', ')}, written after ${owner.modelName} ${missing.join(', ')} was deleted (source: owner guard, write-then-check)`);
  throw new OwnerGoneError(model.modelName, owner.modelName, missing, ids.map(String));
}

/**
 * Schema plugin. `path` is the field holding the owner's id; `owner` is the
 * model it points at. Documents with no owner id (a null or missing `path`)
 * pass unchecked.
 *
 *   schema.plugin(ownerGuard, { path: 'userId', owner: User });
 */
export function ownerGuard(schema, opts) {
  schema.pre('save', function () {
    // isNew is already false by the time post('save') runs, so record it here.
    this.$locals.ownerGuardInsert = this.isNew;
  });
  schema.post('save', async function (doc) {
    if (doc.$locals.ownerGuardInsert) await discardIfOwnerGone(doc.constructor, [doc], opts, 'save');
  });
  schema.post('insertMany', async function (docs) {
    await discardIfOwnerGone(this, [].concat(docs), opts, 'insertMany');
  });
}
