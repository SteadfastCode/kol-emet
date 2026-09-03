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
| `Conversation` | `conversations` | Saved AI chat sessions per user |
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
  workspaceId: ObjectId | null,// multi-tenancy key; stored, not yet enforced in queries
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

Indexed on `{ name, workspaceId }` — names are intended to be unique per workspace (`null` = global
for now).

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
  actorType:   'user' | 'mcp',      // human vs. AI-via-MCP write
  actorLabel:  String,              // e.g. "alice@example.com" or "alice@example.com via AI"
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
