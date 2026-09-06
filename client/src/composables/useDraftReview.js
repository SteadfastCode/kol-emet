import { ref, computed } from 'vue';
import { getDraft, decideItem, retargetItem, acceptClean, applyDraft } from '../api/drafts.js';

/**
 * Review state for one draft.
 *
 * Decisions are sent immediately and optimistically: the card updates, and
 * reverts with an error if the server disagrees. Batching them until Apply
 * would mean losing every decision if the tab closed — and those decisions are
 * the training signal, so they are worth more than the writes they authorise.
 */
export function useDraftReview() {
  const draft   = ref(null);
  const loading = ref(false);
  const error   = ref('');
  const busyIds = ref(new Set());   // items with an in-flight decision

  const items = computed(() => draft.value?.items ?? []);

  async function load(draftId) {
    loading.value = true;
    error.value = '';
    try {
      draft.value = await getDraft(draftId);
    } catch (err) {
      error.value = err.message;
    } finally {
      loading.value = false;
    }
  }

  /** localKey -> item, for resolving what a relationship depends on. */
  const byLocalKey = computed(() => {
    const m = new Map();
    for (const it of items.value) m.set(it.localKey, it);
    return m;
  });

  /**
   * An item is unreachable when something it depends on was rejected — the
   * server would refuse it as 'blocked' at apply time, so saying so during
   * review is more honest than letting someone accept a change that cannot land.
   *
   * Returns a reason string, or null when the item is fine.
   */
  function blockedReason(item) {
    for (const key of item.dependsOn ?? []) {
      const dep = byLocalKey.value.get(key);
      if (!dep) continue;
      if (dep.decision === 'rejected') {
        return `Needs "${titleOf(dep)}", which you rejected`;
      }
      if (dep.decision === 'pending') {
        return `Waiting on "${titleOf(dep)}"`;
      }
    }
    return null;
  }

  function titleOf(item) {
    const p = item.accepted ?? item.proposed ?? {};
    return p.title ?? p.label ?? p.question ?? item.localKey;
  }

  /**
   * Ordering: anything needing a human decision comes first, because the
   * failure mode of a 30-item review is rubber-stamping — and the flagged
   * items are exactly the ones that must not be rubber-stamped.
   */
  const ordered = computed(() => {
    const rank = it => {
      if (it.applyState === 'applied') return 4;
      if (it.decision !== 'pending')   return 3;
      if (it.flags?.length)            return 0;   // needs attention
      if (blockedReason(it))           return 2;
      return 1;
    };
    return [...items.value].sort((a, b) => rank(a) - rank(b) || a.seq - b.seq);
  });

  const counts = computed(() => {
    const c = { total: items.value.length, pending: 0, accepted: 0, edited: 0, rejected: 0, flagged: 0, applied: 0 };
    for (const it of items.value) {
      if (it.applyState === 'applied') c.applied++;
      if (it.decision === 'pending') c.pending++;
      else if (it.decision === 'accepted') c.accepted++;
      else if (it.decision === 'edited') c.edited++;
      else if (it.decision === 'rejected') c.rejected++;
      if (it.decision === 'pending' && it.flags?.length) c.flagged++;
    }
    return c;
  });

  const readyToApply = computed(() =>
    items.value.some(it =>
      (it.decision === 'accepted' || it.decision === 'edited') && it.applyState === 'pending'
    )
  );

  function replaceItem(updated) {
    const i = draft.value.items.findIndex(it => it._id === updated._id);
    if (i !== -1) draft.value.items[i] = updated;
  }

  async function decide(item, decision, { payload, note } = {}) {
    const snapshot = { ...item };
    busyIds.value = new Set(busyIds.value).add(item._id);
    error.value = '';

    // Optimistic, so a 30-item review feels immediate rather than latency-bound.
    replaceItem({ ...item, decision, accepted: decision === 'rejected' ? null : (payload ?? item.proposed) });

    try {
      const res = await decideItem(draft.value._id, item._id, { decision, payload, note });
      replaceItem(res.item);
      if (res.counts) draft.value.counts = res.counts;
    } catch (err) {
      replaceItem(snapshot);   // the server is the authority; put it back
      error.value = err.message;
    } finally {
      const next = new Set(busyIds.value); next.delete(item._id); busyIds.value = next;
    }
  }

  async function retarget(item, targetEntityId) {
    error.value = '';
    try {
      const res = await retargetItem(draft.value._id, item._id, targetEntityId);
      replaceItem(res.item);
    } catch (err) {
      error.value = err.message;
    }
  }

  async function acceptAllClean() {
    error.value = '';
    try {
      const res = await acceptClean(draft.value._id);
      await load(draft.value._id);   // several items changed; refetch is simpler than patching each
      return res;
    } catch (err) {
      error.value = err.message;
      return null;
    }
  }

  async function apply() {
    error.value = '';
    try {
      const res = await applyDraft(draft.value._id);
      await load(draft.value._id);
      return res;
    } catch (err) {
      error.value = err.message;
      return null;
    }
  }

  return {
    draft, items, ordered, counts, loading, error, busyIds,
    readyToApply, blockedReason, titleOf,
    load, decide, retarget, acceptAllClean, apply,
  };
}
