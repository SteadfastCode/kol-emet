import { onMounted, onUnmounted } from 'vue';

/**
 * The app's one global keydown listener.
 *
 * Exactly one listener may own a key. Two of them and a single press fires
 * both, which is how "Escape closes the topmost layer" becomes "Escape closes
 * two layers at once" — so this is the only `window.addEventListener('keydown',
 * …)` in the client, and a component that wants a key either scopes it to its
 * own subtree (`@keydown.esc` on its root, which only fires while focus is
 * inside it) or registers it here.
 *
 * Ownership is one rule in two halves:
 *   - A focused text field keeps every key except Escape. Every other key is a
 *     character it is entitled to; Escape is how you get back out of the field,
 *     so that one is always ours.
 *   - A key held with ctrl, meta or alt is never ours — those belong to the
 *     browser and the OS. Shift is deliberately not in that list: `?` *is*
 *     shift and another key on most layouts, so a press that arrives as
 *     `event.key === '?'` with `shiftKey` set is that shortcut, not a
 *     modifier combination someone else owns.
 *
 * Handlers decide about `preventDefault` themselves: `/` has to swallow the
 * character it would otherwise type, Escape has nothing to swallow.
 *
 * @param {Record<string, { handler: (event: KeyboardEvent) => void, label: string }>} bindings
 *   `event.key` → `{ handler, label }`. Use named functions for the handler:
 *   the name is what the log lines below report, and what makes the shortcut
 *   set readable in one place. The label is the sentence the `?` cheatsheet
 *   shows for the key.
 * @returns {{ shortcuts: Array<{ key: string, label: string }> }}
 *   The same set, in the order it was registered, for the cheatsheet to render.
 */
export function useKeyboardShortcuts(bindings) {
  // Before the listener: a malformed binding is a startup bug, not a key that
  // silently does nothing (see describeBindings).
  const shortcuts = describeBindings(bindings);

  function onKeydown(event) {
    shortcutLog('verbose', `keydown "${event.key}" from ${describeTarget(event.target)}`);

    if (!Object.hasOwn(bindings, event.key)) return;
    const { handler } = bindings[event.key];

    if (event.ctrlKey || event.metaKey || event.altKey) {
      shortcutLog('normal', `"${event.key}" declined: held with ctrl/meta/alt, so it is the browser's`);
      return;
    }

    if (event.key !== 'Escape' && isTextField(event.target)) {
      shortcutLog('normal', `"${event.key}" declined: ${describeTarget(event.target)} has focus and keeps its own characters`);
      return;
    }

    shortcutLog('light', `"${event.key}" from ${describeTarget(event.target)} → ${handler.name || 'anonymous'}()`);
    handler(event);
  }

  onMounted(() => window.addEventListener('keydown', onKeydown));
  onUnmounted(() => window.removeEventListener('keydown', onKeydown));

  return { shortcuts };
}

/**
 * The `?` cheatsheet is this list, which is why it is derived from the binding
 * map instead of written out beside it (KOL-072): a shortcut added to the map
 * reaches the sheet with it, and one added without a sentence to show for it
 * fails here — at registration, loudly — rather than shipping as a key nobody
 * can discover. Order is the map's order, so the sheet reads the way the
 * bindings are written.
 */
function describeBindings(bindings) {
  return Object.entries(bindings).map(([key, binding]) => {
    if (typeof binding?.handler !== 'function') {
      throw new TypeError(`Keyboard shortcut "${key}" needs a { handler } function.`);
    }
    if (typeof binding.label !== 'string' || !binding.label.trim()) {
      throw new TypeError(
        `Keyboard shortcut "${key}" needs a { label } — the sentence the ? cheatsheet shows for it.`,
      );
    }
    return { key, label: binding.label };
  });
}

// ─── Debug tiers ──────────────────────────────────────────────────────────────
// Which key reached which handler is invisible after the fact — the only trace
// a wrong answer leaves is a layer that closed, or did not. So:
// localStorage `KEYBOARD_SHORTCUT_LOG_LEVEL` ∈ off | light | normal | verbose
// (default light). light names the key, the element it came from and the
// handler it reached — the source of whatever changed, not just that something
// closed. normal adds the presses this declined and why. verbose adds every
// keydown seen, including the ones nothing is bound to.

const LOG_LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function shortcutLog(level, msg) {
  let setting = null;
  try { setting = localStorage.getItem('KEYBOARD_SHORTCUT_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((LOG_LEVELS[setting] ?? LOG_LEVELS.light) >= LOG_LEVELS[level]) {
    console.log(`[shortcuts:${level}] ${msg}`);
  }
}

/** Enough of an element to name where a press came from. */
function describeTarget(target) {
  const tag = target?.tagName?.toLowerCase();
  if (!tag) return 'unknown';
  const cls = target.classList?.[0];
  return cls ? `${tag}.${cls}` : tag;
}

// `[contenteditable="false"]` is explicitly not editable, so it is not a field.
const TEXT_FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function isTextField(target) {
  return typeof target?.matches === 'function' && target.matches(TEXT_FIELD);
}
