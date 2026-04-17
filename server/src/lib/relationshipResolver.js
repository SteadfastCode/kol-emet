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

import mongoose from 'mongoose';
import RelationshipGroup from '../models/RelationshipGroup.js';
import Entity from '../models/Entity.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function eid(refId) {
  if (!refId) return '';
  if (typeof refId === 'object' && refId._id) return String(refId._id);
  return String(refId);
}

// ─── Member ref population ────────────────────────────────────────────────────

/**
 * In-place: adds a `ref` field to each member entry.
 *   Entity members:            ref = { _id, title }
 *   RelationshipGroup members: ref = { _id, label }
 */
async function addMemberRefs(group) {
  const entityIds = group.members
    .filter(m => m.refModel === 'Entity')
    .map(m => m.refId);
  const groupIds = group.members
    .filter(m => m.refModel === 'RelationshipGroup')
    .map(m => m.refId);

  const [entities, groups] = await Promise.all([
    entityIds.length
      ? Entity.find({ _id: { $in: entityIds } }).select('title').lean()
      : Promise.resolve([]),
    groupIds.length
      ? RelationshipGroup.find({ _id: { $in: groupIds } }).select('label').lean()
      : Promise.resolve([]),
  ]);

  const entityMap = new Map(entities.map(e => [String(e._id), e]));
  const groupMap  = new Map(groups.map(g => [String(g._id), g]));

  group.members = group.members.map(m => ({
    ...m,
    ref: m.refModel === 'Entity'
      ? (entityMap.get(String(m.refId)) ?? { _id: m.refId, title: '(deleted)' })
      : (groupMap.get(String(m.refId))  ?? { _id: m.refId, label: null }),
  }));
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
  for (const m of (group.members ?? []).filter(m => m.refModel === 'RelationshipGroup')) {
    const subGroup = await RelationshipGroup.findById(m.refId).lean();
    if (subGroup) {
      await addMemberRefs(subGroup);
      await populateSubGroups(subGroup, new Set(visited)); // copy so siblings don't block each other
      group._subGroups.push(subGroup);
    }
  }
}

// ─── Label resolution ─────────────────────────────────────────────────────────

/**
 * Collect all groups (within the tree rooted at `group`) where both
 * `viewerEid` and `coMemberEid` are present, annotated with depth and size.
 * Only Entity members participate in label resolution.
 */
function collectCandidates(group, viewerEid, coMemberEid, depth, candidates) {
  const entityMembers  = (group.members ?? []).filter(m => m.refModel === 'Entity');
  const viewerInGroup  = entityMembers.some(m => eid(m.refId) === viewerEid);
  const coMemberInGroup = entityMembers.some(m => eid(m.refId) === coMemberEid);

  if (viewerInGroup && coMemberInGroup) {
    const coMember = entityMembers.find(m => eid(m.refId) === coMemberEid);
    candidates.push({ depth, size: entityMembers.length, label: coMember?.label ?? null });
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
 * ready object: resolved member labels (for Entity members), and
 * expandedSubGroups for labeled sub-groups where the viewer is not a member.
 */
function processGroup(group, viewerEntityId, viewerEid) {
  // Resolve labels for Entity members; pass group-ref members through unchanged
  const members = group.members.map(m => {
    if (m.refModel === 'Entity') {
      const resolvedLabel = bestLabel(group, viewerEntityId, m.refId);
      return { ...m, resolvedLabel: resolvedLabel ?? m.label };
    }
    return m;
  });

  // For labeled sub-groups where the viewer is NOT a member, build an expanded
  // tree entry (header + indented members). When the viewer IS a member, the
  // client collapses it into a reference row instead.
  const expandedSubGroups = [];
  const directEntityIds = new Set(
    members.filter(m => m.refModel === 'Entity').map(m => eid(m.refId))
  );

  for (const m of members.filter(m => m.refModel === 'RelationshipGroup' && m.label)) {
    const sg = (group._subGroups ?? []).find(s => String(s._id) === String(m.refId));
    if (!sg) continue;
    if (sg.members.some(sm => sm.refModel === 'Entity' && eid(sm.refId) === viewerEid)) continue; // viewer in sub-group → collapsed on client

    const subMembers = sg.members
      .filter(sm => sm.refModel === 'Entity' && eid(sm.refId) !== viewerEid && !directEntityIds.has(eid(sm.refId)))
      .map(sm => ({ ...sm, resolvedLabel: m.label }));

    expandedSubGroups.push({
      groupId:    sg._id,
      linkLabel:  m.label,
      groupLabel: sg.label ?? null,
      members:    subMembers,
    });
  }

  const { _subGroups, ...rest } = group;
  return { ...rest, members, expandedSubGroups };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Given an array of raw (lean, unpopulated) relationship group documents and
 * the ID of the entity whose detail page is being rendered, return the same
 * groups enriched with:
 *   - `ref` on each member (populated title/label)
 *   - `resolvedLabel` on Entity members
 *   - `expandedSubGroups` for labeled sub-groups the viewer is NOT in
 *
 * Also traverses upward: if any of the viewer's groups are labeled sub-groups
 * of a parent group, that parent group is included so the viewer can see
 * co-members from the parent context.
 */
export async function resolveGroupLabels(groups, viewerEntityId) {
  const viewerEid = eid(viewerEntityId);

  // Populate member refs and sub-group trees for all direct groups
  for (const group of groups) {
    await addMemberRefs(group);
    await populateSubGroups(group);
  }

  const result = groups.map(group => processGroup(group, viewerEntityId, viewerEid));

  // Find parent groups: any group that has one of the viewer's groups as a
  // labeled sub-group link (refModel=RelationshipGroup, label non-null).
  const viewerGroupIds = groups.map(g => g._id);
  const processedIds   = new Set(groups.map(g => String(g._id)));

  const parentCandidates = await RelationshipGroup
    .find({
      members: {
        $elemMatch: {
          refId:    { $in: viewerGroupIds },
          refModel: 'RelationshipGroup',
          label:    { $ne: null },
        },
      },
    })
    .lean();

  for (const parent of parentCandidates) {
    if (processedIds.has(String(parent._id))) continue;
    processedIds.add(String(parent._id));
    await addMemberRefs(parent);
    await populateSubGroups(parent);
    result.push(processGroup(parent, viewerEntityId, viewerEid));
  }

  return result;
}
