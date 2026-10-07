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
 *     browser and the OS.
 *
 * Handlers decide about `preventDefault` themselves: `/` has to swallow the
 * character it would otherwise type, Escape has nothing to swallow.
 *
 * @param {Record<string, (event: KeyboardEvent) => void>} bindings
 *   `event.key` → handler. Use named functions: the name is what the log lines
 *   below report, and what makes the shortcut set readable in one place.
 */
export function useKeyboardShortcuts(bindings) {
  function onKeydown(event) {
    shortcutLog('verbose', `keydown "${event.key}" from ${describeTarget(event.target)}`);

    const handler = Object.hasOwn(bindings, event.key) ? bindings[event.key] : null;
    if (typeof handler !== 'function') return;

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
