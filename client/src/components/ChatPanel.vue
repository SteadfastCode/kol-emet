<template>
  <Transition name="chat-slide">
    <div v-if="open" class="chat-panel">
      <!-- Header -->
      <div class="chat-header">
        <span class="chat-title">AI Chat</span>
        <div class="chat-header-controls">
          <select
            v-if="providers.length"
            v-model="selectedProvider"
            class="provider-select"
            :disabled="streaming"
            @change="onProviderChange"
          >
            <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <select
            v-if="currentModels.length"
            v-model="selectedModel"
            class="model-select"
            :disabled="streaming"
          >
            <option v-for="m in currentModels" :key="m" :value="m">{{ m }}</option>
          </select>
          <button class="icon-btn" title="New conversation" @click="clearHistory">↺</button>
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
            <div class="msg-content">{{ msg.content }}</div>
          </div>
        </template>

        <!-- Streaming message -->
        <div v-if="streaming" class="chat-msg assistant">
          <div class="msg-role">{{ selectedProviderName }}</div>
          <div class="msg-content">{{ streamBuffer }}<span class="cursor">▋</span></div>
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
          @click="send"
        >
          <span v-if="streaming">…</span>
          <span v-else>Send</span>
        </button>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { getProviders, streamChat } from '../api/chat.js';

defineProps({ open: Boolean });
defineEmits(['close']);

// ─── Provider / model state ───────────────────────────────────────────────────

const providers       = ref([]);
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
});

// ─── Chat state ───────────────────────────────────────────────────────────────

const messages    = ref([]);     // { id, role: 'user'|'assistant', content }
const inputText   = ref('');
const streaming   = ref(false);
const streamBuffer = ref('');
const error       = ref('');
const messagesEl  = ref(null);
let msgCounter    = 0;

function makeId() { return ++msgCounter; }

function clearHistory() {
  messages.value = [];
  error.value = '';
}

// Scroll to bottom when new content arrives
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
  // Ctrl+Enter or Cmd+Enter to send
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    send();
  }
}

async function send() {
  const text = inputText.value.trim();
  if (!text || streaming.value) return;

  error.value = '';
  inputText.value = '';

  messages.value.push({ id: makeId(), role: 'user', content: text });

  // Build the messages payload (role + content only)
  const payload = messages.value.map(m => ({ role: m.role, content: m.content }));

  streaming.value  = true;
  streamBuffer.value = '';

  try {
    const gen = streamChat({
      provider: selectedProvider.value,
      model:    selectedModel.value,
      messages: payload,
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
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    streaming.value   = false;
    streamBuffer.value = '';
  }
}
</script>

<style scoped>
.chat-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 380px;
  z-index: 500;
  display: flex;
  flex-direction: column;
  background: #0f0f0f;
  border-left: 1px solid #1e1e1e;
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.6);
}

/* ─── Header ─────────────────────────────────────────────────────────── */
.chat-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid #1e1e1e;
  background: #0a0a0a;
  gap: 10px;
}

.chat-title {
  font-size: 13px;
  font-weight: 600;
  color: #888;
  white-space: nowrap;
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

/* ─── Messages ───────────────────────────────────────────────────────── */
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

.chat-msg.user .msg-role { color: #4a6a8a; }
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

/* ─── Input ──────────────────────────────────────────────────────────── */
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
.chat-input:focus { outline: none; border-color: #444; }
.chat-input::placeholder { color: #3a3a3a; }
.chat-input:disabled { opacity: 0.5; }

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
.send-btn:disabled { opacity: 0.4; cursor: default; }

/* ─── Slide transition ───────────────────────────────────────────────── */
.chat-slide-enter-active,
.chat-slide-leave-active {
  transition: transform 0.25s ease, opacity 0.2s ease;
}
.chat-slide-enter-from,
.chat-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

/* ─── Mobile portrait: full-screen ──────────────────────────────────── */
@media (orientation: portrait) and (max-width: 768px) {
  .chat-panel {
    width: 100%;
    left: 0;
  }
}
</style>
