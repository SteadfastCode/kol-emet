<template>
  <LoginView v-if="!isAuthenticated" @login-success="onLoginSuccess" />
  <div v-else class="app">
    <header class="app-header">
      <h1>Kol Emet</h1>
      <div class="top-bar">
        <input v-model="searchQuery" class="search" placeholder="Search entries..." />
        <button class="btn" @click="openModal()">+ Add entry</button>
        <button class="btn" @click="handleLogout">Sign out</button>
      </div>
    </header>

    <div class="cat-pills">
      <span
        v-for="cat in ['All', ...CATEGORIES]" :key="cat"
        class="pill" :class="{ active: activeCat === cat && !activeTag }"
        @click="setCat(cat)"
      >{{ cat }}</span>
      <span v-if="activeTag" class="pill active" @click="clearTag">#{{ activeTag }} ✕</span>
    </div>

    <div class="stats">{{ filtered.length }} of {{ entries.length }} entries</div>

    <div v-if="loading" class="empty">Loading…</div>
    <div v-else-if="!filtered.length" class="empty">No entries found.</div>
    <div v-else class="entries" :style="editingCardHeight ? { paddingTop: editingCardHeight + 16 + 'px' } : {}">
      <EntryCard
        v-for="entry in filtered" :key="entry._id"
        :entry="entry"
        :expanded="expandedId === entry._id"
        :is-another-editing="editingId !== null && editingId !== entry._id"
        @toggle="toggleEntry(entry._id)"
        @tag-click="setTag"
        @saved="handleSaved"
        @delete="handleDelete(entry._id)"
        @edit-start="editingId = entry._id"
        @edit-end="editingId = null"
        @edit-height="editingCardHeight = $event"
      />
    </div>

    <!-- Modal -->
    <div v-if="modal.open" class="modal-wrap" @click.self="closeModal">
      <div class="modal">
        <h3>{{ modal.entry ? 'Edit entry' : 'New entry' }}</h3>

        <label>Title</label>
        <input v-model="form.title" placeholder="Entry name" />

        <label>Category</label>
        <select v-model="form.category">
          <option v-for="cat in CATEGORIES" :key="cat">{{ cat }}</option>
        </select>

        <label>Summary</label>
        <input v-model="form.summary" placeholder="One-line description" />

        <label>Full notes</label>
        <textarea v-model="form.body" placeholder="Detailed notes…" />

        <label>Tags <span class="hint">(comma separated)</span></label>
        <input v-model="form.tagsRaw" placeholder="e.g. WorldTrain, Xor, Founder" />

        <div class="modal-actions">
          <button class="btn-sm" @click="closeModal">Cancel</button>
          <button class="btn-sm primary" @click="saveEntry" :disabled="!form.title.trim()">Save</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import EntryCard from './components/EntryCard.vue';
import { getEntries, createEntry, updateEntry, deleteEntry } from './api/entries.js';
import { getSession, logout } from './api/auth.js';
import LoginView from './views/LoginView.vue';

const CATEGORIES = ['Characters', 'Worlds', 'Organizations', 'Lore & Mechanics', 'Timeline'];

const entries = ref([]);
const loading = ref(true);
const searchQuery = ref('');
const activeCat = ref('All');
const activeTag = ref(null);
const expandedId = ref(null);
const editingId = ref(null);
const modal = ref({ open: false, entry: null });
const form = ref(emptyForm());
const isAuthenticated = ref(false);
const editingCardHeight = ref(0);

function emptyForm() {
  return { title: '', category: 'Characters', summary: '', body: '', tagsRaw: '' };
}

onMounted(async () => {
  try {
    await getSession();
    isAuthenticated.value = true;
    await load();
  } catch {
    isAuthenticated.value = false;
  }
});

function onLoginSuccess() {
  isAuthenticated.value = true;
  load();
}

async function handleLogout() {
  await logout();
  isAuthenticated.value = false;
}

async function load() {
  loading.value = true;
  entries.value = await getEntries();
  loading.value = false;
}

const filtered = computed(() => {
  const q = searchQuery.value.toLowerCase();
  return entries.value.filter(e => {
    if (activeCat.value !== 'All' && e.category !== activeCat.value) return false;
    if (activeTag.value && !e.tags.map(t => t.toLowerCase()).includes(activeTag.value.toLowerCase())) return false;
    if (q) {
      const hay = [e.title, e.summary, e.body, ...e.tags, e.open_question].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
});

function setCat(cat) { activeCat.value = cat; activeTag.value = null; }
function setTag(tag) { activeTag.value = tag; activeCat.value = 'All'; }
function clearTag() { activeTag.value = null; }
function toggleEntry(id) { expandedId.value = expandedId.value === id ? null : id; }

function openModal(entry = null) {
  modal.value = { open: true, entry };
  if (entry) {
    form.value = {
      title: entry.title,
      category: entry.category,
      summary: entry.summary,
      body: entry.body,
      tagsRaw: entry.tags.join(', '),
    };
  } else {
    form.value = emptyForm();
  }
}

function closeModal() { modal.value = { open: false, entry: null }; }

async function saveEntry() {
  const data = {
    title: form.value.title.trim(),
    category: form.value.category,
    summary: form.value.summary.trim(),
    body: form.value.body.trim(),
    tags: form.value.tagsRaw.split(',').map(t => t.trim()).filter(Boolean),
  };
  if (modal.value.entry) {
    await updateEntry(modal.value.entry._id, data);
  } else {
    await createEntry(data);
  }
  closeModal();
  await load();
}

function handleSaved(updated) {
  const idx = entries.value.findIndex(e => e._id === updated._id);
  if (idx !== -1) entries.value[idx] = updated;
}

async function handleDelete(id) {
  await deleteEntry(id);
  if (expandedId.value === id) expandedId.value = null;
  await load();
}
</script>

<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: #121212;
  color: #e0e0e0;
  font-family: system-ui, sans-serif;
  padding: 2rem 1rem;
}

.app { max-width: 760px; margin: 0 auto; }

/* Header */
.app-header { margin-bottom: 1.25rem; }
.app-header h1 { font-size: 1.5rem; font-weight: 500; margin-bottom: 0.75rem; }
.top-bar { display: flex; gap: 8px; }
.search {
  flex: 1; padding: 8px 12px; font-size: 14px;
  border-radius: 8px; border: 1px solid #333;
  background: #1e1e1e; color: #e0e0e0;
}
.search:focus { outline: none; border-color: #555; }

/* Buttons */
.btn {
  padding: 8px 14px; font-size: 13px; border-radius: 8px;
  border: 1px solid #444; background: #1e1e1e; color: #e0e0e0;
  cursor: pointer; white-space: nowrap;
}
.btn:hover { background: #2a2a2a; }
.btn-sm {
  padding: 5px 11px; font-size: 12px; border-radius: 7px;
  border: 1px solid #444; background: #1e1e1e; color: #e0e0e0; cursor: pointer;
}
.btn-sm:hover { background: #2a2a2a; }
.btn-sm.primary { background: #e0e0e0; color: #121212; border-color: #e0e0e0; }
.btn-sm.primary:hover { opacity: 0.88; }
.btn-sm.primary:disabled { opacity: 0.4; cursor: default; }
.btn-sm.danger { color: #e07070; border-color: #5a2a2a; }
.btn-sm.danger:hover { background: #2a1a1a; }

/* Category pills */
.cat-pills { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 0.75rem; }
.pill {
  font-size: 12px; padding: 4px 11px; border-radius: 999px;
  border: 1px solid #333; background: #1e1e1e; color: #888;
  cursor: pointer; transition: all 0.1s;
}
.pill:hover { color: #e0e0e0; border-color: #555; }
.pill.active { background: #e0e0e0; color: #121212; border-color: #e0e0e0; }

.stats { font-size: 12px; color: #555; margin-bottom: 0.75rem; }

/* Entry list */
.entries { display: flex; flex-direction: column; gap: 8px; }
.empty { font-size: 14px; color: #555; padding: 2rem 0; text-align: center; }

/* Entry card */
.entry-card {
  background: #1a1a1a; border: 1px solid #2a2a2a;
  border-radius: 10px; padding: 0.9rem 1.1rem; cursor: pointer;
  transition: border-color 0.1s;
}
.entry-card:hover { border-color: #3a3a3a; }
.entry-card.open { border-color: #4a4a4a; }

.entry-header {
  display: flex; align-items: flex-start;
  justify-content: space-between; gap: 12px;
}
.entry-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.entry-title { font-size: 14px; font-weight: 500; }
.oq-badge {
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  background: #3a2500; color: #f0a040; border: 1px solid #6a4000;
}
.entry-cat {
  font-size: 11px; padding: 2px 9px; border-radius: 999px;
  white-space: nowrap; font-weight: 500; flex-shrink: 0;
}
.entry-summary { font-size: 13px; color: #888; margin-top: 5px; line-height: 1.5; }

/* Entry body (expanded) */
.entry-body {
  margin-top: 12px; padding-top: 12px;
  border-top: 1px solid #2a2a2a;
  font-size: 13px; line-height: 1.7; color: #ccc;
}
.entry-body p { margin-bottom: 8px; }
.entry-body p:last-of-type { margin-bottom: 0; }
.linked-oqs { margin-top: 10px; }
.oq-label {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
  color: #c07020; margin-bottom: 5px;
}
.linked-oq {
  padding: 7px 10px; margin-bottom: 5px;
  background: #2a1800; border-radius: 7px;
  font-size: 12px; color: #f0a040;
}
.linked-oq:last-child { margin-bottom: 0; }
.entry-tags { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 10px; }
.tag {
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  background: #222; color: #777; border: 1px solid #333; cursor: pointer;
}
.tag:hover { color: #aaa; border-color: #555; }
.entry-actions { display: flex; gap: 8px; margin-top: 10px; }

/* Modal */
.modal-wrap {
  position: fixed; inset: 0; background: rgba(0,0,0,0.6);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 2rem 1rem; z-index: 10; overflow-y: auto;
}
.modal {
  background: #1a1a1a; border: 1px solid #333; border-radius: 12px;
  padding: 1.25rem; width: 100%; max-width: 520px;
}
.modal h3 { font-size: 15px; font-weight: 500; margin-bottom: 1rem; }
.modal label {
  font-size: 11px; color: #666; display: block;
  margin-top: 10px; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em;
}
.hint { text-transform: none; letter-spacing: 0; color: #444; }
.modal input, .modal select, .modal textarea {
  width: 100%; font-size: 13px; padding: 7px 10px;
  border-radius: 7px; border: 1px solid #333;
  background: #121212; color: #e0e0e0; font-family: inherit;
}
.modal input:focus, .modal select:focus, .modal textarea:focus {
  outline: none; border-color: #555;
}
.modal textarea { min-height: 110px; resize: vertical; }
.modal-actions { display: flex; gap: 8px; margin-top: 1rem; justify-content: flex-end; }
</style>
