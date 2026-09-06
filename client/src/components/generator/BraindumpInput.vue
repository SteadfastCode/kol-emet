<template>
  <div class="braindump">
    <div class="intro">
      <h2>Turn notes into a graph</h2>
      <p>
        Paste or import rough notes — a character sketch, a session of worldbuilding, a chapter
        of background. Kol Emet reads them and proposes entities and relationships for you to
        review. <strong>Nothing is saved until you approve it.</strong>
      </p>
    </div>

    <div
      class="drop"
      :class="{ dragging, busy: importing }"
      @dragover.prevent="dragging = true"
      @dragenter.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <textarea
        ref="ta"
        v-model="text"
        class="dump"
        placeholder="Tamsin runs the salvage yard out on the Rift Verge. Her younger brother Cael gambles, and owes money to a woman called Iseult Vane…&#10;&#10;Or drop a .txt, .md or .docx file here."
        :disabled="busy || importing"
        @keydown.meta.enter="submit"
        @keydown.ctrl.enter="submit"
      />
      <div v-if="dragging" class="drop-hint">Drop to import</div>
      <div v-else-if="importing" class="drop-hint">Reading {{ importingName }}…</div>
    </div>

    <div class="row">
      <div class="left">
        <button class="btn-sm" :disabled="busy || importing" @click="picker?.click()">
          Import file…
        </button>
        <input
          ref="picker"
          type="file"
          class="hidden"
          multiple
          :accept="ACCEPT_ATTR"
          @change="onPick"
        />
        <span v-if="imported.length" class="imported">
          Imported {{ imported.join(', ') }}
          <button class="link" @click="clearAll">clear</button>
        </span>
      </div>

      <div class="meter" :class="{ warn: nearLimit, over: overLimit }">
        <span>{{ text.length.toLocaleString() }} / {{ maxChars.toLocaleString() }}</span>
        <span v-if="allowance" class="allowance">· {{ allowance.remaining }} left</span>
      </div>
    </div>

    <p v-for="msg in importErrors" :key="msg" class="warn-line">{{ msg }}</p>
    <p v-if="overLimit" class="warn-line">
      That's {{ (text.length - maxChars).toLocaleString() }} characters over the limit.
      Trim it, or generate in two passes.
    </p>
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
import { extractAll, ACCEPT_ATTR } from '../../lib/importFile.js';

const props = defineProps({
  maxChars:  { type: Number, default: 25000 },
  allowance: { type: Object, default: null },
  busy:      { type: Boolean, default: false },
  error:     { type: String, default: '' },
});
const emit = defineEmits(['generate', 'close']);

const text = ref('');
const ta = ref(null);
const picker = ref(null);
const dragging = ref(false);
const importing = ref(false);
const importingName = ref('');
const imported = ref([]);
const importErrors = ref([]);

onMounted(() => ta.value?.focus());

const overLimit   = computed(() => text.value.length > props.maxChars);
const nearLimit   = computed(() => text.value.length > props.maxChars * 0.9 && !overLimit.value);
const noAllowance = computed(() => props.allowance?.exhausted === true);
const canSubmit = computed(() =>
  !props.busy && !importing.value && text.value.trim().length > 0 && !overLimit.value && !noAllowance.value
);

/**
 * Imported text is appended, never replaced — someone who has typed a
 * paragraph and then imports a file should not lose what they wrote. It lands
 * in the same editable field so it can be corrected before generating, which
 * matters for .docx especially: Word export is rarely clean.
 */
async function ingest(files) {
  const list = [...files];
  if (!list.length) return;

  importing.value = true;
  importingName.value = list.length === 1 ? list[0].name : `${list.length} files`;
  importErrors.value = [];

  try {
    const { text: extracted, names, errors } = await extractAll(list);
    importErrors.value = errors;
    if (extracted) {
      text.value = text.value.trim() ? `${text.value.trim()}\n\n${extracted}` : extracted;
      imported.value.push(...names);
    }
    // Over-length is surfaced rather than silently truncated: cutting someone's
    // notes off mid-sentence without saying so is worse than refusing.
  } finally {
    importing.value = false;
    importingName.value = '';
    if (picker.value) picker.value.value = '';   // let the same file be re-picked
  }
}

const onDrop = (e) => { dragging.value = false; ingest(e.dataTransfer?.files ?? []); };
const onPick = (e) => ingest(e.target.files ?? []);

function clearAll() {
  text.value = '';
  imported.value = [];
  importErrors.value = [];
  ta.value?.focus();
}

function submit() {
  if (!canSubmit.value) return;
  emit('generate', text.value);
}
</script>

<style scoped>
.braindump { display: flex; flex-direction: column; gap: 10px; height: 100%; }

.intro h2 { margin: 0 0 6px; font-size: 18px; color: #e8e8e8; }
.intro p  { margin: 0; font-size: 13px; line-height: 1.55; color: #888; max-width: 62ch; }
.intro strong { color: #aaa; font-weight: 600; }

.drop { position: relative; flex: 1; min-height: 200px; display: flex; }
.drop.dragging::after,
.drop.busy::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 8px;
  border: 2px dashed #3a5f8a;
  background: rgba(58, 95, 138, 0.08);
  pointer-events: none;
}
.drop-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: #7ab4f5;
  pointer-events: none;
}

.dump {
  flex: 1;
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

.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.left { display: flex; align-items: center; gap: 8px; min-width: 0; }
.hidden { display: none; }

.imported {
  font-size: 11px;
  color: #6a8a6a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.link {
  background: none; border: none; padding: 0 0 0 4px;
  color: #666; font-size: 11px; text-decoration: underline; cursor: pointer;
}
.link:hover { color: #999; }

.meter { display: flex; gap: 4px; font-size: 11px; color: #555; white-space: nowrap; }
.meter.warn { color: #c08a30; }
.meter.over { color: #c05050; }
.allowance { color: #555; }

.warn-line { margin: 0; font-size: 12px; line-height: 1.5; color: #c08a30; }

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
