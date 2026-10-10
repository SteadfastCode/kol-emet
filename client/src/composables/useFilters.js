import { computed, getCurrentScope, onScopeDispose, ref, watch } from 'vue';
import { useToasts } from './useToasts.js';

/**
 * What the sidebar shows: a searched set, narrowed by the category and tag
 * pills.
 *
 * The search box asks the server; the pills stay in the browser (KOL-068).
 *
 * This used to filter the already-loaded list over `title`, `summary` and
 * `tags`, which meant the one field a wiki keeps its content in — a text
 * block's markdown — was not searchable from the UI at all. `GET /entities?q=`
 * has always matched block markdown as well as title and summary
 * (`keywordFilter`, server/src/lib/searchFilter.js), so a word that appeared
 * only inside a block found nothing here while the API returned the entity.
 * KOL-061's list projection then made that permanent: before it, the browser at
 * least *had* the text it was failing to search.
 *
 * So the split is by what each side knows. The server knows block content, so
 * the keyword goes there. The browser already holds every listed row's category
 * and tags, so a pill needs no request — and a pill press during a search
 * narrows the result set rather than restarting it.
 *
 * Two consequences worth knowing:
 *
 *   A search result is not the loaded list. It can hold an entity the paged
 *   load has not reached yet, and it does not change when the list is
 *   refetched; clearing the box is what returns the sidebar to the loaded list.
 *
 *   `?q=` does not match tags (its `$or` is title, summary, block markdown),
 *   where the old in-browser filter did. Typing a tag's name in the box
 *   therefore no longer finds a row on the strength of that tag alone; the tag
 *   pills are the exact-match path, and `setTag` is unchanged.
 *
 * Tiered debug logging: set localStorage.SEARCH_LOG_LEVEL to
 * off | light | normal | verbose (default light). A search is debounced,
 * asynchronous and raced, and none of that is visible in the sidebar — a row
 * that should be there and is not looks the same whichever step dropped it.
 *   light   — every query, naming its source (a typed term, a cleared box, a
 *             pill change) and the rows it ended up showing; every stale
 *             response discarded; every failure
 *   normal  — light, plus each keystroke that restarted the debounce, which is
 *             how coalescing is checked
 *   verbose — normal, plus the titles returned, and which matched out of sight
 */

/**
 * How long the box waits after the last keystroke. Long enough that typing a
 * word is one request rather than one per letter, short enough that it still
 * feels like the list is answering the box.
 */
export const SEARCH_DEBOUNCE_MS = 250;

const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  let setting = null;
  try { setting = localStorage.getItem('SEARCH_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((LEVELS[setting] ?? LEVELS.light) >= LEVELS[level]) console.log(`[search:${level}] ${msg}`);
}

/**
 * Marks the rows whose only hit was somewhere the reader cannot see.
 *
 * The server's `$or` is title, summary, block markdown; the response carries no
 * blocks. So a returned row that does not hold the term in its title or its
 * summary matched inside a block, and that is a result with no visible reason
 * to be there — hence the `matchedInText` flag the sidebar renders a line from.
 *
 * Tags are deliberately not consulted: `?q=` does not match them, so a term
 * that happens to be one of a row's tags says nothing about why the row came
 * back. Checking tags here would suppress the line on exactly the rows that
 * need it.
 */
function markBlockOnlyMatches(rows, term) {
  const needle = term.toLowerCase();
  return rows.map((row) => {
    const visible = `${row.title ?? ''} ${row.summary ?? ''}`.toLowerCase();
    return visible.includes(needle) ? row : { ...row, matchedInText: true };
  });
}

/**
 * @param {import('vue').Ref<object[]>} entries the loaded entity list
 * @param {{ search?: (term: string) => Promise<object[]>, debounceMs?: number }} opts
 *   `search` is the keyword request — `searchEntities` from api/entities.js at
 *   the one call site (WikiLayout). Injected rather than imported so this
 *   composable still reaches nothing by itself, and so its own tests can hand
 *   it a request they control.
 */
export function useFilters(entries, { search = null, debounceMs = SEARCH_DEBOUNCE_MS } = {}) {
  const searchQuery = ref('');
  const activeCat = ref('All');
  const activeTag = ref(null);

  /**
   * The server's answer to the current term, or null when no search is in play
   * — null is what makes the loaded list the source again, which is why this is
   * not just an empty array.
   */
  const searchResults = ref(null);
  /** A query is in flight. The previous rows stay on screen while it is. */
  const searching = ref(false);

  const { addToast } = useToasts();

  // The debounce timer, and which query owns `searchResults`. A later query
  // always wins: an overtaken response must never replace a newer one, however
  // long the network took over it. Same guard as useEntityTypes.
  let timer = null;
  let latest = 0;

  /** The set the pills narrow: a search's rows, or everything loaded. */
  const searched = computed(() => searchResults.value ?? entries.value);

  const filtered = computed(() => searched.value.filter((e) => {
    if (activeCat.value !== 'All' && e.category !== activeCat.value) return false;
    if (activeTag.value && !(e.tags ?? []).map(t => t.toLowerCase()).includes(activeTag.value.toLowerCase())) return false;
    return true;
  }));

  /** Stops a debounce that has not fired yet. */
  function cancelPending() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  /**
   * Abandons whatever is in flight and puts the loaded list back in the
   * sidebar. `++latest` is what disowns an outstanding response: it arrives to
   * find itself stale and is dropped rather than repopulating a box the reader
   * has emptied.
   */
  function clearSearch(source) {
    cancelPending();
    latest += 1;
    searchResults.value = null;
    searching.value = false;
    log('light', `cleared the search (source: ${source}) → ${filtered.value.length} row(s) from the loaded list`);
  }

  async function runSearch(term, source) {
    if (!search) {
      log('light', `no search function was provided; "${term}" (source: ${source}) asked nothing and the loaded list stands`);
      return;
    }
    const seq = ++latest;
    searching.value = true;
    try {
      const rows = await search(term);
      if (seq !== latest) {
        log('light', `discarded a stale response for "${term}" (source: ${source}): a newer query started`);
        return;
      }
      const marked = markBlockOnlyMatches(Array.isArray(rows) ? rows : [], term);
      searchResults.value = marked;
      const hidden = marked.filter(r => r.matchedInText).length;
      log('light', `"${term}" (source: ${source}) → ${marked.length} row(s), ${hidden} matched only in block text, ${filtered.value.length} shown after the pills`);
      log('verbose', `titles: ${marked.map(r => `${r.title}${r.matchedInText ? ' (in text)' : ''}`).join(' | ')}`);
    } catch (err) {
      if (seq !== latest) {
        log('light', `discarded a stale failure for "${term}" (source: ${source}): ${err.message}`);
        return;
      }
      // Emptying the sidebar would read as "no matches" — an answer the server
      // never gave. The previous rows stay, and the toast is what says the
      // box is no longer describing them.
      log('light', `"${term}" (source: ${source}) failed: ${err.message}; keeping the ${filtered.value.length} row(s) already shown`);
      addToast({ message: `Search failed — showing the previous results. ${err.message}` });
    } finally {
      if (seq === latest) searching.value = false;
    }
  }

  // `flush: 'sync'`, so the box and the request are not a tick apart: the
  // debounce starts on the keystroke that caused it, and emptying the box
  // disowns the outstanding response there and then rather than after a render.
  watch(searchQuery, (raw) => {
    const term = (raw ?? '').trim();
    if (!term) {
      clearSearch('a cleared box');
      return;
    }
    // A keystroke restarts the wait rather than adding a request to it.
    const restarted = Boolean(timer);
    cancelPending();
    log('normal', `waiting ${debounceMs}ms before searching "${term}" (source: a typed term${restarted ? ', restarting the wait' : ''})`);
    timer = setTimeout(() => {
      timer = null;
      runSearch(term, 'a typed term');
    }, debounceMs);
  }, { flush: 'sync' });

  // The pills need no request; what is worth a line is that the row count
  // moved and a pill is why, so a count that looks wrong can be read back to
  // the thing that changed it.
  watch([activeCat, activeTag], ([cat, tag]) => {
    log('light', `pills → category ${cat}, tag ${tag ?? '(none)'} (source: a pill change) → ${filtered.value.length} of ${searched.value.length} row(s)`);
  });

  if (getCurrentScope()) onScopeDispose(cancelPending);

  function setCat(cat) { activeCat.value = cat; activeTag.value = null; }
  function setTag(tag) { activeTag.value = tag; activeCat.value = 'All'; }
  function clearTag() { activeTag.value = null; }

  function resetFilters() {
    // Emptying the box is what tears the request down — the watcher above runs
    // synchronously on this assignment, so no timer is left to fire into a
    // sidebar that has already been reset. An already-empty box has nothing in
    // flight to cancel, which is why there is no second path here.
    searchQuery.value = '';
    activeCat.value = 'All';
    activeTag.value = null;
  }

  return {
    searchQuery, activeCat, activeTag, filtered, searching,
    setCat, setTag, clearTag, resetFilters,
  };
}
