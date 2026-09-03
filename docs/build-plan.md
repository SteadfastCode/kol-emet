# Kol Emet — Build Plan: Phase 6 + Auto-writer, and the road to a worldbuilding launch

Companion to [roadmap.md](roadmap.md). Estimates are rough, in **focused build-days** (a day of
concentrated Daniel + Claude Code work), not calendar days — see the calendar translation at the end.

Storage decision confirmed: **DB-canonical** (MongoDB is the source of truth; a Git connector is a
later round-trip, not the store).

---

## Part A — Phase 6 scope: user-defined entity types + templates

### Design
Mirror the existing `RelationshipType` pattern (a workspace-scoped **registry** used for the picker;
the data holds a free string, not a hard foreign key). This is the codebase's established philosophy
and the lowest-risk path.

- **New `EntityType` model** (registry): `{ _id, workspaceId, name, icon, color, order }`. `workspaceId`
  is `null` (global) until Phase 8 enforcement, exactly like `RelationshipType` today.
- **`Entity.category` stays a required string but loses the hardcoded enum.** It holds the type
  *name*; the `EntityType` registry defines which names exist and their icon/color. (Keeping the field
  name `category` avoids a rename across the whole client; `type` collides with Mongoose's `type` key,
  so it's not worth the churn.)
- Validate `category` against the workspace's registry on write (soft warn, hard reject configurable).
- Type **rename cascades** to entities (same as a tag rename) — acceptable and simple.

### Files touched (the enum lives in exactly these places)
- `server/src/models/Entity.js:17` — drop the enum.
- **New:** `server/src/models/EntityType.js` + `server/src/routes/entityTypes.js` (GET/POST/PUT/DELETE),
  mounted in `index.js`. Reuse the near-duplicate detection from `relationshipTypes.js`.
- `server/src/routes/mcp.js:44` — drop `z.enum(CATEGORIES)` on create/update; add a `list_entity_types`
  tool so the agent knows valid types; update tool descriptions.
- `server/src/routes/chat.js:81` — the in-app assistant's category list becomes a fetch, not a const.
- `client/src/config/categories.js`, `client/src/components/EntityCard.vue:91,105` — pills, filters,
  the editor type-picker, and icon/color all read from `/entity-types` instead of the hardcoded lists.
- **Migration/seed:** create the six current categories as `EntityType` docs (with today's colors) so
  existing data keeps working.

### Templates
A **template = a bundle of `EntityType[]` + `RelationshipType[]`** (+ optional starter entities),
defined in code as JSON at first (no admin UI needed).
- Seed the chosen template's types on **workspace creation**.
- Ship two: **Worldbuilding** (today's six categories + current relationship types) and **Software
  Architecture** (Service, Data Store, API, Team, External Dependency; relationships *depends-on*,
  *owned-by*, *calls*, *exposes*).

### Effort — Phase 6
| Piece | Days |
|-------|------|
| `EntityType` model + `/entity-types` route (mirror `RelationshipType`) | 0.5 |
| Drop enum + write-time validation + seed/migrate the 6 defaults | 0.5 |
| MCP: `list_entity_types`, drop enum, tool descriptions | 0.5 |
| Client: data-driven types (pills, filter, picker, icon/color) | 1.0–1.5 |
| Templates: code-defined bundles + seed-on-create, 2 templates | 1.0 |
| Test + polish | 0.5 |
| **Total** | **~4–5 days** |

> **Important:** Phase 6 is for the *architecture* expansion. It is **not on the critical path to a
> worldbuilding launch** — the current hardcoded categories already *are* worldbuilding categories.
> Do Phase 6 in parallel or after the launch, not before. (See Part C.)

---

## Part B — Auto-writer routine (Claude Code routine)

A scheduled Claude Code routine that autonomously grows/maintains the graph on a cadence — dogfooding
Daniel's World Train instance now, and prototyping the Phase 7 generator/continuous-sync hook cheaply
before it's built into the product.

### What one run does (bounded)
1. Read current state via MCP (`search_entities`, `list_open_questions`, `get_entity`).
2. Pick **one small unit of work** from a priority list: answer/expand an open question → flesh out a
   thin entity → propose relationships between entities that mention each other but aren't linked →
   add a missing entity that others reference.
3. Write via MCP, **capped at N changes/run**, checking existence first (no duplicates) and skipping
   anything a human edited recently (read `ChangeLog` actor/recency).

### Safety model
- **Bounded writes per run** (a hard cap) — never a big autonomous dump.
- Every write already flows through `ChangeLog` (snapshot + rollback) tagged `actorType: 'mcp'`, so the
  routine's work is fully audited and one-click reversible.
- For **Daniel's own instance**, direct writes are fine (he owns it, it's tracked and reversible). The
  **product** version writes to the Phase-7 *proposed/draft* state instead — same routine, different
  sink. This routine is the prototype of that pipeline.

### Cadence
Encode the window in the cron expression; don't fire around the clock and no-op (every no-op fire
still spins a full session). Propose a conservative default — e.g. **twice daily inside a working
window** — plus a cheap in-task window check as a safety net for burst catch-up after sleep.

### Debug logging (built in from the start, tiered)
- **light** (default): each run logs the unit of work chosen, *why* (which trigger fired), what it
  wrote, and the resulting `ChangeLog` ids — enough to answer *what changed, when, and why*.
- **normal**: per-candidate scoring (which entities/questions were considered and skipped).
- **verbose**: full MCP request/response payloads. Opt-in, short sessions.

### Effort — auto-writer
~**1–2 days** to stand up (routine prompt + priority logic + caps + logging). Runs in parallel; not on
the launch critical path.

### Blockers / inputs needed before it can be switched on
1. The **kol-emet MCP server must be reachable** (it failed to connect this session:
   `CONNECTION_CLOSED`) and the connector authorized (`Settings.mcpUserId` set, `MCP_BEARER_TOKEN`
   configured for the routine).
2. **Cadence** (how often + window) and **per-run write cap** — Daniel's call.
3. **Scope** — confirm World Train only.
4. Confirmation to create standing automation that writes to the live wiki.

---

## Part C — Critical path to a worldbuilding launch

The key realization: **the fastest path to marketing to worldbuilders does not go through Phase 6.**
The engine already fits the domain. What a worldbuilder needs to *see and trust* is the graph, the
relationships, and the "talk to it / it writes itself" magic — plus the basics of a real multi-user
product.

### On the critical path
| Work | Days | Notes |
|------|------|-------|
| **`workspaceId` enforcement** (per-user data isolation in every query) | 3–5 | The real blocker for *public* signups; touches every query + tests. Highest risk. |
| **Onboarding + template seed on signup** (worldbuilding starter) | 2–3 | New user can't land on a blank wall; seed types + a few starter entities + empty states. |
| **Generator v1** (braindump → proposed entities/relationships, approval diff) | 4–6 | The differentiating demo — the hook. |
| **Polish** (Phase 5: detail panel, gallery images) + empty states | 2–3 | |
| **Landing site + product name + copy** | 2–4 | Branding under Steadfast Code. |
| **Critical-path total** | **~13–21 days** | |

### Off the critical path (parallel or fast-follow)
- Phase 6 entity types + templates (~4–5 d) — needed for the *architecture* expansion, not this launch.
- Auto-writer routine (~1–2 d) — dogfood + demo content, runs alongside.
- Billing — can launch a **free beta** without it.

### Calendar translation
~13–21 focused build-days. Solo and part-time (Claude Code-accelerated), that's realistically
**~6–10 weeks** to a **public worldbuilding beta**; a **private/invite beta** (skip landing polish and
some onboarding) is reachable in **~3–4 weeks**. Biggest schedule risks: `workspaceId` enforcement
(easy to get subtly wrong — needs care + tests) and generator output quality (the demo lives or dies
on it).
