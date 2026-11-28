/**
 * The label fields in the relationships section, and the vocabulary now behind them (KOL-159).
 * Over the real client API modules, with `fetch` stubbed, so what is pinned here is the route the
 * section reads the vocabulary from and the bodies its writes send.
 *
 * Why these lists exist: `server/src/lib/workspaceSeeder.js` says of the relationship types it puts
 * in every new workspace that "without them the relationship picker is empty and the core feature
 * of the product looks broken on first use". There was no picker. Every label on a group or one of
 * its members was typed free-hand into a field offering an example placeholder and nothing else, so
 * a graph accumulated `owns`, `Owns` and `owned by` as three unrelated labels while the vocabulary
 * that would have named them sat in the database — read by the generator to name its edges, and
 * offered to nobody.
 *
 * Four properties:
 *
 *   **`scope` decides which half a field offers.** A relationship carries labels in two places and
 *   they are different vocabularies — a GROUP is a "Marriage", a MEMBER of it is a "Wife" — so a
 *   group-label field is never offered a member role and vice versa. A row with no `scope` at all
 *   (every create before KOL-159 taught the route to read one) is a member role, which is the
 *   model's default.
 *
 *   **A typed label that matches nothing still saves verbatim.** The list is a suggestion, never a
 *   constraint: the vocabulary is the workspace's own, and a label it has no word for yet is how
 *   the next word gets in.
 *
 *   **Keyboard-navigable and dismissible**, the ARIA combobox pattern the tag field already uses
 *   (`EntityEditor.vue`): arrows move the active option, Enter takes it, Escape closes the list and
 *   an arrow reopens it.
 *
 *   **The fetch is best-effort.** A failed `GET /relationship-types` leaves fields with no list,
 *   and every one of them still saves what was typed — a vocabulary that cannot be loaded must not
 *   cost a user the label they are writing.
 *
 * What the section already did — the groups, the members, the drag-to-reorder, the sub-group
 * nesting and the `canEdit` gate — is not re-pinned here; `server/tests/http/` covers the nine
 * writes and KOL-150 covers the gate.
 *
 * Falsification: drop the `scope` filter and the first two cases offer each other's words; make the
 * field a select and the verbatim case fails; stop stopping Escape's propagation and the dismiss
 * case closes something else; let the failed fetch throw and the last case fails on mount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';

import RelationshipsSection from './RelationshipsSection.vue';

/**
 * Two group labels, two member roles, and a row with no scope at all — in the
 * order `GET /relationship-types` answers in, which is by name across both
 * scopes. The section offers each half in the order it arrives, so the lists
 * below are alphabetical because the route's are.
 */
const VOCABULARY = [
  { _id: 'r4', name: 'Husband',    scope: 'member' },
  { _id: 'r1', name: 'Marriage',   scope: 'group' },
  { _id: 'r2', name: 'Parentage',  scope: 'group' },
  // No `scope`: the shape every create left behind before the route read one.
  { _id: 'r5', name: 'Ward of' },
  { _id: 'r3', name: 'Wife',       scope: 'member' },
];

const BOB  = { _id: 'e2', title: 'Bob' };
const CARA = { _id: 'e3', title: 'Cara' };

/** Alice, married to Bob — one group, two entity members. */
const ENTITY = () => ({
  _id: 'e1',
  title: 'Alice',
  relationships: [{
    _id: 'g1',
    label: 'Marriage',
    members: [
      { refId: 'e1', refModel: 'Entity', label: 'Wife', resolvedLabel: 'Wife', ref: { _id: 'e1', title: 'Alice' } },
      { refId: 'e2', refModel: 'Entity', label: 'Husband', resolvedLabel: 'Husband', ref: BOB },
    ],
  }],
});

let routes;
let calls;

beforeEach(() => {
  localStorage.setItem('RELATIONSHIP_TYPE_LOG_LEVEL', 'off');
  calls = [];
  routes = { 'GET /relationship-types': () => [200, VOCABULARY] };
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

/** Mounts the section as `EntityDetail` does, and waits for the vocabulary load. */
const open = async (entity = ENTITY()) => {
  const wrapper = mount(RelationshipsSection, {
    props: { entity, canEdit: true },
    global: { provide: { entities: ref([BOB, CARA]), followLink: () => {} } },
  });
  await flushPromises();
  return wrapper;
};

const iconButton = (wrapper, title) => {
  const found = wrapper.findAll('button').find((b) => b.attributes('title') === title);
  if (!found) throw new Error(`no button titled "${title}"`);
  return found;
};

const button = (wrapper, text, within = wrapper) => {
  const found = within.findAll('button').find((b) => b.text() === text);
  if (!found) throw new Error(`no "${text}" button`);
  return found;
};

/** The words a field is offering right now, in the order it offers them. */
const offered = (wrapper, fieldClass) =>
  wrapper.findAll(`.${fieldClass} .label-suggest-option`).map((o) => o.text());

/** Focuses a field so its list can open, as a user clicking into it would. */
const focus = async (wrapper, fieldClass) => {
  const input = wrapper.get(`.${fieldClass} input`);
  await input.trigger('focus');
  return input;
};

describe('RelationshipsSection label suggestions', () => {
  it('reads the vocabulary once on mount', async () => {
    await open();
    expect(calls.map((c) => c.key)).toEqual(['GET /relationship-types']);
  });

  it('offers a group-label field only the GROUP-scoped names', async () => {
    const wrapper = await open();

    await iconButton(wrapper, 'Edit group label').trigger('click');
    await focus(wrapper, 'group-label-input');

    // The field holds "Marriage", which is the only name matching it and is not
    // offered back: a row that would set the field to what it already says.
    expect(offered(wrapper, 'group-label-input')).toEqual([]);

    await wrapper.get('.group-label-input input').setValue('');
    expect(offered(wrapper, 'group-label-input')).toEqual(['Marriage', 'Parentage']);
    // Never a member role — the two are different vocabularies.
    expect(offered(wrapper, 'group-label-input')).not.toContain('Wife');
    expect(offered(wrapper, 'group-label-input')).not.toContain('Ward of');
  });

  it('offers a member field only the MEMBER-scoped names, a row with no scope among them', async () => {
    const wrapper = await open();

    await iconButton(wrapper, 'Add member to group').trigger('click');
    await focus(wrapper, 'add-member-label-input');

    // The route sorts by name, and `member` is every row whose scope is not 'group' —
    // including `Ward of`, which has no scope at all.
    expect(offered(wrapper, 'add-member-label-input')).toEqual(['Husband', 'Ward of', 'Wife']);
    expect(offered(wrapper, 'add-member-label-input')).not.toContain('Marriage');
  });

  it('offers both ends of a new relationship member roles, and its group label group labels', async () => {
    const wrapper = await open();

    await button(wrapper, '+ Add').trigger('click');

    await focus(wrapper, 'new-my-label-input');
    expect(offered(wrapper, 'new-my-label-input')).toEqual(['Husband', 'Ward of', 'Wife']);

    await focus(wrapper, 'new-their-label-input');
    expect(offered(wrapper, 'new-their-label-input')).toEqual(['Husband', 'Ward of', 'Wife']);

    await focus(wrapper, 'new-group-label-input');
    expect(offered(wrapper, 'new-group-label-input')).toEqual(['Marriage', 'Parentage']);
  });

  it('filters as the field is typed, prefix matches first', async () => {
    const wrapper = await open();

    await iconButton(wrapper, 'Add member to group').trigger('click');
    const input = await focus(wrapper, 'add-member-label-input');
    await input.setValue('w');

    // 'Wife' and 'Ward of' start with it; 'Husband' does not match at all.
    expect(offered(wrapper, 'add-member-label-input')).toEqual(['Ward of', 'Wife']);
  });

  it('takes a suggestion by keyboard, and sends exactly that word', async () => {
    routes['POST /relationship-groups/g1/members'] = () => [200, {}];
    const wrapper = await open();

    await iconButton(wrapper, 'Add member to group').trigger('click');
    const form = wrapper.get('.rel-add-form');
    await form.get('input.input-sm').setValue('Cara');
    await form.get('.target-option').trigger('click');

    const input = await focus(wrapper, 'add-member-label-input');
    await input.setValue('w');
    await input.trigger('keydown', { key: 'ArrowDown' });   // Ward of
    await input.trigger('keydown', { key: 'ArrowDown' });   // Wife
    await input.trigger('keydown', { key: 'Enter' });

    expect(wrapper.get('.add-member-label-input input').element.value).toBe('Wife');

    await button(wrapper, 'Add').trigger('click');
    await flushPromises();

    expect(JSON.parse(calls.at(-1).body)).toEqual({
      members: [{ entityId: 'e3', label: 'Wife', notes: null }],
    });
  });

  it('Escape closes the list without closing anything else, and an arrow reopens it', async () => {
    const wrapper = await open();

    await iconButton(wrapper, 'Add member to group').trigger('click');
    const input = await focus(wrapper, 'add-member-label-input');
    expect(offered(wrapper, 'add-member-label-input').length).toBeGreaterThan(0);

    const escape = { key: 'Escape' };
    await input.trigger('keydown', escape);
    expect(offered(wrapper, 'add-member-label-input')).toEqual([]);
    // The form the field is in is still open: Escape closed the nearer of the two.
    expect(wrapper.find('.add-member-label-input').exists()).toBe(true);

    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(offered(wrapper, 'add-member-label-input').length).toBeGreaterThan(0);
  });

  it('saves a label the vocabulary has no word for, verbatim', async () => {
    routes['POST /relationship-groups/g1/members'] = () => [200, {}];
    const wrapper = await open();

    await iconButton(wrapper, 'Add member to group').trigger('click');
    const form = wrapper.get('.rel-add-form');
    await form.get('input.input-sm').setValue('Cara');
    await form.get('.target-option').trigger('click');

    const input = await focus(wrapper, 'add-member-label-input');
    await input.setValue('co-pilot of');
    // Nothing matches it, so there is no list to get in the way...
    expect(offered(wrapper, 'add-member-label-input')).toEqual([]);

    await button(wrapper, 'Add').trigger('click');
    await flushPromises();

    // ...and the word goes to the server exactly as it was typed. This is how the
    // next entry in the vocabulary gets written in the first place.
    expect(JSON.parse(calls.at(-1).body)).toEqual({
      members: [{ entityId: 'e3', label: 'co-pilot of', notes: null }],
    });
  });

  it('a new relationship sends the group label and both ends as typed', async () => {
    routes['POST /relationship-groups'] = () => [201, {}];
    const wrapper = await open();

    await button(wrapper, '+ Add').trigger('click');
    const form = wrapper.get('.rel-add-form');
    await form.get('input.input-sm').setValue('Cara');
    await form.get('.target-option').trigger('click');

    // One taken from the list, one typed: both reach the server the same way.
    const mine = await focus(wrapper, 'new-my-label-input');
    await mine.setValue('Wif');
    await wrapper.get('.new-my-label-input .label-suggest-option').trigger('mousedown');
    await wrapper.get('.new-their-label-input input').setValue('bondsman');
    await wrapper.get('.new-group-label-input input').setValue('Marriage');

    await button(wrapper, 'Add').trigger('click');
    await flushPromises();

    expect(JSON.parse(calls.at(-1).body)).toEqual({
      label: 'Marriage',
      members: [
        { entityId: 'e1', label: 'Wife', notes: null },
        { entityId: 'e3', label: 'bondsman' },
      ],
    });
  });

  it('a failed vocabulary load leaves every field working, with no list', async () => {
    routes['GET /relationship-types'] = () => [500, { error: 'nope' }];
    routes['PATCH /relationship-groups/g1'] = () => [200, {}];
    const wrapper = await open();

    await iconButton(wrapper, 'Edit group label').trigger('click');
    const input = await focus(wrapper, 'group-label-input');
    expect(offered(wrapper, 'group-label-input')).toEqual([]);

    await input.setValue('Betrothal');
    await button(wrapper, 'Save').trigger('click');
    await flushPromises();

    expect(calls.at(-1)).toEqual({
      key: 'PATCH /relationship-groups/g1',
      body: JSON.stringify({ label: 'Betrothal' }),
    });
  });
});
