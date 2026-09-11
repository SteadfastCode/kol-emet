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
 * Entity types seed the EntityType registry (Phase 6 step 1), but the Entity
 * model still validates `category` against the hardcoded enum, so a template's
 * types must be exactly that enum for now. Once step 2 drops it, a second
 * template (software architecture: Service, Data Store, API, Team, External
 * Dependency) becomes possible. Until then, shipping a non-worldbuilding
 * template would mean handing users categories that do not fit their domain,
 * so only the worldbuilding one is real.
 */

import { CATEGORIES } from './categories.js';

export const DEFAULT_TEMPLATE = 'worldbuilding';

// The client's pill colours for today's six categories (CAT_COLORS in
// client/src/config/categories.js), carried into the registry so existing
// data looks the same once the client reads its colours from there.
const WORLDBUILDING_COLORS = {
  'Characters':       { bg: '#B5D4F4', text: '#0C447C' },
  'Worlds':           { bg: '#9FE1CB', text: '#085041' },
  'Organizations':    { bg: '#F5C4B3', text: '#712B13' },
  'Lore & Mechanics': { bg: '#CECBF6', text: '#3C3489' },
  'Timeline':         { bg: '#FAC775', text: '#633806' },
  'Open Questions':   { bg: '#F4C4C4', text: '#7C0C0C' },
};

export const TEMPLATES = {
  worldbuilding: {
    name: 'Worldbuilding',
    description: 'Characters, worlds, organizations and the relationships between them.',

    // Derived from CATEGORIES rather than listed a second time, so the registry
    // and the Entity enum cannot disagree while the enum stands. No icons: the
    // client has none to carry over.
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
};

export function getTemplate(key) {
  return TEMPLATES[key] ?? TEMPLATES[DEFAULT_TEMPLATE];
}
