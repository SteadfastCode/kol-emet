<template>
  <div class="relationships-section">
    <div class="section-header">
      <span class="section-label">Relationships</span>
      <button v-if="canEdit && !addingNew && !addToGroupId" class="add-btn" @click="startAdd">+ Add</button>
    </div>

    <!-- Existing relationships -->
    <template v-for="group in entry.relationships" :key="group._id">

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
        <div v-else class="rel-row">
          <span class="rel-label">{{ coMember.label || '—' }}</span>
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
              @click="removeRelationship(group)"
            >✕</button>
          </div>
        </div>
      </template>

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
    <div v-if="!entry.relationships?.length && !addingNew" class="rel-empty">
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
import { ref, inject } from 'vue';
import { createGroup, updateGroupLabel, addMember, updateMember, removeMember, deleteGroup } from '../api/relationshipGroups.js';

const props = defineProps({ entry: Object, canEdit: Boolean });
const emit = defineEmits(['refresh']);

const entries  = inject('entries', ref([]));
const followLink = inject('followLink', () => {});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function coMembersOf(group) {
  return group.members.filter(m => String(m.entityId._id) !== String(props.entry._id));
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
  addToGroupResults.value = (entries.value ?? [])
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

async function removeRelationship(group) {
  // If this entry is the only member besides one other, removing triggers group deletion
  await removeMember(group._id, props.entry._id);
  emit('refresh');
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
  targetResults.value = (entries.value ?? [])
    .filter(e => e.title.toLowerCase().includes(q) && e._id !== props.entry._id)
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
        { entityId: props.entry._id, label: newForm.value.myLabel || null, notes: newForm.value.notes || null },
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
</style>
