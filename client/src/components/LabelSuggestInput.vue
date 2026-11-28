<template>
  <div class="label-suggest-field">
    <input
      :value="modelValue"
      :class="inputClass"
      type="text"
      :placeholder="placeholder"
      :aria-label="ariaLabel"
      :disabled="disabled"
      role="combobox"
      autocomplete="off"
      aria-autocomplete="list"
      :aria-controls="listId"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-activedescendant="activeOptionId"
      @input="onInput($event.target.value)"
      @focus="focused = true"
      @blur="focused = false"
      @keydown.down="onArrow($event, 1)"
      @keydown.up="onArrow($event, -1)"
      @keydown.enter="onEnter"
      @keydown.esc="onEscape"
    />
    <ul v-if="open" :id="listId" class="label-suggest" role="listbox">
      <li
        v-for="(name, i) in suggestions"
        :id="optionId(i)"
        :key="name"
        class="label-suggest-option"
        :class="{ active: i === activeIndex }"
        role="option"
        :aria-selected="i === activeIndex"
        @mousedown.prevent="choose(name, 'click')"
      >{{ name }}</li>
    </ul>
  </div>
</template>

<script setup>
import { computed, ref, useId } from 'vue';

/**
 * A label field with the workspace's vocabulary behind it (KOL-159).
 *
 * `/relationship-types` has held a workspace's label vocabulary since the first
 * template was written — `workspaceSeeder.js` says of the types it inserts that
 * "without them the relationship picker is empty and the core feature of the
 * product looks broken on first use" — and there was no picker. Every label on
 * a relationship group or one of its members was typed free-hand, so a graph
 * accumulated `owns`, `Owns` and `owned by` as three unrelated labels while the
 * vocabulary that would have named them sat in the database, read by the
 * generator and offered to nobody.
 *
 * This is the **tag-suggestion pattern of `EntityEditor.vue`**, lifted to a
 * component because `RelationshipsSection.vue` has seven label fields and they
 * are not all the same vocabulary: `scope` decides which half each one offers,
 * so a group label is never offered a member role. The parent filters and hands
 * the already-right list down as `options`.
 *
 * Three properties it keeps from the tag field, each deliberate:
 *
 *   **A typed label that matches nothing still saves verbatim.** The list is a
 *   suggestion, never a constraint: the vocabulary is the workspace's own and a
 *   label it has no word for yet is exactly how the next word gets in. So this
 *   is a plain text input with a list beside it, not a select, and `options`
 *   being empty — including because the fetch behind it failed — leaves a field
 *   that works.
 *
 *   **Keyboard-navigable and dismissible**, as the ARIA combobox pattern wants:
 *   the input owns the list, the list owns the options, arrows move the active
 *   option, Enter takes it, Escape closes the list *only* (an arrow key reopens
 *   it, the way a native combobox does). Escape stops propagating so it closes
 *   the list rather than the panel the field is in.
 *
 *   **The list is only ever open while the field has focus**, so no two of the
 *   seven can be open at once and a form with several of them is readable.
 *
 * Tiered debug logging: set localStorage.RELATIONSHIP_TYPE_LOG_LEVEL to
 * off | light | normal | verbose (default light) — the same key the settings
 * group and the server route read.
 *   light   — every change the list makes to a field, naming the field, what
 *             made the change (click or keyboard) and the old value
 *   normal  — light, plus the list opening and closing
 *   verbose — normal, plus the matches computed for each keystroke
 */

const props = defineProps({
  modelValue: { type: String, default: '' },
  /** The vocabulary to offer, already filtered to this field's `scope`. */
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '' },
  /** Names the field in the log lines and to a screen reader. */
  ariaLabel: { type: String, required: true },
  /** The classes the bare `<input>` carried before it gained a list. */
  inputClass: { type: String, default: 'input input-sm' },
  disabled: { type: Boolean, default: false },
});

const emit = defineEmits(['update:modelValue']);

const MAX_SUGGESTIONS = 8;
const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  let configured = null;
  try { configured = localStorage.getItem('RELATIONSHIP_TYPE_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((LEVELS[configured] ?? LEVELS.light) >= LEVELS[level]) {
    console.log(`[labelSuggest:${level}] ${msg}`);
  }
}

const focused     = ref(false);
const dismissed   = ref(false);
const activeIndex = ref(-1);

// Unique per field: seven of these can be on screen at once, and
// aria-controls has to point at the right list.
const listId = useId();
const optionId = (i) => `${listId}-option-${i}`;

/**
 * Prefix matches first, then substring, case-insensitively — the tag field's
 * order, which puts what was most likely meant at the top. The name the field
 * already holds is dropped: offering the value back is a row that does nothing.
 */
const suggestions = computed(() => {
  const query = props.modelValue.trim().toLowerCase();
  const prefix = [];
  const substring = [];
  for (const name of props.options) {
    if (typeof name !== 'string' || !name.trim()) continue;
    const lower = name.toLowerCase();
    if (lower === query) continue;
    const at = lower.indexOf(query);
    if (at < 0) continue;
    (at === 0 ? prefix : substring).push(name);
  }
  return [...prefix, ...substring].slice(0, MAX_SUGGESTIONS);
});

const open = computed(() => focused.value && !dismissed.value && suggestions.value.length > 0);

const activeOptionId = computed(() =>
  (open.value && activeIndex.value >= 0) ? optionId(activeIndex.value) : null);

function onInput(value) {
  dismissed.value = false;
  activeIndex.value = -1;
  emit('update:modelValue', value);
  log('verbose', `"${props.ariaLabel}" typed "${value}" → ${suggestions.value.join(', ') || '(no match)'}`);
}

function onArrow(event, delta) {
  const count = suggestions.value.length;
  if (!count) return;
  event.preventDefault();
  // An arrow key reopens a list Escape closed, the way a native combobox does.
  if (dismissed.value) {
    dismissed.value = false;
    log('normal', `"${props.ariaLabel}" list reopened by an arrow key`);
  }
  activeIndex.value = activeIndex.value < 0
    ? (delta > 0 ? 0 : count - 1)
    : (activeIndex.value + delta + count) % count;
}

function onEnter(event) {
  // Only when an option is active: otherwise Enter is the key that submits
  // whatever form the field is in, and must stay that.
  if (!open.value || activeIndex.value < 0) return;
  event.preventDefault();
  choose(suggestions.value[activeIndex.value], 'keyboard');
}

function onEscape(event) {
  if (!open.value) return;
  event.preventDefault();
  // The panel this field sits in also closes on Escape, so the key must not do
  // two things at once: closing the list is the nearer of the two.
  event.stopPropagation();
  dismissed.value = true;
  activeIndex.value = -1;
  log('normal', `"${props.ariaLabel}" list closed by Escape`);
}

/** Replaces the field with `name` — the whole field, since it holds one label. */
function choose(name, source) {
  const previous = props.modelValue;
  activeIndex.value = -1;
  dismissed.value = false;
  emit('update:modelValue', name);
  log('light', `"${props.ariaLabel}" set by a ${source} suggestion "${name}": "${previous}" -> "${name}"`);
}
</script>

<style scoped>
.label-suggest-field { position: relative; }
.label-suggest-field input { width: 100%; }

.label-suggest {
  position: absolute;
  z-index: 5;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  margin: 0;
  padding: 4px;
  list-style: none;
  max-height: 200px;
  overflow-y: auto;
  background: #161616;
  border: 1px solid #333;
  border-radius: 7px;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.45);
}

.label-suggest-option {
  font-size: 12px;
  color: #888;
  padding: 5px 8px;
  border-radius: 5px;
  cursor: pointer;
}
.label-suggest-option:hover,
.label-suggest-option.active { background: #222; color: #e0e0e0; }
</style>
