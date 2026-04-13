<template>
  <div class="block-list">
    <template v-if="timelineEvents.length >= 2">
      <!-- Auto-render timeline view for 2+ events -->
      <TimelineView :events="timelineEvents" />
      <!-- Individual edit blocks for each timeline event (hidden in view, accessible via edit) -->
      <div class="timeline-individual">
        <TimelineEventBlock
          v-for="block in timelineEvents"
          :key="block._id"
          :block="block"
          :can-edit="!editingBlockId || editingBlockId === block._id"
          @save="data => saveBlock(block, data)"
        />
      </div>
    </template>

    <template v-for="block in nonTimelineBlocks" :key="block._id">
      <div class="block-wrap" :class="{ 'other-editing': editingBlockId && editingBlockId !== block._id }">
        <!-- Delete button -->
        <button
          v-if="!editingBlockId && canEdit"
          class="block-delete-btn"
          title="Remove block"
          @click="$emit('delete-block', block._id)"
        >✕</button>

        <TextBlock
          v-if="block.type === 'text'"
          :block="block"
          :can-edit="!editingBlockId || editingBlockId === block._id"
          @save="data => saveBlock(block, data)"
          @edit-start="editingBlockId = block._id"
          @edit-end="editingBlockId = null"
        />
        <RelationshipBlock
          v-else-if="block.type === 'relationship'"
          :block="block"
          :can-edit="!editingBlockId || editingBlockId === block._id"
          @save="data => saveBlock(block, data)"
        />
        <TimelineEventBlock
          v-else-if="block.type === 'timeline_event'"
          :block="block"
          :can-edit="!editingBlockId || editingBlockId === block._id"
          @save="data => saveBlock(block, data)"
        />
        <AttributeBlock
          v-else-if="block.type === 'attribute'"
          :block="block"
          :can-edit="!editingBlockId || editingBlockId === block._id"
          @save="data => saveBlock(block, data)"
        />
        <QuoteBlock
          v-else-if="block.type === 'quote'"
          :block="block"
          :can-edit="!editingBlockId || editingBlockId === block._id"
          @save="data => saveBlock(block, data)"
        />
        <GalleryBlock
          v-else-if="block.type === 'gallery'"
          :block="block"
          :can-edit="!editingBlockId || editingBlockId === block._id"
          @save="data => saveBlock(block, data)"
        />
      </div>
    </template>

    <!-- Add block -->
    <div v-if="canEdit && !editingBlockId" class="add-block-section">
      <div v-if="!showAddMenu" class="add-block-trigger" @click="showAddMenu = true">
        + Add block
      </div>
      <div v-else class="add-block-menu">
        <button
          v-for="type in BLOCK_TYPES"
          :key="type"
          class="block-type-btn"
          @click="addBlock(type)"
        >{{ BLOCK_TYPE_LABELS[type] }}</button>
        <button class="btn-sm" @click="showAddMenu = false">Cancel</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import TextBlock from './blocks/TextBlock.vue';
import RelationshipBlock from './blocks/RelationshipBlock.vue';
import TimelineEventBlock from './blocks/TimelineEventBlock.vue';
import TimelineView from './blocks/TimelineView.vue';
import AttributeBlock from './blocks/AttributeBlock.vue';
import QuoteBlock from './blocks/QuoteBlock.vue';
import GalleryBlock from './blocks/GalleryBlock.vue';

const BLOCK_TYPES = ['text', 'relationship', 'timeline_event', 'attribute', 'quote', 'gallery'];
const BLOCK_TYPE_LABELS = {
  text: 'Text',
  relationship: 'Relationship',
  timeline_event: 'Timeline Event',
  attribute: 'Attribute',
  quote: 'Quote',
  gallery: 'Gallery',
};

const BLOCK_DEFAULTS = {
  text: { markdown: '' },
  relationship: { targetId: null, relationshipType: '', notes: '' },
  timeline_event: { date: '', sortKey: 0, era: '', description: '', linkedEntryId: null },
  attribute: { label: '', value: '' },
  quote: { text: '', attribution: '' },
  gallery: { images: [] },
};

const props = defineProps({
  blocks: Array,
  canEdit: Boolean,
});
const emit = defineEmits(['save-block', 'delete-block', 'add-block']);

const editingBlockId = ref(null);
const showAddMenu = ref(false);

const sorted = computed(() => [...(props.blocks ?? [])].sort((a, b) => a.order - b.order));
const timelineEvents = computed(() => sorted.value.filter(b => b.type === 'timeline_event'));
const nonTimelineBlocks = computed(() =>
  timelineEvents.value.length >= 2
    ? sorted.value.filter(b => b.type !== 'timeline_event')
    : sorted.value
);

async function saveBlock(block, newData) {
  await emit('save-block', { ...block, data: newData });
  editingBlockId.value = null;
}

function addBlock(type) {
  const newBlock = {
    type,
    order: (props.blocks?.length ?? 0),
    data: { ...BLOCK_DEFAULTS[type] },
  };
  emit('add-block', newBlock);
  showAddMenu.value = false;
}
</script>

<style scoped>
.block-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.block-wrap {
  position: relative;
  transition: opacity 0.1s;
}
.block-wrap.other-editing { opacity: 0.4; pointer-events: none; }

.block-delete-btn {
  position: absolute;
  top: 12px;
  right: 24px;
  background: none;
  border: none;
  color: #333;
  cursor: pointer;
  font-size: 11px;
  z-index: 1;
  padding: 2px 4px;
  border-radius: 4px;
  transition: color 0.1s;
}
.block-wrap:hover .block-delete-btn { color: #e07070; }

.timeline-individual {
  display: none; /* hidden in view mode; edit access via individual block pencils */
}

/* Show individual timeline events when editing is possible */
.block-list:has(.block-wrap):not(.no-edit) .timeline-individual {
  display: flex;
  flex-direction: column;
}

.add-block-section {
  padding: 8px 24px 16px;
}

.add-block-trigger {
  font-size: 12px;
  color: #333;
  cursor: pointer;
  padding: 6px 0;
  transition: color 0.1s;
}
.add-block-trigger:hover { color: #777; }

.add-block-menu {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 0;
}

.block-type-btn {
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid #333;
  background: #1a1a1a;
  color: #888;
  cursor: pointer;
  transition: all 0.1s;
}
.block-type-btn:hover { color: #e0e0e0; border-color: #555; }
</style>
