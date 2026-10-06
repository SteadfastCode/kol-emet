/**
 * Unit tests for src/lib/searchFilter.js — the caller-supplied search term.
 *
 * Three routes compile a caller's string into a regex and match it against
 * every entity in a workspace (`GET /entities`, the MCP `search_entities` tool,
 * and the chat assistant's copy of it). Two properties have to hold for every
 * one of them, and both are cheap to pin here rather than once per route:
 *
 *   Punctuation is data, not syntax. `C++ (v2)` has to find the entity whose
 *   title is `C++ (v2)` — before this lib it threw a SyntaxError, which the
 *   route answered as a 500 and the model read as a tool error — and `.` has to
 *   find a literal full stop rather than matching every document in the
 *   workspace.
 *
 *   A value that is not a string is not a filter. Express 4's extended query
 *   parser hands `?category[$ne]=Characters` to a route as an object and
 *   `?q=a&q=b` as an array, and Mongoose casts whatever it is handed; so
 *   `searchTerm` is where an operator object stops being a query the caller
 *   wrote. `tests/http/entitySearch.test.js` asserts the same thing over real
 *   HTTP, where the parser is the real one rather than a hand-built object.
 *
 * Falsification: drop the `escapeRegex` call in `keywordFilter` and the literal
 * matching group fails; drop the `typeof raw !== 'string'` guard and the typing
 * group fails; drop the `MAX_TERM_LENGTH` slice and the cap test fails.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { escapeRegex, searchTerm, keywordFilter, MAX_TERM_LENGTH } from '../../src/lib/searchFilter.js';

/** The title regex out of a filter, which is what the term compiled to. */
function titleRegex(term) {
  const re = keywordFilter(term).$or[0].title;
  assert.ok(re instanceof RegExp, 'the title clause should be a compiled regex');
  return re;
}

describe('escapeRegex', () => {
  test('escapes every character the regex engine reads as syntax', () => {
    // The class routes/bridge.js escapes with, one character per assertion so a
    // dropped member names itself.
    for (const char of ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']) {
      assert.equal(escapeRegex(char), `\\${char}`, `${char} should have been escaped`);
    }
  });

  test('leaves ordinary text alone', () => {
    assert.equal(escapeRegex('Iron Gate 7'), 'Iron Gate 7');
  });

  test('produces a pattern that matches the original string literally', () => {
    const raw = 'C++ (v2)';
    const re = new RegExp(escapeRegex(raw));
    assert.ok(re.test(raw), 'the escaped pattern should match the string it came from');
  });
});

describe('searchTerm', () => {
  test('returns a trimmed string', () => {
    assert.equal(searchTerm('  Iron Gate  '), 'Iron Gate');
  });

  test('returns null for anything that is not a non-empty string', () => {
    // `?category[$ne]=Characters` and `?q=a&q=b` as the query parser delivers
    // them, plus the rest of what a JSON tool call can carry.
    assert.equal(searchTerm({ $ne: 'Characters' }), null);
    assert.equal(searchTerm({ $regex: '.*' }), null);
    assert.equal(searchTerm(['a', 'b']), null);
    assert.equal(searchTerm(''), null);
    assert.equal(searchTerm('   '), null);
    assert.equal(searchTerm(undefined), null);
    assert.equal(searchTerm(null), null);
    assert.equal(searchTerm(7), null);
    assert.equal(searchTerm(true), null);
  });

  test('caps a long term at MAX_TERM_LENGTH', () => {
    const capped = searchTerm('a'.repeat(500));
    assert.equal(capped.length, MAX_TERM_LENGTH);
    assert.equal(MAX_TERM_LENGTH, 200);
  });

  test('a term is still trimmed after the cap', () => {
    const capped = searchTerm(`${'a'.repeat(MAX_TERM_LENGTH - 1)}   tail`);
    assert.equal(capped, 'a'.repeat(MAX_TERM_LENGTH - 1), 'no whitespace tail should survive the cut');
  });
});

describe('keywordFilter', () => {
  test('searches title, summary and block markdown with one case-insensitive regex', () => {
    const filter = keywordFilter('gate');

    assert.deepEqual(Object.keys(filter), ['$or']);
    assert.equal(filter.$or.length, 3);
    const [title, summary, blocks] = filter.$or;
    assert.ok(title.title instanceof RegExp);
    assert.ok(summary.summary instanceof RegExp);
    assert.deepEqual(Object.keys(blocks), ['blocks']);
    assert.ok(blocks.blocks.$elemMatch['data.markdown'] instanceof RegExp);
    for (const re of [title.title, summary.summary, blocks.blocks.$elemMatch['data.markdown']]) {
      assert.equal(re.flags, 'i', 'search is case-insensitive');
      assert.equal(re.source, title.title.source, 'all three clauses share one pattern');
    }
  });

  test('punctuation matches literally', () => {
    const re = titleRegex('C++ (v2)');

    assert.ok(re.test('C++ (v2)'), 'the entity that actually holds the term must match');
    assert.ok(re.test('the c++ (v2) runtime'), 'and it is still a case-insensitive substring search');
    assert.ok(!re.test('C (v2)'), 'the + must not be read as a quantifier');
  });

  test('a lone dot does not match everything', () => {
    const re = titleRegex('.');

    assert.ok(re.test('Act 1. The Gate'), 'a literal full stop matches');
    assert.ok(!re.test('Iron Gate'), 'a title with no full stop must not match');
  });

  test('a catastrophic pattern is a literal search, not a backtracking one', () => {
    // Unescaped, `(a+)+$` against a long non-matching string is the event loop
    // gone. Escaped, there are no quantifiers left to nest.
    const re = titleRegex('(a+)+$');

    assert.ok(re.test('matches (a+)+$ exactly'), 'the term can still be searched for literally');
    assert.ok(!re.test(`${'a'.repeat(40)}!`), 'and it matches nothing it does not literally occur in');
  });

  test('compiles rather than throwing for every shape of punctuation', () => {
    for (const term of ['(', '[', '\\', '*', '?', '+', '{2,}', 'a)b', '[z-a]']) {
      assert.doesNotThrow(() => keywordFilter(term), `keywordFilter(${JSON.stringify(term)}) threw`);
    }
  });
});
