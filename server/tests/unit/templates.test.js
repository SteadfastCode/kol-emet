/**
 * Unit tests for the workspace templates in src/config/templates.js.
 *
 * A template is seeded at registration by lib/workspaceSeeder.js, which
 * swallows its errors so a seeding failure never costs a user their account.
 * That makes a broken template quiet: a relationship type whose category hint
 * names a type the template does not define is refused by the registry
 * (lib/entityTypeRegistry.js) on insert, seeding stops there, and the new
 * workspace is left with types but no vocabulary or starter content. So every
 * template is held here to the things its own seed will be checked against —
 * whichever template is added next included. The HTTP side, a real
 * registration per template, is in tests/http/entityTypes.test.js.
 *
 * The lookup is tested for the keys a request body can carry: `template` comes
 * straight from `POST /auth/register`, and a plain-object lookup would resolve
 * `'constructor'` to `Object` rather than falling back to the default.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEMPLATES,
  DEFAULT_TEMPLATE,
  getTemplate,
  hasTemplate,
  listTemplates,
} from '../../src/config/templates.js';
import { CATEGORIES } from '../../src/config/categories.js';

const lower = s => s.toLowerCase();

describe('listTemplates', () => {
  test('lists every template as { key, name, description }, the default first', () => {
    const listed = listTemplates();
    assert.deepEqual(listed.map(t => t.key), ['worldbuilding', 'software-architecture']);
    assert.equal(listed[0].key, DEFAULT_TEMPLATE);
    for (const t of listed) {
      assert.deepEqual(Object.keys(t).sort(), ['description', 'key', 'name'], `${t.key} lists only its key, name and description`);
      assert.equal(t.name, TEMPLATES[t.key].name);
      assert.ok(t.description.trim(), `${t.key} needs a description`);
    }
    assert.equal(listed[1].name, 'Software Architecture');
  });
});

describe('hasTemplate and getTemplate', () => {
  test('a listed key is a template and resolves to itself', () => {
    for (const { key } of listTemplates()) {
      assert.equal(hasTemplate(key), true, key);
      assert.equal(getTemplate(key), TEMPLATES[key], key);
    }
  });

  test('anything else is not a template, and resolves to the default', () => {
    const notTemplates = [
      'nope', '', 'Worldbuilding', 'software_architecture',
      'constructor', '__proto__', 'toString', 'hasOwnProperty',
      undefined, null, 42, {}, ['software-architecture'],
    ];
    for (const key of notTemplates) {
      assert.equal(hasTemplate(key), false, `${JSON.stringify(key)} is not a template`);
      assert.equal(getTemplate(key), TEMPLATES[DEFAULT_TEMPLATE], `${JSON.stringify(key)} falls back to the default`);
    }
  });
});

describe('every template is consistent with its own registry', () => {
  for (const [key, template] of Object.entries(TEMPLATES)) {
    describe(key, () => {
      const typeNames = template.entityTypes.map(t => t.name);

      test('entity types have unique names, contiguous orders and a colour pair', () => {
        assert.ok(typeNames.length, 'at least one type');
        assert.equal(new Set(typeNames.map(lower)).size, typeNames.length, 'names are unique case-insensitively, as the index requires');
        assert.deepEqual(template.entityTypes.map(t => t.order), typeNames.map((_, i) => i));
        for (const t of template.entityTypes) {
          assert.match(t.color?.bg ?? '', /^#[0-9A-F]{6}$/i, `"${t.name}" background`);
          assert.match(t.color?.text ?? '', /^#[0-9A-F]{6}$/i, `"${t.name}" text`);
        }
      });

      test('relationship types are scoped, unique within a scope, and hint only at its own types', () => {
        // Within a scope: the same word can be both a group label and a member
        // role (worldbuilding's "Home World" and "Home world").
        const scoped = template.relationshipTypes.map(t => `${t.scope}:${lower(t.name)}`);
        assert.equal(new Set(scoped).size, scoped.length, 'no duplicate vocabulary within a scope');
        for (const t of template.relationshipTypes) {
          assert.ok(['group', 'member'].includes(t.scope), `"${t.name}" has a scope`);
          for (const hint of [t.sourceCategory, t.targetCategory]) {
            assert.ok(hint === null || typeNames.includes(hint), `"${t.name}" hints at "${hint}", which ${key} does not define`);
          }
        }
      });

      test('starter content uses its own types and keys', () => {
        const keys = template.starterEntities.map(e => e.key);
        assert.equal(new Set(keys).size, keys.length, 'starter keys are unique');
        for (const e of template.starterEntities) {
          assert.ok(typeNames.includes(e.category), `starter "${e.title}" is a "${e.category}", which ${key} does not define`);
        }
        for (const m of template.starterRelationship?.members ?? []) {
          assert.ok(keys.includes(m.entityKey), `starter relationship member "${m.entityKey}" is not a starter entity`);
        }
        for (const k of template.starterOpenQuestion?.linkTo ?? []) {
          assert.ok(keys.includes(k), `starter open question links "${k}", which is not a starter entity`);
        }
      });
    });
  }
});

describe('the two shipped templates', () => {
  test('worldbuilding is still the six built-in categories', () => {
    assert.deepEqual(TEMPLATES.worldbuilding.entityTypes.map(t => t.name), CATEGORIES);
  });

  test('software architecture: its five types, four group labels each with a member-role pair, and a Depends-on starter', () => {
    const sa = TEMPLATES['software-architecture'];
    assert.deepEqual(sa.entityTypes.map(t => t.name), ['Service', 'Data Store', 'API', 'Team', 'External Dependency']);

    const inScope = scope => sa.relationshipTypes.filter(t => t.scope === scope).map(t => t.name);
    assert.deepEqual(inScope('group'), ['Depends on', 'Owned by', 'Calls', 'Exposes']);
    assert.deepEqual(inScope('member'), ['Dependent', 'Dependency', 'Owner', 'Owned', 'Caller', 'Callee', 'Provider', 'Endpoint']);

    const pair = t => `${t.color.bg}/${t.color.text}`.toUpperCase();
    const worldbuilding = new Set(TEMPLATES.worldbuilding.entityTypes.map(pair));
    assert.ok(sa.entityTypes.every(t => !worldbuilding.has(pair(t))), 'no worldbuilding colour pair is reused');

    assert.deepEqual(sa.starterEntities.map(e => e.category), ['Service', 'Data Store']);
    assert.equal(sa.starterRelationship.label, 'Depends on');
    assert.deepEqual(sa.starterRelationship.members.map(m => m.label), ['Dependent', 'Dependency']);
    assert.ok(sa.starterOpenQuestion.question.trim());
  });
});
