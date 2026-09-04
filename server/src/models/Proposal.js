import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/**
 * A generated set of changes awaiting human review — "a pull request against
 * the graph". Nothing here touches entities/relationshipgroups until an
 * explicit apply.
 *
 * This collection is also the training corpus for a future self-hosted model
 * (Decision Log, 2026-09-03), which drives three choices that would otherwise
 * look odd:
 *
 *   - No TTL anywhere. ChangeLog expires after 30 days because it is undo;
 *     this is the corpus and must be permanent. DELETE is a soft
 *     status:'discarded'; hard deletion belongs to account deletion alone.
 *   - `accepted` is written at DECISION time, not apply time, so a proposal
 *     that is reviewed in full and then abandoned — the most common outcome —
 *     still yields a complete set of labels.
 *   - A rejection never removes the item. The negative example is the most
 *     valuable and the easiest to lose.
 */

// A member of a proposed relationship. Exactly one of localKey (a sibling item
// in THIS proposal) or refId (an entity that already exists) is set. `name` is
// what the model actually emitted and survives resolution failure, so a dropped
// member stays explainable instead of silently vanishing.
const proposedMemberSchema = new mongoose.Schema({
  localKey: { type: String, default: null },
  refId:    { type: ObjectId, default: null },
  refModel: { type: String, enum: ['Entity', 'RelationshipGroup'], default: 'Entity' },
  name:     { type: String, required: true },
  label:    { type: String, default: null },
  notes:    { type: String, default: null },
}, { _id: false });

// charStart/charEnd are computed server-side by indexOf against source.text.
// Models reliably get offsets wrong; they can copy a quote.
const evidenceSchema = new mongoose.Schema({
  quote:      { type: String, default: '' },
  charStart:  { type: Number, default: null },
  charEnd:    { type: Number, default: null },
  chunkIndex: { type: Number, default: 0 },
}, { _id: false });

const itemSchema = new mongoose.Schema({
  // Server-assigned: 'e1', 'r1', 'q1'. Ids emitted by the model are discarded,
  // so a model that repeats or invents ids cannot corrupt cross-references.
  localKey: { type: String, required: true },
  seq:      { type: Number, required: true },
  kind:     { type: String, enum: ['entity', 'relationship', 'open_question'], required: true },
  // 'delete' is reserved for drift detection and deliberately not generated yet.
  op:       { type: String, enum: ['create', 'update'], required: true },

  // ── fine-tune triple, part 1: INPUT (written at generation) ───────────────
  input: {
    evidence:         { type: evidenceSchema, default: () => ({}) },
    contextEntityIds: [{ type: ObjectId, ref: 'Entity' }],
  },

  // ── part 2: PROPOSED (written at generation, post-validation). Frozen. ────
  proposed: { type: mongoose.Schema.Types.Mixed, required: true },

  // ── part 3: ACCEPTED (written at decision time) ───────────────────────────
  // Copied verbatim from `proposed` on a plain accept rather than left null,
  // so the exporter is a single-pass map that stays correct even if the
  // normalizer changes later.
  accepted: { type: mongoose.Schema.Types.Mixed, default: null },

  // ── the HUMAN LABEL. Written only by the decision routes. ─────────────────
  decision:     { type: String, enum: ['pending', 'accepted', 'edited', 'rejected'], default: 'pending' },
  decisionVia:  { type: String, enum: ['individual', 'bulk'], default: null },
  decisionNote: { type: String, default: null },
  decidedBy:    { type: ObjectId, ref: 'User', default: null },
  decidedAt:    { type: Date, default: null },

  // ── dedup / targeting ────────────────────────────────────────────────────
  targetEntityId: { type: ObjectId, ref: 'Entity', default: null },
  baseUpdatedAt:  { type: Date, default: null },
  matchedBy:      { type: String, enum: ['exact-normalized-title', 'manual', 'none'], default: 'none' },
  duplicateOf:    { type: ObjectId, ref: 'Entity', default: null },
  duplicateScore: { type: Number, default: null },
  dependsOn:      [{ type: String }],
  flags:          [{ type: String }],
  confidence:     { type: Number, default: null },

  // ── SYSTEM OUTCOME. Written only by the applier, never from a request body.
  // Kept separate from the human label so an apply failure can never overwrite
  // the record that a person said yes.
  applyState:  { type: String, enum: ['pending', 'applied', 'failed', 'skipped', 'blocked', 'stale'], default: 'pending' },
  resultId:    { type: ObjectId, default: null },
  changeLogId: { type: ObjectId, ref: 'ChangeLog', default: null },
  applyError:  { type: String, default: null },
  appliedAt:   { type: Date, default: null },
}, { _id: true });

const proposalSchema = new mongoose.Schema({
  // required, unlike Entity.workspaceId which is `default: null` to accommodate
  // pre-tenancy rows. A new collection has none, so it fails closed from row one.
  workspaceId: { type: ObjectId, ref: 'Workspace', required: true, index: true },
  createdBy:   { type: ObjectId, ref: 'User', required: true },
  title:       { type: String, default: '' },
  status: {
    type: String,
    enum: ['generating', 'ready', 'failed', 'applied', 'partially_applied', 'discarded'],
    default: 'generating',
  },

  // The producer seam: drift / repo / openapi become new enum values here
  // rather than new collections.
  source: {
    producer:        { type: String, enum: ['braindump'], default: 'braindump' },
    producerVersion: { type: String, default: 'braindump@1' },
    text:            { type: String, default: '' },
    textHash:        { type: String, default: null },
  },

  // Exactly what the model was shown, so a training example is reproducible.
  grounding: {
    promptVersion:     { type: String, default: null },
    categories:        [{ type: String }],
    relationshipTypes: [{ type: String }],
    rosterCount:       { type: Number, default: 0 },
    rosterTruncated:   { type: Boolean, default: false },
    systemPrompt:      { type: String, default: null },
  },

  route: {
    provider: { type: String, default: null },
    model:    { type: String, default: null },
    strategy: { type: String, default: null },
  },

  items: { type: [itemSchema], default: [] },

  // Denormalised so "is the generator improving across prompt versions" is a
  // cheap query rather than a batch job.
  counts: {
    proposed: { type: Number, default: 0 },
    accepted: { type: Number, default: 0 },
    edited:   { type: Number, default: 0 },
    rejected: { type: Number, default: 0 },
    pending:  { type: Number, default: 0 },
    dropped:  { type: Number, default: 0 },
    applied:  { type: Number, default: 0 },
    failed:   { type: Number, default: 0 },
  },

  // How much repair the raw model output needed — the signal for whether a
  // weaker self-hosted model is viable for this task.
  diagnostics: {
    parsedVia:       [{ type: String }],
    repairAttempted: { type: Boolean, default: false },
    dropReasons:     [{ type: String }],
    rawOutput:       { type: String, default: null },
    passes:          { type: Number, default: 0 },
    error:           { type: String, default: null },
    generationMs:    { type: Number, default: null },
  },

  applyingAt: { type: Date, default: null },
  appliedAt:  { type: Date, default: null },
}, { timestamps: true });

proposalSchema.index({ workspaceId: 1, createdAt: -1 });
proposalSchema.index({ workspaceId: 1, status: 1 });

/** Recomputes `counts` from items. Call after any decision or apply. */
proposalSchema.methods.recountItems = function recountItems() {
  const c = { proposed: this.items.length, accepted: 0, edited: 0, rejected: 0, pending: 0, applied: 0, failed: 0 };
  for (const it of this.items) {
    if (it.decision === 'accepted') c.accepted++;
    else if (it.decision === 'edited') c.edited++;
    else if (it.decision === 'rejected') c.rejected++;
    else c.pending++;
    if (it.applyState === 'applied') c.applied++;
    else if (it.applyState === 'failed') c.failed++;
  }
  this.counts = { ...this.counts.toObject?.() ?? this.counts, ...c };
  return this.counts;
};

export default mongoose.model('Proposal', proposalSchema);
