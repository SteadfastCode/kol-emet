<template>
  <div class="entry-detail">
    <BreadcrumbBar
      :breadcrumbs="breadcrumbs"
      @crumb-click="$emit('crumb-click', $event)"
    />

    <div v-if="loading" class="detail-loading">Loading…</div>

    <template v-else-if="entry">
      <EntryHeader
        :entry="entry"
        @save="saveHeader"
        @set-tag="$emit('set-tag', $event)"
      />

      <div class="blocks-section">
        <BlockList
          :blocks="entry.blocks"
          :can-edit="true"
          @save-block="saveBlock"
          @delete-block="deleteBlock"
          @add-block="addBlock"
        />
      </div>

      <RelationshipsSection
        :entry="entry"
        :can-edit="true"
        @refresh="$emit('refresh')"
      />

      <div class="entry-footer">
        <button class="btn-sm danger" @click="confirmDelete">Delete entry</button>
      </div>
    </template>
  </div>
</template>

<script setup>
import BreadcrumbBar from './BreadcrumbBar.vue';
import EntryHeader from './EntryHeader.vue';
import BlockList from './BlockList.vue';
import RelationshipsSection from './RelationshipsSection.vue';

const props = defineProps({
  entry: Object,
  loading: Boolean,
  breadcrumbs: Array,
});

const emit = defineEmits(['crumb-click', 'follow-link', 'set-tag', 'saved', 'deleted', 'refresh']);

async function saveHeader(headerData) {
  emit('saved', props.entry._id, {
    ...headerData,
    blocks: props.entry.blocks,
  });
}

async function saveBlock(updatedBlock) {
  const blocks = props.entry.blocks.map(b =>
    b._id === updatedBlock._id ? updatedBlock : b
  );
  emit('saved', props.entry._id, { blocks });
}

async function deleteBlock(blockId) {
  const blocks = props.entry.blocks.filter(b => b._id !== blockId);
  emit('saved', props.entry._id, { blocks });
}

async function addBlock(newBlock) {
  const blocks = [...props.entry.blocks, newBlock];
  emit('saved', props.entry._id, { blocks });
}

function confirmDelete() {
  if (confirm(`Delete "${props.entry.title}"? This cannot be undone.`)) {
    emit('deleted', props.entry._id);
  }
}
</script>

<style scoped>
.entry-detail {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.detail-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #444;
  font-size: 14px;
}

.blocks-section {
  margin-top: 20px;
  flex: 1;
  padding: 0 24px;
}

.entry-footer {
  padding: 16px 24px 32px;
  border-top: 1px solid #1e1e1e;
  margin-top: 24px;
}
</style>
