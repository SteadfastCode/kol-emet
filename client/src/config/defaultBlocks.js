export const DEFAULT_BLOCKS = {
  Characters: [
    { type: 'attribute', order: 0, data: { label: 'Status', value: '' } },
    { type: 'attribute', order: 1, data: { label: 'Species', value: '' } },
  ],
  Timeline: [
    { type: 'timeline_event', order: 0, data: { date: '', sortKey: 0, era: '', description: '', linkedEntryId: null } },
  ],
};

export function getDefaultBlocks(category) {
  return (DEFAULT_BLOCKS[category] ?? []).map(b => ({ ...b, data: { ...b.data } }));
}
