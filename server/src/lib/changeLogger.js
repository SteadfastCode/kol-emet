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

export async function logCreate(entity, actor, excludeClientId = null, opts = {}) {
  const changes = {
    fieldsChanged: [],
    blocksAdded: (entity.blocks ?? []).map(b => ({ type: b.type, order: b.order })),
    blocksUpdated: [],
    blocksDeleted: [],
  };
  const logEntry = await ChangeLog.create({
    workspaceId: entity.workspaceId ?? null,
    origin:      opts.origin ?? undefined,
    entityId:    entity._id,
    entityTitle: entity.title,
    changeType: 'created',
    actorId:    actor.userId,
    actorType:  actor.type,
    actorLabel: actor.label,
    changes,
    snapshot:   null,
  });
  // An apply emits ONE draft:applied event at the end instead of a burst of
  // per-entity events, so a 30-item apply does not flood every open tab.
  if (opts.broadcast !== false) {
    broadcast('entity:created', {
      entity,
      actor:   { label: actor.label, type: actor.type },
      changes,
    }, { workspaceId: entity.workspaceId, excludeClientId });
  }
  return logEntry;
}

export async function logUpdate(before, after, actor, excludeClientId = null, opts = {}) {
  const changes = computeDiff(before, after);
  const logEntry = await ChangeLog.create({
    workspaceId: after.workspaceId ?? before.workspaceId ?? null,
    origin:      opts.origin ?? undefined,
    entityId:    after._id,
    entityTitle: after.title,
    changeType: 'updated',
    actorId:    actor.userId,
    actorType:  actor.type,
    actorLabel: actor.label,
    changes,
    snapshot:   before,
  });
  if (opts.broadcast !== false) {
    broadcast('entity:updated', {
      entity:   after,
      actor:    { label: actor.label, type: actor.type },
      changes,
    }, { workspaceId: after.workspaceId ?? before.workspaceId, excludeClientId });
  }
  return logEntry;
}

export async function logDelete(entity, actor, excludeClientId = null) {
  const deletedAt = new Date().toISOString();
  await ChangeLog.create({
    workspaceId: entity.workspaceId ?? null,
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
  }, { workspaceId: entity.workspaceId, excludeClientId });
}
