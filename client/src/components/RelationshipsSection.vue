<template>
  <div class="relationships-section">
    <div class="section-header">
      <span class="section-label">Relationships</span>
      <button v-if="canEdit && !addingNew && !addToGroupId" class="add-btn" @click="startAdd">+ Add</button>
    </div>

    <!-- Existing relationships -->
    <template v-for="group in topLevelGroups" :key="group._id">

      <!-- Group label row — always show when canEdit so actions are accessible -->
      <div v-if="group.label || canEdit" class="group-label-row">
        <template v-if="editingGroupId === group._id">
          <input v-model="groupLabelDraft" class="input input-sm" placeholder="Group label (optional)" />
          <div class="row-actions" style="margin-top: 4px;">
            <button class="btn-sm" @click="cancelGroupEdit">Cancel</button>
            <button class="btn-sm primary" :disabled="groupLabelSaving" @click="saveGroupLabel(group._id)">
              <span v-if="groupLabelSaving" class="spinner" /><span v-else>Save</span>
            </button>
          </div>
        </template>
        <template v-else>
          <span class="group-label-text">{{ group.label || '' }}</span>
          <div v-if="canEdit" class="group-label-actions">
            <button class="icon-btn" title="Edit group label" @click="startGroupEdit(group)">✎</button>
            <button class="icon-btn" title="Add member to group" @click="startAddToGroup(group._id)">+</button>
            <button class="icon-btn" title="Link sub-group" @click="startLinkSubGroup(group._id)">⤵</button>
            <button class="icon-btn danger" title="Delete group" @click="confirmDeleteGroup(group)">✕</button>
          </div>
        </template>
      </div>

      <template v-for="coMember in coMembersOf(group)" :key="coMember.entityId._id">
        <!-- Edit row -->
        <div v-if="editingKey === rowKey(group._id, coMember.entityId._id)" class="rel-edit-row">
          <input
            v-model="editDraft.label"
            class="input input-sm"
            placeholder="Label (optional)"
          />
          <textarea
            v-model="editDraft.notes"
            class="block-textarea"
            placeholder="Notes (optional)"
            rows="2"
          />
          <div class="row-actions">
            <button class="btn-sm" @click="cancelEdit">Cancel</button>
            <button class="btn-sm primary" :disabled="editSaving" @click="saveEdit(group, coMember.entityId._id)">
              <span v-if="editSaving" class="spinner" /><span v-else>Save</span>
            </button>
          </div>
        </div>

        <!-- View row -->
        <div
          v-else
          class="rel-row"
          :class="{
            'drag-src':  canEdit && drag.groupId === String(group._id) && drag.srcId  === String(coMember.entityId._id),
            'drag-over': canEdit && drag.groupId === String(group._id) && drag.overId === String(coMember.entityId._id) && drag.srcId !== String(coMember.entityId._id),
          }"
          :draggable="canEdit ? 'true' : 'false'"
          @dragstart="canEdit && onDragStart($event, group._id, coMember.entityId._id)"
          @dragover="onDragOver($event, group._id, coMember.entityId._id)"
          @dragleave="onDragLeave"
          @dragend="onDragEnd"
          @drop="onDrop($event, group, coMember.entityId._id)"
        >
          <span v-if="canEdit" class="drag-handle">⠿</span>
          <span class="rel-label">{{ coMember.resolvedLabel || '—' }}</span>
          <span
            class="rel-target wiki-link"
            @click="followLink(coMember.entityId._id, coMember.entityId.title)"
          >{{ coMember.entityId.title }}</span>
          <div class="rel-row-actions">
            <button
              v-if="canEdit"
              class="icon-btn"
              title="Edit"
              @click="startEdit(group, coMember.entityId._id)"
            >✎</button>
            <button
              v-if="canEdit"
              class="icon-btn danger"
              title="Remove"
              @click="removeRelationship(group, coMember.entityId._id)"
            >✕</button>
          </div>
        </div>
      </template>

      <!-- Expanded sub-group trees (labeled sub-groups, viewer not a member) -->
      <template v-for="sub in (group.expandedSubGroups ?? [])" :key="sub.groupId">
        <div class="subgroup-tree-header">
          <span class="subgroup-tree-name">{{ sub.groupLabel || '(group)' }}</span>
          <div class="group-label-actions">
            <button
              v-if="canEdit"
              class="icon-btn danger"
              title="Unlink sub-group"
              @click="unlinkSubGroup(group._id, sub.groupId)"
            >✕</button>
          </div>
        </div>
        <div
          v-for="m in sub.members"
          :key="m.entityId._id"
          class="rel-row subgroup-member-row"
        >
          <span class="rel-label">{{ m.resolvedLabel || '—' }}</span>
          <span
            class="rel-target wiki-link"
            @click="followLink(m.entityId._id, m.entityId.title)"
          >{{ m.entityId.title }}</span>
        </div>
      </template>

      <!-- Collapsed sub-group reference rows (labeled sub-groups, viewer IS a member) -->
      <template v-for="ref in collapsedSubGroupRefs(group)" :key="ref.groupId">
        <div class="rel-row subgroup-ref-row">
          <span class="rel-label">{{ pluralize(ref.linkLabel) }}</span>
          <span class="rel-target subgroup-ref-name">{{ ref.groupLabel || '(group)' }}</span>
          <div class="rel-row-actions">
            <button
              v-if="canEdit"
              class="icon-btn danger"
              title="Unlink sub-group"
              @click="unlinkSubGroup(group._id, ref.groupId)"
            >✕</button>
          </div>
        </div>
      </template>

      <!-- Unlabeled sub-group links (edit-only management row) -->
      <div v-if="canEdit && group.relationships?.some(r => !r.label)" class="subgroups-row">
        <span class="subgroups-label">sub-groups:</span>
        <template v-for="sub in group.relationships.filter(r => !r.label)" :key="sub.groupId">
          <span class="subgroup-chip">
            {{ subGroupTitle(sub) }}
            <button
              class="icon-btn chip-remove"
              title="Unlink sub-group"
              @click="unlinkSubGroup(group._id, sub.groupId)"
            >✕</button>
          </span>
        </template>
      </div>

      <!-- Link sub-group form -->
      <div v-if="linkSubGroupParentId === group._id" class="rel-add-form">
        <div class="form-field">
          <label class="field-label">Sub-group to link</label>
          <input
            v-model="linkSubGroupSearch"
            class="input input-sm"
            placeholder="Search groups by label…"
            @input="filterSubGroupTargets(group)"
          />
          <div v-if="linkSubGroupResults.length" class="target-dropdown">
            <div
              v-for="g in linkSubGroupResults"
              :key="g._id"
              class="target-option"
              @click="selectSubGroupTarget(g)"
            >{{ g.label || '(unlabeled group)' }}</div>
          </div>
          <div v-if="linkSubGroupTargetId" class="selected-target">
            ✓ {{ linkSubGroupTargetLabel }}
            <button class="icon-btn" @click="clearSubGroupTarget">✕</button>
          </div>
        </div>
        <div class="form-field">
          <label class="field-label">Link label <span class="field-hint">(optional — if set, sub-group shows as a row; if omitted, members merge into parent)</span></label>
          <input v-model="linkSubGroupLinkLabel" class="input input-sm" placeholder="e.g. Inhabitant (singular)" />
        </div>
        <div class="row-actions">
          <button class="btn-sm" @click="cancelLinkSubGroup">Cancel</button>
          <button
            class="btn-sm primary"
            :disabled="linkSubGroupSaving || !linkSubGroupTargetId"
            @click="saveLinkSubGroup(group._id)"
          >
            <span v-if="linkSubGroupSaving" class="spinner" /><span v-else>Link</span>
          </button>
        </div>
      </div>

      <!-- Add-to-group form -->
      <div v-if="addToGroupId === group._id" class="rel-add-form">
        <div class="form-field">
          <label class="field-label">New member</label>
          <input
            v-model="addToGroupForm.targetSearch"
            class="input input-sm"
            placeholder="Search entries…"
            @input="filterAddToGroupTargets(group)"
          />
          <div v-if="addToGroupResults.length" class="target-dropdown">
            <div
              v-for="e in addToGroupResults"
              :key="e._id"
              class="target-option"
              @click="selectAddToGroupTarget(e)"
            >{{ e.title }}</div>
          </div>
          <div v-if="addToGroupForm.targetId" class="selected-target">
            ✓ {{ addToGroupForm.targetTitle }}
            <button class="icon-btn" @click="clearAddToGroupTarget">✕</button>
          </div>
        </div>

        <div class="form-field">
          <label class="field-label">Their label</label>
          <input v-model="addToGroupForm.label" class="input input-sm" placeholder="e.g. sibling (optional)" />
        </div>

        <div class="form-field">
          <label class="field-label">Notes</label>
          <textarea v-model="addToGroupForm.notes" class="block-textarea" placeholder="Optional" rows="2" />
        </div>

        <div class="row-actions">
          <button class="btn-sm" @click="cancelAddToGroup">Cancel</button>
          <button
            class="btn-sm primary"
            :disabled="addToGroupSaving || !addToGroupForm.targetId"
            @click="saveAddToGroup"
          >
            <span v-if="addToGroupSaving" class="spinner" /><span v-else>Add</span>
          </button>
        </div>
      </div>

    </template>

    <!-- Empty state -->
    <div v-if="!topLevelGroups.length && !addingNew" class="rel-empty">
      No relationships yet.
    </div>

    <!-- Add new relationship form -->
    <div v-if="addingNew" class="rel-add-form">
      <div class="form-field">
        <label class="field-label">Target</label>
        <input
          v-model="newForm.targetSearch"
          class="input input-sm"
          placeholder="Search entries…"
          @input="filterTargets"
        />
        <div v-if="targetResults.length" class="target-dropdown">
          <div
            v-for="e in targetResults"
            :key="e._id"
            class="target-option"
            @click="selectTarget(e)"
          >{{ e.title }}</div>
        </div>
        <div v-if="newForm.targetId" class="selected-target">
          ✓ {{ newForm.targetTitle }}
          <button class="icon-btn" @click="clearTarget">✕</button>
        </div>
      </div>

      <div class="form-row">
        <div class="form-field">
          <label class="field-label">Your label</label>
          <input v-model="newForm.myLabel" class="input input-sm" placeholder="e.g. father" />
        </div>
        <div class="form-field">
          <label class="field-label">Their label</label>
          <input v-model="newForm.theirLabel" class="input input-sm" placeholder="e.g. son" />
        </div>
      </div>

      <div class="form-field">
        <label class="field-label">Group label</label>
        <input v-model="newForm.groupLabel" class="input input-sm" placeholder="e.g. parentage (optional)" />
      </div>

      <div class="form-field">
        <label class="field-label">Notes</label>
        <textarea v-model="newForm.notes" class="block-textarea" placeholder="Optional" rows="2" />
      </div>

      <div class="row-actions">
        <button class="btn-sm" @click="cancelAdd">Cancel</button>
        <button
          class="btn-sm primary"
          :disabled="addSaving || !newForm.targetId"
          @click="saveNew"
        >
          <span v-if="addSaving" class="spinner" /><span v-else>Add</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, inject } from 'vue';
import { createGroup, updateGroupLabel, addMember, updateMember, removeMember, reorderMembers, deleteGroup, addSubGroup, removeSubGroup } from '../api/relationshipGroups.js';

const props = defineProps({ entity: Object, canEdit: Boolean });
const emit = defineEmits(['refresh']);

const entities = inject('entities', ref([]));
const followLink = inject('followLink', () => {});

// ─── Pluralization ────────────────────────────────────────────────────────────

function pluralize(word) {
  if (!word) return word;
  if (/(?:s|sh|ch|x|z)$/i.test(word)) return word + 'es';
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
  return word + 's';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Map: childGroupId (string) → { parentId, linkLabel }
const subGroupLinkMap = computed(() => {
  const map = new Map();
  for (const group of (props.entity.relationships ?? [])) {
    for (const link of (group.relationships ?? [])) {
      map.set(String(link.groupId), { parentId: String(group._id), linkLabel: link.label });
    }
  }
  return map;
});

// Show a group at top level if:
//   - it is not referenced as a sub-group at all, OR
//   - it IS a sub-group but the link has a label (viewer is in both; show both)
const topLevelGroups = computed(() =>
  (props.entity.relationships ?? []).filter(g => {
    const linkInfo = subGroupLinkMap.value.get(String(g._id));
    return !linkInfo || !!linkInfo.linkLabel;
  })
);

// For a given parent group, return the sub-group links that have a label.
// These sub-groups are "collapsed" — shown as a reference row, members excluded from direct display.
function collapsedSubGroupRefs(group) {
  return (group.relationships ?? [])
    .filter(link => {
      const sg = (props.entity.relationships ?? []).find(g => String(g._id) === String(link.groupId));
      return sg && link.label;
    })
    .map(link => {
      const sg = (props.entity.relationships ?? []).find(g => String(g._id) === String(link.groupId));
      return { groupId: link.groupId, linkLabel: link.label, groupLabel: sg?.label || null };
    });
}

// Set of member IDs that belong to collapsed sub-groups (should be hidden from direct display).
function collapsedMemberIds(group) {
  const ids = new Set();
  for (const link of (group.relationships ?? [])) {
    const sg = (props.entity.relationships ?? []).find(g => String(g._id) === String(link.groupId));
    if (sg && link.label) {
      for (const m of sg.members) {
        ids.add(String(m.entityId?._id ?? m.entityId));
      }
    }
  }
  return ids;
}

function coMembersOf(group) {
  const collapsed = collapsedMemberIds(group);
  return (group.members ?? []).filter(m => {
    const mid = String(m.entityId._id ?? m.entityId);
    return mid !== String(props.entity._id) && !collapsed.has(mid);
  });
}

function rowKey(groupId, coMemberId) {
  return `${groupId}:${coMemberId}`;
}

// ─── Group label edit ─────────────────────────────────────────────────────────

const editingGroupId  = ref(null);
const groupLabelDraft = ref('');
const groupLabelSaving = ref(false);

function startGroupEdit(group) {
  groupLabelDraft.value = group.label ?? '';
  editingGroupId.value = group._id;
}

function cancelGroupEdit() { editingGroupId.value = null; }

async function saveGroupLabel(groupId) {
  groupLabelSaving.value = true;
  try {
    await updateGroupLabel(groupId, groupLabelDraft.value || null);
    editingGroupId.value = null;
    emit('refresh');
  } finally {
    groupLabelSaving.value = false;
  }
}

async function confirmDeleteGroup(group) {
  if (!window.confirm('Delete this entire relationship group? This cannot be undone.')) return;
  await deleteGroup(group._id);
  emit('refresh');
}

// ─── Add member to existing group ────────────────────────────────────────────

const addToGroupId      = ref(null);
const addToGroupSaving  = ref(false);
const addToGroupForm    = ref({ targetId: null, targetTitle: '', targetSearch: '', label: '', notes: '' });
const addToGroupResults = ref([]);

function startAddToGroup(groupId) { addToGroupId.value = groupId; }

function cancelAddToGroup() {
  addToGroupId.value = null;
  addToGroupForm.value = { targetId: null, targetTitle: '', targetSearch: '', label: '', notes: '' };
  addToGroupResults.value = [];
}

function filterAddToGroupTargets(group) {
  const q = addToGroupForm.value.targetSearch.toLowerCase();
  if (!q) { addToGroupResults.value = []; return; }
  const existingIds = new Set(group.members.map(m => String(m.entityId._id)));
  addToGroupResults.value = (entities.value ?? [])
    .filter(e => e.title.toLowerCase().includes(q) && !existingIds.has(String(e._id)))
    .slice(0, 8);
}

function selectAddToGroupTarget(e) {
  addToGroupForm.value.targetId = e._id;
  addToGroupForm.value.targetTitle = e.title;
  addToGroupForm.value.targetSearch = e.title;
  addToGroupResults.value = [];
}

function clearAddToGroupTarget() {
  addToGroupForm.value.targetId = null;
  addToGroupForm.value.targetTitle = '';
  addToGroupForm.value.targetSearch = '';
}

async function saveAddToGroup() {
  if (!addToGroupForm.value.targetId) return;
  addToGroupSaving.value = true;
  try {
    await addMember(addToGroupId.value, {
      entityId: addToGroupForm.value.targetId,
      label:    addToGroupForm.value.label || null,
      notes:    addToGroupForm.value.notes || null,
    });
    cancelAddToGroup();
    emit('refresh');
  } finally {
    addToGroupSaving.value = false;
  }
}

// ─── Edit existing member ─────────────────────────────────────────────────────

const editingKey = ref(null);
const editDraft  = ref({ label: '', notes: '' });
const editSaving = ref(false);

function startEdit(group, coMemberId) {
  // Load the co-member's label/notes — that's what's displayed in the row
  const coMember = group.members.find(m => String(m.entityId._id) === String(coMemberId));
  editDraft.value = { label: coMember?.label ?? '', notes: coMember?.notes ?? '' };
  editingKey.value = rowKey(group._id, coMemberId);
}

function cancelEdit() { editingKey.value = null; }

async function saveEdit(group, coMemberId) {
  editSaving.value = true;
  try {
    await updateMember(group._id, coMemberId, {
      label: editDraft.value.label || null,
      notes: editDraft.value.notes || null,
    });
    editingKey.value = null;
    emit('refresh');
  } finally {
    editSaving.value = false;
  }
}

// ─── Remove ───────────────────────────────────────────────────────────────────

async function removeRelationship(group, memberId) {
  await removeMember(group._id, memberId);
  emit('refresh');
}

// ─── Drag-to-reorder ─────────────────────────────────────────────────────────

const drag = ref({ groupId: null, srcId: null, overId: null });

function onDragStart(e, groupId, entityId) {
  drag.value = { groupId: String(groupId), srcId: String(entityId), overId: null };
  e.dataTransfer.effectAllowed = 'move';
}

function onDragOver(e, groupId, entityId) {
  if (drag.value.groupId !== String(groupId)) return;
  e.preventDefault();
  drag.value.overId = String(entityId);
}

function onDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) drag.value.overId = null;
}

function onDragEnd() {
  drag.value = { groupId: null, srcId: null, overId: null };
}

async function onDrop(e, group, targetEntityId) {
  e.preventDefault();
  const { groupId, srcId } = drag.value;
  onDragEnd();
  const targetId = String(targetEntityId);
  if (!srcId || String(groupId) !== String(group._id) || srcId === targetId) return;

  const allIds = group.members.map(m => String(m.entityId._id));
  const fromIdx = allIds.indexOf(srcId);
  const toIdx   = allIds.indexOf(targetId);
  if (fromIdx === -1 || toIdx === -1) return;

  allIds.splice(fromIdx, 1);
  allIds.splice(toIdx, 0, srcId);

  await reorderMembers(group._id, allIds);
  emit('refresh');
}

// ─── Link / unlink sub-group ─────────────────────────────────────────────────

const linkSubGroupParentId    = ref(null);
const linkSubGroupSearch      = ref('');
const linkSubGroupResults     = ref([]);
const linkSubGroupTargetId    = ref(null);
const linkSubGroupTargetLabel = ref('');
const linkSubGroupLinkLabel   = ref('');
const linkSubGroupSaving      = ref(false);

function startLinkSubGroup(groupId) {
  linkSubGroupParentId.value  = groupId;
  linkSubGroupSearch.value    = '';
  linkSubGroupResults.value   = [];
  linkSubGroupTargetId.value  = null;
  linkSubGroupLinkLabel.value = '';
}

function cancelLinkSubGroup() {
  linkSubGroupParentId.value  = null;
  linkSubGroupLinkLabel.value = '';
}

function clearSubGroupTarget() {
  linkSubGroupTargetId.value   = null;
  linkSubGroupTargetLabel.value = '';
  linkSubGroupSearch.value     = '';
}

function filterSubGroupTargets(currentGroup) {
  const q = linkSubGroupSearch.value.toLowerCase();
  if (!q) { linkSubGroupResults.value = []; return; }
  const existingSubIds = new Set((currentGroup.relationships ?? []).map(r => String(r.groupId)));
  linkSubGroupResults.value = (props.entity.relationships ?? [])
    .filter(g =>
      String(g._id) !== String(currentGroup._id) &&
      !existingSubIds.has(String(g._id)) &&
      (g.label ?? '').toLowerCase().includes(q)
    )
    .slice(0, 8);
}

function selectSubGroupTarget(g) {
  linkSubGroupTargetId.value    = g._id;
  linkSubGroupTargetLabel.value = g.label || '(unlabeled group)';
  linkSubGroupSearch.value      = g.label || '';
  linkSubGroupResults.value     = [];
}

async function saveLinkSubGroup(parentGroupId) {
  if (!linkSubGroupTargetId.value) return;
  linkSubGroupSaving.value = true;
  try {
    await addSubGroup(parentGroupId, linkSubGroupTargetId.value, linkSubGroupLinkLabel.value || null);
    cancelLinkSubGroup();
    emit('refresh');
  } finally {
    linkSubGroupSaving.value = false;
  }
}

async function unlinkSubGroup(parentGroupId, subGroupId) {
  if (!window.confirm('Unlink this sub-group? Members not already in the parent group will be re-added to it.')) return;
  await removeSubGroup(parentGroupId, subGroupId);
  emit('refresh');
}

// The resolver now enriches each relationship link with groupLabel, so we use it directly.
function subGroupTitle(sub) {
  return sub.groupLabel || '(unlabeled group)';
}

// ─── Add new ─────────────────────────────────────────────────────────────────

const addingNew = ref(false);
const addSaving = ref(false);
const newForm = ref({ targetId: null, targetTitle: '', targetSearch: '', myLabel: '', theirLabel: '', groupLabel: '', notes: '' });
const targetResults = ref([]);

function startAdd() { addingNew.value = true; }

function cancelAdd() {
  addingNew.value = false;
  resetForm();
}

function resetForm() {
  newForm.value = { targetId: null, targetTitle: '', targetSearch: '', myLabel: '', theirLabel: '', groupLabel: '', notes: '' };
  targetResults.value = [];
}

function filterTargets() {
  const q = newForm.value.targetSearch.toLowerCase();
  if (!q) { targetResults.value = []; return; }
  targetResults.value = (entities.value ?? [])
    .filter(e => e.title.toLowerCase().includes(q) && e._id !== props.entity._id)
    .slice(0, 8);
}

function selectTarget(e) {
  newForm.value.targetId = e._id;
  newForm.value.targetTitle = e.title;
  newForm.value.targetSearch = e.title;
  targetResults.value = [];
}

function clearTarget() {
  newForm.value.targetId = null;
  newForm.value.targetTitle = '';
  newForm.value.targetSearch = '';
}

async function saveNew() {
  if (!newForm.value.targetId) return;
  addSaving.value = true;
  try {
    await createGroup({
      label: newForm.value.groupLabel || null,
      members: [
        { entityId: props.entity._id, label: newForm.value.myLabel || null, notes: newForm.value.notes || null },
        { entityId: newForm.value.targetId, label: newForm.value.theirLabel || null },
      ],
    });
    cancelAdd();
    emit('refresh');
  } finally {
    addSaving.value = false;
  }
}
</script>

<style scoped>
.relationships-section {
  padding: 0 24px 24px;
  margin-top: 8px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid #1a1a1a;
}

.section-label {
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #555;
  font-weight: 600;
}

.add-btn {
  font-size: 11px;
  color: #4f6a8a;
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 4px;
}
.add-btn:hover { color: #7ab4f5; }

.group-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 8px 0 2px;
  min-height: 20px;
}

.group-label-text {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #754219;
}

.group-label-actions {
  display: flex;
  gap: 0;
  opacity: 0;
  transition: opacity 0.1s;
}
.group-label-row:hover .group-label-actions { opacity: 1; }

.rel-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px solid #141414;
}

.drag-handle {
  color: #2a2a2a;
  cursor: grab;
  font-size: 14px;
  padding-right: 2px;
  user-select: none;
  flex-shrink: 0;
}
.rel-row:hover .drag-handle { color: #444; }
.rel-row.drag-src  { opacity: 0.35; }
.rel-row.drag-over { border-top: 2px solid #4f6a8a; margin-top: -1px; }

.rel-label {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: #1e2a3a;
  color: #7ab4f5;
  border: 1px solid #2a4a6a;
  white-space: nowrap;
  min-width: 24px;
  text-align: center;
}

.rel-target {
  font-size: 13px;
  color: #e0e0e0;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rel-target.wiki-link {
  color: #7ab4f5;
  cursor: pointer;
}
.rel-target.wiki-link:hover { text-decoration: underline; }

.rel-row-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.1s;
}
.rel-row:hover .rel-row-actions { opacity: 1; }

.icon-btn {
  background: none;
  border: none;
  color: #444;
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 4px;
}
.icon-btn:hover { color: #aaa; }
.icon-btn.danger:hover { color: #e07070; }

.rel-empty {
  font-size: 12px;
  color: #333;
  padding: 6px 0;
}

/* Edit row */
.rel-edit-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 0;
  border-bottom: 1px solid #1e1e1e;
}

.row-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}

/* Add form */
.rel-add-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 0 4px;
  border-top: 1px solid #1e1e1e;
  margin-top: 4px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-row {
  display: flex;
  gap: 8px;
}
.form-row .form-field { flex: 1; }

.field-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #444;
}

.input-sm {
  font-size: 12px;
  padding: 5px 8px;
}

.block-textarea {
  width: 100%;
  background: #0e0e0e;
  border: 1px solid #333;
  border-radius: 7px;
  color: #e0e0e0;
  font-family: inherit;
  font-size: 12px;
  padding: 6px 8px;
  resize: vertical;
  box-sizing: border-box;
}
.block-textarea:focus { outline: none; border-color: #555; }

.target-dropdown {
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 7px;
  margin-top: 2px;
  max-height: 160px;
  overflow-y: auto;
}
.target-option {
  padding: 7px 10px;
  font-size: 13px;
  cursor: pointer;
  color: #ccc;
}
.target-option:hover { background: #252525; }

.selected-target {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #6dca6d;
  margin-top: 2px;
}

/* Expanded sub-group tree — header */
.subgroup-tree-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 6px 0 2px;
  padding-left: 4px;
  min-height: 18px;
}

.subgroup-tree-name {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #4a6a4a;
}

.subgroup-tree-header .group-label-actions {
  opacity: 0;
  transition: opacity 0.1s;
}
.subgroup-tree-header:hover .group-label-actions { opacity: 1; }

/* Expanded sub-group tree — indented member rows */
.subgroup-member-row {
  padding-left: 16px;
  border-left: 1px solid #1e2e1e;
  margin-left: 4px;
}

/* Collapsed sub-group reference row */
.subgroup-ref-row .rel-target.subgroup-ref-name {
  font-style: italic;
  color: #888;
  cursor: default;
}
.subgroup-ref-row .rel-target.subgroup-ref-name:hover { text-decoration: none; }

/* Unlabeled sub-group chips (edit-only management row) */
.subgroups-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 3px 0 5px;
  font-size: 11px;
  color: #444;
}

.subgroups-label {
  color: #3a3a3a;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.subgroup-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: #1a1a1a;
  border: 1px solid #2a2a2a;
  border-radius: 999px;
  padding: 1px 6px 1px 8px;
  font-size: 11px;
  color: #666;
}

.chip-remove {
  font-size: 10px;
  padding: 0 2px;
  color: #333;
}
.chip-remove:hover { color: #e07070; }

.field-hint {
  font-size: 9px;
  color: #444;
  text-transform: none;
  letter-spacing: 0;
  margin-left: 4px;
}
</style>
