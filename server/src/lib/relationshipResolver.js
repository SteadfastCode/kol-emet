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

// ─── Per-group processor ──────────────────────────────────────────────────────

/**
 * Process a single group (with _subGroups already populated) into a response-
 * ready object: resolved member labels, enriched relationships (with groupLabel),
 * and expandedSubGroups for labeled sub-groups where the viewer is not a member.
 */
function processGroup(group, viewerEntityId, viewerEid) {
  // Resolve labels for direct members
  const members = group.members.map(m => {
    const resolvedLabel = bestLabel(group, viewerEntityId, m.entityId);
    return { ...m, resolvedLabel: resolvedLabel ?? m.label };
  });

  // Enrich sub-group link entries with the sub-group's own label so the client
  // doesn't need to look it up through props.entity.relationships (which only
  // contains groups the viewer is directly in).
  const relationships = (group.relationships ?? []).map(rel => {
    const sg = (group._subGroups ?? []).find(s => String(s._id) === String(rel.groupId));
    return { ...rel, groupLabel: sg?.label ?? null };
  });

  // For labeled sub-groups where the viewer is NOT a member, build an expanded
  // tree entry (header + indented members). When the viewer IS a member, the
  // client collapses it into a reference row instead.
  const expandedSubGroups = [];
  const directIds = new Set(members.map(m => eid(m.entityId)));

  for (const rel of relationships) {
    if (!rel.label) continue;
    const sg = (group._subGroups ?? []).find(s => String(s._id) === String(rel.groupId));
    if (!sg) continue;
    if (sg.members.some(m => eid(m.entityId) === viewerEid)) continue; // viewer in sub-group → collapsed on client

    const subMembers = sg.members
      .filter(m => eid(m.entityId) !== viewerEid && !directIds.has(eid(m.entityId)))
      .map(m => ({ ...m, resolvedLabel: rel.label }));

    expandedSubGroups.push({
      groupId:    sg._id,
      linkLabel:  rel.label,
      groupLabel: sg.label ?? null,
      members:    subMembers,
    });
  }

  const { _subGroups, ...rest } = group;
  return { ...rest, relationships, members, expandedSubGroups };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Given an array of (populated) relationship group documents and the ID of the
 * entity whose detail page is being rendered, return the same groups with a
 * `resolvedLabel` field added to each member.
 *
 * Also traverses upward: if any of the viewer's groups are labeled sub-groups of
 * a parent group, that parent group is included in the result so the viewer can
 * see co-members from the parent context (e.g. Eldan sees Earth via World RG).
 */
export async function resolveGroupLabels(groups, viewerEntityId) {
  const viewerEid = eid(viewerEntityId);

  // Populate sub-group trees for all direct groups
  for (const group of groups) {
    await populateSubGroups(group);
  }

  const result = groups.map(group => processGroup(group, viewerEntityId, viewerEid));

  // Find parent groups: any group that has one of the viewer's groups as a
  // labeled sub-group link. Works for all existing data without a migration.
  const viewerGroupIds = groups.map(g => g._id);
  const processedIds   = new Set(groups.map(g => String(g._id)));

  const parentCandidates = await RelationshipGroup
    .find({
      relationships: {
        $elemMatch: { groupId: { $in: viewerGroupIds }, label: { $ne: null } },
      },
    })
    .populate({ path: 'members.entityId', select: 'title' })
    .lean();

  for (const parent of parentCandidates) {
    if (processedIds.has(String(parent._id))) continue; // already in viewer's direct groups
    processedIds.add(String(parent._id));
    await populateSubGroups(parent);
    result.push(processGroup(parent, viewerEntityId, viewerEid));
  }

  return result;
}
