<template>
  <div class="block-list">
    <template v-if="timelineEvents.length >= 2">
      <div v-if="!isEditingTimeline" class="block-wrap timeline-wrap">
        <TimelineView :events="timelineEvents" :can-edit="canEdit" @edit="isEditingTimeline = true" />
      </div>
      <template v-else>
        <div class="timeline-edit-header">
          <span class="block-type-label">Timeline — editing events</span>
          <button class="btn-sm" @click="isEditingTimeline = false">Done</button>
        </div>
        <div class="block-wrap" v-for="block in timelineEvents" :key="block._id">
          <TimelineEventBlock
            :block="block"
            :can-edit="blockEditable(block)"
            @save="data => saveBlock(block, data)"
          />
        </div>
      </template>
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
          :can-edit="blockEditable(block)"
          @save="data => saveBlock(block, data)"
          @edit-start="editingBlockId = block._id"
          @edit-end="editingBlockId = null"
        />
        <TimelineEventBlock
          v-else-if="block.type === 'timeline_event'"
          :block="block"
          :can-edit="blockEditable(block)"
          @save="data => saveBlock(block, data)"
        />
        <AttributeBlock
          v-else-if="block.type === 'attribute'"
          :block="block"
          :can-edit="blockEditable(block)"
          @save="data => saveBlock(block, data)"
        />
        <QuoteBlock
          v-else-if="block.type === 'quote'"
          :block="block"
          :can-edit="blockEditable(block)"
          @save="data => saveBlock(block, data)"
        />
        <GalleryBlock
          v-else-if="block.type === 'gallery'"
          :block="block"
          :can-edit="blockEditable(block)"
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
import TimelineEventBlock from './blocks/TimelineEventBlock.vue';
import TimelineView from './blocks/TimelineView.vue';
import AttributeBlock from './blocks/AttributeBlock.vue';
import QuoteBlock from './blocks/QuoteBlock.vue';
import GalleryBlock from './blocks/GalleryBlock.vue';

const BLOCK_TYPES = ['text', 'timeline_event', 'attribute', 'quote', 'gallery'];
const BLOCK_TYPE_LABELS = {
  text: 'Text',
  timeline_event: 'Timeline Event',
  attribute: 'Attribute',
  quote: 'Quote',
  gallery: 'Gallery',
};

const BLOCK_DEFAULTS = {
  text: { markdown: '' },
  timeline_event: { date: '', sortKey: 0, era: '', description: '', linkedEntryId: null },
  attribute: { label: '', value: '' },
  quote: { text: '', attribution: '' },
  gallery: { images: [] },
};

const props = defineProps({
  blocks: Array,
  /**
   * Whether this entity's blocks can be written at all: false for a viewer,
   * whose writes the server refuses with `403 NOT_WORKSPACE_EDITOR`, and for a
   * deleted entity's snapshot (KOL-150). It already gated the ✕ and
   * "+ Add block"; see `blockEditable` for the part it did not.
   */
  canEdit: Boolean,
});
const emit = defineEmits(['save-block', 'delete-block', 'add-block']);

const editingBlockId = ref(null);
const showAddMenu = ref(false);
const isEditingTimeline = ref(false);

/**
 * Whether one block's own editor may be opened. Two gates, and they say
 * different things: `canEdit` is whether this page may be written at all, and
 * the rest is the one-at-a-time rule that keeps every *other* block read-only
 * while one is open.
 *
 * Until KOL-150 each block was handed the second clause alone, so a list
 * mounted `can-edit="false"` still rendered a pencil on every block in it —
 * the parent flag reached the delete ✕ and the add menu and stopped there.
 */
const blockEditable = (block) =>
  props.canEdit && (!editingBlockId.value || editingBlockId.value === block._id);

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

/**
 * A new block's data, copied out of `BLOCK_DEFAULTS`. A shallow spread is not
 * a copy of `BLOCK_DEFAULTS.gallery`: its `images` array would be shared by
 * every gallery block this menu creates (KOL-148, where the same aliasing in
 * EntityEditor made two galleries show each other's rows). Nothing on this
 * path edits rows in place today — the block is emitted straight to a save —
 * but anything that did would write them into both blocks.
 */
function freshBlockData(type) {
  const data = { ...BLOCK_DEFAULTS[type] };
  if (type === 'gallery') data.images = [];
  return data;
}

function addBlock(type) {
  const newBlock = {
    type,
    order: (props.blocks?.length ?? 0),
    data: freshBlockData(type),
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
  padding: 14px 0;
  border-bottom: 1px solid #1a1a1a;
}
.block-wrap.other-editing { opacity: 0.4; pointer-events: none; }

.block-delete-btn {
  position: absolute;
  top: 14px;
  right: 0;
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

.timeline-edit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0 6px;
  border-bottom: 1px solid #1e1e1e;
  margin-bottom: 4px;
}

.add-block-section {
  padding: 14px 0 16px;
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
