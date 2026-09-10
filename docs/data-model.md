# Kol Emet — Data Model

The source of truth is the Mongoose schemas under [`server/src/models/`](../server/src/models). This
document mirrors them. When the code and this file disagree, the code wins — update this file.

MongoDB collections:

| Model | Collection | Purpose |
|-------|-----------|---------|
| `Entity` | `entities` | Wiki entries (characters, worlds, etc.), built from ordered content blocks |
| `RelationshipGroup` | `relationshipgroups` | Links between entities; unified member array supports nesting |
| `RelationshipType` | `relationshiptypes` | Vocabulary of relationship labels, optionally category-scoped |
| `OpenQuestion` | `openquestions` | Unresolved questions, each linked to one or more entities |
| `ChangeLog` | `changelogs` | Audit trail of entity writes (TTL 30 days) |
| `Draft` | `drafts` | Generated changes awaiting human review; also the fine-tune corpus (**no TTL**) |
| `Conversation` | `conversations` | Saved AI chat sessions per user |
| `Workspace` | `workspaces` | Tenancy boundary + AI allowance |
| `User` | `users` | Accounts: email + bcrypt hash + WebAuthn passkeys |
| `Settings` | `settings` | Singleton global config (`_id: 'global'`) |

---

## Entity

The central document. Replaces the original flat `title`/`summary`/`body`/`tags` entry shape — long-form
content now lives in an ordered `blocks` array, and there is **no `body` field**.

```js
{
  _id:        ObjectId,
  title:      String,          // required
  category:   String,          // required, enum (see below)
  summary:    String,          // required, one-line description
  tags:       [String],        // queryable string array (default [])
  blocks:     [Block],         // ordered content blocks (default [])
  relationships: [ObjectId],   // refs → RelationshipGroup (back-reference; see note)
  open_questions: [ObjectId],  // refs → OpenQuestion
  workspaceId: ObjectId | null,// multi-tenancy key; enforced per request (see Workspace)
  createdAt:  Date,
  updatedAt:  Date,
}
```

**`category`** enum: `Characters`, `Worlds`, `Organizations`, `Lore & Mechanics`, `Timeline`,
`Open Questions`.

### Block

Blocks are embedded subdocuments (each has its own `_id`). `data` is a free-form object whose shape
depends on `type`.

```js
{
  _id:   ObjectId,
  type:  String,   // enum: text | timeline_event | attribute | quote | gallery
  order: Number,   // 0-based; normalized densely on every create/update
  data:  Mixed,    // shape depends on type
}
```

`BLOCK_TYPES` is exported from [`Entity.js`](../server/src/models/Entity.js) and validated on write.
**Relationships are not a block type** — they are a separate collection (below). On create/update the
API sorts blocks by `order` and rewrites them to a dense `0..n-1` sequence, so `order` gaps never
persist.

---

## RelationshipGroup

A relationship is a *group of members*, not a directed edge. A simple pairwise link is just a group
with two members; a family or faction is a group with many. Members use a **unified array with a
`refModel` discriminator**, so a group can contain both entities and other groups (nesting) — array
position is the display order.

```js
{
  _id:     ObjectId,
  label:   String | null,      // e.g. "House Xitren", "the twins"
  members: [{
    refId:    ObjectId,        // required
    refModel: 'Entity' | 'RelationshipGroup',  // required — discriminator
    label:    String | null,   // this member's role, e.g. "father", "twin sister"
    notes:    String | null,
  }],
  entityId: ObjectId | null,   // LEGACY, unused — do not read/write
  createdAt: Date,
}
```

Design notes:
- **The group's `members` array is the source of truth for who is related**, not the `relationships`
  back-reference on `Entity`. Reads query `RelationshipGroup` by `members.refId`
  (indexed) rather than trusting the back-reference, which is kept only as a convenience/cache.
- Member `label`s should be specific to each member's role and gender: `"brother"`/`"sister"`, not
  `"sibling"`; `"twin brother"`, not `"twin"`. The MCP tool descriptions enforce this convention.
- Deleting an entity prunes it from every group's `members`; a group left with fewer than two entity
  members is deleted and its back-references cleaned up.

---

## RelationshipType

The controlled vocabulary the editor autocompletes against (via Fuse.js on the client). Optionally
scoped to source/target categories.

```js
{
  _id:            ObjectId,
  name:           String,        // required, trimmed
  sourceCategory: String | null,
  targetCategory: String | null,
  workspaceId:    ObjectId | null,
  createdAt:      Date,
  updatedAt:      Date,
}
```

Indexed on `{ name, workspaceId }` — names are intended to be unique per workspace. Each workspace
has its own vocabulary: reads filter on the caller's workspace, so a `null` row is visible to no one
rather than global.

---

## OpenQuestion

An unresolved question, linked to the entities it concerns. Replaces the old inline
`open_question` string field on entries.

```js
{
  _id:       ObjectId,
  question:  String,               // required
  status:    'open' | 'resolved',  // default 'open'
  entry_ids: [ObjectId],           // refs → Entity
  createdAt: Date,
  updatedAt: Date,
}
```

---

## ChangeLog

Append-only audit record written on every entity create/update/delete. Documents **auto-expire 30
days after creation** via a TTL index — this is recent-history/undo, not permanent provenance.

```js
{
  _id:         ObjectId,
  entityId:    ObjectId,   // ref → Entity (indexed)
  entityTitle: String,
  changeType:  'created' | 'updated' | 'deleted',
  actorId:     ObjectId | null,     // ref → User
  actorType:   'user' | 'mcp' | 'generator',   // human · AI-via-MCP · applied from a draft
  actorLabel:  String,              // e.g. "alice@example.com" or "alice@example.com via AI"

  // Set only when the write came from an accepted draft item, so a generated
  // change is traceable back to the draft and the item a human approved.
  origin: {
    kind:     'draft' | null,
    draftId:  ObjectId | null,   // ref → Draft
    itemId:   ObjectId | null,   // the item within that draft
    producer: String | null,     // e.g. 'braindump'
  },
  changes: {
    fieldsChanged: [String],
    blocksAdded:   [{ type, order }],
    blocksUpdated: [{ type, order }],
    blocksDeleted: [{ type, order }],
  },
  snapshot:    Mixed | null,   // pre-change snapshot, enables rollback
  createdAt:   Date,
}
```

`actorType` distinguishes **who made a change and why** — a human edit in the UI vs. an automated MCP
write from an AI client — so the history view can tell an intentional action apart from a background
one. Rollback restores from `snapshot` (see [`POST /entities/:id/rollback/:logId`](api.md)).

`generator` was added for draft applies. The person who clicked Apply is still in `actorId` and
`actorLabel`, but the *change itself* was written by the generator and reviewed by them — recording
it as an ordinary user edit would make a 30-item apply indistinguishable from thirty hand edits.
`origin` carries the back-reference, so any generated change in the history can be traced to the
draft item it came from. Both are set by the applier.

---

## Draft

A generated set of proposed changes awaiting review — *a pull request against the graph*. Items are
**embedded**, not a separate collection: an export must be a single-pass map over one document, and
a join would mean the training triple lives in pieces that can drift apart.

This collection is also the **fine-tune corpus** (Decision Log, 2026-09-03), which drives three
choices that would otherwise look odd:

- **No TTL anywhere.** `ChangeLog` expires after 30 days because it is undo; this is the corpus and
  must be permanent. `DELETE` is a soft `status: 'discarded'`; the only hard delete is account
  deletion (see Workspace).
- **`accepted` is written at decision time, not apply time**, so a draft reviewed in full and then
  abandoned — the common outcome — still yields a complete set of labels.
- **A rejection never removes the item.** The negative example is the most valuable and the easiest
  to lose.

`workspaceId` is `required: true`, unlike `Entity.workspaceId` which is `default: null` to
accommodate pre-tenancy rows. A new collection has none, so it fails closed from row one.

```js
{
  _id:         ObjectId,
  workspaceId: ObjectId,   // ref → Workspace, REQUIRED (indexed)
  createdBy:   ObjectId,   // ref → User
  title:       String,     // first ~60 chars of the input, for the list view
  status: 'generating' | 'ready' | 'failed' | 'applied' | 'partially_applied' | 'discarded',

  // The producer seam: drift / repo / openapi become new enum values here
  // rather than new collections.
  source: {
    producer:        'braindump',
    producerVersion: String,      // 'braindump@1'
    text:            String,      // the input, verbatim
    textHash:        String,      // 'sha256:…'
  },

  // Exactly what the model was shown, so a training example is reproducible.
  grounding: {
    promptVersion, categories[], relationshipTypes[],
    rosterCount, rosterTruncated, systemPrompt,
  },

  route: { provider, model, strategy },
  items: [Item],           // see below
  counts: { proposed, accepted, edited, rejected, pending, dropped, applied, failed },

  // How much repair the raw model output needed — the signal for whether a
  // weaker self-hosted model is viable for this task.
  diagnostics: {
    parsedVia: [String], repairAttempted: Boolean, dropReasons: [String],
    rawOutput: String, passes: Number, error: String, generationMs: Number,
    usage: { promptTokens, completionTokens, calls },
  },

  applyingAt: Date | null,  // atomic apply lock; >5 min old is a crashed apply
  appliedAt:  Date | null,
  createdAt:  Date,
  updatedAt:  Date,
}
```

Indexes: `{ workspaceId, createdAt: -1 }` and `{ workspaceId, status }`.

### Draft item

Each item carries the fine-tune triple as three **separately written** parts.

```js
{
  _id:      ObjectId,
  localKey: String,   // server-assigned: 'e1', 'r1', 'q1'
  seq:      Number,
  kind:     'entity' | 'relationship' | 'open_question',
  op:       'create' | 'update',

  // ── part 1: INPUT — written at generation ────────────────────────────────
  input: {
    evidence: { quote, charStart, charEnd, chunkIndex },
    contextEntityIds: [ObjectId],   // what the model was shown
  },

  // ── part 2: PROPOSED — written at generation, post-validation. Frozen. ───
  proposed: Mixed,

  // ── part 3: ACCEPTED — written at DECISION time ──────────────────────────
  accepted: Mixed | null,

  // ── the HUMAN LABEL — written only by the decision routes ────────────────
  decision:    'pending' | 'accepted' | 'edited' | 'rejected',
  decisionVia: 'individual' | 'bulk' | null,
  decisionNote: String | null,
  decidedBy:   ObjectId | null,   // ref → User
  decidedAt:   Date | null,

  // ── targeting / dedup ────────────────────────────────────────────────────
  targetEntityId: ObjectId | null,   // set when op is 'update'
  baseUpdatedAt:  Date | null,       // staleness baseline for the applier
  matchedBy:      'exact-normalized-title' | 'manual' | 'none',
  duplicateOf:    ObjectId | null,   // fuzzy candidate; NEVER auto-merged
  duplicateScore: Number | null,
  dependsOn:      [String],          // localKeys this item needs applied first
  flags:          [String],          // duplicate_candidate, category_coerced, …
  confidence:     Number | null,

  // ── the SYSTEM OUTCOME — written only by the applier ─────────────────────
  applyState:  'pending' | 'applied' | 'failed' | 'skipped' | 'blocked' | 'stale',
  resultId:    ObjectId | null,   // the Entity / RelationshipGroup created
  changeLogId: ObjectId | null,
  applyError:  String | null,
  appliedAt:   Date | null,
}
```

The split between the human label and the system outcome is load-bearing: the decision routes reject
any request body containing a system key, so **an apply failure can never overwrite the record that a
human said yes**. `accepted` is copied verbatim from `proposed` on a plain accept rather than left
null, so the exporter stays a single-pass map even if the normalizer changes later.

Proposed relationship members are stored in the `RelationshipGroup` **model** shape
(`{ refId, refModel, label, notes }`), not the route's `{ entityId }` shape, because `refModel` is the
discriminator that supports nesting when subgroup drafts land. A member is either `localKey` (a
sibling item in this draft, not yet written) or `refId` (an entity that already exists) — never both.
Members also carry the `name` the model emitted, so a member that fails to resolve stays explainable
rather than silently vanishing.

### Export shape

[`lib/draftExporter.js`](../server/src/lib/draftExporter.js) maps a draft to one JSONL record
(`kol-emet/draft-export@1`) with **no queries** — that is the property proving the capture is
complete. ObjectIds never leave: sibling references become `local:<localKey>`, everything else a
keyed HMAC pseudonym. A raw ObjectId surviving the mapping fails the export rather than being
silently scrubbed, because a scrub would hide a field the mapper forgot.

---

## Conversation

Saved AI chat sessions (the in-app ChatPanel). One document per conversation, scoped to a user.

```js
{
  _id:       ObjectId,
  userId:    ObjectId,   // ref → User (indexed)
  provider:  String,     // e.g. 'xai', 'openai', 'gemini'
  model:     String,
  title:     String,     // default ''
  autoTitle: Boolean,    // true until the user manually renames (default true)
  messages: [{
    role:      'user' | 'assistant',
    content:   String,
    createdAt: Date,
  }],
  createdAt: Date,
  updatedAt: Date,
}
```

---

## Workspace

The tenancy boundary. Every piece of graph content belongs to exactly one, and a request may only
touch content in a workspace the caller is a member of — enforced by
[`middleware/workspace.js`](../server/src/middleware/workspace.js), which **fails closed** with a 403
rather than falling through to unscoped data. Rows written before tenancy carry `workspaceId: null`,
which no scoped query matches;
[`scripts/migrate-workspaces.js`](../server/scripts/migrate-workspaces.js) adopts them into a named
workspace.

**Known gap:** `populate()` is unscoped for `Entity.open_questions` (entity routes, changelog
rollback, the MCP entity tools) and `OpenQuestion.entry_ids` (open-question routes,
`list_open_questions`). A caller who writes another workspace's id into either array can read back
that row's question text or entity title.
[`tests/http/tenancy.test.js`](../server/tests/http/tenancy.test.js) pins both as `todo` tests that
pass once the populate is scoped (`match: { workspaceId }`) or foreign ids are rejected on write.

Members are modelled from the start rather than a bare `ownerId`, so shared workspaces don't require
reshaping the schema later. Registration creates a personal workspace with the new user as sole owner.

**Account deletion** is a hard delete, drafts included
([`lib/accountDeleter.js`](../server/src/lib/accountDeleter.js); no route yet). It removes the user,
every workspace they *solely* own (they are `ownerId` and no other member holds `owner`), every
document in those workspaces across every model carrying `workspaceId`, and their `UserMemory` and
`Conversation` rows. It refuses, deleting nothing, while the user belongs to any workspace they
don't solely own, whether as editor, viewer or co-owner.

```js
{
  _id:     ObjectId,
  name:    String,
  ownerId: ObjectId,   // ref → User (indexed)
  members: [{ userId: ObjectId, role: 'owner' | 'editor' | 'viewer' }],

  // AI allowance in MICRO-DOLLARS (1_000_000 = $1.00). Integers, because this
  // is compared and decremented on every AI call and float cents drift.
  aiBudget: {
    grantedMicros:   Number,      // default AI_TRIAL_GRANT_MICROS ($3.50)
    spentMicros:     Number,
    generatingSince: Date | null, // concurrency lock; stale after 10 min
  },
  createdAt: Date,
  updatedAt: Date,
}
```

Indexes: `{ ownerId }` and `{ 'members.userId' }` — membership lookups drive every scoped request.

A **total** allowance rather than a daily rate: the audience works in bursts, and a free Saturday
with three chapters of notes is the exact session a daily cap would block, while worst-case exposure
is identical either way. It covers everything that calls a provider we pay for — generation, in-app
chat, memory extraction, and self-hosted inference (cheap, but electricity is not free). It
deliberately does **not** cover MCP: Claude.ai runs that inference on the user's own subscription, so
it costs nothing here and stays free.

`generatingSince` is a lock, not a timestamp for display. Cost is unknown until a run finishes, so
simultaneous runs would each pass the same budget check; this caps the overshoot at one run.

---

## User

```js
{
  _id:          ObjectId,
  email:        String,   // required, unique, lowercased, trimmed
  passwordHash: String,   // required — bcrypt, 12 rounds
  passkeys: [{
    credentialID: String,   // base64url, for querying
    publicKey:    Buffer,
    counter:      Number,
    transports:   [String],
    createdAt:    Date,
  }],
  createdAt:    Date,
  updatedAt:    Date,
}
```

Registration is **open** — anyone can create an account. Passkeys (WebAuthn) are supported alongside
password login.

---

## Settings

A single global document. Always upsert with `_id: 'global'` — never create a second one.

```js
{
  _id:       'global',
  mcpUserId: ObjectId | null,   // ref → User the MCP connector writes as
}
```

`mcpUserId` is the account that MCP/AI writes are attributed to. It is set when a user authorizes the
MCP connector from wiki settings; if it is unset, `requireActor` rejects MCP writes with a
"re-authorize" error.
