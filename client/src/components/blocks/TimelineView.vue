<template>
  <div class="timeline-view">
    <div class="block-toolbar">
      <span class="block-type-label">Timeline</span>
      <button v-if="canEdit" class="icon-btn" title="Edit timeline events" @click="$emit('edit')"><PencilIcon /></button>
    </div>
    <div class="timeline">
      <div
        v-for="event in sortedEvents"
        :key="event._id"
        class="timeline-event"
      >
        <div class="timeline-dot" />
        <div class="timeline-content">
          <div class="event-date">
            <span class="date-str">{{ event.data.date || 'Unknown date' }}</span>
            <span v-if="event.data.era" class="date-era">{{ event.data.era }}</span>
          </div>
          <p class="event-desc">{{ event.data.description }}</p>
          <span
            v-if="linkedEntryFor(event)"
            class="event-link wiki-link"
            @click="followLink(linkedEntryFor(event)._id, linkedEntryFor(event).title)"
          >→ {{ linkedEntryFor(event).title }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, inject, ref } from 'vue';
import PencilIcon from '../icons/PencilIcon.vue';

const props = defineProps({ events: Array, canEdit: Boolean });
defineEmits(['edit']);
const entries = inject('entries', ref([]));
const followLink = inject('followLink', () => {});

const sortedEvents = computed(() =>
  [...props.events].sort((a, b) => (a.data.sortKey ?? 0) - (b.data.sortKey ?? 0))
);

function linkedEntryFor(event) {
  return event.data.linkedEntryId
    ? entries.value?.find(e => e._id === event.data.linkedEntryId)
    : null;
}
</script>

<style scoped>
.timeline-view { }

.timeline {
  position: relative;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.timeline::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 8px;
  bottom: 8px;
  width: 1px;
  background: #2a2a2a;
}

.timeline-event {
  position: relative;
  display: flex;
  gap: 12px;
  padding: 10px 0;
}

.timeline-dot {
  position: absolute;
  left: -16px;
  top: 16px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #FAC775;
  border: 2px solid #121212;
  flex-shrink: 0;
}

.timeline-content { display: flex; flex-direction: column; gap: 4px; }

.event-date { display: flex; align-items: center; gap: 8px; }
.date-str { font-size: 13px; font-weight: 500; color: #FAC775; }
.date-era { font-size: 11px; color: #666; }
.event-desc { font-size: 14px; color: #ccc; line-height: 1.6; }
.event-link { font-size: 12px; color: #7ab4f5; cursor: pointer; }
.event-link:hover { text-decoration: underline; }
</style>
