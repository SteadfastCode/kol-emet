/**
 * How an inline editor finds out whether the write it asked for happened
 * (KOL-156).
 *
 * The inline editors — a block's pencil, the entity header's — own their own
 * open/closed state, and each one used to close itself like this:
 *
 *     await emit('save', data);
 *     isEditing.value = false;
 *
 * `emit` returns no handler result: Vue's `emit` returns `undefined`, so that
 * `await` awaited nothing and the editor closed in the same tick the request
 * was sent. A refused write — `403 NOT_WORKSPACE_EDITOR` when the role
 * answered `viewer` after the first paint, a 400 from the block validator, a
 * 409 — raised the toast WikiLayout raises for it, by which time the markdown,
 * the title or the summary the user had typed was gone and the block had
 * reverted to the stored content. The claim the toast makes ("there is nothing
 * to retype") held only for the new-entity panel, whose open/closed state
 * belongs to WikiLayout and is therefore set after the await.
 *
 * So the save travels **down as a function prop and back as a result**. The
 * page hands each editor its save as `onSave` (which `@save="…"` on the
 * component still fills in — nothing changes in the parent templates), and the
 * chain
 *
 *     block editor → BlockList → EntityDetail → WikiLayout.onEntityUpdated
 *
 * returns a promise for `true` when the entity was actually written. The header
 * is the same chain without BlockList.
 *
 * **Only `true` closes an editor.** A refusal, a handler that reports nothing,
 * and no handler at all are all "the write did not land", and all leave the
 * editor open holding what was typed. That is the safe direction to be wrong
 * in: an editor wrongly left open costs a click on Cancel, while one wrongly
 * closed costs everything typed into it.
 *
 * ─── Tiered debug logging ───────────────────────────────────────────────────
 * localStorage.INLINE_EDIT_LOG_LEVEL = off | light | normal | verbose
 * (default light). WikiLayout logs the refusal itself — status, code, the role
 * as this tab read it — on its own ENTITY_WRITE_LOG_LEVEL.
 *   light   — every inline save and how it ended: which editor, whether the
 *             write landed, and what that did to the editor and the typed
 *             text, naming what reported it. "The editor closed and the text
 *             is gone" is the whole bug this file exists for, and it leaves no
 *             other trace — the save looks successful from the inside
 *   normal  — light, plus the fields each save sends up
 *   verbose — normal, plus the payload as sent (block content and titles — a
 *             user's own text, so it is off at every lower tier)
 */

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

export function inlineEditLog(level, msg) {
  let configured = null;
  try { configured = localStorage.getItem('INLINE_EDIT_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((LEVELS[configured] ?? LEVELS.light) >= LEVELS[level]) console.log(`[inlineEdit:${level}] ${msg}`);
}

/**
 * Sends one inline editor's draft up to the page and reports whether the write
 * landed — `true` only then, so the caller closes itself only then.
 *
 * @param {Function|undefined} handler the page's save (`props.onSave`)
 * @param {object} payload what to save, in the shape that handler expects
 * @param {string} what names the editor, for the log
 * @returns {Promise<boolean>} true only if the entity was written
 */
export async function commitInlineEdit(handler, payload, what) {
  if (typeof handler !== 'function') {
    inlineEditLog('light', `${what}: nothing above is listening, so the write was never sent — editor left open, still holding what was typed (source: no save handler on this editor)`);
    return false;
  }

  inlineEditLog('normal', `${what}: sending ${Object.keys(payload ?? {}).join(', ') || '(no fields)'} up to the page to write (source: this editor's Save)`);
  inlineEditLog('verbose', `${what}: payload as sent ${JSON.stringify(payload ?? null)}`);

  let landed;
  try {
    landed = (await handler(payload)) === true;
  } catch (err) {
    // The page is meant to report a refusal rather than throw it — WikiLayout
    // catches, toasts and returns false — but a handler that throws has not
    // written anything either, and that must not close the editor.
    inlineEditLog('light', `${what}: not saved — the page's save handler threw "${err?.message ?? err}"; editor left open, still holding what was typed (source: the rejected promise from this editor's Save)`);
    return false;
  }

  inlineEditLog('light', landed
    ? `${what}: saved — editor closed (source: the page reported the write landed)`
    : `${what}: not saved — editor left open, still holding what was typed (source: the page reported the write did not land; see ENTITY_WRITE_LOG_LEVEL for which refusal it was)`);
  return landed;
}
