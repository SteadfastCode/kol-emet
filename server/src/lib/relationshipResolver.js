/**
 * Relationship label resolver.
 *
 * When an entity belongs to a group that has sub-groups, co-members should be
 * shown with the label from the most specific (deepest) sub-group that contains
 * both the viewer and the co-member. This module provides the resolution logic.
 *
 * Algorithm:
 *   For each root group the viewer belongs to, do a DFS over the sub-group tree.
 *   Collect every group where BOTH viewer and co-member appear.
 *   Pick the candidate with the greatest depth; tie-break by smallest group size
 *   (smaller = more exclusive = more specific), then list order.
 */

import RelationshipGroup from '../models/RelationshipGroup.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function eid(entityId) {
  if (!entityId) return '';
  if (typeof entityId === 'object' && entityId._id) return String(entityId._id);
  return String(entityId);
}

// ─── Sub-group tree loader ────────────────────────────────────────────────────

/**
 * Recursively populate sub-groups into a (lean) group object.
 * Adds `_subGroups` array to the group in place.
 * Uses `visited` to guard against cycles.
 */
async function populateSubGroups(group, visited = new Set()) {
  const id = String(group._id);
  if (visited.has(id)) return;
  visited.add(id);

  group._subGroups = [];
  for (const rel of (group.relationships ?? [])) {
    const subGroup = await RelationshipGroup.findById(rel.groupId)
      .populate({ path: 'members.entityId', select: 'title' })
      .lean();
    if (subGroup) {
      await populateSubGroups(subGroup, new Set(visited)); // copy so siblings don't block each other
      group._subGroups.push(subGroup);
    }
  }
}

// ─── Label resolution ─────────────────────────────────────────────────────────

/**
 * Collect all groups (within the tree rooted at `group`) where both
 * `viewerEid` and `coMemberEid` are present, annotated with depth and size.
 */
function collectCandidates(group, viewerEid, coMemberEid, depth, candidates) {
  const viewerInGroup   = group.members.some(m => eid(m.entityId) === viewerEid);
  const coMemberInGroup = group.members.some(m => eid(m.entityId) === coMemberEid);

  if (viewerInGroup && coMemberInGroup) {
    const coMember = group.members.find(m => eid(m.entityId) === coMemberEid);
    candidates.push({ depth, size: group.members.length, label: coMember?.label ?? null });
  }

  for (const sub of (group._subGroups ?? [])) {
    collectCandidates(sub, viewerEid, coMemberEid, depth + 1, candidates);
  }
}

/**
 * Given a root group (with `_subGroups` already populated), return the best
 * resolved label for `coMemberEntityId` when viewed by `viewerEntityId`.
 * Returns `null` if neither entity is found in this group tree.
 */
function bestLabel(group, viewerEntityId, coMemberEntityId) {
  const viewerEid   = eid(viewerEntityId);
  const coMemberEid = eid(coMemberEntityId);

  const candidates = [];
  collectCandidates(group, viewerEid, coMemberEid, 0, candidates);

  if (!candidates.length) return null;

  // Deepest wins; tie-break: smallest group; final tie-break: list order (stable sort preserves it)
  candidates.sort((a, b) => {
    if (b.depth !== a.depth) return b.depth - a.depth;
    return a.size - b.size;
  });

  return candidates[0].label;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Given an array of (populated) relationship group documents and the ID of the
 * entity whose detail page is being rendered, return the same groups with a
 * `resolvedLabel` field added to each member.
 *
 * `resolvedLabel` is the co-member's label from the most specific sub-group
 * that contains both the viewer and that co-member. Falls back to the member's
 * own label in the root group if no sub-group applies.
 */
export async function resolveGroupLabels(groups, viewerEntityId) {
  // Recursively populate sub-group trees for all root groups
  for (const group of groups) {
    await populateSubGroups(group);
  }

  return groups.map(group => {
    const members = group.members.map(m => {
      const resolvedLabel = bestLabel(group, viewerEntityId, m.entityId);
      return { ...m, resolvedLabel: resolvedLabel ?? m.label };
    });

    // Strip internal _subGroups from the response
    const { _subGroups, ...rest } = group;
    return { ...rest, members };
  });
}
