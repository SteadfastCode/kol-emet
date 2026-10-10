<template>
  <!-- Click-outside is the backdrop's own click: the sheet is a child of it, so a press that
       lands on the sheet never reaches here. No document-level listener and no Escape handler
       of its own — the layout's binding map owns both keys (see useKeyboardShortcuts.js). -->
  <div class="sheet-backdrop" @click.self="$emit('close')">
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="shortcut-sheet-title">
      <div class="sheet-chrome">
        <span id="shortcut-sheet-title" class="sheet-title">Keyboard shortcuts</span>
        <button class="icon-btn sheet-close" type="button" title="Close" @click="$emit('close')">✕</button>
      </div>

      <ul class="sheet-list">
        <li v-for="shortcut in shortcuts" :key="shortcut.key" class="sheet-row">
          <kbd class="sheet-key">{{ shortcut.key }}</kbd>
          <span class="sheet-label">{{ shortcut.label }}</span>
        </li>
      </ul>

      <p class="sheet-note">
        These keys type their character while you are in a text field instead — Escape is the way
        back out of one.
      </p>
    </div>
  </div>
</template>

<script setup>
/**
 * The `?` cheatsheet (KOL-072). A shortcut nobody can discover is a shortcut nobody uses, and the
 * first visit — straight off a signup form — is when that matters most.
 *
 * The rows are the layout's binding map, handed down as `shortcuts`, never a list retyped here: a
 * key added to that map arrives on this sheet with it, and one added without a label fails at
 * registration rather than shipping undiscoverable.
 */
defineProps({
  // [{ key, label }], in registration order — what useKeyboardShortcuts derived from the bindings.
  shortcuts: { type: Array, required: true },
});

defineEmits(['close']);
</script>

<style scoped>
/* Above settings (600), the chat panel and the graph (500): this is the layer you open to find
   out how to get out of the others. Toasts (9999) stay over it — they are never in the way. */
.sheet-backdrop {
  position: fixed;
  inset: 0;
  z-index: 700;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12vh 16px 16px;
  background: rgba(0, 0, 0, 0.7);
}

.sheet {
  width: 100%;
  max-width: 420px;
  max-height: 76vh;
  overflow-y: auto;
  padding: 14px 18px 16px;
  background: #0a0a0a;
  border: 1px solid #1e1e1e;
  border-radius: 12px;
}

.sheet-chrome {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 10px;
  border-bottom: 1px solid #1e1e1e;
}
.sheet-title { font-size: 13px; font-weight: 600; color: #ccc; }

.sheet-list {
  margin: 0;
  padding: 10px 0 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sheet-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 6px 2px;
}

/* Fixed width so the sentences line up however long a key name is. */
.sheet-key {
  flex: 0 0 64px;
  text-align: center;
  padding: 3px 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: #d0d0d0;
  background: #161616;
  border: 1px solid #2a2a2a;
  border-bottom-width: 2px;
  border-radius: 5px;
}

.sheet-label { font-size: 13px; line-height: 1.5; color: #999; }

.sheet-note {
  margin: 12px 0 0;
  padding-top: 10px;
  border-top: 1px solid #1a1a1a;
  font-size: 11px;
  line-height: 1.5;
  color: #555;
}
</style>
