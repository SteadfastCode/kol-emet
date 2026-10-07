<template>
  <div class="tag-settings">
    <p class="tag-note">
      Renaming a tag changes it on every entity that carries it, and merges it into the new name
      when one already has both. Each change is recorded in that entity's history.
    </p>

    <p v-if="!tags.length" class="tag-note">No tags yet.</p>
    <ul v-else class="tag-list">
      <li v-for="t in tags" :key="t.name" class="tag-item">
        <form v-if="renamingTag === t.name" class="tag-rename" @submit.prevent="rename(t)">
          <input
            v-model="renameTo"
            class="tag-input"
            type="text"
            :aria-label="`New name for ${t.name}`"
            :disabled="!!busy"
          />
          <button type="submit" class="mini" :disabled="!!busy || !renameTo.trim()">
            {{ busy === t.name ? 'Saving…' : 'Save' }}
          </button>
          <button type="button" class="mini" :disabled="!!busy" @click="reset">Cancel</button>
        </form>
        <template v-else>
          <div class="tag-info">
            <span class="tag-name">{{ t.name }}</span>
            <span class="tag-count">{{ t.count }} {{ t.count === 1 ? 'entity' : 'entities' }}</span>
          </div>
          <div v-if="confirmingTag === t.name" class="tag-actions">
            <button type="button" class="mini danger" :disabled="!!busy" @click="remove(t)">
              {{ busy === t.name ? 'Removing…' : 'Remove' }}
            </button>
            <button type="button" class="mini" :disabled="!!busy" @click="reset">Keep</button>
          </div>
          <div v-else class="tag-actions">
            <button type="button" class="mini" :disabled="!!busy" @click="startRename(t)">Rename</button>
            <button type="button" class="mini" :disabled="!!busy" @click="startRemove(t)">Remove</button>
          </div>
        </template>
      </li>
    </ul>

    <p v-if="error" class="tag-error" role="alert">{{ error }}</p>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { renameTag, removeTag } from '../api/tags.js';

/**
 * The Tags group in Settings (KOL-053): every tag in the workspace with the
 * number of entities carrying it, and a rename and a remove for each.
 *
 * The counts come from the entity list the layout already holds, not from a
 * request of their own — `GET /tags` answers names without counts, and the
 * list is loaded before Settings can be opened. After a change the parent
 * refetches (`changed`), which is what moves the counts.
 *
 * Tiered debug logging: set localStorage.TAG_LOG_LEVEL to
 * off | light | normal | verbose (default light). The server logs the same
 * operations on its own TAG_LOG_LEVEL.
 *   light   — every rename and removal sent from here and how it ended,
 *             naming the action that started it
 *   normal  — light, plus the tag list each render was built from
 *   verbose — normal, plus the per-tag counts
 */

const props = defineProps({
  /** The workspace's entities, as `useEntities` holds them. */
  entities: { type: Array, default: () => [] },
});

const emit = defineEmits(['changed']);

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  let configured;
  try { configured = localStorage.getItem('TAG_LOG_LEVEL'); } catch { configured = null; }
  const active = LEVELS[configured] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[tags:${level}] ${msg}`);
}

const renamingTag  = ref(null);   // the tag whose rename field is open
const confirmingTag = ref(null);  // the tag whose Remove is armed
const renameTo     = ref('');
const busy         = ref(null);   // null, or the tag a request is in flight for
const error        = ref('');

const SESSION_EXPIRED = 'Your session has expired. Sign in again to manage tags.';

/** `[{ name, count }]`, every tag in the workspace, sorted by name. */
const tags = computed(() => {
  const counts = new Map();
  for (const entity of props.entities) {
    for (const tag of entity?.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const list = [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
  log('normal', `${list.length} tag(s) across ${props.entities.length} entities (source: the layout's entity list)`);
  log('verbose', `counts: ${list.map(t => `${t.name}=${t.count}`).join(', ') || 'none'}`);
  return list;
});

function reset() {
  renamingTag.value = null;
  confirmingTag.value = null;
  renameTo.value = '';
}

function startRename(t) {
  reset();
  error.value = '';
  renamingTag.value = t.name;
  renameTo.value = t.name;
}

function startRemove(t) {
  reset();
  error.value = '';
  confirmingTag.value = t.name;
}

function messageFor(err, verb) {
  if (err.status === 401) return SESSION_EXPIRED;
  // 404 (nothing carries it any more), 413 (too many entities) and 400 are the
  // server's own sentences, and each names what the caller needs to know.
  if ([400, 404, 413].includes(err.status)) return err.message;
  return `Could not ${verb} the tag. Please try again.`;
}

async function rename(t) {
  const to = renameTo.value.trim();
  if (!to) return;
  if (to === t.name) { reset(); return; }

  error.value = '';
  busy.value = t.name;
  try {
    const res = await renameTag(t.name, to);
    log('light', `renamed "${t.name}" → "${to}" on ${res?.renamed ?? '?'} entities (source: Settings → Tags → Rename)`);
    reset();
    emit('changed');
  } catch (err) {
    log('light', `renaming "${t.name}" → "${to}" failed: ${err.status ?? err.message} (source: Settings → Tags → Rename)`);
    error.value = messageFor(err, 'rename');
  } finally {
    busy.value = null;
  }
}

async function remove(t) {
  error.value = '';
  busy.value = t.name;
  try {
    const res = await removeTag(t.name);
    log('light', `removed "${t.name}" from ${res?.removed ?? '?'} entities (source: Settings → Tags → Remove)`);
    reset();
    emit('changed');
  } catch (err) {
    log('light', `removing "${t.name}" failed: ${err.status ?? err.message} (source: Settings → Tags → Remove)`);
    error.value = messageFor(err, 'remove');
  } finally {
    busy.value = null;
  }
}
</script>

<style scoped>
.tag-settings { display: flex; flex-direction: column; gap: 8px; }

.tag-note  { font-size: 12px; color: #777; line-height: 1.5; margin: 0; }
.tag-error { font-size: 12px; color: #e07070; margin: 0; }

.tag-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }

.tag-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: #111;
  border: 1px solid #1e1e1e;
  border-radius: 8px;
}

.tag-info  { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.tag-name  { font-size: 14px; color: #ccc; overflow-wrap: anywhere; }
.tag-count { font-size: 12px; color: #777; }

.tag-actions { display: flex; gap: 6px; }

.tag-rename { display: flex; align-items: center; gap: 6px; width: 100%; }

.tag-input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  background: #0b0b0b;
  border: 1px solid #2a2a2a;
  border-radius: 6px;
  color: #ccc;
  font-size: 14px;
  font-family: inherit;
}
.tag-input:focus { outline: none; border-color: #3a3a3a; }

.mini {
  flex-shrink: 0;
  padding: 6px 10px;
  background: none;
  border: 1px solid #2a2a2a;
  border-radius: 6px;
  color: #aaa;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}
.mini:hover:not(:disabled) { background: #1a1a1a; }
.mini:disabled { opacity: 0.4; cursor: default; }
.mini.danger { color: #e07070; border-color: #3a1a1a; }
</style>
