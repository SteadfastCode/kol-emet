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
 * The second suite covers the other half of the matching, added with KOL-054:
 * whether a proposed RELATIONSHIP is one the workspace already holds. Before
 * it, every re-import of an unchanged source created a second group for every
 * edge it had found the first time, and each entity's Relationships section
 * showed the same link twice.
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

const MIRA = {
  _id: 'entity-mira',
  title: 'Mira',
  updatedAt: new Date('2026-01-02T03:04:05.000Z'),
};

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

describe('normalizeDraft — matching a proposed relationship against existing groups', () => {
  // The workspace as a re-import finds it: both entities, and the group the
  // last run created between them.
  const KEEPERS = {
    _id: 'group-keepers',
    label: 'Keepers',
    members: [
      { refId: MIRA._id, refModel: 'Entity', label: 'Keeper' },
      { refId: IRON_GATE._id, refModel: 'Entity', label: 'Kept' },
    ],
  };

  const reimport = (relationships, groups = [KEEPERS], entities = [MIRA, IRON_GATE]) =>
    normalizeDraft(
      // Both titles already exist, so both entity items are updates — which is
      // what makes their ids known before anything is applied.
      [{ title: 'Mira', category: 'Characters' }, { title: 'The Iron Gate', category: 'Worlds' }],
      relationships,
      { categories: CATEGORIES, sourceText: SOURCE, existingEntities: entities, existingGroups: groups },
    );

  const keepers = (members = [{ name: 'Mira', role: 'Keeper' }, { name: 'The Iron Gate', role: 'Kept' }]) =>
    ({ label: 'Keepers', members });

  test('a group the workspace already holds becomes an update carrying its id', () => {
    const { items } = reimport([keepers()]);

    const group = items.find(i => i.kind === 'relationship');
    assert.ok(group, 'the relationship was dropped');
    assert.equal(group.op, 'update');
    assert.equal(group.matchedBy, 'same-members-and-label');
    assert.equal(group.proposed.targetGroupId, 'group-keepers');
    // Resolved through the sibling entity items, which are themselves updates.
    assert.deepEqual(group.proposed.members.map(m => m.localKey), ['e1', 'e2']);
  });

  test('the same members in the other order are the same group', () => {
    const { items } = reimport([keepers([{ name: 'The Iron Gate', role: 'Kept' }, { name: 'Mira', role: 'Keeper' }])]);
    const group = items.find(i => i.kind === 'relationship');
    assert.equal(group.op, 'update');
    assert.equal(group.proposed.targetGroupId, 'group-keepers');
  });

  test('a role the source now spells differently still matches, and is what the apply will set', () => {
    const { items } = reimport([keepers([{ name: 'Mira', role: 'Warden' }, { name: 'The Iron Gate', role: 'Kept' }])]);
    const group = items.find(i => i.kind === 'relationship');
    assert.equal(group.op, 'update', 'roles are what a re-import is allowed to update');
    assert.equal(group.proposed.members[0].label, 'Warden');
  });

  test('a different label is a different link', () => {
    const { items } = reimport([{ ...keepers(), label: 'Guards' }]);
    const group = items.find(i => i.kind === 'relationship');
    assert.equal(group.op, 'create');
    assert.equal(group.matchedBy, 'none');
    assert.equal(group.proposed.targetGroupId, null);
  });

  test('a label differing only in case or padding is the same label', () => {
    const { items } = reimport([{ ...keepers(), label: '  keepers ' }]);
    assert.equal(items.find(i => i.kind === 'relationship').proposed.targetGroupId, 'group-keepers');
  });

  test('a group holding a member a person added is still recognised, and the extra member is not proposed', () => {
    const withThird = {
      ...KEEPERS,
      members: [...KEEPERS.members, { refId: 'entity-silas', refModel: 'Entity', label: 'Witness' }],
    };
    const group = reimport([keepers()], [withThird]).items.find(i => i.kind === 'relationship');
    assert.equal(group.op, 'update');
    assert.equal(group.proposed.targetGroupId, 'group-keepers');
    assert.equal(group.proposed.members.length, 2, 'the proposal says nothing about the third member');
  });

  test('an exact member set outranks a superset, so the 2-member edge is not swallowed', () => {
    const bigger = {
      _id: 'group-keepers-plus',
      label: 'Keepers',
      members: [...KEEPERS.members, { refId: 'entity-silas', refModel: 'Entity', label: 'Witness' }],
    };
    // Listed first, so a first-match rule would pick it.
    const group = reimport([keepers()], [bigger, KEEPERS]).items.find(i => i.kind === 'relationship');
    assert.equal(group.proposed.targetGroupId, 'group-keepers');
  });

  test('roles break a tie, so "Mira keeps the gate" does not match the group saying the gate keeps Mira', () => {
    const reversed = {
      _id: 'group-keepers-reversed',
      label: 'Keepers',
      members: [
        { refId: MIRA._id, refModel: 'Entity', label: 'Kept' },
        { refId: IRON_GATE._id, refModel: 'Entity', label: 'Keeper' },
      ],
    };
    const group = reimport([keepers()], [reversed, KEEPERS]).items.find(i => i.kind === 'relationship');
    assert.equal(group.proposed.targetGroupId, 'group-keepers');
  });

  test('one group is claimed by one proposal: a second copy in the same run is a create', () => {
    const groups = reimport([keepers(), keepers()]).items.filter(i => i.kind === 'relationship');
    assert.deepEqual(groups.map(g => g.op), ['update', 'create']);
    assert.deepEqual(groups.map(g => g.proposed.targetGroupId), ['group-keepers', null]);
  });

  test('a member that will only exist once the draft is applied leaves the proposal a create', () => {
    // Silas is new, so his id is unknown here; applyRelationship runs the same
    // check against the ids it resolves.
    const { items } = normalizeDraft(
      [{ title: 'Silas', category: 'Characters' }],
      [{ label: 'Keepers', members: [{ name: 'Silas', role: 'Keeper' }, { name: 'The Iron Gate', role: 'Kept' }] }],
      { categories: CATEGORIES, sourceText: SOURCE, existingEntities: [MIRA, IRON_GATE], existingGroups: [KEEPERS] },
    );
    const group = items.find(i => i.kind === 'relationship');
    assert.equal(group.op, 'create');
    assert.equal(group.proposed.targetGroupId, null);
  });

  test('a workspace with no groups at all proposes creates (positive control)', () => {
    const group = reimport([keepers()], []).items.find(i => i.kind === 'relationship');
    assert.equal(group.op, 'create');
    assert.equal(group.proposed.targetGroupId, null);
  });
});
