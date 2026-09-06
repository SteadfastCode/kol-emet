/**
 * Applies an accepted draft to the graph.
 *
 * This is the only place in the generator feature that writes entities and
 * relationships, and it is built around four rules:
 *
 *  1. ORDER. Relationships reference entities by localKey, so entities must
 *     land first and the localKey -> ObjectId map is built as we go.
 *  2. APPEND, NEVER OVERWRITE. An update adds blocks and tags; it does not
 *     replace prose. A human's writing cannot be destroyed by an apply.
 *  3. PARTIAL FAILURE IS NORMAL. One bad item must not roll back the rest.
 *     Each item records its own outcome, and the draft ends 'applied' or
 *     'partially_applied' accordingly.
 *  4. IDEMPOTENT. Items already applied are skipped, so a retry after a
 *     partial failure finishes the job rather than duplicating it.
 *
 * Writes reuse Entity.create / RelationshipGroup.create / logCreate / logUpdate
 * rather than a parallel write stack, so generated content goes through the
 * same validation and audit trail as anything typed by hand.
 */

import Entity, { BLOCK_TYPES } from '../models/Entity.js';
import RelationshipGroup from '../models/RelationshipGroup.js';
import OpenQuestion from '../models/OpenQuestion.js';
import { logCreate, logUpdate } from '../lib/changeLogger.js';

const LEVELS = { off: 0, light: 1, normal: 2 };
function log(level, msg) {
  const active = LEVELS[process.env.APPLY_LOG_LEVEL] ?? LEVELS.light;
  if (active >= LEVELS[level]) console.log(`[draftApplier:${level}] ${msg}`);
}

/** Mirrors the validation POST /entities applies, so generated blocks cannot
 *  enter the graph in a shape a hand-created entity could not. */
function validateBlocks(blocks) {
  if (!Array.isArray(blocks)) return 'blocks must be an array';
  for (const b of blocks) {
    if (!BLOCK_TYPES.includes(b.type)) return `Invalid block type: ${b.type}`;
    if (typeof b.order !== 'number') return 'Each block must have a numeric order';
    if (!b.data || typeof b.data !== 'object') return 'Each block must have a data object';
  }
  return null;
}

const normalizeOrder = blocks =>
  [...blocks].sort((a, b) => a.order - b.order).map((b, i) => ({ ...b, order: i }));

/**
 * Entity.summary is required, but the generator's schema defaults it to '' —
 * so a model that omits one would produce an item that could never be applied,
 * failing on a mongoose validation error the reviewer cannot act on.
 *
 * Derived from content the model actually produced (first sentence of the
 * first text block) rather than invented, falling back to the title. Nothing
 * here fabricates a claim the source did not support.
 */
function ensureSummary(summary, title, blocks) {
  const given = String(summary ?? '').trim();
  if (given) return given;

  const firstText = blocks.find(b => b.type === 'text')?.data?.markdown;
  if (firstText) {
    const sentence = String(firstText)
      .replace(/^#+\s.*$/gm, '')          // skip markdown headings
      .replace(/\s+/g, ' ')
      .trim()
      .split(/(?<=[.!?])\s/)[0];
    if (sentence) return sentence.slice(0, 200);
  }
  return String(title).slice(0, 200);
}

/** The payload a human signed off on — the edit if there was one, else the proposal. */
const payloadOf = item => item.accepted ?? item.proposed;

// ─── per-kind appliers ───────────────────────────────────────────────────────

async function applyEntityCreate(item, ctx) {
  const p = payloadOf(item);
  const blocks = normalizeOrder(p.blocks ?? []);
  const err = validateBlocks(blocks);
  if (err) throw new Error(err);

  const entity = await Entity.create({
    title: p.title,
    // The uncoerced value is kept on `proposed` for the corpus; what goes into
    // the graph is the coerced one, which is the only value the enum accepts.
    category: p.normalizedCategory ?? p.category,
    summary: ensureSummary(p.summary, p.title, blocks),
    tags: p.tags ?? [],
    blocks,
    workspaceId: ctx.workspaceId,
  });

  const entry = await logCreate(entity.toObject(), ctx.actor, null, {
    origin: { kind: 'draft', draftId: ctx.draftId, itemId: item._id, producer: ctx.producer },
    broadcast: false,
  });

  return { resultId: entity._id, changeLogId: entry?._id ?? null };
}

/**
 * Updates are append-only, and deliberately narrow.
 *
 * Title and category are never touched: the item matched an existing entity BY
 * title, so rewriting it would be incoherent. Summary is filled in only when
 * the entity has none — overwriting a human's one-line description with a
 * model's is exactly the silent damage this whole feature exists to avoid.
 */
async function applyEntityUpdate(item, ctx) {
  const p = payloadOf(item);
  const target = await Entity.findOne({ _id: item.targetEntityId, workspaceId: ctx.workspaceId });
  if (!target) throw new Error(`Target entity ${item.targetEntityId} no longer exists`);

  const before = target.toObject();

  // Staleness: has a human touched this since the draft was generated?
  const changedSince =
    item.baseUpdatedAt && target.updatedAt && target.updatedAt > item.baseUpdatedAt;

  const newBlocks = normalizeOrder(p.blocks ?? []);
  const err = validateBlocks(newBlocks);
  if (err) throw new Error(err);

  // Re-number appended blocks to sit after whatever is already there.
  const offset = target.blocks.length;
  const appended = newBlocks.map((b, i) => ({ ...b, order: offset + i }));

  if (appended.length) target.blocks.push(...appended);
  for (const t of (p.tags ?? [])) if (!target.tags.includes(t)) target.tags.push(t);
  if (!target.summary && p.summary) target.summary = p.summary;

  await target.save();

  const entry = await logUpdate(before, target.toObject(), ctx.actor, null, {
    origin: { kind: 'draft', draftId: ctx.draftId, itemId: item._id, producer: ctx.producer },
    broadcast: false,
  });

  return {
    resultId: target._id,
    changeLogId: entry?._id ?? null,
    // Recorded rather than blocked: appending cannot destroy their edit, but
    // the reviewer should know the target moved under them.
    flag: changedSince ? 'target_changed' : null,
  };
}

async function applyRelationship(item, ctx) {
  const p = payloadOf(item);

  const members = [];
  for (const m of p.members ?? []) {
    const refId = m.localKey ? ctx.localKeys.get(m.localKey) : m.refId;
    if (!refId) {
      // Its dependency was rejected or failed. Blocked, not failed — nothing
      // went wrong here, the prerequisite just is not in the graph.
      const reason = m.localKey
        ? `depends on "${m.localKey}", which was not applied`
        : `member "${m.name}" has no target`;
      const e = new Error(reason);
      e.blocked = true;
      throw e;
    }
    members.push({ refId, refModel: m.refModel ?? 'Entity', label: m.label ?? null, notes: m.notes ?? null });
  }

  // Same floor the relationship routes enforce.
  if (members.length < 2) {
    const e = new Error('Fewer than 2 resolvable members');
    e.blocked = true;
    throw e;
  }

  const group = await RelationshipGroup.create({
    label: p.label ?? null,
    members,
    workspaceId: ctx.workspaceId,
  });

  // Back-reference, scoped so a stray id cannot reach another workspace.
  await Entity.updateMany(
    { _id: { $in: members.map(m => m.refId) }, workspaceId: ctx.workspaceId },
    { $addToSet: { relationships: group._id } }
  );

  return { resultId: group._id, changeLogId: null };
}

async function applyOpenQuestion(item, ctx) {
  const p = payloadOf(item);
  const linkIds = (p.entry_ids ?? [])
    .map(k => ctx.localKeys.get(k) ?? k)
    .filter(Boolean);

  const oq = await OpenQuestion.create({
    question: p.question,
    entry_ids: linkIds,
    workspaceId: ctx.workspaceId,
  });

  if (linkIds.length) {
    await Entity.updateMany(
      { _id: { $in: linkIds }, workspaceId: ctx.workspaceId },
      { $addToSet: { open_questions: oq._id } }
    );
  }

  return { resultId: oq._id, changeLogId: null };
}

// ─── orchestration ───────────────────────────────────────────────────────────

/**
 * Entity creates first so their ids exist, then updates, then relationships
 * (which need those ids), then open questions. Within each phase, draft order.
 */
function orderItems(items) {
  const rank = it =>
    it.kind === 'entity' && it.op === 'create' ? 0 :
    it.kind === 'entity'                       ? 1 :
    it.kind === 'relationship'                 ? 2 : 3;
  return [...items].sort((a, b) => rank(a) - rank(b) || a.seq - b.seq);
}

/**
 * @param {Document} draft  a mongoose Draft document (mutated and saved here)
 * @param {object}   ctx    { workspaceId, actor }
 */
export async function applyDraft(draft, { workspaceId, actor }) {
  // Writes from an apply are attributed to the generator, not the person who
  // clicked Apply. They approved the change; they did not author it, and the
  // history should say which. actorLabel still names them.
  const generatorActor = { ...actor, type: 'generator' };

  const localKeys = new Map();
  const applyCtx = {
    workspaceId,
    actor: generatorActor,
    draftId: draft._id,
    producer: draft.source?.producer ?? 'braindump',
    localKeys,
  };

  let applied = 0, failed = 0, blocked = 0, skipped = 0;

  for (const item of orderItems(draft.items)) {
    // Idempotency: a retry after a partial failure finishes the job rather
    // than duplicating what already landed.
    if (item.applyState === 'applied') {
      if (item.resultId && item.localKey) localKeys.set(item.localKey, item.resultId);
      skipped++;
      continue;
    }
    // Only what a human accepted. Pending and rejected items are not writes.
    if (item.decision !== 'accepted' && item.decision !== 'edited') {
      skipped++;
      continue;
    }

    try {
      let out;
      if (item.kind === 'entity' && item.op === 'create')      out = await applyEntityCreate(item, applyCtx);
      else if (item.kind === 'entity')                          out = await applyEntityUpdate(item, applyCtx);
      else if (item.kind === 'relationship')                    out = await applyRelationship(item, applyCtx);
      else if (item.kind === 'open_question')                   out = await applyOpenQuestion(item, applyCtx);
      else throw new Error(`Unknown item kind: ${item.kind}`);

      item.applyState = 'applied';
      item.resultId = out.resultId;
      item.changeLogId = out.changeLogId;
      item.applyError = null;
      item.appliedAt = new Date();
      if (out.flag && !item.flags.includes(out.flag)) item.flags.push(out.flag);
      if (item.localKey) localKeys.set(item.localKey, out.resultId);
      applied++;
    } catch (err) {
      // One item failing must not stop the rest. 'blocked' is distinguished
      // from 'failed' because a blocked item is a consequence of a decision,
      // not a fault to investigate.
      item.applyState = err.blocked ? 'blocked' : 'failed';
      item.applyError = err.message;
      if (err.blocked) blocked++; else failed++;
      log('light', `item ${item.localKey} ${item.applyState}: ${err.message}`);
    }
  }

  draft.recountItems();
  draft.status = (failed || blocked) ? 'partially_applied' : 'applied';
  draft.appliedAt = new Date();
  await draft.save();

  const summary = { applied, failed, blocked, skipped };
  log('light', `draft ${draft._id}: ${JSON.stringify(summary)} -> ${draft.status}`);
  return summary;
}
