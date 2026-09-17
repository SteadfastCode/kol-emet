/**
 * Workspace templates — the bundle of starting content a new workspace is
 * seeded with, so a new user never lands on a blank wall.
 *
 * A template is a set of entity types and relationship types plus a few
 * illustrative starter entities and one relationship group linking them.
 * Starter content is deliberately small and obviously example-shaped: it
 * demonstrates blocks and the relationship graph, and is easy to delete once
 * the user has their own.
 *
 * Two ship: Worldbuilding (the default, and the six categories every workspace
 * had before the registry) and Software Architecture (Service, Data Store, API,
 * Team, External Dependency). The signup form lists them from the public
 * `GET /templates` (routes/templates.js), and registration seeds whichever
 * `req.body.template` names (routes/auth.js → lib/workspaceSeeder.js) — the
 * default when it names none, a 400 when it names one that isn't here.
 *
 * Entity types seed the EntityType registry, which is the only gate on
 * `Entity.category` since Phase 6 step 2 dropped the hardcoded enum — so a
 * template's types can be any names. They are checked on insert all the same:
 * a template's relationship-type category hints and starter entities must name
 * its own types, or seeding fails partway (tests/unit/templates.test.js holds
 * every template to that).
 *
 * Templates are code, not data: there is no admin UI, and changing one affects
 * only workspaces registered afterwards.
 */

import { CATEGORIES } from './categories.js';

export const DEFAULT_TEMPLATE = 'worldbuilding';

// The client's pill colours for the six categories, carried over from its old
// hardcoded CAT_COLORS so existing data looks the same now that the client
// reads its colours from the registry (client/src/composables/useEntityTypes.js).
const WORLDBUILDING_COLORS = {
  'Characters':       { bg: '#B5D4F4', text: '#0C447C' },
  'Worlds':           { bg: '#9FE1CB', text: '#085041' },
  'Organizations':    { bg: '#F5C4B3', text: '#712B13' },
  'Lore & Mechanics': { bg: '#CECBF6', text: '#3C3489' },
  'Timeline':         { bg: '#FAC775', text: '#633806' },
  'Open Questions':   { bg: '#F4C4C4', text: '#7C0C0C' },
};

// Software Architecture's types, in pill order. Five hues none of the six above
// use, at the same light-background/dark-text contrast (6.3–6.9:1).
const SOFTWARE_ARCHITECTURE_TYPES = [
  { name: 'Service',             color: { bg: '#C0DD97', text: '#27500A' } },
  { name: 'Data Store',          color: { bg: '#D3D1C7', text: '#444441' } },
  { name: 'API',                 color: { bg: '#F4C0D1', text: '#72243E' } },
  { name: 'Team',                color: { bg: '#F6E27A', text: '#5A4A00' } },
  { name: 'External Dependency', color: { bg: '#A6E1EE', text: '#0B4A58' } },
];

export const TEMPLATES = {
  worldbuilding: {
    name: 'Worldbuilding',
    description: 'Characters, worlds, organizations and the relationships between them.',

    // Derived from CATEGORIES rather than listed a second time, so the seed and
    // the names a pre-registry workspace falls back to cannot disagree. No
    // icons: the client has none to carry over.
    entityTypes: CATEGORIES.map((name, order) => ({
      name,
      order,
      icon: null,
      color: WORLDBUILDING_COLORS[name],
    })),

    // A relationship carries labels in TWO positions, and they are different
    // vocabularies:
    //
    //   scope:'group'  — the label on the group itself: "Marriage", "Home World",
    //                    "affiliation". Answers what KIND of relationship this is.
    //   scope:'member' — the label on one member within that group: "Wife", "Son",
    //                    "Planet", "Recruiter". Answers what that entity's PART in
    //                    it is.
    //
    // Both are needed. An earlier version of this list flattened them into one
    // set, which left the registry unable to offer the right terms in the right
    // place, and gave the generator no way to tell which position a term belongs in.
    //
    // Member roles are specific and gendered where the domain is, matching the
    // MCP tool descriptions ("brother"/"sister", not "sibling"). The ungendered
    // fallbacks — parent, child, sibling, spouse — are omitted on purpose:
    // offering them invites the model to reach for the vague option, which those
    // tool descriptions already work to prevent.
    //
    // Capitalisation follows the convention in real data: member roles display
    // as stored, group labels are uppercased by CSS.
    //
    // Today this list is consumed only by the generator, as vocabulary grounding.
    // The client types labels as free text and never calls /relationship-types.
    //
    // sourceCategory/targetCategory are hints for a future picker, not constraints.
    relationshipTypes: [
      // ── group labels: what kind of relationship this is ──────────────────
      { name: 'Marriage',     scope: 'group', sourceCategory: null, targetCategory: null },
      { name: 'Family',       scope: 'group', sourceCategory: null, targetCategory: null },
      { name: 'Siblings',     scope: 'group', sourceCategory: null, targetCategory: null },
      { name: 'Affiliation',  scope: 'group', sourceCategory: null, targetCategory: null },
      { name: 'Antagonism',   scope: 'group', sourceCategory: null, targetCategory: null },
      { name: 'Alliance',     scope: 'group', sourceCategory: null, targetCategory: null },
      { name: 'Home World',   scope: 'group', sourceCategory: null, targetCategory: null },
      { name: 'Headquarters', scope: 'group', sourceCategory: null, targetCategory: null },
      { name: 'Founders',     scope: 'group', sourceCategory: null, targetCategory: null },
      { name: 'Mentorship',   scope: 'group', sourceCategory: null, targetCategory: null },

      // ── member roles: this entity's part in the relationship ─────────────
      // Family
      { name: 'Father',       scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      { name: 'Mother',       scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      { name: 'Son',          scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      { name: 'Daughter',     scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      { name: 'Brother',      scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      { name: 'Sister',       scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      { name: 'Twin brother', scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      { name: 'Twin sister',  scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      { name: 'Husband',      scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      { name: 'Wife',         scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      { name: 'Grandfather',  scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      { name: 'Grandmother',  scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      { name: 'Uncle',        scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      { name: 'Aunt',         scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      { name: 'Cousin',       scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      { name: 'Nephew',       scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      { name: 'Niece',        scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      // Social
      { name: 'Ally',         scope: 'member', sourceCategory: null, targetCategory: null },
      { name: 'Enemy',        scope: 'member', sourceCategory: null, targetCategory: null },
      { name: 'Rival',        scope: 'member', sourceCategory: null, targetCategory: null },
      { name: 'Mentor',       scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      { name: 'Student',      scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      { name: 'Friend',       scope: 'member', sourceCategory: 'Characters', targetCategory: 'Characters' },
      // Organizational
      { name: 'Member',       scope: 'member', sourceCategory: 'Characters', targetCategory: 'Organizations' },
      { name: 'Leader',       scope: 'member', sourceCategory: 'Characters', targetCategory: 'Organizations' },
      { name: 'Founder',      scope: 'member', sourceCategory: 'Characters', targetCategory: 'Organizations' },
      { name: 'Agent',        scope: 'member', sourceCategory: 'Characters', targetCategory: 'Organizations' },
      { name: 'Recruiter',    scope: 'member', sourceCategory: 'Characters', targetCategory: 'Organizations' },
      // Place
      { name: 'Inhabitant',   scope: 'member', sourceCategory: 'Characters', targetCategory: 'Worlds' },
      { name: 'Home world',   scope: 'member', sourceCategory: 'Worlds', targetCategory: 'Characters' },
      { name: 'Planet',       scope: 'member', sourceCategory: 'Worlds', targetCategory: null },
      { name: 'Ruler',        scope: 'member', sourceCategory: 'Characters', targetCategory: 'Worlds' },
    ],

    // Keyed so the relationship group below can refer to them before they have ids.
    starterEntities: [
      {
        key: 'protagonist',
        title: 'Example Character',
        category: 'Characters',
        summary: 'A starter entity — edit or delete it once your own notes take over.',
        tags: ['example'],
        blocks: [
          {
            type: 'text',
            order: 0,
            data: {
              markdown:
                '## About\n\nThis is a **text block**. Entities are built from ordered blocks, ' +
                'so you can mix prose, attributes, quotes and timeline events in one page.\n\n' +
                'Delete this entity whenever you like — nothing depends on it.',
            },
          },
          { type: 'attribute', order: 1, data: { label: 'Status', value: 'Alive' } },
          { type: 'attribute', order: 2, data: { label: 'Species', value: 'Human' } },
        ],
      },
      {
        key: 'world',
        title: 'Example World',
        category: 'Worlds',
        summary: 'The place your example character lives. Also safe to delete.',
        tags: ['example'],
        blocks: [
          {
            type: 'text',
            order: 0,
            data: {
              markdown:
                '## Overview\n\nWorlds, organizations and characters are all *entities* — ' +
                'the difference is the category. What makes the wiki a graph is the ' +
                'relationships between them, shown in the sidebar and the graph view.',
            },
          },
        ],
      },
    ],

    // Members reference starterEntities by key.
    starterRelationship: {
      label: 'Example relationship',
      members: [
        { entityKey: 'protagonist', label: 'Inhabits' },
        { entityKey: 'world',       label: 'Home of' },
      ],
    },

    starterOpenQuestion: {
      question: 'What is the central conflict of your story? (An example open question — resolve or delete it.)',
      linkTo: ['protagonist'],
    },
  },

  'software-architecture': {
    name: 'Software Architecture',
    description: 'Services, data stores, APIs and teams, and what depends on, calls and owns what.',

    entityTypes: SOFTWARE_ARCHITECTURE_TYPES.map(({ name, color }, order) => ({
      name,
      order,
      icon: null,
      color,
    })),

    // Same two label positions as Worldbuilding's (see the comment there): a
    // group label says what kind of relationship it is, and each group comes
    // with the pair of member roles that says which side of it an entity is on.
    //
    // For a member role, sourceCategory is the type that usually plays the role
    // and targetCategory the type on the other side — Owner is a Team owning a
    // Service. Null where either side is commonly several types: a service
    // depends on data stores, APIs, other services and external dependencies
    // alike. Hints for a future picker, not constraints.
    relationshipTypes: [
      // ── group labels: what kind of relationship this is ──────────────────
      { name: 'Depends on', scope: 'group', sourceCategory: null, targetCategory: null },
      { name: 'Owned by',   scope: 'group', sourceCategory: null, targetCategory: null },
      { name: 'Calls',      scope: 'group', sourceCategory: null, targetCategory: null },
      { name: 'Exposes',    scope: 'group', sourceCategory: null, targetCategory: null },

      // ── member roles: this entity's part in the relationship ─────────────
      // Depends on
      { name: 'Dependent',  scope: 'member', sourceCategory: 'Service', targetCategory: null },
      { name: 'Dependency', scope: 'member', sourceCategory: null,      targetCategory: 'Service' },
      // Owned by
      { name: 'Owner',      scope: 'member', sourceCategory: 'Team',    targetCategory: 'Service' },
      { name: 'Owned',      scope: 'member', sourceCategory: 'Service', targetCategory: 'Team' },
      // Calls
      { name: 'Caller',     scope: 'member', sourceCategory: 'Service', targetCategory: null },
      { name: 'Callee',     scope: 'member', sourceCategory: null,      targetCategory: 'Service' },
      // Exposes
      { name: 'Provider',   scope: 'member', sourceCategory: 'Service', targetCategory: 'API' },
      { name: 'Endpoint',   scope: 'member', sourceCategory: 'API',     targetCategory: 'Service' },
    ],

    starterEntities: [
      {
        key: 'service',
        title: 'Example Service',
        category: 'Service',
        summary: 'A starter service — edit or delete it once your own architecture takes over.',
        tags: ['example'],
        blocks: [
          {
            type: 'text',
            order: 0,
            data: {
              markdown:
                '## About\n\nThis is a **text block**. Entities are built from ordered blocks, ' +
                'so you can mix prose, attributes, quotes and timeline events in one page.\n\n' +
                'Delete this entity whenever you like — nothing depends on it.',
            },
          },
          { type: 'attribute', order: 1, data: { label: 'Status', value: 'In production' } },
          { type: 'attribute', order: 2, data: { label: 'Runtime', value: 'Container' } },
        ],
      },
      {
        key: 'database',
        title: 'Example Database',
        category: 'Data Store',
        summary: 'The database your example service reads and writes. Also safe to delete.',
        tags: ['example'],
        blocks: [
          {
            type: 'text',
            order: 0,
            data: {
              markdown:
                '## Overview\n\nServices, data stores, APIs and teams are all *entities* — ' +
                'the difference is the type. What makes the wiki a graph is the ' +
                'relationships between them, shown in the sidebar and the graph view.',
            },
          },
        ],
      },
    ],

    starterRelationship: {
      label: 'Depends on',
      members: [
        { entityKey: 'service',  label: 'Dependent' },
        { entityKey: 'database', label: 'Dependency' },
      ],
    },

    starterOpenQuestion: {
      question: 'Which team owns this service, and who is paged when it fails? (An example open question — resolve or delete it.)',
      linkTo: ['service'],
    },
  },
};

/**
 * Whether `key` names a template. Own keys only, so a request body's
 * `template: 'constructor'` or `'__proto__'` is not mistaken for one.
 */
export function hasTemplate(key) {
  return typeof key === 'string' && Object.hasOwn(TEMPLATES, key);
}

/** `key`'s template, or the default one when `key` names none. */
export function getTemplate(key) {
  return TEMPLATES[hasTemplate(key) ? key : DEFAULT_TEMPLATE];
}

/**
 * Every template's key, name and description, in definition order (the
 * default first) — what a picker offers.
 *
 * @returns {{ key: string, name: string, description: string }[]}
 */
export function listTemplates() {
  return Object.entries(TEMPLATES).map(([key, { name, description }]) => ({ key, name, description }));
}
