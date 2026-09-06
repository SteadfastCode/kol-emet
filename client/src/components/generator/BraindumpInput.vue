<template>
  <div class="braindump">
    <div class="intro">
      <h2>Turn notes into a graph</h2>
      <p>
        Paste rough notes — a character sketch, a session of worldbuilding, a chapter of
        background. Kol Emet reads them and proposes entities and relationships for you to
        review. <strong>Nothing is saved until you approve it.</strong>
      </p>
    </div>

    <textarea
      ref="ta"
      v-model="text"
      class="dump"
      :maxlength="maxChars"
      placeholder="Tamsin runs the salvage yard out on the Rift Verge. Her younger brother Cael gambles, and owes money to a woman called Iseult Vane…"
      :disabled="busy"
      @keydown.meta.enter="submit"
      @keydown.ctrl.enter="submit"
    />

    <div class="meter" :class="{ warn: nearLimit, over: overLimit }">
      <span>{{ text.length.toLocaleString() }} / {{ maxChars.toLocaleString() }} characters</span>
      <span v-if="allowance" class="allowance">
        {{ allowance.remaining }} of {{ allowance.granted }} AI allowance left
      </span>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="actions">
      <button class="btn-sm" :disabled="busy" @click="$emit('close')">Cancel</button>
      <button class="btn-sm primary" :disabled="!canSubmit" @click="submit">
        {{ busy ? 'Reading…' : 'Generate draft' }}
      </button>
    </div>
    <p class="hint">⌘/Ctrl + Enter</p>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';

const props = defineProps({
  maxChars:  { type: Number, default: 25000 },
  allowance: { type: Object, default: null },
  busy:      { type: Boolean, default: false },
  error:     { type: String, default: '' },
});
const emit = defineEmits(['generate', 'close']);

const text = ref('');
const ta = ref(null);
onMounted(() => ta.value?.focus());

const overLimit  = computed(() => text.value.length > props.maxChars);
const nearLimit  = computed(() => text.value.length > props.maxChars * 0.9);
// An exhausted allowance is reported by the server as a 402; the button is
// disabled here too so the failure is visible before the click, not after.
const noAllowance = computed(() => props.allowance?.exhausted === true);
const canSubmit = computed(() =>
  !props.busy && text.value.trim().length > 0 && !overLimit.value && !noAllowance.value
);

function submit() {
  if (!canSubmit.value) return;
  emit('generate', text.value);
}
</script>

<style scoped>
.braindump { display: flex; flex-direction: column; gap: 12px; height: 100%; }

.intro h2 { margin: 0 0 6px; font-size: 18px; color: #e8e8e8; }
.intro p  { margin: 0; font-size: 13px; line-height: 1.55; color: #888; max-width: 62ch; }
.intro strong { color: #aaa; font-weight: 600; }

.dump {
  flex: 1;
  min-height: 220px;
  resize: none;
  padding: 14px 16px;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
  background: #141414;
  color: #ddd;
  font-size: 14px;
  line-height: 1.6;
  font-family: inherit;
}
.dump:focus { outline: none; border-color: #3a5f8a; }
.dump:disabled { opacity: 0.6; }

.meter {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  color: #555;
}
.meter.warn  { color: #c08a30; }
.meter.over  { color: #c05050; }
.allowance { color: #555; }

.error {
  margin: 0;
  padding: 8px 12px;
  border-radius: 6px;
  background: #2a1616;
  border: 1px solid #4a2020;
  color: #e0a0a0;
  font-size: 12px;
}

.actions { display: flex; justify-content: flex-end; gap: 8px; }
.hint { margin: 0; text-align: right; font-size: 10px; color: #444; }
</style>
