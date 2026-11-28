/**
 * The Relationship types group in Settings (KOL-159), over the real client API module. `fetch` is
 * stubbed rather than `api/relationshipTypes.js` mocked, so what is pinned here is the routes the
 * group calls — method, path and body — and what it does with their answers.
 *
 * Why this screen exists: `workspaceSeeder.js` says of the relationship types it puts in every new
 * workspace that "without them the relationship picker is empty and the core feature of the product
 * looks broken on first use". `/relationship-types` had all four verbs and **no client caller at
 * all** — no `client/src/api/relationshipTypes.js`, and the string `relationship-types` appeared
 * nowhere under `client/src` — so a template's vocabulary sat in the database where its owner could
 * neither read it nor add to it, while the generator read it to name every edge it proposed.
 *
 * Four properties, each of which was the hole:
 *
 *   **`scope` is a field on the screen.** The add form and the rename form both carry it, because
 *   the suggestion lists filter on it: a type in the wrong scope is a type offered in the wrong
 *   place. The server had to learn to read it first — `POST` and `PUT` destructured three fields
 *   and not this one — so a group label created from here is the write that was impossible.
 *
 *   **A failed load is not an empty vocabulary.** "This workspace has no relationship types" is a
 *   claim about the workspace, and must not be made about a request that failed; the error keeps a
 *   Retry, for a viewer as much as for an editor.
 *
 *   **Every refusal is shown beside the row it is about** (KOL-150's rule), in the server's own
 *   words, and the row goes on showing its stored name and scope — a screen showing the new name
 *   beside an error reads as a change that landed. The editor stays open with what was typed
 *   (KOL-156).
 *
 *   **The near-duplicate `warning` is a warning.** `POST` creates the type *and* says a similar
 *   name exists, which is the drift this screen exists to stop ("Owns" beside "owned by"), so
 *   rendering it as an error would claim the opposite of what happened.
 *
 * The server's own rules — the 400 on a bad scope with nothing written, the cross-scope 409, the
 * cross-tenant 404s — are in server/tests/http/relationshipTypes.test.js. Where the group sits in
 * Settings is in WikiLayout.test.js. The suggestion lists it feeds are in
 * RelationshipsSection.test.js.
 *
 * Falsification: drop `scope` from the add body and the group-label case fails; show a failed load
 * as an empty list and that case loses its Retry; close the editor on a refusal and the refused
 * rename loses its input; render the `warning` in `.rtype-error` and that case fails; drop the
 * `canWrite` gate and the viewer case fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

import RelationshipTypeSettings from './RelationshipTypeSettings.vue';

/** A seeded worldbuilding vocabulary: one group label, two member roles. */
const MARRIAGE = { _id: 'r1', name: 'Marriage', scope: 'group', sourceCategory: null, targetCategory: null };
const WIFE     = { _id: 'r2', name: 'Wife',     scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' };
/** No `scope` at all — the shape every pre-KOL-159 create left behind. */
const CREW     = { _id: 'r3', name: 'Crew of' };

/** `{ 'METHOD /path': (init) => [status, body] }`, answered by the stubbed fetch. */
let routes;
/** Every request made, as `{ key, body }` with key `'METHOD /path'`. */
let calls;

beforeEach(() => {
  localStorage.setItem('RELATIONSHIP_TYPE_LOG_LEVEL', 'off');
  calls = [];
  routes = { 'GET /relationship-types': () => [200, [MARRIAGE, WIFE, CREW]] };
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${new URL(url, 'http://localhost').pathname}`;
    calls.push({ key, body: init.body });
    if (!routes[key]) throw new Error(`unexpected request: ${key}`);
    const [status, body] = routes[key](init);
    return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body };
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Mounts and waits for the load the group makes on mount. */
const open = async (props = {}) => {
  const wrapper = mount(RelationshipTypeSettings, { props });
  await flushPromises();
  return wrapper;
};

const button = (wrapper, text, within = wrapper) => {
  const found = within.findAll('button').find((b) => b.text() === text);
  if (!found) throw new Error(`no "${text}" button`);
  return found;
};

/** The row whose stored name is `name`. */
const itemFor = (wrapper, name) => {
  const found = wrapper.findAll('.rtype-item')
    .find((li) => li.find('.rtype-name').exists() && li.get('.rtype-name').text() === name);
  if (found) return found;
  // Mid-rename the name is in the input, so fall back to the open editor's row.
  const editing = wrapper.findAll('.rtype-item').find((li) => li.find('.rtype-edit').exists());
  if (editing) return editing;
  throw new Error(`no row for relationship type "${name}"`);
};

const names = (wrapper) => wrapper.findAll('.rtype-item .rtype-name').map((n) => n.text());
const scopes = (wrapper) => wrapper.findAll('.rtype-item .rtype-scope').map((s) => s.text());

describe('RelationshipTypeSettings', () => {
  it('loads the vocabulary on mount and lists group labels before member roles', async () => {
    const wrapper = await open();

    expect(calls.map((c) => c.key)).toEqual(['GET /relationship-types']);
    expect(names(wrapper)).toEqual(['Marriage', 'Crew of', 'Wife']);
    // A row with no `scope` at all is a member role: that is the model's default, and
    // the vocabulary every pre-KOL-159 create landed in.
    expect(scopes(wrapper)).toEqual(['Group label', 'Member role', 'Member role']);
  });

  it('adds a GROUP-scoped type — the write no client could make — and appends the row', async () => {
    routes['POST /relationship-types'] = () => [201, { _id: 'r4', name: 'Depends on', scope: 'group' }];
    const wrapper = await open();

    await wrapper.get('.rtype-add input').setValue('  Depends on  ');
    await wrapper.get('.rtype-add select').setValue('group');
    await wrapper.get('.rtype-add').trigger('submit');
    await flushPromises();

    // `scope` goes on every create: the server defaults to 'member', so a group label
    // picked in this form would otherwise quietly become a member role.
    expect(calls.at(-1)).toEqual({
      key: 'POST /relationship-types',
      body: JSON.stringify({ name: 'Depends on', scope: 'group' }),
    });
    expect(names(wrapper)).toContain('Depends on');
    expect(itemFor(wrapper, 'Depends on').get('.rtype-scope').text()).toBe('Group label');
    expect(wrapper.get('.rtype-add input').element.value).toBe('');
    expect(wrapper.find('.rtype-error').exists()).toBe(false);
  });

  it('adds a member role when that is what the form says, with the name trimmed', async () => {
    routes['POST /relationship-types'] = () => [201, { _id: 'r5', name: 'Dependency', scope: 'member' }];
    const wrapper = await open();

    await wrapper.get('.rtype-add input').setValue(' Dependency ');
    await wrapper.get('.rtype-add').trigger('submit');
    await flushPromises();

    expect(JSON.parse(calls.at(-1).body)).toEqual({ name: 'Dependency', scope: 'member' });
    expect(itemFor(wrapper, 'Dependency').get('.rtype-scope').text()).toBe('Member role');
  });

  it('renders the near-duplicate warning as a warning beside the row that WAS created', async () => {
    routes['POST /relationship-types'] = () => [201, {
      _id: 'r6', name: 'Owns', scope: 'group', warning: 'Similar types exist: owned by',
    }];
    const wrapper = await open();

    await wrapper.get('.rtype-add input').setValue('Owns');
    await wrapper.get('.rtype-add').trigger('submit');
    await flushPromises();

    expect(names(wrapper)).toContain('Owns');
    expect(itemFor(wrapper, 'Owns').get('.rtype-warning').text()).toBe('Similar types exist: owned by');
    expect(wrapper.find('.rtype-error').exists()).toBe(false);
  });

  it('a name another scope already holds is 409 and says so without adding a row', async () => {
    routes['POST /relationship-types'] = () => [409, { error: 'Relationship type already exists', existing: WIFE }];
    const wrapper = await open();

    await wrapper.get('.rtype-add input').setValue('wife');
    await wrapper.get('.rtype-add select').setValue('group');
    await wrapper.get('.rtype-add').trigger('submit');
    await flushPromises();

    expect(wrapper.get('.rtype-error').text()).toBe('Relationship type already exists');
    expect(names(wrapper)).toEqual(['Marriage', 'Crew of', 'Wife']);
  });

  it('renames through PUT /relationship-types/:id with only the field that changed', async () => {
    routes['PUT /relationship-types/r2'] = () => [200, { ...WIFE, name: 'Spouse' }];
    const wrapper = await open();

    await button(wrapper, 'Rename', itemFor(wrapper, 'Wife')).trigger('click');
    await itemFor(wrapper, 'Wife').get('.rtype-edit input').setValue('Spouse');
    await itemFor(wrapper, 'Wife').get('.rtype-edit').trigger('submit');
    await flushPromises();

    expect(calls.at(-1)).toEqual({
      key: 'PUT /relationship-types/r2',
      body: JSON.stringify({ name: 'Spouse' }),
    });
    expect(names(wrapper)).toContain('Spouse');
    expect(names(wrapper)).not.toContain('Wife');
  });

  it('moves a type between scopes, which is what repairs a row created before the route read scope', async () => {
    routes['PUT /relationship-types/r3'] = (init) => [200, { ...CREW, ...JSON.parse(init.body) }];
    const wrapper = await open();

    // `Crew of` arrived with no scope, so it is listed as a member role; it is a group label.
    await button(wrapper, 'Rename', itemFor(wrapper, 'Crew of')).trigger('click');
    await itemFor(wrapper, 'Crew of').get('.rtype-edit select').setValue('group');
    await itemFor(wrapper, 'Crew of').get('.rtype-edit').trigger('submit');
    await flushPromises();

    expect(JSON.parse(calls.at(-1).body)).toEqual({ scope: 'group' });
    expect(itemFor(wrapper, 'Crew of').get('.rtype-scope').text()).toBe('Group label');
    // Group labels sort first, so the repaired row moved up.
    expect(names(wrapper)).toEqual(['Crew of', 'Marriage', 'Wife']);
  });

  it('a save with nothing changed asks for nothing', async () => {
    const wrapper = await open();
    const before = calls.length;

    await button(wrapper, 'Rename', itemFor(wrapper, 'Marriage')).trigger('click');
    await itemFor(wrapper, 'Marriage').get('.rtype-edit').trigger('submit');
    await flushPromises();

    expect(calls.length).toBe(before);
  });

  it('a refused rename leaves the stored name and scope on the row, with the server\'s sentence beside it', async () => {
    routes['PUT /relationship-types/r2'] = () => [409, { error: 'Relationship type already exists', existing: MARRIAGE }];
    const wrapper = await open();

    await button(wrapper, 'Rename', itemFor(wrapper, 'Wife')).trigger('click');
    await itemFor(wrapper, 'Wife').get('.rtype-edit input').setValue('Marriage');
    await itemFor(wrapper, 'Wife').get('.rtype-edit').trigger('submit');
    await flushPromises();

    const row = itemFor(wrapper, 'Wife');
    expect(row.get('.rtype-scope').text()).toBe('Member role');
    expect(row.get('.rtype-error').text()).toBe('Relationship type already exists');
    // The editor stays open with what was typed (KOL-156), and the list is untouched.
    expect(row.get('.rtype-edit input').element.value).toBe('Marriage');
    expect(names(wrapper)).not.toContain('Marriage: Wife');
    expect(wrapper.findAll('.rtype-item')).toHaveLength(3);
  });

  it('a refused write names the write gate when the role is the reason', async () => {
    routes['DELETE /relationship-types/r1'] = () => [403, { error: 'NOT_WORKSPACE_EDITOR' }];
    const wrapper = await open();

    await button(wrapper, 'Remove', itemFor(wrapper, 'Marriage')).trigger('click');
    await button(wrapper, 'Remove', itemFor(wrapper, 'Marriage')).trigger('click');
    await flushPromises();

    const row = itemFor(wrapper, 'Marriage');
    expect(row.get('.rtype-error').text())
      .toBe('You do not have permission to change this workspace\'s relationship types.');
    expect(names(wrapper)).toContain('Marriage');
  });

  it('removes through DELETE /relationship-types/:id, but only after the action is confirmed', async () => {
    routes['DELETE /relationship-types/r1'] = () => [204, null];
    const wrapper = await open();
    const before = calls.length;

    await button(wrapper, 'Remove', itemFor(wrapper, 'Marriage')).trigger('click');
    expect(calls.length).toBe(before);           // arming it is not the removal

    await button(wrapper, 'Remove', itemFor(wrapper, 'Marriage')).trigger('click');
    await flushPromises();

    expect(calls.at(-1).key).toBe('DELETE /relationship-types/r1');
    expect(names(wrapper)).toEqual(['Crew of', 'Wife']);
  });

  it('a failed load is an error with a Retry, not an empty vocabulary', async () => {
    routes['GET /relationship-types'] = () => [500, { error: 'nope' }];
    const wrapper = await open();

    expect(wrapper.get('.rtype-error').text()).toContain('Could not load the relationship types.');
    expect(wrapper.text()).not.toContain('No relationship types yet.');
    expect(wrapper.findAll('.rtype-item')).toHaveLength(0);

    routes['GET /relationship-types'] = () => [200, [MARRIAGE]];
    await button(wrapper, 'Retry').trigger('click');
    await flushPromises();

    expect(names(wrapper)).toEqual(['Marriage']);
    expect(wrapper.find('.rtype-error').exists()).toBe(false);
  });

  it('says a workspace has no vocabulary only when the load said so', async () => {
    routes['GET /relationship-types'] = () => [200, []];
    const wrapper = await open();

    expect(wrapper.text()).toContain('No relationship types yet.');
    expect(wrapper.find('.rtype-error').exists()).toBe(false);
  });

  it('gives a viewer the list and no write control at all', async () => {
    const wrapper = await open({ canWrite: false });

    expect(names(wrapper)).toEqual(['Marriage', 'Crew of', 'Wife']);
    expect(wrapper.find('.rtype-add').exists()).toBe(false);
    expect(wrapper.findAll('button')).toHaveLength(0);
    // Reading the vocabulary is not a write: the load still happened, and nothing else did.
    expect(calls.map((c) => c.key)).toEqual(['GET /relationship-types']);
  });
});
