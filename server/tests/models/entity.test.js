/**
 * Model-level tests against a real (in-memory) mongod.
 *
 * These cover the two schema guards the rest of the system trusts without
 * re-checking: an entity's `category` and its blocks' `type`. Routes, the MCP
 * tools and the generator all write entities, and only the schema enum stops a
 * typo'd category from creating a category the UI has no pill for.
 *
 * Workspace's AI budget default lives here too — it is the other value that is
 * only ever set implicitly, at document creation, and never asserted by any
 * caller.
 */

import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';

import * as db from '../helpers/db.js';
import Entity, { BLOCK_TYPES } from '../../src/models/Entity.js';
import { CATEGORIES } from '../../src/config/categories.js';

// Workspace reads AI_TRIAL_GRANT_MICROS once, when the schema is built at
// module load, so the environment has to be in place before the import — hence
// the dynamic import here rather than a static one at the top of the file. The
// value is deliberately not the production default, so a test that passed by
// coincidence would show up as a mismatch.
const TRIAL_GRANT_MICROS = 1_234_567;
process.env.AI_TRIAL_GRANT_MICROS = String(TRIAL_GRANT_MICROS);
const { default: Workspace } = await import('../../src/models/Workspace.js');

/** A valid entity, for tests that vary exactly one field away from valid. */
function validEntity(overrides = {}) {
  return {
    title: 'Iron Gate',
    category: 'Worlds',
    summary: 'The eastern terminus of the line.',
    ...overrides,
  };
}

before(async () => { await db.connect(); });
beforeEach(async () => { await db.clear(); });
after(async () => { await db.disconnect(); });

describe('Entity.category', () => {
  test('accepts every configured category', async () => {
    for (const category of CATEGORIES) {
      const entity = await Entity.create(validEntity({ category }));
      assert.equal(entity.category, category);
    }
  });

  test('rejects a category that is not in the configured list', async () => {
    await assert.rejects(
      Entity.create(validEntity({ category: 'Vehicles' })),
      (err) => {
        assert.ok(err instanceof mongoose.Error.ValidationError, `expected a ValidationError, got ${err.name}`);
        assert.ok(err.errors.category, 'the error should name the category path');
        return true;
      }
    );

    assert.equal(await Entity.countDocuments(), 0, 'a rejected entity must not be persisted');
  });
});

describe('Entity.blocks[].type', () => {
  test('accepts every declared block type', async () => {
    const blocks = BLOCK_TYPES.map((type, order) => ({ type, order, data: {} }));
    const entity = await Entity.create(validEntity({ blocks }));

    assert.deepEqual(entity.blocks.map((b) => b.type), BLOCK_TYPES);
  });

  test('rejects an unknown block type', async () => {
    const blocks = [
      { type: 'text', order: 0, data: { text: 'fine' } },
      { type: 'sidebar', order: 1, data: {} },
    ];

    await assert.rejects(
      Entity.create(validEntity({ blocks })),
      (err) => {
        assert.ok(err instanceof mongoose.Error.ValidationError, `expected a ValidationError, got ${err.name}`);
        assert.ok(err.errors['blocks.1.type'], `the error should name the offending block, got ${Object.keys(err.errors)}`);
        return true;
      }
    );

    assert.equal(await Entity.countDocuments(), 0, 'a rejected entity must not be persisted');
  });
});

describe('Workspace.aiBudget', () => {
  test('grants a new workspace AI_TRIAL_GRANT_MICROS, spent nothing, unlocked', async () => {
    const created = await Workspace.create({ name: 'Personal', ownerId: new mongoose.Types.ObjectId() });
    const stored = await Workspace.findById(created._id).lean();

    assert.equal(stored.aiBudget.grantedMicros, TRIAL_GRANT_MICROS);
    assert.equal(stored.aiBudget.spentMicros, 0);
    assert.equal(stored.aiBudget.generatingSince, null);
  });
});

describe('the in-memory harness', () => {
  // clear() drops collections, and a dropped collection loses its indexes.
  // Mongoose only builds them once per model, so without the resync in
  // helpers/db.js a later test of a unique constraint would run against a
  // collection that no longer has the index meant to enforce it.
  test('clear() leaves schema indexes in place', async () => {
    await Entity.create(validEntity());
    await db.clear();
    await Entity.create(validEntity());

    const names = (await Entity.collection.indexes()).map((i) => i.name);
    assert.ok(names.includes('workspaceId_1_title_1'), `expected the compound index, got ${names}`);
  });
});
