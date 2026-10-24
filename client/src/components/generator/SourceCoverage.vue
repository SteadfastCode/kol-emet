<template>
  <section v-if="coverage.hasSource" class="coverage">
    <!-- Collapsed by default: the items are the review, this is the check you
         run before trusting it. The headline carries the number either way, so
         a draft that ignored half the notes says so without being opened. -->
    <button
      class="cov-head"
      type="button"
      :aria-expanded="open ? 'true' : 'false'"
      @click="open = !open"
    >
      <span class="chev" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
      <span class="cov-line">
        <strong>{{ coverage.usedPct }}%</strong> of {{ coverage.label }} went into this draft
        <template v-if="unusedCount">
          <span class="cov-unused">· {{ unusedCount }} passage{{ unusedCount === 1 ? '' : 's' }} unused</span>
        </template>
        <span v-else class="cov-clear">· nothing substantial was left out</span>
      </span>
    </button>

    <div v-if="open" class="cov-body">
      <div class="cov-modes" role="group" aria-label="Source coverage view">
        <button
          type="button" class="mode" :class="{ on: mode === 'unused' }"
          :aria-pressed="mode === 'unused' ? 'true' : 'false'"
          @click="mode = 'unused'"
        >Unused only</button>
        <button
          type="button" class="mode" :class="{ on: mode === 'context' }"
          :aria-pressed="mode === 'context' ? 'true' : 'false'"
          @click="mode = 'context'"
        >In context</button>
      </div>

      <!-- A quote that never located leaves its span looking unused, so say so
           rather than letting the percentage be read as the whole story. -->
      <p v-if="coverage.unlocatedCount" class="cov-caveat">
        {{ coverage.unlocatedCount }} proposal{{ coverage.unlocatedCount === 1 ? '' : 's' }}
        quote{{ coverage.unlocatedCount === 1 ? 's' : '' }} something that couldn't be found in
        {{ coverage.label }}, so this understates what was used.
      </p>

      <template v-if="mode === 'unused'">
        <p v-if="!unusedCount" class="cov-empty">
          Every passage of {{ coverage.label }} sits behind at least one proposal above.
        </p>
        <ol v-else class="cov-list">
          <li v-for="p in coverage.unused" :key="p.start" class="cov-passage">
            <span class="cov-where">line {{ p.line }}</span>
            <span class="cov-passage-text">{{ p.text.trim() }}</span>
          </li>
        </ol>
      </template>

      <pre v-else class="cov-text"><span
        v-for="(seg, i) in coverage.segments"
        :key="i"
        :class="seg.used ? 'seg-used' : 'seg-unused'"
      >{{ seg.text }}</span></pre>

      <p class="cov-foot">
        Measured from the quote each proposal was built on
        ({{ coverage.locatedCount }} of {{ itemCount }} located<template v-if="coverage.noEvidenceCount">,
        {{ coverage.noEvidenceCount }} with no quote</template>).
      </p>
    </div>
  </section>
</template>

<script setup>
import { ref, computed } from 'vue';
import { coverageOf } from '../../lib/sourceCoverage.js';

const props = defineProps({
  draft: { type: Object, default: null },
  /** Names the caller in the coverage log. */
  source: { type: String, default: 'SourceCoverage' },
});

const open = ref(false);
const mode = ref('unused');   // unused | context

const coverage = computed(() => coverageOf(props.draft, { source: props.source }));
const unusedCount = computed(() => coverage.value.unused.length);
const itemCount = computed(() => props.draft?.items?.length ?? 0);
</script>

<style scoped>
.coverage {
  border: 1px solid #1f1f1f;
  border-radius: 8px;
  background: #121212;
  overflow: hidden;
}

.cov-head {
  display: flex;
  align-items: baseline;
  gap: 7px;
  width: 100%;
  padding: 9px 12px;
  background: none;
  border: none;
  text-align: left;
  cursor: pointer;
  color: #888;
  font-size: 12px;
  font-family: inherit;
}
.cov-head:hover { background: #171717; }
.chev { color: #5a5a5a; font-size: 10px; }
.cov-line strong { color: #ddd; }
.cov-unused { color: #c08a30; }
.cov-clear  { color: #6a9a5a; }

.cov-body {
  padding: 2px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cov-modes { display: flex; gap: 6px; }
.mode {
  padding: 3px 9px;
  border: 1px solid #262626;
  border-radius: 999px;
  background: #171717;
  color: #888;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
}
.mode:hover { color: #bbb; }
.mode.on { background: #1e2a3a; border-color: #2a4a6a; color: #7ab4f5; }

.cov-caveat { margin: 0; font-size: 11px; line-height: 1.5; color: #c08a30; }
.cov-empty  { margin: 0; font-size: 12px; line-height: 1.5; color: #6a9a5a; }

.cov-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 42vh;
  overflow-y: auto;
}
.cov-passage {
  padding-left: 9px;
  border-left: 2px solid #3a3020;
  font-size: 12px;
  line-height: 1.55;
  color: #b0a68f;
  white-space: pre-wrap;
}
.cov-where {
  display: block;
  font-size: 10px;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: #6a6a6a;
  margin-bottom: 2px;
}

.cov-text {
  margin: 0;
  max-height: 42vh;
  overflow-y: auto;
  padding: 10px;
  border-radius: 6px;
  background: #0d0d0d;
  border: 1px solid #1c1c1c;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
/* Used text recedes; the unused text is the content of this pane. */
.seg-used   { color: #4a4a4a; }
.seg-unused { color: #d8cdb4; background: #231d10; border-radius: 2px; }

.cov-foot { margin: 0; font-size: 10px; line-height: 1.5; color: #5a5a5a; }
</style>
