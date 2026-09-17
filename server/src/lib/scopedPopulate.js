import Entity from '../models/Entity.js';

/**
 * Populate options for the two cross-collection id arrays, scoped to a workspace.
 *
 * `Entity.open_questions` and `OpenQuestion.entry_ids` are plain id arrays, and
 * `populate()` resolves whatever ids they hold — it knows nothing about
 * workspaces. An id belonging to another workspace (planted through a write
 * path, or left over from before writes were filtered) would otherwise come
 * back as that tenant's question text or entity title. `match` confines the
 * lookup to the caller's workspace.
 *
 * Unmatched ids do not surface as `null`: Mongoose drops them from populated
 * arrays by default (`retainNullValues` is off), so a foreign or dangling id is
 * simply absent from the response. `tests/http/tenancy.test.js` pins that.
 *
 * Every populate of either array goes through these, so no call site spells the
 * workspace clause on its own. A new populate of either path should use them.
 */
export function openQuestionsIn(workspaceId) {
  return { path: 'open_questions', select: 'question status', match: { workspaceId } };
}

export function entriesIn(workspaceId) {
  return { path: 'entry_ids', select: 'title category', match: { workspaceId } };
}

/**
 * The subset of `entryIds` naming entities that exist in `workspaceId`, in the
 * order given. Open questions are written with only these, so another tenant's
 * entity id never reaches `OpenQuestion.entry_ids` in the first place.
 *
 * A malformed id still throws a CastError, as it did when the ids went straight
 * to `OpenQuestion.create` — callers answer that with 400.
 */
export async function ownEntryIds(entryIds, workspaceId) {
  if (!entryIds.length) return [];
  const owned = await Entity.find({ _id: { $in: entryIds }, workspaceId }).select('_id').lean();
  const ownedIds = new Set(owned.map(e => String(e._id)));
  return entryIds.filter(id => ownedIds.has(String(id)));
}
