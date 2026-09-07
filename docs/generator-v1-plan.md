# Generator v1 — implementation plan

Braindump text → proposed graph → human-approved diff → applied entities.

Produced 2026-09-03 by a design panel: four independent designs (shippable-first,
data-model-first, review-ux-first, pipeline-generality), scored by three judges on separate lenses
(constraint compliance, shippability, product strength), then synthesised. Aggregate ranking:
shippable-first 8.2, data-model-first 7.7, review-ux-first and pipeline-generality below.

**Estimated 6 focused build-days across 9 steps, each leaving the app working.**

---

## The spine

One new collection (`Draft`, items embedded), one generation lib, one applier, one route file,
one full-screen Vue overlay. Generation uses plain-JSON prompting through the parse ladder already
proven in `server/src/lib/memoryExtractor.js` — **never forced `tool_choice`**. Review decisions are
recorded by `PATCH` and are strictly separate from a single explicit Apply. Apply reuses
`Entity.create`, `RelationshipGroup.create`, the `$addToSet` back-reference and `logCreate`/`logUpdate`
verbatim rather than growing a parallel write stack.

**Why this shape won:** it refuses things. It declines to extract shared write helpers out of
`entities.js`/`relationshipGroups.js`, declines to rewrite `changeLogger`'s signature, declines to
stream items into the UI. The rival designs each took on three-plus refactors of already-working
code that buy zero v1 functionality while putting the app's primary write path under test days
before the demo it exists to enable.

The second reason is concrete rather than stylistic: `aiProviders.js` routes `claude` through
Anthropic's OpenAI-compat baseURL and `gemini` through Google's. Designs betting their
structured-output tier on forced `tool_choice`/`response_format` rely on shims that handle those
unevenly. Plain-JSON-plus-parse-ladder is the one path that cannot fail to at least *run* on all six
registry entries — which is what the model-agnostic constraint actually demands.

## Where the winning design was overruled

1. **The SSE broadcaster leak** — it proposed knowingly shipping the existing behaviour. Not
   acceptable; generation amplifies it ~20x. **(Already fixed, commit `0367f08`.)**
2. **The review editor** — it used an inline 5-field form. That loses the highest-value fine-tune
   signal, so the real `EntityEditor` is used for the edit path instead.
3. **Server-side fuzzy dedup** — its client-only Fuse.js plan cannot drive "accept all clean".
4. **The missing `{workspaceId, title}` index on Entity** — `Entity.js` declares no indexes at all,
   while `RelationshipGroup`, `OpenQuestion` and `ChangeLog` all index `workspaceId`.

## Data model

One new model, `server/src/models/Draft.js`, with items embedded. **No TTL anywhere on it** —
`ChangeLog` expires after 30 days because it is undo; `Draft` *is* the training corpus and must be
permanent. `DELETE` is a soft `status: 'discarded'`; hard deletion belongs only to an
account-deletion path.

`workspaceId` is `required: true` — unlike `Entity.js`, which uses `default: null` to accommodate
pre-tenancy rows. A new collection has none, so it fails closed from row one.

Each item carries the fine-tune triple as three separately-written parts:

- **`input`** — evidence quote plus `charStart`/`charEnd` computed **server-side** by `indexOf`
  against the source text (models get offsets wrong; they can copy a quote), and the context entity
  ids the model was shown.
- **`proposed`** — written at generation, post-validation, pre-human. Frozen thereafter.
- **`accepted`** — written at decision time. **Copied verbatim from `proposed` on a plain accept,
  never left null**, so the exporter is a single-pass map that stays correct if normalisation
  changes later.

The load-bearing split, grafted from the data-model-first design: the **human label**
(`decision`, `decisionVia`, `decidedBy`, `decidedAt`, `accepted`) is written *only* by `PATCH`, and
the **system outcome** (`applyState`, `resultId`, `changeLogId`, `applyError`) *only* by the applier,
which rejects those keys if they appear in a `PATCH` body. An apply failure therefore cannot
overwrite the record that a human said yes.

**Rejection never deletes the row.** The negative example is the most valuable and the easiest to
lose. A user who reviews 20 items and then abandons the draft has still produced 20 labelled
examples, and they must survive — this is why `accepted` is written at decision time rather than at
apply time.

Proposed relationship members are stored in the `RelationshipGroup` **model** shape
(`{refId, refModel, label, notes}`), not the route's `{entityId}` shape, because `refModel` is the
discriminator that supports nesting when subgroup drafts land later. Members carry the `name` the
model actually emitted, so a member that fails to resolve is still explainable rather than silently
vanishing.

## Generation

Two narrow passes (entities per chunk, then relationships over the merged name list), temperature 0,
hard chunking so weak models never see too much at once. Per-item validation drops bad items rather
than failing the run, and **the drop count is surfaced in the UI** — "N items couldn't be used"
rather than silently showing 8 of 12.

Dedup is exact-normalised-title server-side (flips the item to `op: 'update'` with a staleness
baseline) plus a fuzzy candidate flagged as `duplicate_candidate` and **never auto-merged**.

## Review UX

Needs-attention-first ordering, per-item accept/reject/edit, a dependency cascade (rejecting an
entity greys out and unstages the relationships that depend on it, with a named reason), and a
constrained "accept all clean" that **refuses flagged items and reports how many it skipped** —
so bulk acceptance can never rubber-stamp the uncertain ones.

## Open questions for Daniel

1. ~~**Default generation route and spend.**~~ **Settled 2026-09-05.** A **total** allowance per
   workspace in micro-dollars, not a per-day or per-run cap: measured runs vary ~6x, so a run cap
   prices nothing. Default grant $3.50, no time limit. Generation is a capped trial; the non-AI
   product is free forever. Self-hosted is priced (cheaply) rather than free — it burns electricity.
   MCP is excluded, since Claude.ai runs that inference on the user's own subscription.
   **Still open:** with self-hosted priced, an exhausted allowance blocks it too, so the "generation
   gets slower rather than stopping" fallback needs its own decision. Deferred by Daniel.
2. ~~**Retention policy.**~~ **Settled 2026-09-05.** Account deletion **hard-deletes** drafts;
   signup **discloses** that reviewed generations may be used to improve the product, with **no
   opt-out on the free tier**. Neither is built yet — see Remaining work.
3. ~~**Product-facing name.**~~ **Settled 2026-09-05: "Draft".** The code originally said
   `Proposal` while the UI was to say "Draft"; Daniel chose to make them match rather than let the
   two drift, so the model, routes and collection were all renamed to `drafts`. The Decision Log's
   "pull request against the graph" framing stays as the *concept*, since it is the right one for
   the software-architecture expansion — it is just not the user-facing word.
4. ~~**Input ceiling.**~~ **Settled 2026-09-05: 25,000 characters** ("25k fine for now"). The job
   queue that uncapped input would need is a later milestone, not a v1 blocker.
5. **Source-coverage pane.** The judge on product strength rated "here is the text I did *not* use"
   the single strongest trust signal in any design, and the data ships in v1 either way. Agreed in
   scope; **not built** — see Remaining work.

## Remaining work

v1 is complete: braindump or imported file → generated draft → per-item review → apply → entities in
the graph, with the full decision record exportable as training data. What was agreed but is not yet
built:

- **Source-coverage pane** (item 5 above). The evidence offsets it needs are already stored.
- **Open-question item kind in generation.** The applier handles `open_question` items; the
  generator does not emit them yet.
- **Account-deletion hard delete** and the **signup disclosure copy** (item 2 above).
- **Post-trial self-hosted fallback** (item 1 above).

## Build sequence

| # | Step | Leaves app working |
|---|------|--------------------|
| 1 | Tenancy + plumbing prerequisites (SSE fix, Entity index, shared categories config, ChangeLog `generator` actor + origin, similarity extraction) | yes |
| 2 | `Draft` model + read-only routes (GET/GET:id/soft DELETE) | yes |
| 3 | Generation pipeline, CLI-testable before any route exists | yes |
| 4 | `POST /drafts` as SSE | yes |
| 5 | Decision routes — human label, zero graph writes | yes |
| 6 | The applier + `POST /apply` | yes |
| 7 | Client API + input screen | yes |
| 8 | Review UI | yes |
| 9 | Export proof + docs + Decision Log entries | yes |

**All nine steps are built and verified as of 2026-09-06.**

Step 3 is CLI-testable deliberately: `scripts/try-generate.js <workspaceId> <file>` runs the whole
pipeline and prints the would-be Draft without touching a route or saving anything, so prompt
quality can be tuned against both a frontier model and `steadfast/qwen2.5-coder:14b` before any
persistence exists.

Step 9's export script is written as *proof the capture is complete* — if the exporter needs a join,
the schema is wrong, and that is the moment to find out.
