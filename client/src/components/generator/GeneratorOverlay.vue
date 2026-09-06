<template>
  <div class="gen-overlay" @keydown.esc="tryClose">
    <div class="gen-chrome">
      <span class="gen-title">{{ titleFor(stage) }}</span>
      <button class="icon-btn" title="Close" @click="tryClose">✕</button>
    </div>

    <div class="gen-body">
      <!-- input -->
      <BraindumpInput
        v-if="stage === 'input'"
        :max-chars="maxChars"
        :allowance="allowance"
        :busy="false"
        :error="error"
        @generate="start"
        @close="tryClose"
      />

      <!-- generating -->
      <div v-else-if="stage === 'generating'" class="progress">
        <div class="spinner" />
        <p class="stage-line">{{ stageLabel }}</p>
        <p class="stage-note">
          This takes up to a minute. Closing this panel won't cancel it —
          the draft will be waiting in your list.
        </p>
      </div>

      <!-- review -->
      <DraftReview
        v-else-if="stage === 'review'"
        :draft-id="draftId"
        @applied="onApplied"
      />

      <!-- applied -->
      <div v-else-if="stage === 'applied'" class="landed">
        <p class="landed-count">
          {{ result.applied }} item{{ result.applied === 1 ? '' : 's' }} added to your wiki
        </p>
        <p v-if="result.blocked" class="landed-drop">
          {{ result.blocked }} couldn't be added — {{ result.blocked === 1 ? 'it depends' : 'they depend' }}
          on something you skipped.
        </p>
        <p v-if="result.failed" class="landed-drop">
          {{ result.failed }} failed. Reopen the draft to see why.
        </p>
        <div class="actions">
          <button class="btn-sm" @click="reset">New draft</button>
          <button class="btn-sm primary" @click="tryClose">Done</button>
        </div>
      </div>

      <!-- failed -->
      <div v-else-if="stage === 'failed'" class="landed">
        <p class="error">{{ error || 'Generation failed.' }}</p>
        <div class="actions">
          <button class="btn-sm primary" @click="reset">Try again</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import BraindumpInput from './BraindumpInput.vue';
import DraftReview from './DraftReview.vue';
import { streamDraft, getAllowance } from '../../api/drafts.js';

const emit = defineEmits(['close', 'generated', 'applied']);

const maxChars  = 25000;
const stage     = ref('input');      // input | generating | review | applied | failed
const error     = ref('');
const stageLabel = ref('');
const counts    = ref({ proposed: 0, dropped: 0 });
const allowance = ref(null);
const draftId   = ref(null);
const result    = ref({ applied: 0, failed: 0, blocked: 0, skipped: 0 });

onMounted(async () => {
  // Surfaced before the first keystroke so an exhausted allowance is visible
  // up front rather than as a 402 after writing 2,000 words.
  try { allowance.value = await getAllowance(); } catch { /* non-fatal */ }
});

const titleFor = s => ({
  input: 'New draft',
  generating: 'Reading your notes',
  review: 'Review draft',
  applied: 'Added to your wiki',
  ready: 'Draft ready',
  failed: 'Generation failed',
}[s] ?? 'Draft');

function describe(ev) {
  if (ev.stage === 'entities') {
    return ev.of > 1
      ? `Finding entities — part ${ev.chunk} of ${ev.of}…`
      : 'Finding entities…';
  }
  if (ev.stage === 'relationships') return 'Working out relationships…';
  if (ev.stage === 'normalizing')   return 'Checking against your existing graph…';
  return 'Working…';
}

async function start(text) {
  error.value = '';
  stage.value = 'generating';
  stageLabel.value = 'Starting…';

  try {
    for await (const ev of streamDraft({ text })) {
      if (ev.type === 'created') draftId.value = ev.draftId;
      else if (ev.type === 'stage') stageLabel.value = describe(ev);
      else if (ev.type === 'done') {
        counts.value = ev.counts ?? { proposed: 0, dropped: 0 };
        if (ev.budget) allowance.value = ev.budget;
        stage.value = 'review';
        emit('generated', { draftId: draftId.value, counts: counts.value });
      } else if (ev.type === 'error') {
        error.value = ev.message;
        stage.value = 'failed';
      }
    }
    // The stream can end without a terminal event if the connection drops
    // mid-run. The draft still completes server-side, so say that rather than
    // leaving a spinner forever.
    if (stage.value === 'generating') {
      error.value = 'Lost the connection while generating. The draft is still being finished — check your list in a moment.';
      stage.value = 'failed';
    }
  } catch (err) {
    error.value = err.message;
    stage.value = err.status === 402 || err.status === 409 ? 'input' : 'failed';
    if (err.body?.remaining) allowance.value = err.body;
  }
}

function onApplied(res) {
  result.value = res;
  stage.value = 'applied';
  // Only now has anything reached the graph, so this is where the entity list
  // needs refreshing — generation alone never changes it.
  emit('applied', res);
}

function reset() {
  stage.value = 'input';
  error.value = '';
  draftId.value = null;
  counts.value = { proposed: 0, dropped: 0 };
  result.value = { applied: 0, failed: 0, blocked: 0, skipped: 0 };
}

function tryClose() {
  // Closing mid-run is allowed — the server finishes regardless — but say so
  // rather than letting it look like a cancel.
  emit('close');
}
</script>

<style scoped>
.gen-overlay {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  background: #0f0f0f;
}

.gen-chrome {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid #1e1e1e;
}
.gen-title { font-size: 13px; font-weight: 600; color: #ccc; }

.gen-body { flex: 1; overflow-y: auto; padding: 20px 24px 24px; }

.progress { display: flex; flex-direction: column; align-items: center; gap: 14px; padding-top: 64px; }
.spinner {
  width: 28px; height: 28px;
  border: 2px solid #2a2a2a;
  border-top-color: #5a8ac0;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.stage-line { margin: 0; font-size: 14px; color: #ccc; }
.stage-note { margin: 0; max-width: 42ch; text-align: center; font-size: 12px; line-height: 1.5; color: #666; }

.landed { display: flex; flex-direction: column; align-items: center; gap: 10px; padding-top: 56px; }
.landed-count { margin: 0; font-size: 18px; color: #e8e8e8; }
.landed-drop  { margin: 0; font-size: 12px; color: #c08a30; }
.landed-note  { margin: 0 0 8px; font-size: 12px; color: #666; }

.error {
  margin: 0;
  max-width: 52ch;
  padding: 10px 14px;
  border-radius: 6px;
  background: #2a1616;
  border: 1px solid #4a2020;
  color: #e0a0a0;
  font-size: 13px;
  line-height: 1.5;
}

.actions { display: flex; gap: 8px; }
</style>
