<template>
  <Transition name="chat-slide">
    <div v-if="open" class="chat-panel" :class="{ 'sidebar-open': sidebarOpen }">

      <!-- ── Conversation sidebar ─────────────────────────────────────── -->
      <div class="chat-sidebar">
        <div class="sidebar-header">
          <span class="sidebar-title">Conversations</span>
          <button class="icon-btn" title="New conversation" @click="newConversation">＋</button>
        </div>
        <div class="sidebar-list">
          <div
            v-for="conv in conversations"
            :key="conv._id"
            class="convo-item"
            :class="{ active: conv._id === activeConvId }"
            @click="selectConversation(conv)"
          >
            <div class="convo-body">
              <template v-if="editingConvId === conv._id">
                <input
                  ref="renameInput"
                  v-model="editingTitle"
                  class="convo-rename-input"
                  @keydown.enter.prevent="commitRename(conv._id)"
                  @keydown.escape.prevent="cancelRename"
                  @blur="commitRename(conv._id)"
                  @click.stop
                />
              </template>
              <template v-else>
                <div class="convo-title" @dblclick.stop="startRename(conv)">
                  {{ conv.title || 'New conversation' }}
                </div>
                <div class="convo-meta">{{ conv.provider }} · {{ conv.model }}</div>
              </template>
            </div>
            <button
              class="convo-delete"
              title="Delete"
              @click.stop="deleteConv(conv._id)"
            >✕</button>
          </div>
          <div v-if="conversations.length === 0" class="sidebar-empty">
            No conversations yet
          </div>
        </div>
      </div>

      <!-- ── Main chat ────────────────────────────────────────────────── -->
      <div class="chat-main">
        <!-- Header -->
        <div class="chat-header">
          <button
            class="icon-btn sidebar-toggle"
            :title="sidebarOpen ? 'Hide conversations' : 'Show conversations'"
            @click="sidebarOpen = !sidebarOpen"
          >☰</button>
          <span class="chat-title">AI Chat</span>
          <div class="chat-header-controls">
            <select
              v-if="providers.length"
              v-model="selectedProvider"
              class="provider-select"
              :disabled="streaming || !!activeConvId"
              @change="onProviderChange"
            >
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <select
              v-if="currentModels.length"
              v-model="selectedModel"
              class="model-select"
              :disabled="streaming || !!activeConvId"
            >
              <option v-for="m in currentModels" :key="m" :value="m">{{ m }}</option>
            </select>
            <button class="icon-btn" title="New conversation" @click="newConversation">↺</button>
            <button class="icon-btn" title="Close" @click="$emit('close')">✕</button>
          </div>
        </div>

        <!-- No providers configured -->
        <div v-if="!providers.length && !loadingProviders" class="chat-empty">
          No AI providers configured. Add API keys to the server .env file.
        </div>

        <!-- Messages -->
        <div v-else class="chat-messages" ref="messagesEl">
          <div v-if="messages.length === 0" class="chat-welcome">
            Ask me anything about the wiki. I can look up entities, check relationships, and make edits.
          </div>

          <template v-for="msg in messages" :key="msg.id">
            <div class="chat-msg" :class="msg.role">
              <div class="msg-role">{{ msg.role === 'user' ? 'You' : selectedProviderName }}</div>
              <div v-if="msg.role === 'assistant'" class="msg-content markdown" v-html="renderMarkdown(msg.content)" />
              <div v-else class="msg-content">{{ msg.content }}</div>
            </div>
          </template>

          <!-- Streaming message -->
          <div v-if="streaming" class="chat-msg assistant">
            <div class="msg-role">{{ selectedProviderName }}</div>
            <div class="msg-content markdown" v-html="renderMarkdown(streamBuffer)" />
            <span class="cursor">▋</span>
          </div>

          <!-- Error -->
          <div v-if="error" class="chat-error">{{ error }}</div>
        </div>

        <!-- Input -->
        <div v-if="providers.length" class="chat-input-area">
          <textarea
            v-model="inputText"
            class="chat-input"
            placeholder="Ask about the wiki…"
            rows="3"
            :disabled="streaming"
            @keydown="onKeydown"
          />
          <button
            class="send-btn"
            :disabled="streaming || !inputText.trim()"
            @click="sendMessage"
          >
            <span v-if="streaming">…</span>
            <span v-else>Send</span>
          </button>
        </div>
      </div>

    </div>
  </Transition>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { marked } from 'marked';
import { getProviders, streamChat } from '../api/chat.js';
import {
  listConversations,
  createConversation,
  getConversation,
  renameConversation,
  deleteConversation,
  generateTitle,
} from '../api/conversations.js';

marked.setOptions({ breaks: true, gfm: true });
function renderMarkdown(text) {
  return marked.parse(text || '');
}

defineProps({ open: Boolean });
defineEmits(['close']);

// ─── Provider / model state ───────────────────────────────────────────────────

const providers        = ref([]);
const loadingProviders = ref(false);
const selectedProvider = ref('');
const selectedModel    = ref('');

const currentProvider = computed(() =>
  providers.value.find(p => p.id === selectedProvider.value) ?? null
);
const currentModels = computed(() => currentProvider.value?.models ?? []);
const selectedProviderName = computed(() => currentProvider.value?.name ?? 'AI');

function onProviderChange() {
  selectedModel.value = currentProvider.value?.defaultModel ?? '';
}

onMounted(async () => {
  loadingProviders.value = true;
  try {
    providers.value = await getProviders();
    if (providers.value.length) {
      selectedProvider.value = providers.value[0].id;
      selectedModel.value    = providers.value[0].defaultModel;
    }
  } catch {
    // silently fail — empty providers list shown
  } finally {
    loadingProviders.value = false;
  }
  await loadConversations();
});

// ─── Sidebar / conversation state ────────────────────────────────────────────

const sidebarOpen   = ref(false);
const conversations = ref([]);
const activeConvId  = ref(null);
const editingConvId = ref(null);
const editingTitle  = ref('');
const renameInput   = ref(null);

async function loadConversations() {
  try {
    conversations.value = await listConversations();
  } catch {
    // silently fail
  }
}

async function selectConversation(conv) {
  if (activeConvId.value === conv._id) return;
  try {
    const full = await getConversation(conv._id);
    messages.value = full.messages.map(m => ({ ...m, id: makeId() }));
    activeConvId.value  = conv._id;
    // Restore provider/model from stored conversation
    const p = providers.value.find(p => p.id === full.provider);
    if (p) {
      selectedProvider.value = full.provider;
      selectedModel.value    = full.model;
    }
    // Trigger auto-title refresh in background
    if (full.autoTitle && full.messages.length >= 2) {
      refreshTitle(conv._id);
    }
  } catch (err) {
    error.value = err.message;
  }
}

async function refreshTitle(convId) {
  try {
    const { title } = await generateTitle(convId);
    const idx = conversations.value.findIndex(c => c._id === convId);
    if (idx !== -1) conversations.value[idx].title = title;
  } catch {
    // non-critical — silently ignore
  }
}

function startRename(conv) {
  editingConvId.value = conv._id;
  editingTitle.value  = conv.title || '';
  nextTick(() => renameInput.value?.focus());
}

function cancelRename() {
  editingConvId.value = null;
  editingTitle.value  = '';
}

async function commitRename(convId) {
  const title = editingTitle.value.trim();
  editingConvId.value = null;
  if (!title) return;
  try {
    await renameConversation(convId, title);
    const idx = conversations.value.findIndex(c => c._id === convId);
    if (idx !== -1) {
      conversations.value[idx].title     = title;
      conversations.value[idx].autoTitle = false;
    }
  } catch {
    // silently fail
  }
}

async function deleteConv(convId) {
  try {
    await deleteConversation(convId);
    conversations.value = conversations.value.filter(c => c._id !== convId);
    if (activeConvId.value === convId) {
      messages.value     = [];
      activeConvId.value = null;
    }
  } catch {
    // silently fail
  }
}

// ─── Chat state ───────────────────────────────────────────────────────────────

const messages     = ref([]);
const inputText    = ref('');
const streaming    = ref(false);
const streamBuffer = ref('');
const error        = ref('');
const messagesEl   = ref(null);
let msgCounter = 0;

function makeId() { return ++msgCounter; }

function newConversation() {
  messages.value     = [];
  activeConvId.value = null;
  error.value        = '';
}

watch(
  [() => messages.value.length, streamBuffer],
  async () => {
    await nextTick();
    if (messagesEl.value) {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
    }
  }
);

// ─── Send ─────────────────────────────────────────────────────────────────────

function onKeydown(e) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendMessage();
  }
}

async function sendMessage() {
  const text = inputText.value.trim();
  if (!text || streaming.value) return;

  error.value    = '';
  inputText.value = '';

  messages.value.push({ id: makeId(), role: 'user', content: text });

  // Build the messages payload (role + content only)
  const payload = messages.value.map(m => ({ role: m.role, content: m.content }));

  // Create a conversation document on first message
  let convId = activeConvId.value;
  if (!convId) {
    try {
      const conv = await createConversation({
        provider: selectedProvider.value,
        model:    selectedModel.value,
      });
      convId             = conv._id;
      activeConvId.value = convId;
      conversations.value.unshift(conv);
    } catch {
      // If creation fails, proceed without persistence
    }
  }

  streaming.value   = true;
  streamBuffer.value = '';

  try {
    const gen = streamChat({
      provider:        selectedProvider.value,
      model:           selectedModel.value,
      messages:        payload,
      conversationId:  convId,
    });

    for await (const event of gen) {
      if (event.type === 'delta') {
        streamBuffer.value += event.content;
      } else if (event.type === 'error') {
        error.value = event.message;
        break;
      } else if (event.type === 'done') {
        break;
      }
    }

    if (streamBuffer.value) {
      messages.value.push({ id: makeId(), role: 'assistant', content: streamBuffer.value });
      // Refresh auto-title after first exchange
      if (convId) refreshTitle(convId);
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    streaming.value    = false;
    streamBuffer.value = '';
  }
}
</script>

<style scoped>
/* ─── Panel shell ─────────────────────────────────────────────────── */
.chat-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 380px;
  z-index: 500;
  display: flex;
  flex-direction: row;
  background: #0f0f0f;
  border-left: 1px solid #1e1e1e;
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.6);
  transition: width 0.22s ease;
}
.chat-panel.sidebar-open { width: 560px; }

/* ─── Conversation sidebar ───────────────────────────────────────── */
.chat-sidebar {
  width: 0;
  overflow: hidden;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #080808;
  border-right: 1px solid #1a1a1a;
  transition: width 0.22s ease;
}
.sidebar-open .chat-sidebar { width: 180px; }

.sidebar-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 10px 8px;
  border-bottom: 1px solid #1a1a1a;
}

.sidebar-title {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #444;
  white-space: nowrap;
}

.sidebar-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sidebar-empty {
  font-size: 11px;
  color: #2a2a2a;
  text-align: center;
  padding: 16px 8px;
}

.convo-item {
  display: flex;
  align-items: flex-start;
  gap: 2px;
  padding: 6px 6px 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  min-width: 0;
}
.convo-item:hover { background: #111; }
.convo-item.active { background: #141a20; }

.convo-body { flex: 1; min-width: 0; }

.convo-title {
  font-size: 11px;
  color: #aaa;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
}
.convo-item.active .convo-title { color: #c8d8e8; }

.convo-meta {
  font-size: 9px;
  color: #333;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.convo-rename-input {
  width: 100%;
  background: #1a1a1a;
  border: 1px solid #2a2a2a;
  border-radius: 3px;
  color: #e0e0e0;
  font-size: 11px;
  font-family: inherit;
  padding: 2px 4px;
  box-sizing: border-box;
}
.convo-rename-input:focus { outline: none; border-color: #444; }

.convo-delete {
  background: none;
  border: none;
  color: #2a2a2a;
  cursor: pointer;
  font-size: 9px;
  padding: 1px 3px;
  flex-shrink: 0;
  border-radius: 3px;
  line-height: 1;
}
.convo-item:hover .convo-delete { color: #555; }
.convo-delete:hover { color: #e07070 !important; }

/* ─── Main chat ──────────────────────────────────────────────────── */
.chat-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* ─── Header ─────────────────────────────────────────────────────── */
.chat-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid #1e1e1e;
  background: #0a0a0a;
  gap: 8px;
}

.sidebar-toggle { color: #333; }
.sidebar-open .sidebar-toggle { color: #555; }

.chat-title {
  font-size: 13px;
  font-weight: 600;
  color: #888;
  white-space: nowrap;
  flex-shrink: 0;
}

.chat-header-controls {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex: 1;
  justify-content: flex-end;
}

.provider-select,
.model-select {
  background: #161616;
  border: 1px solid #2a2a2a;
  color: #aaa;
  font-size: 11px;
  padding: 3px 6px;
  border-radius: 5px;
  cursor: pointer;
  max-width: 110px;
}
.provider-select:disabled,
.model-select:disabled { opacity: 0.4; cursor: default; }
.provider-select:focus,
.model-select:focus { outline: none; border-color: #444; }

.icon-btn {
  background: none;
  border: none;
  color: #444;
  cursor: pointer;
  font-size: 13px;
  padding: 3px 5px;
  border-radius: 4px;
}
.icon-btn:hover { color: #ccc; background: #1a1a1a; }

/* ─── Messages ───────────────────────────────────────────────────── */
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
}

.chat-welcome {
  font-size: 12px;
  color: #3a3a3a;
  text-align: center;
  padding: 20px 10px;
  line-height: 1.6;
}

.chat-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #3a3a3a;
  text-align: center;
  padding: 24px;
  line-height: 1.6;
}

.chat-msg {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.msg-role {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #3a3a3a;
}
.chat-msg.user .msg-role      { color: #4a6a8a; }
.chat-msg.assistant .msg-role { color: #5a7a5a; }

.msg-content {
  font-size: 13px;
  color: #d4d4d4;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.chat-msg.user .msg-content {
  background: #131a22;
  border: 1px solid #1e2d3d;
  border-radius: 8px;
  padding: 8px 12px;
}

/* Markdown-rendered assistant messages */
.msg-content.markdown { white-space: normal; }
.msg-content.markdown :deep(p)                       { margin: 0 0 0.6em; }
.msg-content.markdown :deep(p:last-child)            { margin-bottom: 0; }
.msg-content.markdown :deep(h1),
.msg-content.markdown :deep(h2),
.msg-content.markdown :deep(h3),
.msg-content.markdown :deep(h4)                      { font-size: 13px; font-weight: 600; color: #e0e0e0; margin: 0.8em 0 0.3em; }
.msg-content.markdown :deep(h1:first-child),
.msg-content.markdown :deep(h2:first-child),
.msg-content.markdown :deep(h3:first-child)          { margin-top: 0; }
.msg-content.markdown :deep(ul),
.msg-content.markdown :deep(ol)                      { padding-left: 1.4em; margin: 0.4em 0; }
.msg-content.markdown :deep(li)                      { margin: 0.2em 0; }
.msg-content.markdown :deep(code)                    { font-family: 'Fira Code', 'Cascadia Code', monospace; font-size: 12px; background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 3px; padding: 0.1em 0.35em; color: #c8d3e0; }
.msg-content.markdown :deep(pre)                     { background: #141414; border: 1px solid #222; border-radius: 6px; padding: 10px 12px; overflow-x: auto; margin: 0.5em 0; }
.msg-content.markdown :deep(pre code)                { background: none; border: none; padding: 0; font-size: 12px; color: #c8d3e0; }
.msg-content.markdown :deep(blockquote)              { border-left: 3px solid #333; margin: 0.5em 0; padding: 2px 10px; color: #888; }
.msg-content.markdown :deep(strong)                  { color: #e8e8e8; }
.msg-content.markdown :deep(em)                      { color: #bbb; }
.msg-content.markdown :deep(a)                       { color: #7ab4f5; text-decoration: none; }
.msg-content.markdown :deep(a:hover)                 { text-decoration: underline; }
.msg-content.markdown :deep(hr)                      { border: none; border-top: 1px solid #222; margin: 0.6em 0; }

.cursor {
  display: inline-block;
  animation: blink 1s step-end infinite;
  color: #555;
}
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

.chat-error {
  font-size: 12px;
  color: #e07070;
  background: #2a1010;
  border: 1px solid #4a1a1a;
  border-radius: 6px;
  padding: 8px 12px;
}

/* ─── Input ──────────────────────────────────────────────────────── */
.chat-input-area {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px 14px;
  border-top: 1px solid #1e1e1e;
}

.chat-input {
  width: 100%;
  background: #161616;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
  color: #e0e0e0;
  font-family: inherit;
  font-size: 13px;
  padding: 8px 10px;
  resize: none;
  box-sizing: border-box;
  line-height: 1.5;
}
.chat-input:focus       { outline: none; border-color: #444; }
.chat-input::placeholder { color: #3a3a3a; }
.chat-input:disabled    { opacity: 0.5; }

.send-btn {
  align-self: flex-end;
  background: #1a2a3a;
  border: 1px solid #2a4a6a;
  color: #7ab4f5;
  font-size: 12px;
  font-family: inherit;
  padding: 5px 14px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}
.send-btn:hover:not(:disabled) { background: #223344; color: #aad4ff; }
.send-btn:disabled             { opacity: 0.4; cursor: default; }

/* ─── Slide transition ───────────────────────────────────────────── */
.chat-slide-enter-active,
.chat-slide-leave-active { transition: transform 0.25s ease, opacity 0.2s ease; }
.chat-slide-enter-from,
.chat-slide-leave-to     { transform: translateX(100%); opacity: 0; }

/* ─── Mobile portrait ────────────────────────────────────────────── */
@media (orientation: portrait) and (max-width: 768px) {
  .chat-panel            { width: 100% !important; left: 0; }
  .sidebar-open .chat-sidebar { width: 150px; }
}
</style>
