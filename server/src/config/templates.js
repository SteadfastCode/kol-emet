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

    // sourceCategory/targetCategory are hints for the picker, not constraints.
    relationshipTypes: [
      { name: 'Married to',  sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'Parent of',   sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'Sibling of',  sourceCategory: 'Characters',    targetCategory: 'Characters' },
      { name: 'Member of',   sourceCategory: 'Characters',    targetCategory: 'Organizations' },
      { name: 'Inhabits',    sourceCategory: 'Characters',    targetCategory: 'Worlds' },
      { name: 'Located in',  sourceCategory: 'Organizations', targetCategory: 'Worlds' },
      { name: 'Ally of',     sourceCategory: null,            targetCategory: null },
      { name: 'Enemy of',    sourceCategory: null,            targetCategory: null },
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
