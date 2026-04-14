import ChangeLog from '../models/ChangeLog.js';
import { broadcast } from './broadcaster.js';

// Compute which fields and blocks changed between two entry states
export function computeDiff(before, after) {
  const fieldsChanged = [];
  for (const field of ['title', 'summary', 'category', 'tags']) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      fieldsChanged.push(field);
    }
  }

  const beforeBlocks = before.blocks ?? [];
  const afterBlocks  = after.blocks  ?? [];

  const beforeById = new Map(beforeBlocks.map(b => [String(b._id), b]));
  const afterById  = new Map(afterBlocks.map(b =>  [String(b._id), b]));

  const blocksAdded   = afterBlocks
    .filter(b => !beforeById.has(String(b._id)))
    .map(b => ({ type: b.type, order: b.order }));

  const blocksDeleted = beforeBlocks
    .filter(b => !afterById.has(String(b._id)))
    .map(b => ({ type: b.type, order: b.order }));

  const blocksUpdated = afterBlocks
    .filter(b => {
      const prev = beforeById.get(String(b._id));
      return prev && JSON.stringify(prev.data) !== JSON.stringify(b.data);
    })
    .map(b => ({ type: b.type, order: b.order }));

  return { fieldsChanged, blocksAdded, blocksUpdated, blocksDeleted };
}

export async function logCreate(entry, actor, excludeClientId = null) {
  const changes = {
    fieldsChanged: [],
    blocksAdded: (entry.blocks ?? []).map(b => ({ type: b.type, order: b.order })),
    blocksUpdated: [],
    blocksDeleted: [],
  };
  await ChangeLog.create({
    entryId:    entry._id,
    entryTitle: entry.title,
    changeType: 'created',
    actorId:    actor.userId,
    actorType:  actor.type,
    actorLabel: actor.label,
    changes,
    snapshot:   null,
  });
  broadcast('entry:created', {
    entry,
    actor:   { label: actor.label, type: actor.type },
    changes,
  }, excludeClientId);
}

export async function logUpdate(before, after, actor, excludeClientId = null) {
  const changes = computeDiff(before, after);
  await ChangeLog.create({
    entryId:    after._id,
    entryTitle: after.title,
    changeType: 'updated',
    actorId:    actor.userId,
    actorType:  actor.type,
    actorLabel: actor.label,
    changes,
    snapshot:   before,
  });
  broadcast('entry:updated', {
    entry:   after,
    actor:   { label: actor.label, type: actor.type },
    changes,
  }, excludeClientId);
}

export async function logDelete(entry, actor, excludeClientId = null) {
  const deletedAt = new Date().toISOString();
  await ChangeLog.create({
    entryId:    entry._id,
    entryTitle: entry.title,
    changeType: 'deleted',
    actorId:    actor.userId,
    actorType:  actor.type,
    actorLabel: actor.label,
    changes:    { fieldsChanged: [], blocksAdded: [], blocksUpdated: [], blocksDeleted: [] },
    snapshot:   entry,
  });
  broadcast('entry:deleted', {
    entryId:    String(entry._id),
    entryTitle: entry.title,
    actor:      { label: actor.label, type: actor.type },
    snapshot:   entry,
    deletedAt,
  }, excludeClientId);
}
