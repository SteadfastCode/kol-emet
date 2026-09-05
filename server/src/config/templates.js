/**
 * Workspace templates — the bundle of starting content a new workspace is
 * seeded with, so a new user never lands on a blank wall.
 *
 * A template is a set of relationship types plus a few illustrative starter
 * entities and one relationship group linking them. Starter content is
 * deliberately small and obviously example-shaped: it demonstrates blocks and
 * the relationship graph, and is easy to delete once the user has their own.
 *
 * Entity *categories* are not part of a template yet — they are still a
 * hardcoded enum on the Entity model. Once Phase 6 makes them user-defined,
 * each template gains an `entityTypes` array and a second template
 * (software architecture: Service, Data Store, API, Team, External
 * Dependency) becomes possible. Until then, shipping a non-worldbuilding
 * template would mean handing users categories that do not fit their domain,
 * so only the worldbuilding one is real.
 */

export const DEFAULT_TEMPLATE = 'worldbuilding';

export const TEMPLATES = {
  worldbuilding: {
    name: 'Worldbuilding',
    description: 'Characters, worlds, organizations and the relationships between them.',

    // These are per-MEMBER role labels, not relation kinds. The data model puts
    // a label on each member of a group, so within one family group Eldan is
    // "father" and Ethan is "son" — "Parent of" is not something any single
    // member would ever be labelled.
    //
    // Deliberately specific and gendered where the domain is, matching the MCP
    // tool descriptions ("brother"/"sister", not "sibling"). The ungendered
    // fallbacks — parent, child, sibling, spouse — are left out on purpose:
    // including them invites the model to reach for the vague option, which is
    // exactly what those tool descriptions already work to prevent.
    //
    // Today this list is consumed only by the generator, as vocabulary
    // grounding. The client types member labels as free text and never calls
    // /relationship-types.
    //
    // sourceCategory/targetCategory are hints for a future picker, not constraints.
    relationshipTypes: [
      // Family
      { name: 'father',       sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'mother',       sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'son',          sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'daughter',     sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'brother',      sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'sister',       sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'husband',      sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'wife',         sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'grandfather',  sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'grandmother',  sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'uncle',        sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'aunt',         sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'cousin',       sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'nephew',       sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'niece',        sourceCategory: 'Characters',    targetCategory: 'Characters' },
      // Social
      { name: 'ally',         sourceCategory: null,            targetCategory: null },
      { name: 'enemy',        sourceCategory: null,            targetCategory: null },
      { name: 'rival',        sourceCategory: null,            targetCategory: null },
      { name: 'mentor',       sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'student',      sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'friend',       sourceCategory: 'Characters',    targetCategory: 'Characters' },
      // Organizational
      { name: 'member',       sourceCategory: 'Characters',    targetCategory: 'Organizations' },
      { name: 'leader',       sourceCategory: 'Characters',    targetCategory: 'Organizations' },
      { name: 'founder',      sourceCategory: 'Characters',    targetCategory: 'Organizations' },
      { name: 'agent',        sourceCategory: 'Characters',    targetCategory: 'Organizations' },
      // Place
      { name: 'inhabitant',   sourceCategory: 'Characters',    targetCategory: 'Worlds' },
      { name: 'home of',      sourceCategory: 'Worlds',        targetCategory: 'Characters' },
      { name: 'ruler of',     sourceCategory: 'Characters',    targetCategory: 'Worlds' },
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
