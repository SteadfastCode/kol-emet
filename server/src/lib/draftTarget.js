/**
 * The create / update / nothing-left decision for one proposed entity, and the
 * pass that prunes a draft against what its targets already hold.
 *
 * Every producer in this codebase — `draftNormalizer.js`, which reads a model's
 * braindump output, and the five file producers — answers the same two
 * questions about every entity it proposes. Before this module the first was
 * written out six times and the second was not asked at all:
 *
 *   1. Is this an entity the workspace already has? An exact normalized-title
 *      match becomes an `op: 'update'` against the live entity rather than a
 *      second copy of it (`entityTarget`).
 *   2. Does that update still propose anything? The applier APPENDS and never
 *      overwrites (`draftApplier.js`), so a proposed block the target already
 *      carries would land as a second copy of that block. With those pruned off
 *      (`withoutKnownBlocks`) an update can be left proposing nothing at all —
 *      no block, no tag the entity lacks, and a summary the applier will not
 *      write over — and such an item is dropped (`pruneAgainstTargets`).
 *
 * **Dropped, not flagged.** A flagged item is one `POST /drafts/:id/decide-clean`
 * skips, which leaves the reviewer the same list to read. An item where accept
 * and reject mean the same thing — both produce a `ChangeLog` row with an empty
 * diff, or nothing — is not a decision, and `Draft` is the training corpus
 * (Decision Log, 2026-09-03) rather than a work queue: a corpus of those
 * teaches a model that an empty change is a change worth proposing.
 *
 * **Why the drop is a second pass and not part of `entityTarget`.** Deciding it
 * needs the target's blocks, tags and summary, and both callers deliberately
 * match against a roster of `_id title updatedAt` alone — loading every block of
 * every entity to propose a draft over a workspace of thousands is the cost that
 * roster exists to avoid. So each path parses first and then fetches the matched
 * targets, which is a handful of documents, and runs this pass over the items it
 * already has.
 */

/** Callers pass their own tiered logger; a caller that passes none logs nothing. */
const noLog = () => {};

/**
 * The blocks of `blocks` that `existingBlocks` does not already carry, re-ordered.
 *
 * Attributes are compared on label and value together, text on its trimmed
 * markdown. Nothing fuzzier on purpose: this decides whether a human's prose
 * gets a near-copy of itself appended, and the append-only rule means a wrong
 * answer here cannot be taken back by the next apply.
 */
export function withoutKnownBlocks(blocks, existingBlocks) {
  const attributes = new Set(existingBlocks
    .filter(b => b.type === 'attribute')
    .map(b => `${b.data?.label}\u0000${b.data?.value}`));
  const texts = new Set(existingBlocks
    .filter(b => b.type === 'text')
    .map(b => String(b.data?.markdown ?? '').trim()));
  return blocks
    .filter(b => b.type !== 'attribute' || !attributes.has(`${b.data?.label}\u0000${b.data?.value}`))
    .filter(b => b.type !== 'text' || !texts.has(String(b.data?.markdown ?? '').trim()))
    .map((b, order) => ({ ...b, order }));
}

/**
 * The op / targeting fields for one proposed entity, and the blocks it should
 * carry — the entity half of what `relationshipTarget` does for a link.
 *
 * `existing` is the live entity an exact normalized-title match found, or
 * nothing. Its `blocks` are used when the caller happens to have them (a test,
 * or a caller that matched against an enriched roster); when it does not, the
 * blocks are pruned later by `pruneAgainstTargets` and the result is the same.
 *
 * @param {object|null|undefined} existing  { _id, updatedAt, blocks? }
 * @param {object[]} blocks                 the blocks the caller proposes
 * @returns {{op: string, targetEntityId: any, baseUpdatedAt: Date|null, matchedBy: string, blocks: object[]}}
 */
export function entityTarget(existing, blocks = []) {
  if (!existing) {
    return { op: 'create', targetEntityId: null, baseUpdatedAt: null, matchedBy: 'none', blocks };
  }
  return {
    op: 'update',
    targetEntityId: existing._id,
    baseUpdatedAt: existing.updatedAt ?? null,
    matchedBy: 'exact-normalized-title',
    blocks: Array.isArray(existing.blocks) ? withoutKnownBlocks(blocks, existing.blocks) : blocks,
  };
}

/**
 * Would applying this update write anything?
 *
 * Mirrors `applyEntityUpdate` field for field, deliberately and narrowly: it
 * appends blocks, adds tags the entity lacks, and fills the summary in ONLY
 * when the entity has none. Title and category are never touched by an update,
 * so neither is read here. The summary test is the applier's own (`!target.summary
 * && p.summary`) rather than a trimmed variant, so an item is never dropped as
 * empty by a rule stricter than the write it is standing in for.
 */
function writesNothing(proposed, target) {
  if ((proposed.blocks ?? []).length) return false;
  const held = target.tags ?? [];
  if ((proposed.tags ?? []).some(t => !held.includes(t))) return false;
  if (!target.summary && proposed.summary) return false;
  return true;
}

/**
 * Prunes a parsed draft against the entities its updates target: drops the
 * blocks those entities already carry, then drops any update left writing
 * nothing.
 *
 * Items are mutated in place, and the returned array is a new one when anything
 * was dropped. Three references to a dropped item have to be re-pointed, or the
 * drop would take its dependents down with it at apply time — which would also
 * blank the source spans those items were located in, since source coverage is
 * derived from the items (`client/src/lib/sourceCoverage.js`):
 *
 *   - a relationship member carrying its `localKey` now carries the target's
 *     `refId` instead. The entity is in the graph already; that is the whole
 *     reason its item went away, so the member resolves to the same id either
 *     way — and `relationshipTarget` matched the group on that same id, so the
 *     link's own op does not change;
 *   - an open question's `entry_ids` entry becomes that id as a string, the
 *     shape every already-existing link in `entry_ids` has;
 *   - `dependsOn` loses the key, so the review UI does not grey an item out
 *     waiting on a decision nobody will ever be asked for.
 *
 * @param {object[]} items  draft items, as the normalizer or a producer emits them
 * @param {Map<string, object>} targetsById  entity id, as a string -> { blocks, tags, summary }
 * @param {object} [opts]
 * @param {Function} [opts.log]  (level, msg) => void, this caller's tiered logger
 * @returns {{items: object[], dropReasons: string[]}}
 */
export function pruneAgainstTargets(items, targetsById, { log = noLog } = {}) {
  const dropReasons = [];
  // localKey -> the id of the entity the dropped item would have updated.
  const dropped = new Map();

  for (const item of items) {
    if (item.kind !== 'entity' || item.op !== 'update' || !item.targetEntityId) continue;
    const target = targetsById.get(String(item.targetEntityId));
    // No target fetched is no evidence: an entity deleted since the parse, or a
    // caller that passed a partial map, must not look like an empty update.
    if (!target) continue;

    const before = item.proposed.blocks ?? [];
    if (Array.isArray(target.blocks)) item.proposed.blocks = withoutKnownBlocks(before, target.blocks);
    const pruned = before.length - item.proposed.blocks.length;
    if (pruned) {
      log('normal', `item ${item.localKey} ${JSON.stringify(item.proposed.title)}: dropped ${pruned} of ` +
        `${before.length} proposed block(s) (source: entity ${item.targetEntityId}, which already carries them)`);
    }

    if (!writesNothing(item.proposed, target)) continue;
    dropped.set(item.localKey, item.targetEntityId);
    dropReasons.push(`entity ${JSON.stringify(item.proposed.title)} is already in this workspace and unchanged`);
    log('light', `item ${item.localKey} ${JSON.stringify(item.proposed.title)} dropped: already in the graph and ` +
      `unchanged (source: entity ${item.targetEntityId}, which carries every proposed block and tag` +
      `${target.summary ? ' and a summary of its own' : ''})`);
  }

  if (!dropped.size) return { items, dropReasons };

  const kept = items.filter(item => !dropped.has(item.localKey));
  for (const item of kept) {
    if (item.dependsOn?.some(k => dropped.has(k))) {
      item.dependsOn = item.dependsOn.filter(k => !dropped.has(k));
    }
    if (item.kind === 'relationship') {
      for (const m of item.proposed.members ?? []) {
        if (!m.localKey || !dropped.has(m.localKey)) continue;
        const refId = dropped.get(m.localKey);
        log('normal', `item ${item.localKey} member ${JSON.stringify(m.name)}: now points at entity ${refId} ` +
          `(source: item ${m.localKey} was dropped, and that entity is in the graph)`);
        m.refId = refId;
        m.localKey = null;
      }
    } else if (item.kind === 'open_question' && Array.isArray(item.proposed.entry_ids)) {
      const resolved = [];
      for (const k of item.proposed.entry_ids) {
        const id = dropped.has(k) ? String(dropped.get(k)) : k;
        if (id && !resolved.includes(id)) resolved.push(id);
      }
      if (resolved.join() !== item.proposed.entry_ids.join()) {
        log('normal', `item ${item.localKey} entry_ids: ${JSON.stringify(item.proposed.entry_ids)} -> ` +
          `${JSON.stringify(resolved)} (source: the dropped item(s) those keys named are in the graph)`);
      }
      item.proposed.entry_ids = resolved;
    }
  }
  // `seq` is an item's position in the draft — the applier orders by it within
  // each phase — so it is closed up rather than left with holes in it.
  kept.forEach((item, i) => { item.seq = i; });

  log('light', `${dropped.size} of ${items.length} item(s) dropped as already in the graph and unchanged ` +
    `(source: the ${targetsById.size} matched entit${targetsById.size === 1 ? 'y' : 'ies'} this pass was given)`);
  return { items: kept, dropReasons };
}
