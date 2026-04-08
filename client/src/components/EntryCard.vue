<template>
  <div class="entry-card" :class="{ open: expanded }" @click="$emit('toggle')">
    <div class="entry-header">
      <div class="entry-meta">
        <span class="entry-title">{{ entry.title }}</span>
        <span v-if="entry.open_question" class="oq-badge">open question</span>
      </div>
      <span class="entry-cat" :style="catStyle">{{ entry.category }}</span>
    </div>
    <div class="entry-summary">{{ entry.summary }}</div>

    <div v-if="expanded" class="entry-body" @click.stop>
      <p v-for="(para, i) in bodyParagraphs" :key="i">{{ para }}</p>
      <div v-if="entry.open_question" class="linked-oq">
        <strong>Open question</strong>
        {{ entry.open_question }}
      </div>
      <div v-if="entry.tags.length" class="entry-tags">
        <span v-for="tag in entry.tags" :key="tag" class="tag"
          @click.stop="$emit('tag-click', tag)">#{{ tag }}</span>
      </div>
      <div class="entry-actions">
        <button class="btn-sm" @click.stop="$emit('edit')">Edit</button>
        <button class="btn-sm danger" @click.stop="handleDelete">Delete</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({ entry: Object, expanded: Boolean });
const emit = defineEmits(['toggle', 'tag-click', 'edit', 'delete']);

const CAT_COLORS = {
  'Characters':      { bg: '#B5D4F4', color: '#0C447C' },
  'Worlds':          { bg: '#9FE1CB', color: '#085041' },
  'Organizations':   { bg: '#F5C4B3', color: '#712B13' },
  'Lore & Mechanics':{ bg: '#CECBF6', color: '#3C3489' },
  'Timeline':        { bg: '#FAC775', color: '#633806' },
  'Open Questions':  { bg: '#F4C0D1', color: '#72243E' },
};

const catStyle = computed(() => CAT_COLORS[props.entry.category] ?? { bg: '#333', color: '#aaa' });

const bodyParagraphs = computed(() =>
  props.entry.body.split('\n').filter(p => p.trim())
);

function handleDelete() {
  if (confirm(`Delete "${props.entry.title}"?`)) emit('delete');
}
</script>
