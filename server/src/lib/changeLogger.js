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

export async function logCreate(entity, actor, excludeClientId = null) {
  const changes = {
    fieldsChanged: [],
    blocksAdded: (entity.blocks ?? []).map(b => ({ type: b.type, order: b.order })),
    blocksUpdated: [],
    blocksDeleted: [],
  };
  await ChangeLog.create({
    entityId:    entity._id,
    entityTitle: entity.title,
    changeType: 'created',
    actorId:    actor.userId,
    actorType:  actor.type,
    actorLabel: actor.label,
    changes,
    snapshot:   null,
  });
  broadcast('entity:created', {
    entity,
    actor:   { label: actor.label, type: actor.type },
    changes,
  }, excludeClientId);
}

export async function logUpdate(before, after, actor, excludeClientId = null) {
  const changes = computeDiff(before, after);
  await ChangeLog.create({
    entityId:    after._id,
    entityTitle: after.title,
    changeType: 'updated',
    actorId:    actor.userId,
    actorType:  actor.type,
    actorLabel: actor.label,
    changes,
    snapshot:   before,
  });
  broadcast('entity:updated', {
    entity:   after,
    actor:    { label: actor.label, type: actor.type },
    changes,
  }, excludeClientId);
}

export async function logDelete(entity, actor, excludeClientId = null) {
  const deletedAt = new Date().toISOString();
  await ChangeLog.create({
    entityId:    entity._id,
    entityTitle: entity.title,
    changeType: 'deleted',
    actorId:    actor.userId,
    actorType:  actor.type,
    actorLabel: actor.label,
    changes:    { fieldsChanged: [], blocksAdded: [], blocksUpdated: [], blocksDeleted: [] },
    snapshot:   entity,
  });
  broadcast('entity:deleted', {
    entityId:    String(entity._id),
    entityTitle: entity.title,
    actor:       { label: actor.label, type: actor.type },
    snapshot:    entity,
    deletedAt,
  }, excludeClientId);
}
