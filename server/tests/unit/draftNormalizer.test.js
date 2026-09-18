/**
 * Unit tests for the title-matching half of `normalizeDraft`
 * (src/lib/draftNormalizer.js).
 *
 * The normalizer decides, per generated entity, whether the model described
 * something the workspace already has (`op: 'update'` against the live entity)
 * or something new (`op: 'create'`). It decides that on `normalizeTitle`'s key
 * alone, so any whitespace the model leaves on a title is a correctness bug,
 * not a cosmetic one: a missed match writes a second copy of an existing
 * entity, and nothing downstream reunites them. The fuzzy fallback does not
 * cover it either — '  The Iron Gate' against 'The Iron Gate' scored ~0.64,
 * below DUPLICATE_THRESHOLD (0.72), so the item was not even flagged for the
 * human as a duplicate candidate.
 *
 * These tests pin that padding-insensitive behaviour at the normalizer level
 * rather than only at `normalizeTitle`, because the matching happens in three
 * places that must agree: the `existingByKey` index built from live entities,
 * the per-run `seenKeys` dedup, and relationship-member resolution.
 *
 * Falsification check: this suite was run against the pre-fix normalizeTitle
 * (article stripped before whitespace was collapsed). The three padded
 * "The Iron Gate" cases fail there; the unpadded controls, and the padded
 * member whose name carries no article, still pass — so the suite fails for the
 * stated reason rather than by construction.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeDraft } from '../../src/lib/draftNormalizer.js';

const CATEGORIES = ['Characters', 'Worlds'];
const SOURCE = 'The Iron Gate stands at the edge of the world. Mira keeps it.';

const IRON_GATE = {
  _id: 'entity-iron-gate',
  title: 'The Iron Gate',
  updatedAt: new Date('2026-01-02T03:04:05.000Z'),
};

function run(rawEntities, rawRelationships = [], existingEntities = [IRON_GATE]) {
  return normalizeDraft(rawEntities, rawRelationships, {
    categories: CATEGORIES,
    sourceText: SOURCE,
    existingEntities,
  });
}

describe('normalizeDraft — matching a generated title against existing entities', () => {
  test('matches a padded title to the existing entity as an update', () => {
    const { items } = run([{ title: '  The Iron Gate', category: 'Worlds' }]);

    assert.equal(items.length, 1);
    assert.equal(items[0].op, 'update');
    assert.equal(items[0].matchedBy, 'exact-normalized-title');
    assert.equal(items[0].targetEntityId, IRON_GATE._id);
    assert.equal(items[0].baseUpdatedAt, IRON_GATE.updatedAt);
    // An update must not also be offered as a possible duplicate.
    assert.equal(items[0].duplicateOf, null);
    assert.ok(!items[0].flags.includes('duplicate_candidate'));
  });

  test('matches an unpadded title the same way (positive control)', () => {
    const { items } = run([{ title: 'The Iron Gate', category: 'Worlds' }]);

    assert.equal(items[0].op, 'update');
    assert.equal(items[0].matchedBy, 'exact-normalized-title');
    assert.equal(items[0].targetEntityId, IRON_GATE._id);
  });

  test('stores the proposed title trimmed but otherwise as the model wrote it', () => {
    const { items } = run([{ title: '  The Iron Gate', category: 'Worlds' }]);

    // The key is normalised; the payload the human reviews is not. The article
    // stays, because that is the title that would be written.
    assert.equal(items[0].proposed.title, 'The Iron Gate');
  });

  test('still creates an entity whose title matches nothing existing', () => {
    const { items } = run([{ title: '  Silver Bridge  ', category: 'Worlds' }]);

    assert.equal(items[0].op, 'create');
    assert.equal(items[0].matchedBy, 'none');
    assert.equal(items[0].targetEntityId, null);
  });

  test('treats a padded and an unpadded emission of one title as one item', () => {
    const { items, dropReasons } = run([
      { title: 'The Iron Gate', category: 'Worlds' },
      { title: '  The Iron Gate  ', category: 'Worlds' },
    ]);

    assert.equal(items.length, 1);
    assert.ok(
      dropReasons.some(d => d.includes('duplicate entity')),
      `expected a duplicate drop reason, got: ${dropReasons.join(' | ')}`,
    );
  });

  test('resolves a padded relationship member to the existing entity', () => {
    const { items } = run(
      [{ title: 'Mira', category: 'Characters' }],
      [{ label: 'Keepers', members: [{ name: 'Mira' }, { name: '  The Iron Gate' }] }],
    );

    const group = items.find(i => i.kind === 'relationship');
    assert.ok(group, 'relationship group was dropped');
    assert.ok(!group.flags.includes('member_dropped'));

    const gate = group.proposed.members.find(m => m.name === '  The Iron Gate');
    assert.equal(gate.refId, IRON_GATE._id);
    assert.equal(gate.localKey, null);
  });

  test('resolves a padded relationship member to a sibling item in the same run', () => {
    const { items } = run(
      [{ title: 'Mira', category: 'Characters' }],
      [{ label: 'Keepers', members: [{ name: '  Mira  ' }, { name: 'The Iron Gate' }] }],
      [IRON_GATE],
    );

    const entity = items.find(i => i.kind === 'entity');
    const group = items.find(i => i.kind === 'relationship');
    const mira = group.proposed.members.find(m => m.name === '  Mira  ');
    assert.equal(mira.localKey, entity.localKey);
    assert.equal(mira.refId, null);
    assert.deepEqual(group.dependsOn, [entity.localKey]);
  });
});
