<template>
  <div class="item" :class="[`d-${item.decision}`, { blocked, applied: item.applyState === 'applied' }]">
    <!-- what it is -->
    <div class="head">
      <span v-if="item.kind === 'entity'" class="cat" :style="catStyle">{{ category }}</span>
      <span v-else class="cat kind">{{ item.kind === 'relationship' ? 'Relationship' : 'Open question' }}</span>

      <span class="title">{{ title }}</span>

      <span v-if="item.op === 'update'" class="op" title="Adds to an entity you already have">
        adds to existing
      </span>
      <span v-if="item.applyState === 'applied'" class="op done">in your wiki</span>
    </div>

    <p v-if="summary" class="summary">{{ summary }}</p>

    <!-- relationship members -->
    <div v-if="item.kind === 'relationship'" class="members">
      <span v-for="(m, i) in payload.members" :key="i" class="member">
        <span class="role">{{ m.label || '—' }}</span>{{ m.name }}
      </span>
    </div>

    <!-- what it's built from -->
    <p v-if="evidence" class="evidence" :title="'From your notes'">“{{ evidence }}”</p>

    <!-- things needing a decision -->
    <div v-if="item.flags?.includes('duplicate_candidate')" class="flag dup">
      <span>Looks like it might already exist{{ duplicateTitle ? ` — “${duplicateTitle}”` : '' }}.</span>
      <span class="flag-actions">
        <button class="link" @click="$emit('merge', item)">Add to that one instead</button>
        <button class="link" @click="$emit('keep-separate', item)">Keep separate</button>
      </span>
    </div>
    <p v-if="item.flags?.includes('category_coerced')" class="flag">
      Category was read as “{{ payload.category }}” and filed under {{ category }}.
    </p>
    <p v-if="item.flags?.includes('member_dropped')" class="flag">
      One or more members couldn't be matched and were left out.
    </p>
    <p v-if="item.flags?.includes('no_evidence')" class="flag subtle">
      No supporting quote — check this one against your notes.
    </p>

    <p v-if="blocked" class="flag blocked-note">{{ blocked }}</p>
    <p v-if="item.applyError" class="flag error">{{ item.applyError }}</p>

    <!-- decision -->
    <div class="actions">
      <template v-if="item.applyState === 'applied'">
        <span class="verdict done">Added</span>
      </template>
      <template v-else-if="item.decision === 'pending'">
        <button class="btn-sm" :disabled="busy" @click="$emit('reject', item)">Skip</button>
        <button class="btn-sm" :disabled="busy" @click="$emit('edit', item)">Edit…</button>
        <button class="btn-sm primary" :disabled="busy || !!blocked" @click="$emit('accept', item)">
          Keep
        </button>
      </template>
      <template v-else>
        <span class="verdict" :class="item.decision">{{ verdictLabel }}</span>
        <button class="link" :disabled="busy" @click="$emit('undo', item)">change</button>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { CAT_COLORS } from '../../config/categories.js';

const props = defineProps({
  item:  { type: Object, required: true },
  busy:  { type: Boolean, default: false },
  blocked: { type: String, default: null },
  duplicateTitle: { type: String, default: '' },
});
defineEmits(['accept', 'reject', 'edit', 'undo', 'merge', 'keep-separate']);

// What the reviewer signed off on, if they edited — otherwise the proposal.
const payload  = computed(() => props.item.accepted ?? props.item.proposed ?? {});
const category = computed(() => payload.value.normalizedCategory ?? payload.value.category ?? '');
const catStyle = computed(() => {
  const c = CAT_COLORS[category.value] ?? { bg: '#333', color: '#aaa' };
  return { background: c.bg, color: c.color };
});

const title = computed(() =>
  payload.value.title ?? payload.value.label ?? payload.value.question ?? props.item.localKey
);
const summary = computed(() =>
  props.item.kind === 'entity' ? payload.value.summary : ''
);
const evidence = computed(() => {
  const q = props.item.input?.evidence?.quote ?? '';
  return q.length > 180 ? `${q.slice(0, 180)}…` : q;
});

const verdictLabel = computed(() => ({
  accepted: 'Keeping',
  edited:   'Edited',
  rejected: 'Skipped',
}[props.item.decision] ?? props.item.decision));
</script>

<style scoped>
.item {
  padding: 12px 14px;
  border: 1px solid #232323;
  border-radius: 8px;
  background: #141414;
  display: flex;
  flex-direction: column;
  gap: 7px;
  transition: opacity 120ms ease, border-color 120ms ease;
}
.item.d-rejected { opacity: 0.45; }
.item.blocked    { opacity: 0.6; border-color: #3a2a1a; }
.item.applied    { border-color: #24361f; }

.head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cat {
  font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 999px; white-space: nowrap;
}
.cat.kind { background: #23262e; color: #8a93a5; }
.title { font-size: 14px; font-weight: 600; color: #e6e6e6; }
.op { font-size: 10px; color: #8a7a4a; border: 1px solid #3a331f; border-radius: 4px; padding: 1px 5px; }
.op.done { color: #6a9a5a; border-color: #24361f; }

.summary { margin: 0; font-size: 12px; line-height: 1.5; color: #999; }

.members { display: flex; flex-wrap: wrap; gap: 6px; }
.member { font-size: 11px; color: #bbb; display: inline-flex; align-items: center; gap: 5px; }
.role {
  font-size: 10px; padding: 1px 6px; border-radius: 999px;
  background: #1e2a3a; color: #7ab4f5; border: 1px solid #2a4a6a;
}

.evidence {
  margin: 0;
  padding-left: 9px;
  border-left: 2px solid #2a2a2a;
  font-size: 11px;
  line-height: 1.5;
  color: #666;
  font-style: italic;
}

.flag {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: #c08a30;
}
.flag.subtle { color: #6a6a6a; }
.flag.error  { color: #c07070; }
.flag.blocked-note { color: #a07840; }
.flag.dup { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
.flag-actions { display: flex; gap: 10px; }

.actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-top: 2px; }
.verdict { font-size: 11px; color: #777; }
.verdict.accepted, .verdict.edited { color: #6a9a5a; }
.verdict.rejected { color: #777; }
.verdict.done { color: #6a9a5a; font-weight: 600; }

.link {
  background: none; border: none; padding: 0;
  color: #6a8ab5; font-size: 11px; text-decoration: underline; cursor: pointer;
}
.link:hover { color: #8ab4e5; }
.link:disabled { opacity: 0.4; cursor: default; }
</style>
