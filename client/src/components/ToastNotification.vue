<template>
  <Teleport to="body">
    <div class="toast-stack">
      <TransitionGroup name="toast">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="toast"
          @click="dismiss(toast.id)"
        >
          <span class="actor" :class="{ ai: toast.actorType === 'mcp' }">{{ toast.actorLabel }}</span>
          {{ ' ' }}
          <span class="action">{{ toast.message }}</span>
          <template v-if="toast.entryTitle">
            {{ ' ' }}
            <a
              class="entry-link"
              href="#"
              @click.prevent.stop="openEntry(toast)"
            >{{ toast.entryTitle }}</a>
          </template>
          <button class="dismiss" @click.stop="dismiss(toast.id)" aria-label="Dismiss">×</button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup>
import { inject } from 'vue';
import { useToasts } from '../composables/useToasts.js';

const { toasts, dismissToast } = useToasts();

const openEntryFn    = inject('openEntry', null);
const openSnapshotFn = inject('openSnapshot', null);

function dismiss(id) {
  dismissToast(id);
}

function openEntry(toast) {
  if (toast.changeType === 'deleted' && toast.snapshot) {
    openSnapshotFn?.(toast.snapshot);
  } else if (toast.entryId) {
    openEntryFn?.(toast.entryId, toast.entryTitle);
  }
}
</script>

<style scoped>
.toast-stack {
  position: fixed;
  bottom: 1.5rem;
  right: 1.5rem;
  z-index: 9999;
  display: flex;
  flex-direction: column-reverse;
  gap: 0.5rem;
  max-width: 380px;
  pointer-events: none;
}

.toast {
  background: #1e1e1e;
  border: 1px solid #333;
  border-radius: 8px;
  padding: 0.65rem 2.25rem 0.65rem 0.9rem;
  font-size: 0.85rem;
  color: #d4d4d4;
  line-height: 1.5;
  position: relative;
  pointer-events: all;
  cursor: pointer;
  word-break: break-word;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
}

.toast:hover {
  border-color: #555;
}

.actor {
  font-weight: 600;
  color: #e0e0e0;
}

.actor.ai {
  color: #818cf8;
}

.action {
  color: #aaa;
}

.entry-link {
  color: #60a5fa;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.entry-link:hover {
  color: #93c5fd;
}

.dismiss {
  position: absolute;
  top: 0.4rem;
  right: 0.5rem;
  background: none;
  border: none;
  color: #666;
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
  padding: 0.1rem 0.2rem;
}

.dismiss:hover {
  color: #aaa;
}

/* Transition */
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(1rem);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(1rem);
}
</style>
