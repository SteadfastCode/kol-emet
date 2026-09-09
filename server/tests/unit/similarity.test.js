/**
 * Unit tests for the trigram similarity helpers in src/lib/similarity.js.
 *
 * These are the first tests in the repo. They use Node's built-in runner
 * (node:test + node:assert/strict) so there is no new dependency to install.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { trigrams, similarity, findSimilar, normalizeTitle } from '../../src/lib/similarity.js';

describe('trigrams', () => {
  test('splits a string into its lowercased 3-character windows', () => {
    assert.deepEqual([...trigrams('gate')], ['gat', 'ate']);
    assert.deepEqual([...trigrams('GATE')], ['gat', 'ate']);
  });

  test('yields an empty set for strings shorter than three characters', () => {
    assert.equal(trigrams('').size, 0);
    assert.equal(trigrams('ab').size, 0);
  });
});

describe('similarity', () => {
  test('scores identical strings as 1', () => {
    assert.equal(similarity('Iron Gate', 'Iron Gate'), 1);
  });

  test('ignores case and surrounding whitespace', () => {
    assert.equal(similarity('Iron Gate', '  iron gate  '), 1);
  });

  test('scores an empty string against a non-empty one as 0', () => {
    assert.equal(similarity('', 'Iron Gate'), 0);
    assert.equal(similarity('Iron Gate', ''), 0);
  });

  test('scores wholly dissimilar strings as 0', () => {
    assert.equal(similarity('Iron Gate', 'zzzzzz'), 0);
  });

  test('scores near-duplicates between 0 and 1, above unrelated pairs', () => {
    const near = similarity('Iron Gate', 'The Iron Gate');
    assert.ok(near > 0 && near < 1, `expected a partial score, got ${near}`);
    assert.ok(near > similarity('Iron Gate', 'Silver Bridge'));
  });

  test('is symmetric', () => {
    assert.equal(similarity('Iron Gate', 'Iron Gates'), similarity('Iron Gates', 'Iron Gate'));
  });

  test('treats two sub-trigram strings as identical, since both sets are empty', () => {
    // Documents current behaviour: anything shorter than a trigram has no
    // windows to compare, so the function reports a vacuous match rather than 0.
    assert.equal(similarity('ab', 'xy'), 1);
    assert.equal(similarity('', ''), 1);
  });
});

describe('normalizeTitle', () => {
  test('collapses "The Iron Gate" and "iron gate" to one key', () => {
    assert.equal(normalizeTitle('The Iron Gate'), normalizeTitle('iron gate'));
    assert.equal(normalizeTitle('The Iron Gate'), 'iron gate');
  });

  test('strips punctuation and collapses repeated whitespace', () => {
    assert.equal(normalizeTitle('Gate,  of   Iron!'), 'gate of iron');
    assert.equal(normalizeTitle('An Engine'), 'engine');
  });

  test('only drops a leading article when no whitespace precedes it', () => {
    // Documents a known quirk rather than the intent: the article is stripped
    // before whitespace is collapsed, so a leading space defeats it and
    // '  The Iron Gate' does not share a key with 'The Iron Gate'. Worth
    // fixing separately -- this is the dedup key for generated draft titles.
    assert.equal(normalizeTitle('  The Iron Gate  '), 'the iron gate');
    assert.notEqual(normalizeTitle('  The Iron Gate  '), normalizeTitle('The Iron Gate'));
  });

  test('keeps articles that are only a prefix of a longer word', () => {
    assert.equal(normalizeTitle('Theodore'), 'theodore');
  });

  test('returns an empty string for null, undefined and empty input', () => {
    assert.equal(normalizeTitle(null), '');
    assert.equal(normalizeTitle(undefined), '');
    assert.equal(normalizeTitle('   '), '');
  });
});

describe('findSimilar', () => {
  const existing = [
    { name: 'Iron Gate' },
    { name: 'Iron Gates' },
    { name: 'Silver Bridge' },
  ];

  test('drops the exact match, case-insensitively', () => {
    const matches = findSimilar('iron gate', existing);
    assert.ok(!matches.includes('Iron Gate'), `exact match leaked through: ${matches.join(', ')}`);
    assert.deepEqual(matches, ['Iron Gates']);
  });

  test('returns near-duplicates ordered by descending score', () => {
    const matches = findSimilar('Iron Gatez', [
      { name: 'Silver Bridge' },
      { name: 'Iron Gates' },
      { name: 'Iron Gate' },
    ]);
    // 'Iron Gate' outscores 'Iron Gates' here (0.875 vs 0.778), and neither
    // follows the input order, so this pins the sort rather than the input.
    assert.deepEqual(matches, ['Iron Gate', 'Iron Gates']);
  });

  test('excludes candidates below the threshold', () => {
    // 'Silver Bridge' is dropped as an exact match and the two gates score too
    // low against it, so nothing is left.
    assert.deepEqual(findSimilar('Silver Bridge', existing), []);
    assert.deepEqual(findSimilar('Iron Gate', existing, 0.99), []);
  });

  test('returns an empty array when there is nothing to compare against', () => {
    assert.deepEqual(findSimilar('Iron Gate', []), []);
  });
});
