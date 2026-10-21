# FEATURES.md — kol-emet workqueue

This file is the ONLY source of automated work for kol-emet: an unattended hourly routine takes the first unchecked item under
Workqueue Items, implements exactly that one item, verifies it with the commands the item names, opens a PR, merges to `main`, and
moves the item to Completed Items. Priority is file position — nothing else. Ids are permanent and never renumbered; new items
continue the sequence. Every item serves the public multi-tenant product (CLAUDE.md): nothing here simplifies auth, gates
registration, or removes a feature.

## Workqueue Items

- [ ] **(KOL-047) Bridge error handling, logging and reconnect** [needs-human]
  Filed after the chat side broke: `bridge_poll` returned repeated bare HTTP 400 "missing or invalid
  session ID" while `bridge_send` still worked, then send started failing the same way — the reply
  channel lost valid session context with no retry, no fallback and no visible logging. Three parts.
  (1) Structured server-side logging of every failed bridge request in `server/src/routes/bridge.js`
  and `mcp.js`: one JSON record with tool name, caller, status, and why the session id was rejected —
  never issued, expired, unknown to this process, stateless-server mismatch. (2) Graceful error
  responses instead of bare 400s: a JSON-RPC error body with a machine-readable code and a sentence
  the client can show, so the chat side can tell re-handshake-and-retry from your-token-is-wrong.
  (3) Retry/reconnect on the channel in `orchestrator/lib/bridge.js`, and log each reconnect to
  `bridge.jsonl` so a silent channel is visible afterwards. Note: the box-side client already got
  part of (3) in steadfast-ai commit 4beeedb, and kol-emet e232b8d made `/bridge/mcp` stateless and
  `/mcp` answer unknown sessions with 404 + JSON-RPC -32001; the remaining work is the structured
  logging and the error-body shape across both endpoints.

- [ ] **(KOL-012) GitHub Actions CI running both test suites and the client build** (needs KOL-003, KOL-010) [needs-human]
  Create `.github/workflows/ci.yml`: on push + pull_request, ubuntu-latest, Node 22 via `actions/setup-node` with yarn caching; job
  `server` = `yarn install --frozen-lockfile && yarn test` in `server/`; job `client` = the same plus `yarn build` in `client/`.
  Cache `~/.cache/mongodb-binaries` so `mongodb-memory-server` downloads once. Verify: `gh pr checks` on the routine's own PR shows
  both jobs green before merge. Out of scope: deploys, branch protection (a repo setting Daniel must flip — flag it in the PR).
  needs-human because `.github/**` is denylisted for automated runs (a run may never add or edit its own CI); Daniel adds this one.




- [ ] **(KOL-013) Refresh dependencies against the 50 open Dependabot advisories** (needs KOL-004, KOL-010, KOL-012)
  `yarn upgrade` within existing semver ranges in `server/` and `client/`; keep the `qs` 6.16.0 pin and express 4 (`_comment_qs_pin`
  in `server/package.json`); no major bumps. Verify: `yarn audit --level high` count drops, both `yarn test` suites and `yarn build`
  green, `yarn start` boots. Proposed because an unattended dependency refresh deserves one explicit nod from Daniel even with tests.








- [ ] **(KOL-109) Backlog audit: file new candidates under Proposed** [not-before: 2026-10-27]
  A standing upkeep item, last on purpose: it runs only when nothing above it is claimable. Candidate sources, in
  order: `docs/roadmap.md`, `docs/build-plan.md`, `docs/generator-v1-plan.md` "Remaining work", `docs/wishlist.md`,
  the Decision Log in `kol_emet_spec.md`, the outcomes under Completed Items and the review files under
  `ops/routine/reviews/`, and TODO/FIXME comments. For every candidate grep the code and `git log` and confirm it
  is NOT built before filing it; re-proposing a shipped feature is the failure this item exists to prevent. File
  3–8 items under `## Proposed` in this file's exact format (next free ids, never reuse one): a one-line title,
  then an indented body with what to build, the files involved, the verify commands, and what is out of scope.
  Every item must serve the public multi-tenant product (CLAUDE.md). Tag every filed item `[proposed]` — Daniel
  promotes one by deleting the tag, and the daily update lists them. Skip anything needing a credential, a paid
  generator run, an Atlas index change or a product decision unless the item IS that decision. Then renew this
  item: append a copy of this block at the bottom of `## Workqueue Items` with the next free id and the tag
  `[not-before: <today + 7 days as YYYY-MM-DD>]`, so it runs weekly. The PR touches only FEATURES.md. Verify:
  `node <orchestrator> lint kol-emet --worktree` exits 0 (the `<orchestrator>` path is the one this runbook names
  for `diff-policy`).

- [ ] **(KOL-103) Nothing enforces a role on a content write: a viewer may edit, delete and spend**
  `Workspace.members[].role` is `owner | editor | viewer` (`server/src/models/Workspace.js:15`), `resolveWorkspace`
  reads it onto every request and `GET /workspace` hands it to the client "so it can hide what an editor or a viewer may
  not do" (`server/src/middleware/workspace.js:87`), and `requireWorkspaceRole` has existed since KOL-071 — gating
  exactly two routes, `PATCH /workspace` and `POST /import`. Every other write is ungated: 32 of them, across
  `/entities` (3), `/relationship-groups` (9), `/open-questions` (3), `/entity-types` (3), `/relationship-types` (3),
  `/tags` (2), the rollback in `server/src/routes/changelog.js` (1) and `/drafts` (8, one of which spends the
  workspace's AI allowance). The Decision Log records why it was left — role enforcement on the content routes has
  "nothing to enforce against while every workspace has exactly one member" — and collaborator invites are the
  roadmap's next commercial step, so this is the gate that has to exist before the first invite rather than after it.
  Build: `requireWriteRole` beside `requireWorkspaceRole` in `server/src/middleware/workspace.js` — a pass-through for
  `GET`, `HEAD` and `OPTIONS` and `requireWorkspaceRole('editor')` for every other method, the same
  unsafe-methods-only shape `originGuard` uses (`server/src/middleware/originGuard.js:148`) — mounted once per content
  router in `server/src/app.js`, so a route added to one of those routers later inherits the gate instead of having to
  remember it. The refusal stays `403 { error: 'NOT_WORKSPACE_EDITOR' }`, a code the client already branches on. `/mcp`
  is the hole that would otherwise remain: its tools scope themselves through `mcpWorkspaceId()`
  (`server/src/lib/mcpWorkspace.js:16`) and never pass through this middleware, so a viewer who authorized the
  connector would keep full write access — have `mcpWorkspace.js` return the membership role it already loads and
  refuse the write tools with a tool error naming it. `POST /import` keeps its owner gate; `GET /export` stays open to a
  viewer, because reading is what a viewer is for. Files: `server/src/middleware/workspace.js`, `server/src/app.js`,
  `server/src/lib/mcpWorkspace.js`, `server/src/routes/mcp.js`, a role column in `docs/api.md`, and a Decision Log line
  recording editor as the write floor. Verify: a new `server/tests/http/writeRole.test.js` — one workspace seeded with
  an owner, an editor and a viewer; for every write route named above the viewer is 403 `NOT_WORKSPACE_EDITOR` and the
  collection is unchanged afterwards, while the editor and the owner succeed; every `GET` answers 200 for all three; the
  route list is derived from the mounted routers rather than retyped, so a router added later without the gate fails the
  test; `POST /drafts` refuses a viewer before any allowance is read (`aiBudget.spentMicros` unmoved); the MCP write
  tools refuse a viewer while its reads answer; and `server/tests/http/tenancy.test.js` and `workspace.test.js` pass
  unchanged, because isolation is what this must not weaken. `cd server && yarn test` green; the client is untouched,
  since `GET /workspace` already carries the role. Out of scope: inviting or removing members and the routes that needs;
  any matrix finer than read-versus-write — an owner-only floor for AI spend, for instance, which is a pricing decision
  nobody has made; the `/bridge` endpoints, which carry their own token and no workspace role; and hiding buttons in the
  client, which already has the role and is its own UX item.

- [ ] **(KOL-088) OAuth logs the authorization code, the PKCE verifier, and every code still outstanding**
  `server/src/routes/oauth.js` is the one router with no tiered logging, and it prints credentials unconditionally.
  `POST /oauth/token` logs its whole form body at `:133` — the one-time `code` and the `code_verifier`, which is the
  PKCE secret — and a miss at `:148` logs the submitted code plus `[...authCodes.keys()]`, every code still outstanding
  for every user, while `:156` logs the computed and the stored challenge. Each of those codes is redeemable for
  `MCP_BEARER_TOKEN`, the workspace-wide write token, by anyone who can read the log, and on a hosted deployment the log
  is the deploy console. `GET /authorize` (`:44`) and `POST /authorize` (`:99`) print their whole query and body too, so
  `redirect_uri` and `state` land there as well. Second defect, same file: `authCodes` (`:25`) is a `Map` whose
  `expiresAt` is only ever read at redemption, so a code nobody redeems is never removed and `POST /authorize` grows the
  map without bound. Build: `OAUTH_LOG_LEVEL = off | light | normal | verbose` (default light) in the shape the rest of
  the server uses (`middleware/workspace.js`, `routes/changelog.js`), with no secret at any tier. Light says the source
  of each decision — the route, the grant type, the rule that refused it, and a code's first 8 hex of SHA-256 rather
  than the code, so two lines can be tied to one exchange without either being redeemable; normal adds issue and redeem
  with that fingerprint and the outstanding count; verbose adds `redirect_uri` and `resource`, and still never a code, a
  verifier or a challenge. Plus the sweep: drop expired entries whenever one is issued, and cap the map, refusing a new
  authorization with 503 rather than growing past it. Files: `server/src/routes/oauth.js`,
  `server/tests/http/oauth.test.js` (extend), and the `/oauth` rows in `docs/api.md`. Verify: in
  `server/tests/http/oauth.test.js`, capture `console.log` across a full authorize-then-token exchange and assert the
  captured text contains neither the code, the verifier nor the challenge, while the fingerprint and the chosen rule are
  present; a second pending code is not printed by a failed exchange; an expired code is gone after the next issue,
  asserted through the refusal rather than an exported internal; and the happy path still returns the token, so logging
  cannot have changed the protocol. `cd server && yarn test` green; the client is untouched. Out of scope:
  `server/src/routes/bridge.js`, which runs its own issuer and its own token and is not edited here — oauth.js's
  existing resource branch keeps its behaviour; per-connector tokens and the shared `MCP_BEARER_TOKEN` (KOL-014's
  subject); the ten-year `expires_in`; and a `redirect_uri` allowlist or client registration, which needs a
  deployment-config decision nobody has made.

- [ ] **(KOL-093) A deploy kills in-flight requests and every live stream: handle SIGTERM**
  `server/src/index.js` connects, listens, and installs no signal handler, so the SIGTERM a host sends at every deploy
  takes the process down mid-request: a write caught between its Mongo call and its `ChangeLog` append is cut in half,
  and every open `GET /events` stream dies at the socket with no close frame, which
  `client/src/composables/useEvents.js` can only read as a network error rather than a planned end. The broadcaster
  already has the pieces for a clean ending — `endStream` writes a reason and `closeStreamsForSession` and
  `closeStreamsForUser` use it (`server/src/lib/broadcaster.js:166,196,218`) — there is simply nothing that ends them
  all. Build `server/src/lib/shutdown.js`: one function taking the HTTP server, a stream-closer and a disconnect,
  running them in order — stop accepting connections (`server.close`), end every open stream with a reason a client can
  reconnect on, wait for in-flight requests up to `SHUTDOWN_GRACE_MS` (default 10000), disconnect Mongoose, resolve —
  and force-exit when the grace period expires, because one hung request must not hold a deploy open. Add
  `closeAllStreams(reason)` to the broadcaster beside the two closers it already has. `index.js` wires SIGTERM and
  SIGINT to it idempotently, so a second signal cannot start a second shutdown. Tiered `SHUTDOWN_LOG_LEVEL = off | light
  | normal | verbose` (default light): light names what started it — which signal — and the result of each stage,
  because a shutdown leaves nothing behind to inspect afterwards. Files: `server/src/lib/shutdown.js` (new),
  `server/src/lib/broadcaster.js`, `server/src/index.js`, a paragraph in `docs/architecture.md`, and a Decision Log line
  for the force-exit. Verify: a new `server/tests/unit/shutdown.test.js` — the stages run in order and each is awaited;
  an in-flight request that finishes inside the grace period is waited for and one that does not is abandoned at the
  deadline with the force-exit path taken; a second signal is ignored while the first shutdown is running; and a stage
  that throws does not stop the stages after it, since a failed disconnect must not be what keeps the process alive.
  Plus a broadcaster case that `closeAllStreams` writes its reason to every open stream and leaves the registry empty.
  All of it driven through injected fakes — no real listener, no real signal, nothing that could end the test runner's
  own process. `cd server && yarn test` green; the client is untouched. Out of scope: zero-downtime handover or any
  overlap between an old and a new instance, which is the platform's concern and not the app's; the host's healthcheck
  setting; draining a generation run already in flight, whose budget lock already goes stale on its own after ten
  minutes; and `process.on('uncaughtException')`.

- [ ] **(KOL-102) Live sync misses every bulk write: an apply and an import reach no other client**
  `POST /drafts/:id/apply` broadcasts one `draft:applied` frame to every stream in the workspace except the one that
  asked (`server/src/routes/drafts.js:682`), deliberately in place of a burst of per-entity events — the applier passes
  `broadcast: false` and `server/src/lib/changeLogger.js:56` says why. Nothing listens for it: `useEvents`
  (`client/src/composables/useEvents.js`) registers `client:id`, `entity:created`, `entity:updated` and
  `entity:deleted` and nothing else, so the frame reaches only clients that drop it, while the tab that applied
  refreshes itself through `onDraftApplied` (`client/src/components/WikiLayout.vue:428`). A 30-item apply is therefore
  invisible in every other tab until a reload. `POST /import` is the same hole without the frame: it writes a whole
  graph and broadcasts nothing at all, and its own tab reloads at `WikiLayout.vue:541`. Second defect, same file: when
  the server ends a stream on purpose it writes `event: error` with `{ error: 'session-ended' }` or
  `{ error: 'too-many-streams' }` first (`server/src/lib/broadcaster.js:166,201`, `server/src/routes/events.js:39`),
  and `useEvents` cannot tell that from a dropped socket — `es.onerror` closes and re-dials every 3000 ms forever, so a
  tab whose session was revoked, or one that tripped the per-session stream cap, retries a refusal for as long as it
  stays open. Third: every frame is `console.log`ged with its whole payload, entity bodies included, in the one client
  module with no tier (compare `ENTITY_LOAD_LOG_LEVEL`, `client/src/composables/useEntities.js:5`). Build: a
  `draft:applied` and a `workspace:imported` listener that call `loadEntities(<reason>)` naming the source the way the
  existing handlers do, plus a toast through `addToast` so a user sees who changed what; the
  `broadcast('workspace:imported', …)` call in `server/src/routes/import.js` beside its per-collection counts. Then the
  reconnect: read `e.data` on the error path — a frame the server wrote is a stop and not a retry, so `session-ended`
  ends the loop and surfaces "signed out elsewhere", `too-many-streams` ends it naming the limit, and a transport
  failure still retries but with a growing, jittered, capped delay. Tiered
  `localStorage.SSE_LOG_LEVEL = off | light | normal | verbose` (default light): light names each connect, each ending
  with the source that caused it — which frame, or which transport failure — and each reconnect with its attempt number
  and delay, and carries no payload; normal adds the event name and the entity id; verbose adds the frame. Files:
  `client/src/composables/useEvents.js`, `client/src/components/WikiLayout.vue`, `server/src/routes/import.js`, a new
  `client/src/composables/useEvents.test.js`, and the `/events` section of `docs/api.md`. Verify: the new Vitest suite
  against a fake `EventSource` — a `draft:applied` frame reloads once and toasts once; a `workspace:imported` frame does
  the same; a server `error` frame carrying `session-ended` schedules no reconnect and reports the reason;
  `too-many-streams` likewise; a transport error does reconnect, and successive delays grow rather than repeating
  3000 ms; and at the default tier no log line contains payload text. Plus a `WikiLayout.test.js` case that both new
  events reload the sidebar, and a `server/tests/http/import.test.js` case that an import sends one frame to another
  client in the same workspace and none to a client in another. `cd client && yarn test --run && yarn build` and
  `cd server && yarn test` green. Out of scope: relationship-group writes, which broadcast nothing either but have no
  ChangeLog and so need an event vocabulary of their own; replacing the apply's single frame with per-entity events;
  replaying what a disconnected client missed, and `Last-Event-ID` resumption; and the `/chat` SSE stream, which is a
  different channel with its own client.

- [ ] **(KOL-089) Third vertical-ingestion producer: Kubernetes manifests become a reviewable Draft**
  `docs/roadmap.md` Phase 7 names "repo / OpenAPI / docker-compose / k8s / DB-schema"; KOL-033 built compose, KOL-051
  built OpenAPI and put k8s out of scope, and `server/src/models/Draft.js:114` marks the seam — "drift / repo / k8s
  become new enum values here rather than new collections". Like both existing producers this is deterministic: no model
  call, so no allowance check and no generation lock, which is the property that makes a producer safe to re-run. Build
  `server/src/lib/producers/kubernetes.js` exporting the contract `fileProducerRoute` already takes
  (`server/src/routes/drafts.js:291`) — `PRODUCER`, `PRODUCER_VERSION`, `parse`, a `ParseError` and a character cap —
  mapping into the Software Architecture vocabulary (`server/src/config/templates.js`): a `Deployment`, `StatefulSet` or
  `DaemonSet` becomes a Service, or a Data Store when its image matches the known-image list the compose producer
  already has (imported from it, not copied); a `Service` object becomes an "Exposes" group between the workload its
  selector matches and an API titled for the port; a `PersistentVolumeClaim` becomes a Data Store; an env var or
  `envFrom` whose URL host names another workload becomes "Calls", and one that names nothing in the file becomes an
  External Dependency plus "Depends on". Multi-document YAML (`---`) is the normal shape of a manifest and is the unit
  of iteration. Evidence quote and source offsets per item as both other producers do, and `redactSecrets` before the
  source text is stored — a `Secret`'s `stringData` is exactly what must not reach a corpus that has no TTL. Register
  it: `'kubernetes'` in the `source.producer` enum (`server/src/models/Draft.js:117`), one `fileProducerRoute` call for
  `POST /drafts/kubernetes`, `createKubernetesDraft` in `client/src/api/drafts.js`, and a third branch in `producerFor`
  (`client/src/lib/importFile.js:73`) keyed on `apiVersion` plus `kind`, because a manifest and a compose file are both
  `.yaml` and the extension cannot choose. Files: the new producer, `server/src/routes/drafts.js`,
  `server/src/models/Draft.js`, `client/src/api/drafts.js`, `client/src/lib/importFile.js`,
  `client/src/components/generator/BraindumpInput.vue` (the accept list and its copy), a new
  `server/tests/fixtures/kubernetes.yaml`, `docs/api.md`, and a Decision Log line for the mapping. Verify: a new
  `server/tests/unit/kubernetes.test.js` — the fixture's workloads, services and claims map as documented; a file with
  several `---` documents yields items from every one of them; a `Secret`'s values never appear in the draft's stored
  text; a document whose `kind` is unrecognised is a recorded drop reason and not a 500; and the same file parsed twice
  yields the same items, with the second run dedupping against the graph. A new
  `server/tests/http/kubernetesDraft.test.js` mirroring `openApiDraft.test.js` — 201 with a `ready` draft, no allowance
  spent, an over-size body refused, and no workspace nameable but the caller's own. `cd server && yarn test` and `cd
  client && yarn test --run && yarn build` green. Out of scope: Helm charts and kustomize overlays, which are templated
  input and their own problem; reading a live cluster or any kubeconfig; the repo and DB-schema producers; drift
  detection; and any change to either existing producer's mapping.

## Proposed

- [ ] **(KOL-014) Per-user MCP identity instead of the global Settings.mcpUserId singleton** [needs-human]
  Today `POST /authorize` (`server/src/routes/oauth.js`) overwrites the single `Settings.mcpUserId` and `/oauth/token` hands every
  connector the same `MCP_BEARER_TOKEN` — a second user authorizing the Claude.ai connector re-points everyone's MCP traffic at their
  own workspace; `resolveUserId` in `server/src/middleware/workspace.js` inherits the same limit for `BEARER_TOKEN`. Proposal:
  per-authorization opaque tokens stored with `userId` + `workspaceId`, resolved by the `/mcp` middleware and `requireAuth`; env tokens
  keep working during migration. Design approval first (storage, rotation, re-authorization UX), then 2–3 workqueue items; verify with an extended `mcp.test.js` where A and B each authorize and see only their own entities.
- [ ] **(KOL-016) Emit `open_question` items from the generator** (needs KOL-009) [needs-human]
  The applier and `validateItemPayload` already handle kind `open_question`; `server/src/lib/generatorPrompts.js` and `normalizeDraft`
  (`server/src/lib/draftNormalizer.js`) do not emit it (`docs/generator-v1-plan.md`, Remaining work). Add the prompt section plus a
  raw open-question schema in the normalizer with a fixture-based unit test. Tagged because final verification is a paid run of
  `server/scripts/try-generate.js` against Daniel's allowance.
- [ ] **(KOL-017) Source-coverage pane in the draft review UI** [needs-human]
  "Here is the text I did not use": evidence offsets are already stored on draft items; render the uncovered spans of the source
  alongside `client/src/components/generator/DraftReview.vue`. Agreed in scope; needs UI judgement.
  Verify: a Vitest test that a fixture draft with one evidence span marks the remainder as uncovered.
- [ ] **(KOL-018) Post-trial self-hosted fallback** [needs-human]
  An exhausted allowance blocks `steadfast` runs too (`checkBudget`, `server/src/lib/usageMeter.js`). Deferred by Daniel — options:
  a separate self-hosted allowance, a slower free lane, or stay blocked. Decision first; then a small metered change with a
  `usageMeter` test.
- [ ] **(KOL-019) Lift the ChangeLog 30-day TTL for versioned workspaces** [needs-human]
  `server/src/models/ChangeLog.js` indexes `createdAt` with `expireAfterSeconds` = 30 days; the Decision Log says history cannot
  expire once versioning is the product. Needs a data decision (per-workspace flag, partial TTL index, or archive collection) — an
  Atlas index change is not something a migration script alone should decide.

- [ ] **(KOL-090) Which workspace a request acts in is whatever findOne returned: list them, and choose one explicitly** [proposed]
  `resolveWorkspace` picks the acting workspace with `Workspace.findOne({ 'members.userId': userId })` and no sort
  (`server/src/middleware/workspace.js:97`), under a comment that says it plainly: "A user may later belong to several;
  today registration creates exactly one." For a product whose roadmap has collaborator invites next, that line is the
  gate in front of them — the moment a user is in two workspaces every request resolves to whichever document the server
  happened to return first, so one session can read workspace A and then write workspace B, and `GET /workspace` can
  report a name the content did not come from. Nothing lists a user's workspaces either, so a client cannot show the
  choice, let alone change it. Build: `GET /workspaces`, every workspace the caller is a member of in the existing
  `workspaceBody` shape (`_id`, `name`, `role`, `createdAt`), sorted by `createdAt` then `_id` so the order is total.
  Make the choice explicit session state: `POST /workspaces/:id/select` checks membership and writes
  `req.session.workspaceId`; `resolveWorkspace` prefers that id and re-checks the membership on every request, and when
  the id is stale — the membership was revoked — it falls back to the default rather than answering 403, so losing
  access to one workspace cannot lock a user out of their own. The default is deterministic: the oldest workspace the
  caller owns, else the oldest they are a member of. The MCP path keeps `resolveUserId`'s bearer identity and takes that
  same default, since a connector carries no session to hold a choice in. Files: `server/src/middleware/workspace.js`,
  `server/src/routes/workspace.js`, `server/src/app.js` (the `/workspaces` mount), `client/src/api/workspace.js`, the
  Settings area of `client/src/components/WikiLayout.vue` (a switcher, shown only when there is more than one),
  `docs/api.md`, and a Decision Log line recording that the choice is session state and the fallback is
  ownership-then-age. Verify: a new `server/tests/http/workspaceSelect.test.js` — a user seeded into two workspaces
  resolves the same one on twenty consecutive requests; selecting the second moves `GET /entities`, `GET /workspace` and
  a write together; selecting one the caller is not a member of is 404 and changes nothing; a selection whose membership
  is then removed falls back instead of refusing every request; one user's selection does not affect another's; and
  `server/tests/http/tenancy.test.js` passes unchanged, because isolation is the thing this must not weaken. Plus a
  `WikiLayout.test.js` case that the switcher is absent for a one-workspace user. `cd server && yarn test` and `cd
  client && yarn test --run && yarn build` green. Out of scope: inviting or removing members and the email delivery that
  needs — the roadmap's own next step; creating a second workspace from the UI (the tests seed the second directly, and
  this item is the prerequisite rather than the feature); per-workspace billing; and any change to what a role may do,
  so `requireWorkspaceRole` is untouched.

- [ ] **(KOL-091) A chat belongs to a user but is answered from a workspace, and nothing ties the two together** [proposed]
  `GET /conversations` lists by `userId` alone (`server/src/routes/conversations.js:26`) even though the router is
  mounted behind `resolveWorkspace`, and `POST /chat` loads a conversation by `{ _id, userId }`
  (`server/src/routes/chat.js:343`) and then answers it out of the caller's *current* `req.workspaceId`: the graph tools
  read that workspace (`chat.js:189,206`) and the spend is billed to it (`:422`). `Conversation.workspaceId` is stamped
  at creation and read by nothing — `conversations.js:47` says as much. `UserMemory` has no workspace at all
  (`server/src/models/UserMemory.js:7`), so a fact extracted from one workspace's chat is loaded into another's system
  prompt (`memoryExtractor.js:130,148`). None of this is visible today, because every user has exactly one workspace; it
  becomes visible the moment KOL-090's switcher exists, which is why it is filed alongside it rather than after the bug
  report. Build: filter the conversation list and every by-id lookup on `workspaceId` as well as `userId`, so a chat is
  reachable only from the workspace it was created in; add `workspaceId` to `UserMemory` with the `ownerGuard` the other
  scoped models carry (`{ path: 'workspaceId', owner: Workspace }`), write it in `extractAndSaveMemories`, and filter
  `loadMemories` by it. Rows written before this carry `workspaceId: null`: read a null as belonging to the caller's
  current workspace so nobody loses their history, and record that rule in the Decision Log rather than shipping a
  migration that has to guess which workspace a row meant. Files: `server/src/routes/conversations.js`,
  `server/src/routes/chat.js`, `server/src/models/UserMemory.js`, `server/src/lib/memoryExtractor.js`,
  `server/src/lib/accountDeleter.js` (`UserMemory` joins the workspace-scoped list, whose completeness its own test
  already asserts), `docs/data-model.md`, `docs/api.md`, and the Decision Log line. Verify: a new
  `server/tests/http/conversationScope.test.js` — for one user in two workspaces, a conversation created in the first is
  absent from the list in the second and answers 404 to `GET`, `PATCH`, `DELETE` and `POST /chat` there; a memory
  extracted in the first does not reach the second's prompt; a legacy row with `workspaceId: null` is still readable and
  still listed; and the account-deletion sweep still removes both models. `cd server && yarn test` green; the client
  changes only if a 404 it did not expect needs handling. Out of scope: moving a conversation between workspaces,
  sharing one with another member, per-workspace memory limits, and pagination of the conversation list, which no item
  owns yet.

- [ ] **(KOL-092) Two list routes still answer with the whole workspace** [proposed]
  KOL-061 stopped `GET /entities` shipping every block and KOL-067 gave it keyset pages, but `GET /relationship-groups`
  still returns every group in the workspace with its full `members` array
  (`server/src/routes/relationshipGroups.js:78`) and `GET /open-questions` returns every question with `entry_ids`
  populated (`server/src/routes/openQuestions.js:18`) — one query, no limit, and for the second a populate per row. At
  the size this product is built for those are the two slowest responses in the API, and the graph view asks for the
  whole group list the moment it opens. The caps elsewhere are the pattern to follow: `changelog.js:99` takes 50,
  `drafts.js:90` takes 50, and `/entities` pages. Build: the same keyset contract `/entities` answers with
  (`server/src/routes/entities.js:98-132`) on both routes — `?limit=` clamped to the route's own minimum and maximum,
  `?after=` carrying the previous page's last `_id`, and `{ items, nextAfter }` — ordered by `_id`, so no new database
  index is needed, and keeping the bare-array answer for a request that sends no `limit` exactly as `/entities` kept it,
  so no existing caller breaks. Then the one client caller there is pages until `nextAfter` is null and concatenates:
  `getAllGroups` (`client/src/api/relationshipGroups.js:20`), whose only call site is the graph's loader
  (`client/src/components/GraphView.vue:341`), carrying the partial-failure surface KOL-083 added for the sidebar
  (`loadEntities`, `client/src/composables/useEntities.js:79-130`, is the pattern to copy) — a page that fails leaves a
  visible "stopped partway" state rather than a silently short list. `GET /open-questions` has **no client caller to
  change**: nothing under `client/src` fetches it — open questions reach the client already populated on entities by
  `GET /entities` — and the MCP `list_open_questions` tool queries `OpenQuestion` directly rather than through the route
  (`server/src/routes/mcp.js:260`), so that route is capped for the public API's sake and its only in-repo callers are
  its own tests. Files: `server/src/routes/relationshipGroups.js`, `server/src/routes/openQuestions.js`,
  `client/src/api/relationshipGroups.js`, the graph caller (`client/src/components/GraphView.vue`), `docs/api.md`, and
  the tests below; `client/src/composables/useEntities.js` is read for the paging pattern, not changed.
  Verify: new `server/tests/http/relationshipGroupList.test.js` and `server/tests/http/openQuestionList.test.js`
  mirroring `entityList.test.js` — a page is never longer than its limit; pages concatenate to the whole set with no row
  served twice and none skipped when a write lands mid-walk; an `after` naming another workspace's id yields nothing; a
  limit under the minimum or over the maximum is clamped rather than refused; and a request with no `limit` still gets
  the bare array. Client-side, a Vitest case that the graph's loader pages to the end and one that a failed second page
  surfaces the partial state. `cd server && yarn test` and `cd client && yarn test --run && yarn build` green. Out of
  scope: `GET /conversations`, which is per-user and short and whose filter KOL-091 is already changing; a MongoDB text
  index on block data, which is a change to the deployed database; the `/tags` aggregate; re-opening `/entities`' own
  contract; and building the client an open-question list view, which no item owns and which this item's cap does not
  need.

- [ ] **(KOL-104) Open questions are readable and nothing else: no client can add, answer or resolve one** [proposed]
  The `OpenQuestion` collection has full CRUD behind `/open-questions` (`server/src/routes/openQuestions.js`), a
  `?status=` filter, back-links maintained on both sides, two MCP tools (`add_open_question`, `list_open_questions`),
  and its own section in `docs/data-model.md`. The client reads them and nothing more:
  `client/src/components/EntityHeader.vue:21` renders `entity.open_questions` as static text, there is no
  `client/src/api/openQuestions.js` at all, and nothing under `client/src` fetches the route — the questions arrive
  already populated on `GET /entities`. So on a public product the "what don't I know yet" half of the data model can
  only be written by a user who has connected an AI client, and a question an agent raised can never be marked answered
  from the UI. The routes have no HTTP test either — there is no `server/tests/http/openQuestions.test.js` — so the
  contract the client would be built against is unpinned. Build: `client/src/api/openQuestions.js` wrapping the four
  routes with the `X-SSE-Client-Id` header the other API modules send (`client/src/api/entities.js:1`); in the entity
  detail panel, beside the list that is already there, an "Add a question" field, inline editing of the text, a
  resolve/reopen toggle that writes `status` and nothing else, and a delete — each rendering what came back rather than
  what was typed; and the badge counting open questions only, so a resolved one stops counting. Tiered
  `localStorage.OPEN_QUESTION_LOG_LEVEL = off | light | normal | verbose` (default light): light names every write with
  the question id, the field that changed and what asked for it, because a status write and a text write are otherwise
  indistinguishable after the fact. Files: `client/src/api/openQuestions.js` (new),
  `client/src/components/EntityHeader.vue`, `client/src/components/EntityDetail.vue`, cases in
  `client/src/components/EntityDetail.test.js` (which already carries open-question fixtures), a new
  `server/tests/http/openQuestions.test.js`, and the `/open-questions` rows in `docs/api.md` where they are thinner than
  the routes. Verify: Vitest with `fetch` stubbed — adding a question posts once with the open entity's id in
  `entry_ids` and renders the response; resolving sends `status: 'resolved'` and no other field; a failed write leaves
  the list as it was and says so rather than showing a question the server refused; the badge counts open only; a delete
  that answers 204 removes exactly one row. Server-side, the new suite covers the four routes end to end: a question
  created against an entity appears on `GET /entities/:id`, `?status=open` excludes a resolved one, another workspace's
  entity id is dropped from `entry_ids` rather than stored, a foreign question id is 404, and a delete removes the
  back-link from the entity. `cd client && yarn test --run && yarn build` and `cd server && yarn test` green. Out of
  scope: a workspace-wide open-question view and its paging, which KOL-092 leaves unclaimed and this item does not
  need; the generator emitting `open_question` items, which is KOL-016; Claude flagging a question as possibly answered
  (`docs/wishlist.md`); attaching one question to several entities from the UI, which the route supports and the panel
  has no shape for; and `requireActor` plus a ChangeLog trail on these writes, which this collection has never had.

- [ ] **(KOL-105) The assistant tells every workspace it is a world-building wiki** [proposed]
  `buildSystemPrompt` opens with "You are an AI assistant integrated into Kol Emet, a world-building wiki"
  (`server/src/routes/chat.js:54`) and the rest of that prompt talks about lore and invented content. Phase 6 shipped
  user-defined entity types and two templates, so a workspace seeded from Software Architecture
  (`server/src/config/templates.js:209`) holds Services, Data Stores, APIs and Teams — and its assistant is still told
  the subject is a wiki of worlds and warned not to invent lore. KOL-028 fixed the half of this that is data: the tool
  schema's category enum is built per request from `getCategories(req.workspaceId)` (`chat.js:388`). The prose was left,
  and the workspace's own name is not in the prompt either, though `PATCH /workspace` exists to set it. Build: derive
  the domain sentence from the request — the workspace's name and its entity-type names, from the same
  `getCategories(req.workspaceId)` call hoisted above the prompt build at `chat.js:351` and reused by the tool schema,
  so it stays one query. Where a workspace records which template seeded it, the prompt may use that template's own
  `description` (`templates.js:58,209`), which means persisting the key: `POST /auth/register` already receives it
  (`server/src/routes/auth.js:137`) and hands it to `seedWorkspace` (`:233`), and it is thrown away afterwards — store
  it as a nullable `Workspace.template` with no backfill, so a workspace from before this carries null and falls back to
  its type names. The instructions that are true of every domain stay exactly as they are — search before answering,
  never invent, cite names — and only the ones about fiction go. Files: `server/src/routes/chat.js`,
  `server/src/models/Workspace.js`, `server/src/lib/workspaceSeeder.js`, `server/src/routes/auth.js` (the one line that
  passes the key through), and a Decision Log line on the prompt being per-workspace. Verify:
  `server/tests/http/chat.test.js` already points the `steadfast` provider at a fake OpenAI-compatible server that
  records every request body, which is the only place the prompt is observable — add cases there: a workspace seeded as
  Software Architecture gets a system prompt naming its own types and no longer containing "world-building"; a
  worldbuilding workspace still reads as one; a renamed workspace appears under its new name; a workspace with no types
  at all falls back without leaving an empty list in the sentence; and one tenant's prompt never carries another's type
  names. `cd server && yarn test` green; the client is untouched. Out of scope:
  `server/src/lib/generatorPrompts.js`, whose wording is equally worldbuilding-shaped ("an author's rough notes") but
  whose only honest verification is a paid generation run; re-seeding or inferring a template for existing workspaces;
  the `save_memory` and MCP tool descriptions; and a per-workspace prompt a user can edit, which is a product decision
  nobody has made.

- [ ] **(KOL-106) The error-shape sweeps skip src/lib/producers, the one directory that publishes a caught message** [proposed]
  `server/tests/http/errorShape.test.js` is the guard that no router, middleware or lib hands a caught error's text to a
  caller, and both of its file walks are non-recursive: `writingFiles()` (`:610`) and `sourceFiles()` (`:625`) read
  `src/routes`, `src/middleware` and `src/lib` with a plain `readdirSync` and skip anything that is not a top-level
  `.js`. `src/lib/producers/` is therefore unswept — and it is exactly the code the sweep carves an exception out for,
  since the ParseError gate in the second test exists because a producer's own parse message is the one message a route
  may publish. So `producers/dockerCompose.js` or `producers/openApi.js` could return or store a caught
  `YAMLParseError` or a driver message and both sweeps would stay green; the `names.length >= 30` floor at `:695` cannot
  notice a missing subdirectory either. `parserSourceFiles()` in the same file (`:459`) already walks recursively, so
  this is one loop out of step with its neighbour, and KOL-089 would add a third file to the unswept directory. Found by
  the grader of KOL-100 and never filed. Build: both helpers walk recursively the way `parserSourceFiles()` does, with
  `OUT_OF_SCOPE` and `STORED_EXEMPT` matched on the path relative to `src/` rather than on a bare filename, so an
  exemption cannot silently cover a same-named file in a subdirectory. Then name the producers in the assertion beside
  the existing `draftApplier.js` and `failureNote.js` ones: a floor on a count is what let this through, so the new
  assertion names files instead of counting them. Files: `server/tests/http/errorShape.test.js`, plus whatever the
  newly-swept directory turns out to violate — if a producer does publish or store a caught message, fixing that is part
  of this item rather than a follow-up. Verify: `cd server && yarn test` green with the sweep's own file list including
  `src/lib/producers/dockerCompose.js` and `src/lib/producers/openApi.js`; falsification, as the suite's own header
  style asks — a `res.json({ error: err.message })` added to a producer fails the sweep, and is then reverted; and
  `composeDraft.test.js` and `openApiDraft.test.js` still pass, so the ParseError wording those suites pin is still
  allowed. Out of scope: widening the sweep to `src/config` or `src/models`; the statement-splitting heuristic the sweep
  matches with; the `STORED_EXEMPT` entries, which stay listed and exempt; and the `/chat` carve-out.

- [ ] **(KOL-107) An import whose entityTypes holds a non-object is a 500: the docs are built before the checks run** [proposed]
  `importGraph` builds `entityTypeDocs` at `server/src/lib/graphImporter.js:472-493` and calls `planIds` at `:507`, so
  the row-shape checks `planIds` performs for `entityTypes` (`:357-365` — `isPlainObject`, then a non-empty `name`) run
  after the loop that has already read `row.name`. A hand-edited document whose `entityTypes` holds `null`, a number, or
  a bare name instead of a row throws a raw `TypeError` at `:475`; `server/src/routes/import.js` hands it to
  `next(err)`, and the caller gets `500 INTERNAL` with a ref instead of the `400 MALFORMED_DOCUMENT` naming the field
  that every other malformed row answers with. Nothing is written, so this is about the response and not the data — but
  the module's promise is both that a refused document wrote nothing *and* that the caller is told which field, and
  KOL-097 added those very checks for this class of input. `relationshipTypeDocs` is built at `:518`, after `planIds`,
  so it is not affected. Found by the grader of KOL-097 and never filed. Build: validate before anything reads a row —
  either call `planIds` ahead of the `entityTypeDocs` loop, or, if the canonical-name map `planIds` takes has to be
  built first, run the `entityTypes` shape checks at the top of that build. The ordering is the whole fix: no new
  refusal code, no new message shape, no change to what a well-formed document imports. Files:
  `server/src/lib/graphImporter.js`, `server/tests/unit/graphImporter.test.js`, `server/tests/http/import.test.js`.
  Verify: a unit case per shape — `entityTypes: [null]`, `[42]`, `["Worlds"]` and `[{}]` each refuse with
  `MALFORMED_DOCUMENT` and a `fields` path naming `entityTypes[0]` or `entityTypes[0].name`, with
  `EntityType.countDocuments` unchanged after each; the same through `POST /import`, which answers 400 and carries no
  `ref`; and the existing round-trip, nested-subgroup and per-collection-cap cases pass unchanged. `cd server && yarn
  test` green; the client is untouched. Out of scope: the other collections, whose rows are already checked before they
  are read; a JSON Schema for the whole export document, which is a different way to do all of this; and merging into a
  non-empty workspace, which KOL-077 deliberately left out.

- [ ] **(KOL-108) Rule 5's mark is copied by Object.assign, which the comment says it cannot be** [proposed]
  `RAISED_HERE` is a module-private Symbol set by plain assignment in `httpError()`
  (`server/src/middleware/errorHandler.js:163`), and the comment above it (`:132`) states the guarantee the mark exists
  for: nothing can carry it by accident — "not a property copied across by `Object.assign`". `Object.assign` and object
  spread both copy own *enumerable* symbol-keyed properties, so `Object.assign(new Error(msg), marked)` and
  `{ ...marked }` do carry it, and whatever it lands on then publishes its own `status` and `code` as though this
  codebase had chosen them, which is the exact leak rule 5 exists to prevent. Nothing spreads a caught error today, so
  nothing leaks now: the live protection is `JSON.stringify` dropping symbol keys, and that half of the comment is
  true. What is wrong is the invariant a future `Object.assign(new Error('wrapped'), err)` would be written against,
  and the test that claims to prove it (`server/tests/http/errorShape.test.js:730`) builds a fresh unmarked literal
  rather than copying a marked error, so it cannot fail on this. Found by the grader of KOL-101 and never filed. Build:
  make the claim true rather than softening it — set the mark with
  `Object.defineProperty(err, RAISED_HERE, { value: true })`, which is non-enumerable and so copied by neither
  `Object.assign` nor spread, while `classify` reads it exactly as it does now. Then make the test prove the sentence it
  states, by copying a *marked* error both ways. Files: `server/src/middleware/errorHandler.js`,
  `server/tests/http/errorShape.test.js`, and the KOL-101 Decision Log line if it repeats the overstated wording.
  Verify: new cases in `errorShape.test.js` — `classify(Object.assign(new Error("a dependency's own sentence"),
  httpError(503, 'X')))` is unmapped, and so is `classify({ ...httpError(503, 'X') })`;
  `classify(httpError(503, 'X', { fields: ['a'] }))` is still 503 `X` with its `fields`, so the fix cannot have broken
  the rule it protects; the provider-failure table is still unmapped; and the handler's 500-with-ref path is unchanged.
  Falsification: restore the plain assignment and the two new cases fail. `cd server && yarn test` green; nothing else
  changes. Out of scope: `publicMessage` in `server/src/lib/failureNote.js`, which makes the same kind of authorship
  claim with a plain property and deserves the same treatment on its own evidence; any change to rule 5's status and
  code conditions; and the error codes themselves.

## Blocked Items

## Completed Items

- [x] **(KOL-094) Backlog audit: file new candidates under Proposed** (routine 2026-10-20, d595575)
  A standing upkeep item, last on purpose: it runs only when nothing above it is claimable. Candidate sources, in
  order: `docs/roadmap.md`, `docs/build-plan.md`, `docs/generator-v1-plan.md` "Remaining work", `docs/wishlist.md`,
  the Decision Log in `kol_emet_spec.md`, the outcomes under Completed Items and the review files under
  `ops/routine/reviews/`, and TODO/FIXME comments. For every candidate grep the code and `git log` and confirm it
  is NOT built before filing it; re-proposing a shipped feature is the failure this item exists to prevent. File
  3–8 items under `## Proposed` in this file's exact format (next free ids, never reuse one): a one-line title,
  then an indented body with what to build, the files involved, the verify commands, and what is out of scope.
  Every item must serve the public multi-tenant product (CLAUDE.md). Tag every filed item `[proposed]` — Daniel
  promotes one by deleting the tag, and the daily update lists them. Skip anything needing a credential, a paid
  generator run, an Atlas index change or a product decision unless the item IS that decision. Then renew this
  item: append a copy of this block at the bottom of `## Workqueue Items` with the next free id and the tag
  `[not-before: <today + 7 days as YYYY-MM-DD>]`, so it runs weekly. The PR touches only FEATURES.md. Verify:
  `node <orchestrator> lint kol-emet --worktree` exits 0 (the `<orchestrator>` path is the one this runbook names
  for `diff-policy`).
- [x] **(KOL-101) Rule 2 reuses classify(), whose rule 5 ('explicit status and code') matches raw provider SDK erro…** (routine 2026-10-17, 1234105)
  Found by the grader of KOL-100 (medium, server/src/lib/failureNote.js:116). Rule 2 reuses
  `classify()`, whose rule 5 ('explicit status and code') matches raw provider SDK errors: the
  OpenAI client sets `status` (int) and `code` from the response body (`invalid_api_key`,
  `insufficient_quota`, `context_length_exceeded`), so the commonest real generation failures are
  treated as 'mapped' — stored with `errorRef: null`, the generic sentence 'Something went wrong
  on the server. (<provider code>)', and, at the default `light` tier, no log of the error at all
  (rule 2 logs the error only at `normal`/`verbose`). The item's own trade — 'the note says
  nothing, so the log has to say everything' — is broken exactly where it matters, and the
  published code is a dependency-owned string. The new suite misses this because its stand-in body
  carries `type` but no `code` (draftFailure.test.js:112), so only rule 3 is exercised.
- [x] **(KOL-095) KOL-092 names a client open-question caller that does not exist: nothing under client/src fetches…** (routine 2026-10-16, 1356ce4)
  Found by the grader of KOL-080 (medium, FEATURES.md:218). KOL-092 names a client open-question
  caller that does not exist: nothing under client/src fetches `/open-questions` (grep for
  `open-questions` and for `question` in `client/src/composables/useEntities.js` returns nothing —
  open questions reach the client populated on entities). So "the two client callers page until
  `nextAfter` is null" and the `useEntities.js` entry in the Files list send the implementer to
  code that isn't there; only the graph caller (`GraphView.vue` → `getAllGroups`) exists. This is
  exactly the grep-before-filing check the item is supposed to have done.
- [x] **(KOL-100) draft.diagnostics.error = err.message persists the raw generation error, and GET /drafts/:id (lin…** (routine 2026-10-16, e4439ab)
  Found by the grader of KOL-075 (medium, server/src/routes/drafts.js:234).
  `draft.diagnostics.error = err.message` persists the raw generation error, and `GET /drafts/:id`
  (line 730) returns the whole lean document — so the driver's/provider's verbatim text (a Mongo
  pool error from a grounding read included) still reaches a caller in a plain JSON response body,
  contradicting docs/api.md's 'the driver's own text never reaches a caller'. The source sweep
  cannot see it because the leak is a stored field, not an `err.message` in a `res.json(...)`
  statement, and SSE scoping does not cover this non-SSE route.
- [x] **(KOL-099) Rule 5 requires a string code, but body-parser's errors (entity.parse.failed, entity.too.large) c…** (routine 2026-10-16, f3c8e62)
  Found by the grader of KOL-075 (medium, server/src/middleware/errorHandler.js:171). Rule 5
  requires a string `code`, but body-parser's errors (`entity.parse.failed`, `entity.too.large`)
  carry only `status`/`statusCode`/`type` — so a malformed JSON body or an over-100kB body on any
  endpoint except `/import` now falls to rule 6 and answers 500 `INTERNAL` where Express's
  finalhandler previously honoured the 400/413. `src/routes/import.js:63` states this outright ('a
  `SyntaxError` answered as the caller's 400 instead of falling through to the error handler's
  500'), so every other router now reports a client mistake as a server fault, with a `ref` and a
  logged stack per bad request.
- [x] **(KOL-098) A revoked session keeps a real privilege: POST /authorize (and POST /bridge/authorize, bridge.js:…** (routine 2026-10-16, e7cee9b)
  Found by the grader of KOL-076 (medium, server/src/routes/oauth.js:103). A revoked session keeps
  a real privilege: `POST /authorize` (and `POST /bridge/authorize`, bridge.js:145) read
  `req.session.userId` directly with no `requireAuth`/`requireActor`, so the device that was
  signed out can still call `setMcpUser(userId)` and complete the connector grant — binding the
  MCP bearer identity to the account and regaining full read/write through `/mcp`. The middleware
  header claims the check runs on "every request a browser makes", and the docs' carve-out is
  about *revoking existing* connector tokens (KOL-014), not about a revoked session minting a new
  grant.
- [x] **(KOL-097) planIds validates only refModel/refId on group members and nothing on a group's label or a member…** (routine 2026-10-16, 2a310ea)
  Found by the grader of KOL-077 (medium, server/src/lib/graphImporter.js:288). planIds validates
  only `refModel`/`refId` on group members and nothing on a group's `label` or a member's
  `label`/`notes`, so a hand-edited document with a non-string there (e.g.
  `relationshipGroups[0].label = {}`) passes every pre-write check, the
  EntityType/RelationshipType/Entity insertMany calls all succeed, and the RelationshipGroup
  insert then throws a CastError — a 500 that leaves a partially written graph which the emptiness
  rule refuses to let the owner retry, contradicting the module's documented "nothing is written
  until everything has been checked".
- [x] **(KOL-096) The editor-403 test's "writes nothing" check asserts no entity titled 'Zephyr Line' exists, but t…** (routine 2026-10-16, 5ad04a2)
  Found by the grader of KOL-077 (medium, server/tests/http/import.test.js:262). The editor-403
  test's "writes nothing" check asserts no entity titled 'Zephyr Line' exists, but that title is
  nowhere in the document under test (alice's export holds the seeded 'Example Character'/'Example
  World' plus 'Alice Only' — 'Zephyr Line' belongs to the unit-test fixture), so the assertion
  passes unconditionally and would still pass if the 403 gate were removed and the whole graph
  written into alice's workspace.
- [x] **(KOL-079) Three stale "not built" lists that make a backlog audit re-propose shipped work** (routine 2026-10-15, c034b7d)
  This audit found three documents describing work that has already shipped, which is exactly the input that makes the
  next audit file a duplicate. (1) `docs/generator-v1-plan.md` "Remaining work" still lists **account-deletion hard
  delete** and the **signup disclosure copy** as not built: both shipped in KOL-021 — `Draft` is in the deleted-model
  list at `server/src/lib/accountDeleter.js:84`, and the disclosure is `client/src/views/LoginView.vue:85`. (2)
  `docs/roadmap.md` still heads "Phase 5 — Polish (current)" and "Phase 6 — Generalize the engine (next)", although
  Phase 6's steps all shipped (KOL-020, KOL-022, KOL-027 through KOL-031) and the `EntityType` registry now gates every
  category write. (3) `docs/wishlist.md` still lists "Tag autocomplete on entry editor", "Bulk tag operations" and
  "Entry revision history" as open; all three shipped (KOL-041, KOL-053, and the `ChangeLog` history view with
  snapshot rollback). Build: mark each shipped line the way these same files already mark others — a ✅ with the item id
  and the date — and move Phase 6 to shipped, naming what is actually next in its place (Phase 7's unbuilt halves:
  vertical ingestion beyond the compose and OpenAPI producers, and drift detection). Nothing is deleted: a line that
  now reads as history stays, because the goal is an accurate list rather than a shorter one. Files:
  `docs/generator-v1-plan.md`, `docs/roadmap.md`, `docs/wishlist.md`. Verify: `git diff --name-only` names exactly those
  three files, and `cd server && yarn test` and `cd client && yarn test --run && yarn build` are still green — this is
  documentation only, so movement in either suite means the diff touched more than it should. Out of scope:
  re-sequencing the roadmap or deciding what Phase 8 contains (Daniel's call), rewriting either plan's prose, and any
  code change at all — a line that turns out to describe something genuinely unbuilt is left alone and becomes its own
  queue item.
- [x] **(KOL-078) `GET /health`: liveness and database readiness without a session** (routine 2026-10-15, b854f69)
  Every route in `createApp` is behind `requireAuth` except `/auth/*`, `/oauth`, `/templates`, `/mcp` and the bridge, so
  there is no way to ask a deployed instance whether it is working. The repo runbook's deploy signal is Railway's own
  commit status, which says a container started — not that it can reach Mongo. The failure that leaves invisible is the
  likeliest one in production: the API answering while `mongoose.connection.readyState` is 0, which every tenant route
  turns into a stall that reads to a user as their own connection. Build: `server/src/routes/health.js` — `GET /health`
  returning `{ status, db, uptimeSeconds }`, where `status` is `ok` with 200 when `readyState` is 1 and `degraded` with
  503 otherwise, and `db` is `up` or `down`. Deliberately nothing else in the body: no version, no commit, no
  collection counts, no environment or provider names. It is the one unauthenticated route whose whole job is to be
  polled, and a status endpoint that describes the deployment is a reconnaissance endpoint. Mounted ahead of
  `requireAuth` in `createApp`; it needs no origin-guard exemption, because `originGuard` checks only unsafe methods
  (`server/src/middleware/originGuard.js:148`). Files: `server/src/routes/health.js` (new), `server/src/app.js` (one
  mount), and a `## Health` section in `docs/api.md`. Verify: a new `server/tests/http/health.test.js` — 200
  `{ status: 'ok', db: 'up' }` with no session and no cookie; `degraded` / `down` with 503 when the connection is forced
  to a non-ready state; the body carries exactly the three documented keys and no others, so adding a fourth has to be a
  deliberate change to the assertion; a cross-origin `GET` is not refused; and `HEAD /health` answers for a monitor that
  sends one. `cd server && yarn test` green; the client is untouched. Out of scope: checking the AI providers or any
  outbound dependency, Prometheus or OpenTelemetry metrics, a status page, and pointing Railway's own healthcheck
  setting at it — that is a dashboard change for Daniel, to be flagged in the PR.
- [x] **(KOL-077) `POST /import`: a canonical export round-trips back into an empty workspace** (routine 2026-10-15, cfe4e7d)
  KOL-070 shipped `GET /export` and `server/src/lib/graphExporter.js` — one deterministic JSON document stamped
  `version: 'kol-emet/workspace-export@1'` — and left the other half open: nothing reads it back. So the export is a
  file nobody can prove is complete, `docs/wishlist.md`'s "Bulk import endpoint" has no answer, and the roadmap's
  Git-native track ("a Git connector round-trips it into the customer's repo") has no round trip to connect. Build:
  `server/src/lib/graphImporter.js` — from a parsed export document plus a `workspaceId` to the documents it writes:
  refuse an unknown `version`; give every entity type, relationship type, entity, relationship group and open question a
  fresh `ObjectId` and rewrite every reference to it; keep each group's `members` array order and its `refModel`
  discriminator, because array position is what encodes order; rebuild `Entity.relationships` and
  `Entity.open_questions` from the groups and questions rather than copying the file's ids; and ignore any `workspaceId`
  the file carries, so a document hand-edited to name another tenant writes nothing there. It imports only into an
  **empty** workspace — no entities, no relationship groups, no open questions — and answers 409
  `WORKSPACE_NOT_EMPTY` otherwise. That refusal is the point: it is what lets this item ship with no merge or
  id-collision policy, which is a product decision this deliberately does not make. `POST /import` sits behind
  `requireAuth`, `resolveWorkspace` and `requireWorkspaceRole('owner')` (KOL-071's middleware, `workspace.js:138`), with
  per-collection caps so one upload cannot write an unbounded graph, and tiered
  `IMPORT_LOG_LEVEL = off | light | normal | verbose` (default light) naming the document's version, the per-collection
  counts and the reason behind every refusal. Files: `server/src/lib/graphImporter.js` and `server/src/routes/import.js`
  (both new), `server/src/app.js` (one mount beside `/export`), `client/src/api/export.js`, an "Import workspace" row
  among the Settings groups in `client/src/components/WikiLayout.vue`, an `## Import` section in `docs/api.md`, and a
  Decision Log line for the empty-workspace rule. Verify: a new `server/tests/unit/graphImporter.test.js` — a fixture
  graph exported, imported into a fresh workspace and exported again is byte-identical except for the ids; a nested
  subgroup and its member order survive; an unknown `version` is refused; a planted foreign `workspaceId` lands in the
  caller's workspace and nowhere else; and a document over the caps is refused with nothing written. A new
  `server/tests/http/import.test.js` — the owner of an empty workspace gets 201 and the entities appear under
  `GET /entities`; a workspace holding one entity is 409 and is unchanged; a member whose role is `editor` is 403;
  unauthenticated is 401; malformed JSON is 400. `cd server && yarn test` and `cd client && yarn test --run &&
  yarn build` green. Out of scope: merging into a non-empty workspace and the id-collision policy that needs, importing
  `ChangeLog` or `Draft` (KOL-019 has to settle whether history is permanent first), YAML or Markdown input, the Git
  connector itself, and streaming for very large files.
- [x] **(KOL-076) Sign out everywhere, so a session on a lost device can be ended** (routine 2026-10-15, 3a12e99)
  A session is a row in the Mongo session store keyed by its own id, and nothing in that store can be found *by user* —
  the Decision Log says so where it lists what account deletion cannot reach: "the user's *other* sessions cannot be
  found by user in the store, so they outlive the account holding a dangling id". For a public product the consequence
  is that a session left on a borrowed laptop, or one on a stolen phone, cannot be ended by its owner at all:
  `POST /auth/logout` destroys only the session that called it, and KOL-038 taught just `GET /auth/me` to notice a
  session whose user is gone. Build: `credentialsChangedAt` on `User` (set at creation alongside the existing
  `timestamps`), an `issuedAt` written into the session at every sign-in — `/login`, the WebAuthn completion and
  `/register` — and one check inside `requireAuth` and `requireActor`: a session whose `issuedAt` predates its user's
  `credentialsChangedAt` is destroyed and answered 401. `POST /auth/sessions/revoke-all` re-authenticates the way
  `DELETE /auth/account` does, bumps `credentialsChangedAt` to now, and re-stamps the calling session's `issuedAt` so
  the device that asked stays signed in. A timestamp rather than a session table on purpose: the store cannot be queried
  by user, and a second place that lists sessions is a second thing that has to stay true. Files:
  `server/src/models/User.js`, `server/src/middleware/auth.js`, `server/src/routes/auth.js`, `client/src/api/auth.js`,
  the Settings area that already holds the passkey list in `client/src/components/WikiLayout.vue`, `docs/api.md`, and a
  Decision Log line in `kol_emet_spec.md` (it supersedes the "other sessions outlive the account" gap recorded there).
  Verify: a new `server/tests/http/sessionRevocation.test.js` — two agents signed in as one user, revoke from the first,
  and the second's next `/entities` request is 401 with its session gone from the store while the first still reads
  `/entities`; a second user's session is untouched; a wrong password on the revoke is 403 and bumps nothing; an
  unauthenticated call is 401; a session issued after the bump is accepted; and the MCP bearer token, which carries no
  session, keeps working. Plus a `client/src/components/WikiLayout.test.js` case for the button and its confirmation.
  `cd server && yarn test` and `cd client && yarn test --run && yarn build` green. Out of scope: listing active sessions
  with device, IP or location (the store cannot enumerate them by user — that is precisely why this is a timestamp),
  notifying the account by email, revoking the MCP bearer or OAuth tokens (KOL-014 owns per-connector identity), and
  bumping the timestamp automatically when a passkey is removed.
- [x] **(KOL-075) One error shape for the API, instead of the database's own error text** (routine 2026-10-15, 9d332c1)
  Fifty-nine handlers across twelve routers end in `catch (err) { res.status(500).json({ error: err.message }) }` or its
  400 variant — `entities.js:244,267,287`, `changelog.js:119`, `drafts.js` (13 of them), `relationshipGroups.js` (11),
  `conversations.js`, `openQuestions.js`, `relationshipTypes.js`, `entityTypes.js`, `tags.js`, `workspace.js`,
  `export.js`, `auth.js:384,499` — plus `server/src/middleware/auth.js:51` and `workspace.js`, and `createApp` installs
  no error middleware at all. So whatever Mongoose or the driver says reaches the caller verbatim: `E11000 duplicate key
  error collection: … index: …`, `Entity validation failed: category: …`, or a pool error carrying a connection string.
  KOL-069 closed the one case it could close from outside the catch — a malformed `:id` is 400 `INVALID_ID` before the
  route runs — and that fix is the pattern this follows: the shape belongs in one place, not in fifty-nine catches.
  Build: `server/src/middleware/errorHandler.js`, a four-argument Express handler mounted last in `createApp`, mapping a
  Mongoose `ValidationError` to 400 `{ error: 'VALIDATION_FAILED', fields: [<schema paths>] }` (our own path names,
  which are safe and are what a client needs to show), duplicate key 11000 to 409 `{ error: 'DUPLICATE', fields: […] }`,
  an error carrying an explicit `status` and `code` to those, and anything else to 500 `{ error: 'INTERNAL', ref }`
  where `ref` is a short random id also written to the server log beside the real stack — so a user can quote the ref
  and nothing about the deployment leaves the box. Tiered `ERROR_LOG_LEVEL = off | light | normal | verbose` (default
  light): light logs one line per handled error with the route, the status it chose, the `ref` and *which rule* chose
  it, so the log says the source of the mapping and not just the status. Then the sweep: each leaking `catch` becomes
  `catch (err) { next(err) }`, while every 400/403/404 a route answers on purpose with a written sentence stays exactly
  as it is. Files: `server/src/middleware/errorHandler.js` (new), `server/src/app.js`, the twelve routers, the two
  middleware files, and an `## Errors` section in `docs/api.md` listing the codes. Verify: a new
  `server/tests/http/errorShape.test.js` — a write that fails schema validation is 400 `VALIDATION_FAILED` and the body
  contains neither `validation failed` nor a model name; a duplicate unique value is 409 `DUPLICATE`; a route forced to
  throw is 500 `INTERNAL` with a `ref` and no `message`; that same `ref` appears in the captured log; and a source-level
  assertion that no file under `server/src/routes/` or `server/src/middleware/` still passes `err.message` into a
  response body, so the sweep cannot quietly regress. `cd server && yarn test` green; the client is untouched. Out of
  scope: `server/src/routes/bridge.js` and `mcp.js`, which answer JSON-RPC error objects on their own protocol and are
  KOL-047's subject; request-id propagation into the client's own logs; and changing any status code a route chooses
  deliberately today.
- [x] **(KOL-080) Backlog audit: file new candidates under Proposed** (routine 2026-10-15, 8fa06f4)
  A standing upkeep item, last on purpose: it runs only when nothing above it is claimable. Candidate sources, in
  order: `docs/roadmap.md`, `docs/build-plan.md`, `docs/generator-v1-plan.md` "Remaining work", `docs/wishlist.md`,
  the Decision Log in `kol_emet_spec.md`, the outcomes under Completed Items and the review files under
  `ops/routine/reviews/`, and TODO/FIXME comments. For every candidate grep the code and `git log` and confirm it
  is NOT built before filing it; re-proposing a shipped feature is the failure this item exists to prevent. File
  3–8 items under `## Proposed` in this file's exact format (next free ids, never reuse one): a one-line title,
  then an indented body with what to build, the files involved, the verify commands, and what is out of scope.
  Every item must serve the public multi-tenant product (CLAUDE.md). Tag every filed item `[proposed]` — Daniel
  promotes one by deleting the tag, and the daily update lists them. Skip anything needing a credential, a paid
  generator run, an Atlas index change or a product decision unless the item IS that decision. Then renew this
  item: append a copy of this block at the bottom of `## Workqueue Items` with the next free id and the tag
  `[not-before: <today + 7 days as YYYY-MM-DD>]`, so it runs weekly. The PR touches only FEATURES.md. Verify:
  `node <orchestrator> lint kol-emet --worktree` exits 0 (the `<orchestrator>` path is the one this runbook names
  for `diff-policy`).
- [x] **(KOL-087) An operation whose tags is not a sequence crashes the parse: toJS(...) returns a string (or plain…** (routine 2026-10-14, 518e614)
  Found by the grader of KOL-051 (medium, server/src/lib/producers/openApi.js:362). An operation
  whose `tags` is not a sequence crashes the parse: `toJS(...)` returns a string (or plain object)
  for `tags: Pets` / `tags: {a: b}`, `?? []` does not replace it, and `.filter` is not a function
  — a TypeError escapes `parseOpenApi`, so `POST /drafts/openapi` answers 500 with a raw stack
  message instead of the 400/drop-reason the producer promises for a malformed document.
- [x] **(KOL-086) In findOrCreateGroup, the proposed-target path trusts p.targetGroupId without re-checking that th…** (routine 2026-10-14, 066deed)
  Found by the grader of KOL-054 (medium, server/src/lib/draftApplier.js:259). In
  findOrCreateGroup, the `proposed-target` path trusts `p.targetGroupId` without re-checking that
  the group still holds the proposal's members: a member the group does not hold is silently
  skipped (`if (!held) continue`), yet the back-reference `$addToSet` is still written for every
  member and the item is recorded `applied`. Reachable two ways — (a) a human removes a member
  from a 3+-member group between draft creation and apply (DELETE
  /relationship-groups/:id/members/:entityId leaves the group alive and pulls the back-ref), so
  the re-import neither restores the edge nor reports a problem and leaves the entity with a
  `relationships` entry for a group it is not in (inflating the list view's link count); (b) an
  API-level edit (PATCH /drafts/:id/items/:itemId with decision 'edited') may re-point `members`
  while keeping `targetGroupId`, which `relationshipPayloadSchema` accepts — the applier then
  writes nothing of the accepted edit, bumps back-refs on entities the group does not contain, and
  still returns success. The apply-time matcher path cannot hit this (it requires containment);
  only the id-targeted path lacks the check the comment on line 261 assumes ("cannot happen under
  the match rule").
- [x] **(KOL-085) The conversation-rename input binds @keydown.escape.prevent="cancelRename" with no stopPropagatio…** (routine 2026-10-14, c7e56a0)
  Found by the grader of KOL-063 (medium, client/src/components/ChatPanel.vue:29). The
  conversation-rename input binds `@keydown.escape.prevent="cancelRename"` with no
  `stopPropagation` (unlike EntityEditor's tag combobox, which stops it), so Escape while renaming
  a conversation cancels the rename and then reaches the global listener, which closes the whole
  chat panel — one press doing two things.
- [x] **(KOL-084) Escape inside GeneratorOverlay closes two layers at once: the overlay's own @keydown.esc="tryClos…** (routine 2026-10-14, 9b08c2c)
  Found by the grader of KOL-063 (high, client/src/components/WikiLayout.vue:690). Escape inside
  GeneratorOverlay closes two layers at once: the overlay's own `@keydown.esc="tryClose"`
  (GeneratorOverlay.vue:2) emits `close`, which synchronously sets `generatorOpen = false`, and
  the same event then bubbles on to the window listener, so `closeTopLayer` sees the generator
  already closed and falls through to close the chat or the detail panel underneath — the exact
  double-close the item removed GraphView's listener to prevent, and the opposite of the spec's
  claim that the double call is "a no-op".
- [x] **(KOL-083) A page failure mid-walk leaves the sidebar showing a silently truncated workspace: sidebarLoading…** (routine 2026-10-14, f6a9855)
  Found by the grader of KOL-067 (medium, client/src/composables/useEntities.js:52). A page
  failure mid-walk leaves the sidebar showing a silently truncated workspace: `sidebarLoading` is
  already false, the rejection has no catch anywhere (`onMounted(() => loadEntities())` in
  WikiLayout.vue:574, no global error/unhandledrejection handler in the client), so a 500 or
  network blip on page 3 of 5 renders a partial list that is indistinguishable from a complete one
  — before this change a failed load left the list empty, which at least looked wrong.
- [x] **(KOL-082) searchEntities sends no ?limit=, so every keystroke-word triggers an unbounded GET /entities?q= t…** (routine 2026-10-14, d7dda3c)
  Found by the grader of KOL-068 (medium, client/src/api/entities.js:85). `searchEntities` sends
  no `?limit=`, so every keystroke-word triggers an unbounded `GET /entities?q=` that serializes
  every matching row in the workspace in one response — the exact unpaged full-workspace read
  KOL-067 removed from the initial load (`LIST_LIMIT_MAX`'s own comment: "an unbounded
  JSON.stringify of one workspace's entire row set is time nobody else's request can run in"), now
  reachable from the search box: typing a single common letter matches nearly every entity, on the
  single event loop every tenant shares.
- [x] **(KOL-081) The signup gate is read before the work and recorded only after it (blocked at :148, record at :1…** (routine 2026-10-13, fb2150d)
  Found by the grader of KOL-050 (medium, server/src/routes/auth.js:148). The signup gate is read
  before the work and recorded only after it (`blocked` at :148, `record` at :166, with a
  `User.findOne`, a bcrypt cost-12 hash and two writes in between), so the per-address ceiling
  only binds sequential callers: a script that opens N connections at once has every request pass
  `blocked` while the counter is still 0 and ends up creating ~N accounts per window instead of
  `perSignupIp`, which is exactly the 'as fast as it can post' case the item set out to bound.
  Reserving the slot before the hash (increment-then-check, rolling back on a refusal) would hold
  the bound under concurrency.
- [x] **(KOL-074) Change your password, and one policy both routes share** (routine 2026-10-12, f0bdcae)
  An account registered today can never change its password. `server/src/routes/auth.js` has `/register`, `/login`,
  `/logout`, `/me`, the WebAuthn routes and `DELETE /account`, and nothing between them that replaces `passwordHash` —
  the only way out of a password you no longer trust is deleting the account and rebuilding the workspace. The same
  file's `usablePassword` (`auth.js:103`) accepts any non-empty string, so `a` is a valid password on a product with
  open registration. Build: `server/src/lib/passwordPolicy.js` exporting one `passwordProblem(value)` that returns
  `null` or a sentence, enforcing a 12-character minimum and nothing else (length, not composition rules — NIST
  800-63B), called by `/register` and by the new route so the two cannot drift apart. `POST /auth/password`
  re-authenticates exactly as `DELETE /auth/account` does: the current password, or a passkey assertion against a
  single-use challenge under its own session key, and session-only — not `requireActor`, because a connector token does
  not get to change someone's password. Then bcrypt at 12 rounds, as `/register` uses. A failed re-authentication is
  403, not 401, for the reason the Decision Log already gives for deletion: the session is still good, and a 401 reads
  to a client as "signed out". Counted by the existing `createAuthLimiter` (`server/src/lib/attemptLimiter.js`) under
  its own key, so guessing the current password here is throttled like guessing it at the sign-in form. Accounts whose
  stored password is shorter than the new minimum keep signing in: the policy gates writes and never `/login`, because
  locking out everyone who registered before it is a worse failure than a short password. Files:
  `server/src/lib/passwordPolicy.js` (new), `server/src/routes/auth.js`, `client/src/api/auth.js`, a "Password" group in
  `client/src/components/WikiLayout.vue` beside the passkey settings, `client/src/views/LoginView.vue` (state the
  minimum at registration, with `autocomplete="new-password"`), and a `## Password` note in `docs/api.md`. Verify: a new
  `server/tests/http/password.test.js` — the new password signs in and the old one does not; a wrong current password is
  403 and the hash is unchanged; a passkey assertion is accepted; an 11-character new password is 400 and changes
  nothing; registering with a short password is 400; an account whose stored password is short still signs in; the MCP
  bearer token is refused; an unauthenticated call is 401; and repeated wrong attempts hit the limiter. Plus
  `server/tests/unit/passwordPolicy.test.js` for the boundary, and a `client/src/components/WikiLayout.test.js` case
  that the form posts. `cd server && yarn test` and `cd client && yarn test --run && yarn build` green. Out of scope:
  password reset by email (it needs a mail credential and is `[needs-human]` when it is filed), breach-list or zxcvbn
  scoring, forcing a rotation on existing accounts, and ending the user's *other* sessions on a change — KOL-076 below
  owns that and wants to land after this one.
- [x] **(KOL-073) Backlog audit: file new candidates under Proposed** (routine 2026-10-12, 4503714)
  A standing upkeep item, last on purpose: it runs only when nothing above it is claimable. Candidate sources, in
  order: `docs/roadmap.md`, `docs/build-plan.md`, `docs/generator-v1-plan.md` "Remaining work", `docs/wishlist.md`,
  the Decision Log in `kol_emet_spec.md`, the outcomes under Completed Items and the review files under
  `ops/routine/reviews/`, and TODO/FIXME comments. For every candidate grep the code and `git log` and confirm it
  is NOT built before filing it; re-proposing a shipped feature is the failure this item exists to prevent. File
  3–8 items under `## Proposed` in this file's exact format (next free ids, never reuse one): a one-line title,
  then an indented body with what to build, the files involved, the verify commands, and what is out of scope.
  Every item must serve the public multi-tenant product (CLAUDE.md). Tag every filed item `[proposed]` — Daniel
  promotes one by deleting the tag, and the daily update lists them. Skip anything needing a credential, a paid
  generator run, an Atlas index change or a product decision unless the item IS that decision. Then renew this
  item: append a copy of this block at the bottom of `## Workqueue Items` with the next free id and the tag
  `[not-before: <today + 7 days as YYYY-MM-DD>]`, so it runs weekly. The PR touches only FEATURES.md. Verify:
  `node <orchestrator> lint kol-emet --worktree` exits 0 (the `<orchestrator>` path is the one this runbook names
  for `diff-policy`).
- [x] **(KOL-072) A `?` cheatsheet for the keyboard shortcuts** (routine 2026-10-10, bd9934f)
  KOL-063 shipped `/`, `Escape` and `n` through `client/src/composables/useKeyboardShortcuts.js` and listed "a `?`
  cheatsheet overlay" in its own out-of-scope note; `docs/wishlist.md` carries the same open item ("a `?` cheatsheet and
  user-configurable bindings are still open"). The three bindings are registered in one place
  (`client/src/components/WikiLayout.vue:435`) and nothing in the UI names any of them, so a shortcut nobody can
  discover is a shortcut nobody uses — and for a product people reach straight from a signup form, the first visit is
  exactly when it has to be discoverable. Build: a new `client/src/components/ShortcutCheatsheet.vue` overlay listing
  each binding as key + sentence, opened by `?` registered in the same binding map (so the single global listener still
  owns every key, which is the invariant `useKeyboardShortcuts` exists to hold) and closed by `Escape` or a click
  outside. `Escape` must close it *first*, ahead of Settings and the generator, so it joins `closeTopLayer`'s stated
  order rather than taking a listener of its own. The list is derived from the binding map, not retyped beside it:
  `useKeyboardShortcuts` takes `{ handler, label }` per key (or a parallel label map it validates) so a binding added
  later cannot be missing from the sheet — that derivation is the reason this belongs next to the composable instead of
  in a static template. A small `?` hint button beside the sidebar search opens the same overlay for anyone who would
  never guess the key. Files: `client/src/composables/useKeyboardShortcuts.js`,
  `client/src/components/ShortcutCheatsheet.vue` (new), `client/src/components/WikiLayout.vue`,
  `client/src/components/EntitySidebar.vue`, and the Frontend — UX list in `docs/wishlist.md`. Verify:
  `client/src/components/WikiLayout.test.js` — `?` opens the sheet and it lists every registered binding (asserted
  against the map itself, so a new binding with no label fails the test); `Escape` closes the sheet and leaves an open
  detail panel open; `?` typed into the search input types a `?` and opens nothing; the hint button opens it; and a
  press reported as `event.key === '?'` with `shiftKey` true is not declined as a modifier press.
  `cd client && yarn test && yarn build` green; no server change. Out of scope: user-configurable bindings
  (`docs/wishlist.md` keeps them), shortcuts inside the draft review UI (KOL-063's own exclusion), a per-platform
  `⌘`/`Ctrl` legend beyond plain text, and persisting a "don't show this again" preference.
- [x] **(KOL-071) A workspace has a name its owner can see and change** (routine 2026-10-10, 8043cf0)
  `POST /auth/register` hard-codes `name: 'My Workspace'` (`server/src/routes/auth.js:143`) and nothing ever reads it
  back: no route returns or changes a workspace name, and no component in `client/src` displays one. `Workspace` models
  `members` with `owner | editor | viewer` roles from the start so sharing would not need a schema reshape
  (`server/src/models/Workspace.js`), but `resolveWorkspace` (`server/src/middleware/workspace.js:30`) checks membership
  only and no route anywhere checks a role. For a product whose next commercial step is collaborator invites, a
  workspace that cannot be named, shown, or told apart from another is a gap in the shape of the product — and the role
  check is the piece every later sharing route needs. Build: `GET /workspace` returns
  `{ _id, name, role, createdAt }` for the caller's workspace, `role` read from their own `members` entry so the client
  can hide what an editor or a viewer may not do; `PATCH /workspace` sets `name`, trimmed, 1–80 characters, 400 for
  anything else, and only for an owner — 403 `{ error: 'NOT_WORKSPACE_OWNER' }` otherwise. The role check lives once, as
  `requireWorkspaceRole('owner')` in `server/src/middleware/workspace.js` beside `resolveWorkspace`, because invites,
  member removal and billing will each need exactly it. `POST /auth/register` accepts an optional `workspaceName` (same
  validation; absent keeps today's default) and `client/src/views/LoginView.vue` offers it as an optional field with
  `autocomplete="off"`, so a new user's first workspace is theirs rather than "My Workspace". A "Workspace" group in
  Settings (`client/src/components/WikiLayout.vue:112`) shows the name with an inline rename for an owner and read-only
  text for anyone else. Tiered logging `WORKSPACE_LOG_LEVEL = off | light | normal | verbose` (default light): light
  names every rename with the old name, the new one and who asked, and every refusal with the role it read — the source
  of the change, not just the new value. Files: `server/src/middleware/workspace.js`, `server/src/routes/workspace.js`
  (new), `server/src/app.js`, `server/src/routes/auth.js`, `client/src/api/auth.js`, `client/src/views/LoginView.vue`,
  `client/src/components/WikiLayout.vue`, and a `## Workspace` section in `docs/api.md`. Verify: a new
  `server/tests/http/workspace.test.js` — `GET /workspace` returns the caller's own workspace with `role: 'owner'` and
  never another user's; `PATCH` renames it; an empty, whitespace-only, non-string and 81-character name are each 400 and
  change nothing; a member whose role is `editor` gets 403 and the name is unchanged; an unauthenticated call is 401;
  registering with `workspaceName` uses it and registering without it keeps `My Workspace`. Plus a
  `client/src/views/LoginView.test.js` case that the optional field posts through, and a
  `client/src/components/WikiLayout.test.js` case that the Settings group shows the name and the rename calls the API.
  `cd server && yarn test` and `cd client && yarn test && yarn build` green. Out of scope: inviting or removing members,
  more than one workspace per user (`resolveWorkspace` still takes the first membership, and choosing between several is
  a product decision), enforcing `editor`/`viewer` on the content routes (every workspace has exactly one member today,
  so there is nothing yet to enforce against), and billing.
- [x] **(KOL-070) Canonical workspace export: `GET /export`** (routine 2026-10-10, 9f9538c)
  There is no way to get a workspace's graph out of the product. `server/src/lib/draftExporter.js` and
  `server/scripts/export-drafts-jsonl.js` export *decision records* as JSONL training data, not content; the only other
  reader of the whole graph is the client's own list route. For a product that charges for storing someone's work that
  is two gaps at once: a user who wants to leave cannot take the graph with them, and the roadmap's Git-native track
  names the missing piece exactly — "give the graph a canonical serializable form" is step one of the repo-resident
  graph, and no Git connector can round-trip a form that does not exist. Build:
  `server/src/lib/graphExporter.js` — a pure function from a `workspaceId` to one deterministic JSON document,
  `{ version, exportedAt, workspace: { name }, entityTypes, relationshipTypes, entities, relationshipGroups,
  openQuestions }`, with every collection sorted by a stable key (entities by `title` then `_id`, types by `order` then
  `name`, groups by `_id`), every `ObjectId` stringified, and nothing else in it: no user, no session, no `aiBudget`, no
  ChangeLog, no Draft. Deterministic because diffability is the point — the same graph exported twice must be
  byte-identical, which is what a Git connector needs and what the test pins. Then `GET /export`
  (`server/src/routes/export.js`, mounted behind `requireAuth` + `resolveWorkspace` in `server/src/app.js` like every
  other tenant-content route) returning it with
  `Content-Disposition: attachment; filename="<workspace>-<YYYY-MM-DD>.json"`, and an "Export workspace" row among the
  Settings groups (`client/src/components/WikiLayout.vue:112`, beside "Recently deleted"). Tiered logging
  `EXPORT_LOG_LEVEL = off | light | normal | verbose` (default light): light names the workspace, the per-collection
  counts and the byte size, and the source (this route, or a later script), because an export that silently omits a
  collection leaves a count as its only trace. Files: `server/src/lib/graphExporter.js` and
  `server/src/routes/export.js` (both new), `server/src/app.js` (one mount), `client/src/components/WikiLayout.vue`, a
  new `client/src/api/export.js`, a `## Export` section in `docs/api.md`, and a Decision Log line in `kol_emet_spec.md`
  for the canonical form. Verify: a new `server/tests/unit/graphExporter.test.js` — a fixture workspace exports every
  collection with the documented keys; two exports of the same data are byte-identical; ordering does not depend on
  insertion order; ids are strings; and no `aiBudget`, `passwordHash`, `userId`, `email` or `workspaceId` key appears
  anywhere in the output. A new `server/tests/http/export.test.js` — an authenticated caller gets their own graph and
  nothing of a second workspace's, an unauthenticated call is 401, and the filename header is set. Plus a
  `client/src/components/WikiLayout.test.js` case that the Settings row triggers the download. `cd server && yarn test`
  and `cd client && yarn test && yarn build` green. Out of scope: the import side (`POST /import`, the wishlist's bulk
  import — it needs an id-collision and merge policy and is its own item), the Git connector itself, YAML or Markdown
  output, streaming for very large workspaces, and including ChangeLog history (KOL-019 has to settle whether history
  is permanent first).
- [x] **(KOL-069) A malformed id answers 400, not a 500 carrying the database's own error text** (routine 2026-10-10, 7b97b5d)
  Every `:id` route hands `req.params.id` straight to Mongoose: `GET/PUT/DELETE /entities/:id`
  (`server/src/routes/entities.js:99,142,172`), `GET /entities/:id/history` and
  `POST /entities/:id/rollback/:logId` (`server/src/routes/changelog.js:86,177`), all ten `/relationship-groups/:id…`
  routes (`server/src/routes/relationshipGroups.js:81` onward), and the `:id` routes of `/open-questions`,
  `/conversations` and `/drafts`. A caller sending anything that is not a 24-hex id — a slug, a truncated id, a
  URL-encoded title, a stale link — gets a Mongoose `CastError` thrown inside the route's `try`, caught by
  `catch (err) { res.status(500).json({ error: err.message }) }`, and answered **500** with
  `Cast to ObjectId failed for value "…" (type string) at path "_id" for model "Entity"`. That is two defects in one: a
  client error is reported as a server fault, so in whatever monitors this deployment a mistyped URL is
  indistinguishable from a real outage; and the body is an internal error string naming the model and the driver's cast
  path, which is not a shape a public API should return. `server/src/routes/entityTypes.js:111` already guards with
  `mongoose.isValidObjectId`, so the work is making that the rule instead of one router's good habit. Build:
  `server/src/middleware/objectId.js` exporting `objectIdParam(name)`, which answers
  `400 { error: 'INVALID_ID', param }` when the named route parameter is not a valid ObjectId, registered per router
  with `router.param('id', …)` (plus `logId`, `entityId` and `subGroupId` where they appear) so a route added to that
  router later inherits the check rather than re-deriving it. 400 and not 404 on purpose: a well-formed id that belongs
  to another tenant stays 404, so the API still never confirms another workspace's row exists, but a malformed id
  cannot name anyone's row and so reveals nothing — it is simply a request the caller got wrong. Files:
  `server/src/middleware/objectId.js` (new), the five routers above, and a line in `docs/api.md` stating that any `:id`
  route answers 400 `INVALID_ID` for a malformed id. Verify: a new `server/tests/http/objectId.test.js` — `not-an-id`
  in place of the id is 400 `INVALID_ID` and never 500 on each of the entity, history, rollback, relationship-group,
  open-question, conversation and draft id routes; a well-formed id belonging to a second workspace is still 404; a
  valid id still succeeds on every router touched; and no response body anywhere in the suite contains
  `Cast to ObjectId`. `cd server && yarn test` green. Out of scope: reshaping the 34
  `res.status(500).json({ error: err.message })` handlers into a fixed body plus a server-side log (the same leak in the
  general case, and worth its own item), validating non-id parameters, and the MCP tools' id arguments, which come from
  a model that read them from this API and already answer tool errors rather than HTTP statuses.
- [x] **(KOL-068) The search box asks the server, so block text is searchable in the UI** (routine 2026-10-10, 560b600)
  `useFilters` (`client/src/composables/useFilters.js:11`) filters the already-loaded list in the browser over `title`,
  `summary` and `tags` only. The server's `?q=` (`keywordFilter`, `server/src/lib/searchFilter.js:85`) matches title,
  summary **and** every block's `data.markdown`. So the one field a wiki keeps its content in is not searchable from the
  UI at all: a word that appears only in a text block finds nothing in the sidebar while `GET /entities?q=<word>`
  returns the entity. KOL-061 flagged this as "a real gap worth filing separately" when it stopped shipping `blocks` to
  the list route — before that projection the browser at least *had* the text to search, so the projection made a
  pre-existing gap permanent. Build: the search box queries the server; the category and tag pills stay local.
  `useFilters` keeps `activeCat`/`activeTag` as in-browser filters but takes the searched set as an input rather than
  searching it — with a non-empty `searchQuery`, `WikiLayout.vue:224` feeds it `GET /entities?q=<term>` (debounced
  ~250 ms, newest response wins: an overtaken request must never replace a newer one, the guard
  `client/src/composables/useEntityTypes.js` already implements) and with an empty one it falls back to the full loaded
  list. Because a match can now be invisible, a row whose only hit was inside a block gets a "matched in text" line in
  `client/src/components/EntitySidebar.vue`, so no result appears without a reason the reader can see. Tiered logging
  `SEARCH_LOG_LEVEL = off | light | normal | verbose` (default light): light names each query, its source (a typed term,
  a cleared box, a pill change), the row count, and every stale response discarded. Files:
  `client/src/composables/useFilters.js`, `client/src/components/WikiLayout.vue`,
  `client/src/components/EntitySidebar.vue`, `client/src/api/entities.js`, and the `GET /entities` row of `docs/api.md`
  if the server grows a `matchedIn` hint. Verify: a new `client/src/composables/useFilters.test.js` — an empty box
  filters locally with no request, a typed term calls the API once after the debounce rather than once per keystroke, an
  overtaken response is discarded, a failed request keeps the previous results and raises a toast instead of emptying
  the sidebar, and a category pill still narrows a server result set. `client/src/components/EntitySidebar.test.js` — a
  row that matched only in a block carries the "matched in text" line. `server/tests/http/entitySearch.test.js` — one
  case pinning that `?q=` finds a word present only in block markdown, which is the behaviour the client now depends
  on. `cd client && yarn test && yarn build` and `cd server && yarn test` green. Out of scope: a MongoDB text index or
  `$text` ranking (an Atlas index change), fuzzy matching (`fuse.js` is a dependency in `client/package.json` and
  imported nowhere in `client/src` — removing it belongs to KOL-013), server-side tag search (`?tag=` is exact-match by
  design), and highlighting the matched span inside the block.
- [x] **(KOL-067) Pagination and a total count on `GET /entities`** (routine 2026-10-10, fbd3c73)
  `GET /entities` (`server/src/routes/entities.js:66`) returns every entity in the workspace, unbounded:
  `Entity.find(filter).sort({ title: 1 })` with no `limit`, no `skip` and no cursor, and `loadEntities`
  (`client/src/composables/useEntities.js:10`) calls it on page load and again after every create. KOL-061 took the block
  content out of that response; the row count is still the whole workspace, and it is the first request every tenant
  makes. At a few thousand entities the projected rows are still a megabyte of JSON serialized in one go on the single
  event loop this multi-tenant API shares, so one tenant opening a large workspace stalls everybody else's requests.
  KOL-049 and KOL-061 both put pagination out of scope, and KOL-061 said it "deserves its own item". Build: keyset
  pagination on the sort the route already uses. `?limit=` (an integer 1–200, read through an integer counterpart to
  `searchTerm` in `server/src/lib/searchFilter.js` so a bracketed operator or a repeated parameter is *no* limit rather
  than one the caller never wrote) and `?after=` (the `title` and `_id` of the previous page's last row — titles are not
  unique, so the filter is `{ $or: [{ title: { $gt: t } }, { title: t, _id: { $gt: id } }] }` and the sort becomes
  `{ title: 1, _id: 1 }`; keyset and not `skip`, because `skip` on a growing collection drops and repeats rows between
  pages). With `limit` present the response is an envelope `{ items, nextAfter: { title, _id } | null, total }`, `total`
  from a `countDocuments` of the same filter; without it the response stays today's bare array, so the MCP tools, the
  chat tool and any outside script keep working — the envelope is what KOL-061 called the breaking part, and making it
  opt-in is what keeps this item from being one. Client side, `getEntities` (`client/src/api/entities.js:30`) gains a
  paged variant and `loadEntities` appends page by page at `limit=200`, clearing `sidebarLoading` after the *first*
  page so the sidebar paints immediately instead of waiting for the workspace. Tiered logging
  `ENTITY_LIST_LOG_LEVEL = off | light | normal | verbose` (default light): light names each page's limit, cursor and
  row count and the query string it came from, because a page boundary that drops or repeats a row leaves no other
  trace. Files: `server/src/routes/entities.js`, `server/src/lib/searchFilter.js`, `client/src/api/entities.js`,
  `client/src/composables/useEntities.js`, the `GET /entities` row of `docs/api.md`, and a Decision Log line in
  `kol_emet_spec.md` for the envelope-only-when-asked shape. Verify: `server/tests/http/entityList.test.js` grows — no
  `limit` returns the bare array unchanged; `?limit=2` returns the envelope with the first two rows by title and a
  `total` for the whole filter; paging with `nextAfter` walks a fixture containing two entities with the *same* title
  exactly once each; `?limit=0`, `?limit=abc`, `?limit=-1` and `?limit[$gt]=1` are each no limit and `?limit=9999` is
  capped; `?q=` and `?category=` still filter and `total` counts the filtered set; a second workspace's rows never
  appear on any page. Plus a `client/src/components/WikiLayout.test.js` case where a two-page load ends with every
  entity listed. `cd server && yarn test` and `cd client && yarn test && yarn build` green. Out of scope: making the
  client's search box ask the server (KOL-068), a MongoDB text index (an Atlas index change), offset/`skip` paging, and
  pagination for `/conversations`, `/drafts` and `GET /entities/:id/history`, which already cap at 50.
- [x] **(KOL-064) Backlog audit: file new candidates under Proposed** [not-before: 2026-10-08] (routine 2026-10-08, a8d0d5c)
  A standing upkeep item, last on purpose: it runs only when nothing above it is claimable. Candidate sources, in
  order: `docs/roadmap.md`, `docs/build-plan.md`, `docs/generator-v1-plan.md` "Remaining work", `docs/wishlist.md`,
  the Decision Log in `kol_emet_spec.md`, the outcomes under Completed Items and the review files under
  `ops/routine/reviews/`, and TODO/FIXME comments. For every candidate grep the code and `git log` and confirm it
  is NOT built before filing it; re-proposing a shipped feature is the failure this item exists to prevent. File
  3–8 items under `## Proposed` in this file's exact format (next free ids, never reuse one): a one-line title,
  then an indented body with what to build, the files involved, the verify commands, and what is out of scope.
  Every item must serve the public multi-tenant product (CLAUDE.md). Tag every filed item `[proposed]` — Daniel
  promotes one by deleting the tag, and the daily update lists them. Skip anything needing a credential, a paid
  generator run, an Atlas index change or a product decision unless the item IS that decision. Then renew this
  item: append a copy of this block at the bottom of `## Workqueue Items` with the next free id and the tag
  `[not-before: <today + 7 days as YYYY-MM-DD>]`, so it runs weekly. The PR touches only FEATURES.md. Verify:
  `node <orchestrator> lint kol-emet --worktree` exits 0 (the `<orchestrator>` path is the one this runbook names
  for `diff-policy`).
- [x] **(KOL-063) Keyboard shortcuts: `/` to search, Escape to close the topmost layer** (routine 2026-10-07, 2bc1c8a)
  Most keys are bound inside individual inputs — `EntityEditor.vue`'s tag combobox, `ChatPanel.vue`'s composer, and
  `GeneratorOverlay.vue`'s root `@keydown.esc`, which fires only while focus is inside the overlay (so at the braindump
  stage, which autofocuses its textarea, but not once that unmounts). One global listener already exists:
  `client/src/components/GraphView.vue:323` registers `window.addEventListener('keydown', onKey)` inside `initGraph`,
  closing the graph on Escape, stashed on `containerRef.value._keyListener` at :325 and removed in `onBeforeUnmount` at
  :417-419. (An earlier draft of this item said nothing was global, on a `grep -rn window.addEventListener client/src`
  that found nothing: GraphView.vue carried a literal NUL byte, so grep took the whole file for binary and never showed
  its matches. KOL-065 wrote that byte as `\u0000` instead, and the grep is honest again.) So the gap is narrower than
  "nothing is global": the search box is reachable only with the mouse, and Escape does nothing for the detail panel, the
  chat panel or the Settings overlay, each of which has a ✕ button and nothing else
  (`client/src/components/WikiLayout.vue`) — while the graph already closes on it. The wishlist asks for exactly this, and
  it is the cheapest item on it. Build `client/src/composables/useKeyboardShortcuts.js`: one `keydown` listener added
  `onMounted` and removed `onUnmounted`, taking a map of key → named handler, with a single rule deciding whose key it is
  — a target that is an `input`, `textarea`, `select` or `[contenteditable]` keeps every key except Escape, and a key held
  with `ctrl`, `meta` or `alt` is never ours. `WikiLayout.vue` registers three: `/` focuses the sidebar search input,
  through a ref the sidebar exposes with `defineExpose` rather than a DOM query, and prevents the character being typed;
  `Escape` closes the topmost layer in one stated order — Settings (`closeSettings`), generator, graph, chat
  (`onChatClose`), then the detail panel — so repeated presses walk back out; `n` opens the new-entity editor. Exactly one
  global listener may own Escape, so GraphView's `onKey`, its `_keyListener` stash and its removal go and the layout's
  chain sets `graphOpen = false` instead; leave both in place and a single press with the graph and the chat open closes
  both layers at once, the opposite of walking back out. GraphView keeps emitting `close`, which its ✕ still does.
  `GeneratorOverlay.vue`'s `@keydown.esc` stays — it is scoped to the overlay's own subtree rather than global, and it
  closes the same layer the chain closes first, so a double call is a no-op. Each binding is a named function, not an
  inline arrow, so the whole shortcut set reads in one place and each is testable. Verify:
  `client/src/components/WikiLayout.test.js` — `/` on the document focuses the search input and types no `/`; `/` while
  the search input already has focus types a `/`; `Escape` with the graph, the chat and the panel all open closes the
  graph first, the chat on the second press and the panel on the third; `n` opens the editor; a shortcut with `ctrl`
  held does nothing; `Escape` inside a textarea still reaches the handler; and no handler fires after unmount. That test
  shallow-mounts, so GraphView is a stub and the listener deleted from it cannot regress there: pair it with
  `grep -rn "window.addEventListener" client/src`, which must name the composable and nothing else.
  `cd client && yarn test && yarn build` green; no server change. Out of scope: a `?` cheatsheet overlay,
  user-configurable bindings, shortcuts inside the draft review UI, and anything that moves focus while the chat composer
  has it.
- [x] **(KOL-062) An `/events` stream ends when its session does, and one tenant cannot open an unbounded number** (routine 2026-10-07, 8e6698c)
  `GET /events` (`server/src/routes/events.js`) authenticates once with `requireAuth` and then holds the response open
  forever; `addClient` (`server/src/lib/broadcaster.js:20`) stores only `{ res, workspaceId }`. Two consequences for a
  multi-tenant API. A stream outlives its session: after `POST /auth/logout`, or after the account is deleted, the socket
  keeps receiving `entity:created`/`entity:updated` payloads, and those carry whole entity documents — so the browser on a
  shared machine that "signed out" still has the workspace's content arriving. And there is no cap: a script holding one
  valid session can open thousands of streams, each a held socket plus a write every 30 seconds in the keep-alive loop, on
  the single process every tenant shares. Build: `addClient` also stores `userId` and `req.sessionID`, and the keep-alive
  sweep — which already walks every client every 30 seconds — drops a connection whose session is no longer in the store,
  through a resolver `createApp` passes in, so the broadcaster keeps no Mongo dependency and its existing unit test keeps
  working. `POST /auth/logout` and `DELETE /auth/account` close that session's streams at once rather than waiting for the
  sweep. A per-user cap, `EVENTS_MAX_STREAMS_PER_USER` (default 10), refuses a further connection with one SSE
  `event: error` line and a close. Tiered logging `SSE_LOG_LEVEL = off | light | normal | verbose` (default light)
  replaces the unconditional `console.log`s in `broadcaster.js`: light says *why* each connection ended — closed by the
  client, session gone, over the cap — not only that the count changed. Document the variable in `server/.env.example`
  and the behaviour in the `GET /events` row of `docs/api.md`, and add the Decision Log line. Verify:
  `server/tests/unit/broadcaster.test.js` grows cases for the cap and for the sweep dropping a session the resolver no
  longer knows; a new `server/tests/http/events.test.js` — two streams for one user both receive a broadcast, the
  eleventh is refused, a stream stops receiving once its session is destroyed, and a second workspace's stream receives
  nothing; `cd server && yarn test` green. Out of scope: moving the broadcaster off in-process state so it works across
  API instances (the same limit KOL-035 recorded for the attempt counters), replacing SSE with WebSockets, and
  reconnect/backoff in `client/src/composables/useEvents.js`.
- [x] **(KOL-061) `GET /entities` stops shipping every entity's block content** (routine 2026-10-07, 38f84c8)
  `GET /entities` (`server/src/routes/entities.js:41`) returns every entity in the workspace as a full hydrated Mongoose
  document, `blocks` and all, and the client asks for it unfiltered on load (`getEntities` in
  `client/src/api/entities.js`, `loadEntities` in `client/src/composables/useEntities.js`). Nothing on the list path uses
  `blocks`: the sidebar card, the virtual list and `useFilters` read `title`, `summary`, `category` and `tags` only, and
  both the detail panel and the editor work from `GET /entities/:id`, which does its own `.lean()` read. So the single
  request that decides how long a workspace takes to open carries the entire text of the wiki — megabytes per load, per
  tab, per reconnect for a workspace of a few hundred real entities, and it is the first request every new tenant makes.
  Build: the list route selects the fields the list needs (`title`, `category`, `summary`, `tags`, `open_questions`,
  `relationships`, `createdAt`, `updatedAt`) and reads `.lean()`, matching the single-entity route; `?include=blocks`
  returns the old shape, so a caller outside this repo is not cut off. The `?q=` filter is untouched: it matches
  `blocks.data.markdown` in the *query*, which needs no projection. Measure the win in the test rather than asserting it
  in a comment — one case compares the serialized length of the projected response against the `?include=blocks` one for
  a fixture entity with a large markdown block. Document the parameter in the `GET /entities` row of `docs/api.md`.
  Verify: a new `server/tests/http/entityList.test.js` — the default response carries no `blocks` key and keeps every
  field the client reads, `?include=blocks` carries them, `?q=` still finds an entity by a word that appears only inside a
  block, and a second workspace's entities stay absent; `client/src/components/WikiLayout.test.js` renders a list whose
  entities have no `blocks` without error; `cd server && yarn test` and `cd client && yarn test && yarn build` green.
  Out of scope: pagination and a total count on `GET /entities` (KOL-049 put it out of scope; it turns the response from
  an array into an envelope and deserves its own item), making the client's search box ask the server — a real gap worth
  filing separately, since `useFilters` searches titles, summaries and tags in the browser while the server's `?q=` reads
  block markdown, so block text is not searchable in the UI at all — and the full-text index the wishlist wants (an Atlas
  index change).
- [x] **(KOL-060) Restore a deleted entity from its snapshot** (routine 2026-10-07, 2fc69c8)
  A delete is final today. `DELETE /entities/:id` (`server/src/routes/entities.js:139`) removes the document, `logDelete`
  (`server/src/lib/changeLogger.js:92`) keeps the whole snapshot for the `ChangeLog` TTL's 30 days, and the delete
  broadcast carries it, so a toast in another open tab can open a read-only `[DELETED]` panel
  (`client/src/components/WikiLayout.vue:306`). But the rollback route reads the live entity first and answers 404 when it
  is gone (`server/src/routes/changelog.js:41`), so that snapshot can be looked at and never put back — and once the toast
  is dismissed nothing in the client can reach it, because the entity is no longer in the list and the history route is
  keyed by an id the user no longer has. For a wiki whose history view is its whole safety net, an accidental delete is
  unrecoverable while the data is still sitting in the database. Build: on a `deleted` log entry with no live entity, the
  rollback route recreates the document with its original `_id` and the snapshot's fields under `req.workspaceId` — never
  the snapshot's own `workspaceId`, which is null for snapshots predating tenancy and is the reason the current route
  strips it — writes a `logCreate` attributed to the caller, and broadcasts `entity:created`; 409 when the id is live
  again, so a restore never silently overwrites. And a way back in that outlives the toast: `GET /deleted` in
  `server/src/routes/changelog.js` lists this workspace's `changeType: 'deleted'` entries newest first with
  `entityTitle`, `createdAt`, `actorLabel` and the log id, capped at 50 and skipping ids that are live again; a "Recently
  deleted" group in Settings (`client/src/components/WikiLayout.vue`, beside the Passkeys group) lists them with a Restore
  action calling the rollback route through a new `restoreEntity` in `client/src/api/entities.js`. Document both in
  `docs/api.md`. Verify: `server/tests/http/restore.test.js` — delete an entity, restore it, and it is back at the same
  `_id` with its blocks, tags and `open_questions`, with a `created` ChangeLog entry naming the actor; a second restore is
  409; `GET /deleted` lists the entry and stops listing it once restored; another workspace's deleted entity is neither
  listed nor restorable (404); a snapshot naming a type the registry no longer has is refused the way KOL-059 decides;
  plus a client test that the Settings group lists and restores; `cd server && yarn test` and `cd client && yarn test &&
  yarn build` green. Out of scope: rebuilding the relationship groups the delete pruned (their other members are gone and
  re-deriving the edges is drift detection, not a restore — say so in the UI), a soft-delete/archive state on `Entity`
  (the wishlist's own idea, and a different product shape), lifting the 30-day TTL (KOL-019), and bulk restore.
- [x] **(KOL-059) A rollback whose snapshot names a renamed entity type answers 409, not 500** (routine 2026-10-07, 1c273f6)
  `POST /entities/:id/rollback/:logId` (`server/src/routes/changelog.js:27`) replays `log.snapshot` through
  `findOneAndUpdate` with `runValidators: true`, and `Entity.category` validates against the workspace's `EntityType`
  registry (`server/src/lib/entityTypeRegistry.js`). Renaming a type cascades to everything that used it
  (`relabel`, `server/src/routes/entityTypes.js:96`) but writes no `ChangeLog`, so every snapshot taken before the rename
  still holds the old name — the Decision Log records this as a known gap on the rename entry. The restore then throws a
  `ValidationError` that the route's catch turns into a 500 `{ error: '"Characters" is not an entity type in this
  workspace' }`: a permanent, unfixable failure reported as a server fault, with no way for the user to get that version
  back. Build, in the rollback route: before the write, check the snapshot's `category` with `isRegisteredCategory` and,
  when it is gone, answer 409 `{ error, snapshotCategory, availableCategories }` naming the stale type — and accept an
  explicit `{ category: '<a registered name>' }` in the body as the caller's decision, so the version can be restored
  under the type that replaced it. `GET /entities/:id/history` marks each entry whose snapshot category is no longer
  registered with `snapshotCategoryMissing: true`, from one registry read for the whole page rather than one per entry, so
  the client can say which versions need a choice before the user clicks. In `client/src/components/EntityDetail.vue`'s
  history list such an entry offers the workspace's types from `useEntityTypes` and sends the chosen one. Add the Decision
  Log line recording that a rename deliberately does *not* rewrite snapshots: they are the audit trail, and editing
  history to make a restore succeed is the wrong trade. Verify: `server/tests/http/rollback.test.js` — rename a type, then
  a rollback to a pre-rename snapshot is 409 naming the old category and the workspace's types and changes nothing; the
  same call with `{ category: '<new name>' }` is 200 and the entity holds the new name; a rollback needing no choice is
  unchanged; history flags exactly the affected entries and no others; a deleted type behaves as a renamed one does; plus
  a client test that the history row renders the picker; `cd server && yarn test` and `cd client && yarn test && yarn
  build` green. Out of scope: writing `ChangeLog` entries for the rename cascade itself (one per entity, and a
  `changeType` the model does not have), the same stale-name failure when applying an old draft item (`proposed` payloads
  are training records and are deliberately not rewritten), and restoring a *deleted* entity (KOL-060 — if both are
  promoted, this one first).
- [x] **(KOL-058) Refuse a cookie-authenticated write whose Origin is not this deployment's client** (routine 2026-10-06, a2c1f66)
  Nothing in `server/src` checks `Origin` or carries a CSRF token, and production deliberately issues the session cookie
  with `sameSite: 'none'` (`server/src/lib/sessionCookie.js:114`) because the client and the API sit on sibling subdomains
  — so a browser sends it on cross-site requests. CORS is not the gate it looks like: `server/src/app.js:69` mounts
  `express.urlencoded({ extended: false })` globally, and a form-encoded POST is a *simple* request, sent with no preflight;
  only the response is blocked, never the write. An attacker's page therefore reaches every cookie-authenticated POST with
  the victim's session: `POST /entities` (`server/src/routes/entities.js:89`) creates content from
  `title=&category=&summary=`, `POST /drafts` (`server/src/routes/drafts.js:104`) spends the victim's AI allowance from
  `text=`, `POST /entities/:id/rollback/:logId` (`server/src/routes/changelog.js:27`) and `POST /auth/logout`
  (`server/src/routes/auth.js:191`) need no body at all, and `POST /authorize` (`server/src/routes/oauth.js:91`) re-points
  `Settings.mcpUserId` at whoever is signed in. PUT and DELETE are preflighted and so already refused. Build
  `server/src/middleware/originGuard.js`: for every unsafe method (POST, PUT, PATCH, DELETE) arriving as a *session*
  caller, require `Origin` to equal `CLIENT_ORIGIN` or the request's own origin — the two OAuth approval pages post to
  `/authorize` and `/bridge/authorize` from pages this API served — falling back to `Referer`'s origin when `Origin` is
  absent, and refuse anything else with 403 `{ error: 'CROSS_ORIGIN_REQUEST' }`. A `Bearer` caller is exempt: MCP sends
  no cookie, so no browser can ride it. Mount it in `createApp` directly after the session middleware and ahead of every
  router, so a route added later cannot land outside it. Second layer, because the Origin check is one header:
  move `express.urlencoded` off the app and onto the *four* form-encoded routes that need it — `POST /authorize` and
  `POST /oauth/token` (`server/src/routes/oauth.js:91,125`) and the Steadfast bridge's own issuer,
  `POST /bridge/authorize` and `POST /bridge/oauth/token` (`server/src/routes/bridge.js:135,153`) — so a cross-site
  simple POST cannot form a body any other route will parse. Four and not two: the bridge runs a second
  authorization-code + PKCE flow for its own connector over the same form encoding, and with `express.json()` left
  global an unparsed form POST arrives as `req.body = {}` rather than a throw, so the two bridge endpoints answer 400
  `missing required parameters` and 400 `unsupported_grant_type` — both measured against this tree — and the bridge
  connector's code exchange dies quietly. Mount the parser inside each router next to its own routes rather than in
  `createApp`, so the bridge stays self-contained (its header, and docs/architecture.md). Log at light when
  `CLIENT_ORIGIN` is unset in production, the way `sessionCookie.js` logs a missing cookie domain — `cors()` then
  answers `Access-Control-Allow-Origin: *`, which no browser will use with credentials. Tiered logging
  `ORIGIN_GUARD_LOG_LEVEL = off | light | normal | verbose` (default light): light names every refusal with the method,
  the path, which header it read and the allowlist it compared against, because a 403 nobody can explain is this
  change's failure mode. Document the variable in `server/.env.example`, the 403 in `docs/api.md`, and add the Decision
  Log line in `kol_emet_spec.md`. Verify: `server/tests/unit/originGuard.test.js` — a matching origin, a foreign origin,
  a missing `Origin` with a matching `Referer`, neither header, a safe method, and a bearer caller;
  `server/tests/http/originGuard.test.js` — `POST /entities` with a valid session and `Origin: https://evil.test` is 403
  and creates no entity, the same POST with the configured origin is 201, a form-encoded `POST /entities` is not parsed
  into a write, and `POST /oauth/token` still accepts its form body; `server/tests/http/bridge.test.js` — the two
  existing token-issuance tests drive both bridge endpoints with `.type('form')` and stay green, which is what catches a
  parser left behind. And give the suite an origin as part of this item: no test under `server/tests/http` sends an
  `Origin` and none sets `CLIENT_ORIGIN`, so every session-cookie POST in it is a 403 the moment the guard mounts — set
  `CLIENT_ORIGIN` in each http test's env block and send a matching `Origin` (or a helper that does both) rather than
  meeting the mass failure mid-run. `cd server && yarn test` green. Out of scope: a double-submit or synchronizer CSRF
  token (the Origin check is the whole fix while every client is a browser on one known origin), `sameSite: 'lax'` (it
  would break the cross-subdomain deployment), the `cors()` wildcard behaviour itself, and rate limiting.
- [x] **(KOL-054) Re-proposing a relationship group updates it instead of stacking a second one** (routine 2026-10-06, ab01575)
  `applyRelationship` (`server/src/lib/draftApplier.js:176`) always does `RelationshipGroup.create(...)`. Nothing looks for a
  group that already holds those members under that label, so re-importing an unchanged docker-compose file — the ordinary case,
  and the one `textHash` exists to recognise — adds a second "Depends on" group for every edge it found the first time, and each
  entity's Relationships section shows the link twice. KOL-045's Decision Log entry records this as accepted and names the
  reason: "recognising an existing group is drift detection, which is out of scope". It is the smallest piece of the roadmap's
  continuous-sync work and the one that makes re-import safe. Build: match where the entities are already matched, not in the
  write — a proposed relationship whose resolvable member set (order-insensitive, by resolved entity id) and label equal an
  existing `RelationshipGroup` in the workspace becomes `op: 'update'` with `targetGroupId` and
  `matchedBy: 'same-members-and-label'`, in `server/src/lib/draftNormalizer.js` and
  `server/src/lib/producers/dockerCompose.js`; `targetGroupId` joins the relationship payload in
  `server/src/lib/draftItemSchema.js`. `applyRelationship` then updates that group in place — `$set` on the matching member's
  label and notes, never removing a member a human added — and returns its id. A member that only resolves at apply time (a
  sibling `localKey`) is matched inside `applyRelationship` against the ids it has just resolved, so the check happens once,
  wherever the ids become known. Verify: `server/tests/unit/draftNormalizer.test.js` and
  `server/tests/unit/dockerCompose.test.js` — a second parse against a workspace already holding the group yields `op: 'update'`
  carrying the group's id; `server/tests/http/composeDraft.test.js` — posting the fixture twice and applying both drafts leaves
  exactly one group per edge and each entity's `relationships` array the same length, and a group a human has added a third
  member to keeps that member; `cd server && yarn test` green. Out of scope: proposing the *removal* of a link that has
  disappeared from the source (drift detection proper), deduplicating groups created before this item, `ChangeLog` entries for
  relationship writes (the applier records none today), and open-question dedup.
- [x] **(KOL-053) Workspace-wide tag rename, merge and delete** (routine 2026-10-06, 00b46e4)
  `GET /tags` (`server/src/routes/tags.js`) is the entire tag surface: tags are editable one entity at a time in the editor's
  comma-separated field, and KOL-041 put bulk operations out of scope. A workspace holding `train`, `Train` and `trains` has no
  way to fix it short of opening every entity — the wishlist's "Bulk tag operations". Build, in `server/src/routes/tags.js`:
  `PUT /tags/:tag` with body `{ to }` renames the tag on every entity in the caller's workspace, merging when `to` is already
  present (`$addToSet` then `$pull`, so no entity ends up holding it twice) and answering `{ renamed: <count> }`, 404 when no
  entity carries the tag, 400 for a blank or non-string `to`, and a no-op 200 for a rename to itself; `DELETE /tags/:tag`
  removes it everywhere and answers `{ removed: <count> }`. Both take `requireActor` per route, the way the write routes in
  `server/src/routes/entities.js` do (the mount gives them only `requireAuth` + `resolveWorkspace`), and both write one
  `logUpdate` per changed entity (`server/src/lib/changeLogger.js`), which makes a bulk rename as reversible as a single edit and
  broadcasts `entity:updated` so open clients follow. Bound it like KOL-045 bounded the compose import: past 200 affected
  entities the route answers 413 naming the count rather than writing an unbounded batch of changelog entries. Client: a "Tags"
  group in Settings (`client/src/components/WikiLayout.vue`, beside the Passkeys group) listing the workspace's tags with their
  entity counts and a rename and remove action each, calling new `renameTag`/`removeTag` in `client/src/api/tags.js`; the counts
  come from the entities `useEntities` already holds, not a new route. Document both routes in `docs/api.md`. Verify:
  `server/tests/http/tags.test.js` — a rename moves the tag on two of three entities and leaves the third alone; a merge leaves
  exactly one copy; a delete removes it; each writes one `ChangeLog` entry per changed entity; a second workspace's
  identically-named tag is untouched; a blank `to` is 400 and 201 entities is 413; a client test that the group renders the tags
  with counts and calls the routes; `cd server && yarn test` and `cd client && yarn test && yarn build` green. Out of scope: tag
  colours or descriptions, renaming a tag from the entity editor, a tag index on `Entity` (an Atlas index change), and any
  change to the existing tag pill row.
- [x] **(KOL-052) A stable WebAuthn user handle, and telling the authenticator when a passkey is removed** (routine 2026-10-06, 6472f25)
  Two halves of one gap. (1) `POST /auth/webauthn/register/begin` (`server/src/routes/auth.js:250`) calls
  `generateRegistrationOptions` without `userID`, and @simplewebauthn 13 then generates a fresh random handle per registration
  (`generateRegistrationOptions.js:128`) which is never stored. An account with two passkeys is therefore two unrelated WebAuthn
  users: a password manager offering discoverable credentials lists the same account twice, and nothing on the server can name
  the account to an authenticator. (2) The Decision Log's KOL-025 known gap — a passkey removed in Settings stays in its
  authenticator, which keeps offering it and gets "Passkey not recognized". Build: `webauthnUserHandle` on
  `server/src/models/User.js`, 32 random bytes base64url, written at create for a new account and lazily on the first
  `register/begin` for an existing one, and passed as `userID` so every passkey on an account shares one handle.
  `GET /auth/webauthn/passkeys` returns it and the configured `rpId` alongside the list — as sibling fields, leaving
  `passkeySummary` the explicit field list it is, so no public key can leak in. In `client/src/components/PasskeySettings.vue`,
  a successful remove calls `PublicKeyCredential.signalAllAcceptedCredentials({ rpId, userId, allAcceptedCredentialIds })` with
  the ids still on the account; the passkey sign-in failure path in `client/src/api/auth.js` calls
  `signalUnknownCredential({ rpId, credentialId })` when the server answers "not recognized". Both are feature-detected — an
  absent API is a no-op, never an error the user sees — and both log at light naming the source ("Settings → Remove"), matching
  the tiers `PasskeySettings.vue` already has. `rpId` comes from the route rather than `location.hostname`, because
  `WEBAUTHN_RP_ID` is what the ceremonies used. Verify: `server/tests/http/passkeys.test.js` — the handle is created once and is
  identical across two `register/begin` calls, the list route returns it with `rpId`, and no response carries `publicKey`;
  `client/src/components/PasskeySettings.test.js` — removing a passkey calls `signalAllAcceptedCredentials` with the remaining
  ids, and a jsdom without the API still removes the passkey and shows no error; `cd server && yarn test` and
  `cd client && yarn test && yarn build` green. Out of scope: `signalCurrentUserDetails` (nothing renames an account yet);
  passkeys registered before this keep their random per-credential handles, so a signal cannot reach them — they still sign in,
  and the handle is used for new registrations only; the credential-id unique index (an Atlas change, KOL-036's known gap).
- [x] **(KOL-051) Second vertical-ingestion producer: an OpenAPI document becomes a reviewable Draft** (routine 2026-10-06, b53462d)
  The roadmap's Phase 7 vertical ingestion names "repo / OpenAPI / docker-compose / k8s / DB-schema"; KOL-033 built
  docker-compose and put the rest out of scope. `Draft.source.producer` (`server/src/models/Draft.js:111`) is the enum seam and
  its comment already names `openapi`. Build `server/src/lib/producers/openApi.js`: `parseOpenApi(text, { existingEntities })` →
  `{ items, dropReasons }` in exactly the shape `normalizeDraft` emits, reusing what the compose producer established —
  `MAX_ITEMS`, `normalizeTitle` dedup setting `op: 'update'` with `matchedBy: 'exact-normalized-title'`, `nearestTitle` near-miss
  flags, `pruneKnownBlocks`, and `redactSecrets` at the route seam (a spec can carry an example key). Accept JSON and YAML (the
  `yaml` dependency is already there), OpenAPI 3.x and swagger 2.0, refusing anything else with a 400 naming what it found.
  Mapping, deterministic and with no model call: `info.title` → one entity of category Service, with attribute blocks for the API
  version and the spec version and a text block from `info.description`; each `tags[]` entry — or the first path segment when a
  spec declares no tags — → an entity of category API with an attribute block listing its operations (`GET /pets`, …), joined to
  the service by an "Exposes" group (Provider/Endpoint); each `servers[].url` host that is not the service's own → one External
  Dependency entity plus a "Depends on" group. Only local `#/components` `$ref`s are followed, one level deep; an unresolvable
  ref is a drop reason, not a 400. Route `POST /drafts/openapi` in `server/src/routes/drafts.js` beside `/compose`: same body
  (`{ text, filename? }`), same character cap, same 201 shape with `source.producer: 'openapi'` and
  `producerVersion: 'openapi@1'`. Client: add `.json` in `client/src/lib/importFile.js` and move the producer choice from the
  extension to the content — `openapi:`/`swagger:` at the top level wins over compose's `services:`, since both arrive as
  `.yaml` — plus `createOpenApiDraft` in `client/src/api/drafts.js` and the routing in `BraindumpInput.vue`; `DraftReview.vue`
  and the applier are untouched. Document the route in `docs/api.md` and add the Decision Log line. Verify:
  `server/tests/unit/openApi.test.js` against a new `server/tests/fixtures/openapi.yaml` (two tags, three paths, two `servers`,
  one `$ref`) asserting the categories, the Exposes and Depends-on groups, and that a second parse against existing entities of
  the same titles yields updates; `server/tests/http/openApiDraft.test.js` registering with `template:
  'software-architecture'`, posting the fixture, then `decide-clean` + `apply` landing the entities; a client test that a
  `.yaml` holding `openapi: 3.1.0` goes to the new route while the compose fixture still goes to `/drafts/compose`;
  `cd server && yarn test` and `cd client && yarn test && yarn build` green. Out of scope: k8s, repo and DB-schema producers,
  drift detection, LLM enrichment of the parsed graph, modelling request/response schemas (paths and tags only), and any change
  to the review UI.
- [x] **(KOL-050) Throttle account creation on POST /auth/register** (routine 2026-10-05, c0a17bf)
  Registration is open by design (CLAUDE.md) and `POST /auth/register` (`server/src/routes/auth.js:91`) has no limit of any
  kind: every request runs a 12-round bcrypt hash, and every success creates a `User`, a `Workspace` and a full template seed —
  38 relationship types plus starter content for Worldbuilding (`server/src/lib/workspaceSeeder.js`). One unauthenticated client
  can fill the database and spend this API's CPU as fast as it can post. KOL-035 built the counters and left this out of scope
  ("CAPTCHA or signup throttling"). Build: `createAuthLimiter` (`server/src/lib/attemptLimiter.js`) grows a fourth counter kind,
  `signup`, keyed on `req.ip`, with its own limit and window — `perSignupIp`, default 10 per 60 minutes, from
  `AUTH_LIMIT_MAX_SIGNUPS_PER_IP` and `AUTH_LIMIT_SIGNUP_WINDOW_MS` through `authLimitsFromEnv` and the `authLimits` option
  `createApp` already threads. A separate window because sign-in's 15 minutes is the wrong unit for account creation. `pairs()`
  gains `signup` in check order, and a neutral `record(keys, source)` counts alongside `recordFailure`, since what is counted
  here is a success rather than a guess. The route asks `blocked` before the bcrypt hash, refuses with the shared
  `TOO_MANY_ATTEMPTS` body and a `Retry-After`, and records one signup only once a user was created, so a 400 or a 409 costs the
  caller nothing. Light logging names the route and the key kind, never an address. Document the variables in
  `server/.env.example`, the 429 in the `POST /auth/register` row of `docs/api.md`, and add the Decision Log line in
  `kol_emet_spec.md`. Verify: `server/tests/unit/attemptLimiter.test.js` — the signup counter has its own max and window, and an
  injected clock unblocks it independently of the email counter; in `server/tests/http/auth.test.js`, an app built with
  `authLimits: { perSignupIp: 2 }` registers twice, answers 429 with `Retry-After` on the third and creates no `User`, while a
  400 (no password) and a 409 (duplicate email) leave the budget untouched; `cd server && yarn test` green. Out of scope:
  CAPTCHA, email verification, counters shared across API instances (in-process, as KOL-035 recorded), and rate limits on
  `/oauth/token` and `/drafts`.
- [x] **(KOL-049) Escape the caller's search string before compiling it as a regex** (routine 2026-10-05, 3a2f161)
  `GET /entities` (`server/src/routes/entities.js:49`), the MCP `search_entities` tool (`server/src/routes/mcp.js:115`) and the
  chat assistant's copy of it (`server/src/routes/chat.js:192`) each do `new RegExp(q, 'i')` on a string the caller chose.
  `server/src/routes/bridge.js:466` already escapes its own `q` with exactly the character class the other three need — they
  never got it. Two consequences. A query holding regex punctuation is a crash rather than a search: `?q=C++ (v2)` throws a
  SyntaxError inside the route's `try` and answers 500, and a model emitting the same string gets a tool error instead of
  results. And a catastrophic pattern such as `(a+)+$` is matched against every entity's title, summary and block markdown in
  the workspace, on the single event loop this multi-tenant API shares. Express 4's default extended query parser also hands
  `?category[$ne]=Characters` into the filter as an operator object (workspace-scoped, so it selects the caller's own rows, not
  another tenant's), and turns `?q=a&q=b` into an array that stringifies to `a,b`. Build `server/src/lib/searchFilter.js`:
  `escapeRegex(s)` (one copy of the `bridge.js` class), `searchTerm(raw)` → a trimmed string, or null for anything that is not a
  non-empty string, capped at 200 characters, and `keywordFilter(term)` returning the `$or` the three callers build by hand
  today. All three use it, and `GET /entities` runs `category` and `tag` through `searchTerm` too, so a non-string is no filter
  rather than a filter the caller wrote. Verify: `server/tests/unit/searchFilter.test.js` — punctuation matches literally, `.`
  does not match everything, an object, an array and `''` all give null, a 500-character term is capped; a new
  `server/tests/http/entitySearch.test.js` — `?q=(` is 200 and lists the entity whose summary holds `(`, and
  `?category[$ne]=Characters` lists nothing; one case in `server/tests/http/mcp.test.js` where `search_entities` with
  `q: 'C++ (v2)'` returns the match; `cd server && yarn test` green. Out of scope: a MongoDB text index and `$text` search (an
  Atlas index change), searching block fields other than `data.markdown`, pagination on `GET /entities`.
- [x] **(KOL-066) KOL-058's second layer would break a working feature: it moves express.urlencoded off the app ont…** (routine 2026-10-01, 67fdb02)
  Found by the grader of KOL-055 (medium, FEATURES.md:226). KOL-058's second layer would break a
  working feature: it moves `express.urlencoded` off the app onto only oauth.js's `POST
  /authorize` and `POST /oauth/token`, but the Steadfast bridge has its own form-encoded OAuth
  endpoints (`server/src/routes/bridge.js:135` `POST ${ISSUER_PATH}/authorize` and `:153` `POST
  ${ISSUER_PATH}/oauth/token`), which would then receive no parsed body and fail on destructuring
  `req.body` — the item never mentions them, so a run that implements it as written kills the
  bridge connector's code exchange.
- [x] **(KOL-065) KOL-063's premise is false in the code it cites: client/src/components/GraphView.vue:319-325 alre…** (routine 2026-10-01, bd6efb1)
  Found by the grader of KOL-055 (medium, FEATURES.md:338). KOL-063's premise is false in the code
  it cites: `client/src/components/GraphView.vue:319-325` already registers a global
  `window.addEventListener('keydown', onKey)` that closes the graph on Escape (removed at line
  416), so both "nowhere globally: `grep -rn window.addEventListener client/src` finds nothing"
  and "Escape closes the generator overlay but not ... the graph" are untrue — and the proposed
  single ordered Escape handler (Settings → generator → graph → chat → panel) would fire alongside
  GraphView's own listener, so one Escape with the graph and chat both open closes both layers at
  once, the opposite of the "repeated presses walk back out" behaviour the item specifies.
- [x] **(KOL-055) Backlog audit: file new candidates under Proposed** [not-before: 2026-10-01] (routine 2026-10-01, fe14986)
  A standing upkeep item, last on purpose: it runs only when nothing above it is claimable. Candidate sources, in
  order: `docs/roadmap.md`, `docs/build-plan.md`, `docs/generator-v1-plan.md` "Remaining work", `docs/wishlist.md`,
  the Decision Log in `kol_emet_spec.md`, the outcomes under Completed Items and the review files under
  `ops/routine/reviews/`, and TODO/FIXME comments. For every candidate grep the code and `git log` and confirm it
  is NOT built before filing it; re-proposing a shipped feature is the failure this item exists to prevent. File
  3–8 items under `## Proposed` in this file's exact format (next free ids, never reuse one): a one-line title,
  then an indented body with what to build, the files involved, the verify commands, and what is out of scope.
  Every item must serve the public multi-tenant product (CLAUDE.md). Tag every filed item `[proposed]` — Daniel
  promotes one by deleting the tag, and the daily update lists them. Skip anything needing a credential, a paid
  generator run, an Atlas index change or a product decision unless the item IS that decision. Then renew this
  item: append a copy of this block at the bottom of `## Workqueue Items` with the next free id and the tag
  `[not-before: <today + 7 days as YYYY-MM-DD>]`, so it runs weekly. The PR touches only FEATURES.md. Verify:
  `node <orchestrator> lint kol-emet --worktree` exits 0 (the `<orchestrator>` path is the one this runbook names
  for `diff-policy`).
- [x] **(KOL-057) Widening INLINE_ASSIGN_RE to ([A-Za-z0-9_.-]+)(\s=\s)([^\s;&"']+) makes the leading non-secret ke…** (routine 2026-09-26, 20af6fb)
  Found by the grader of KOL-056 (high, server/src/lib/producers/redactSecrets.js:118). Widening
  INLINE_ASSIGN_RE to `([A-Za-z0-9_.-]+)(\s*=\s*)([^\s;&"']+)` makes the leading non-secret key
  swallow the whole value, so an assignment nested inside another assignment's value is never
  scanned: `- JAVA_OPTS=-Dspring.datasource.password=hunter2` and `-
  WEBHOOK_URL=https://h/x?token=abc123` (or `?api_key=...`) now match once with key
  `JAVA_OPTS`/`WEBHOOK_URL`, fail looksSecret, and are skipped — matchAll resumes past the value,
  so `password=hunter2`/`token=abc123` is stored verbatim in source.text, quoted as evidence and
  exported. The old lazy-prefix regex caught both (it could start matching mid-token), and the map
  form still catches both (`JAVA_OPTS: -Dspring...password=hunter2` redacts, because inlineSpans
  sees the value without a leading `KEY=`), so this is both a regression and the same map-vs-list
  asymmetry the change claims to have eliminated, in a narrower case the new table test does not
  exercise.
- [x] **(KOL-056) The fix closes the map-vs-list asymmetry only in one direction.** (routine 2026-09-25, a9276d9)
  Found by the grader of KOL-048 (medium, server/src/lib/producers/redactSecrets.js:107). The fix
  closes the map-vs-list asymmetry only in one direction. SECRET_WORD_BOUNDED adds
  pass|pwd|salt|auth|bearer|cert (and SECRET_WORD_GLUED adds authorization|certificate) to the key
  rule, but INLINE_ASSIGN_RE's word list is unchanged and contains none of pass, salt, auth,
  bearer, cert, certificate or authorization. So `DB_PASS: hunter2` (a key the test itself asserts
  is a credential) is redacted in map form while `- DB_PASS=hunter2` in a compose `environment`
  list matches no rule — sequence items get no key rule, INLINE_ASSIGN_RE needs one of its own
  words, no URL userinfo, no SECRET_SHAPE — and the password is stored verbatim in source.text,
  the evidence quote and the TTL-less export. Same for `- AUTH=abc123`, `- SIGNING_SALT=...`, `-
  HTTP_AUTHORIZATION=...`. The file's new comment states the invariant 'which compose syntax a
  file happens to use must not decide whether a credential leaks', and that invariant still fails,
  just with the two syntaxes swapped.
- [x] **(KOL-042) Backlog audit: file new candidates under Proposed** [not-before: 2026-09-24] (routine 2026-09-24, 373b3a7)
  A standing upkeep item, last on purpose: it runs only when nothing above it is claimable. Candidate sources, in
  order: `docs/roadmap.md`, `docs/build-plan.md`, `docs/generator-v1-plan.md` "Remaining work", `docs/wishlist.md`,
  the Decision Log in `kol_emet_spec.md`, the outcomes under Completed Items and the review files under
  `ops/routine/reviews/`, and TODO/FIXME comments. For every candidate grep the code and `git log` and confirm it
  is NOT built before filing it; re-proposing a shipped feature is the failure this item exists to prevent. File
  3–8 items under `## Proposed` in this file's exact format (next free ids, never reuse one): a one-line title,
  then an indented body with what to build, the files involved, the verify commands, and what is out of scope.
  Every item must serve the public multi-tenant product (CLAUDE.md). Tag every filed item `[proposed]` — Daniel
  promotes one by deleting the tag, and the daily update lists them. Skip anything needing a credential, a paid
  generator run, an Atlas index change or a product decision unless the item IS that decision. Then renew this
  item: append a copy of this block at the bottom of `## Workqueue Items` with the next free id and the tag
  `[not-before: <today + 7 days as YYYY-MM-DD>]`, so it runs weekly. The PR touches only FEATURES.md. Verify:
  `node <orchestrator> lint kol-emet --worktree` exits 0 (the `<orchestrator>` path is the one this runbook names
  for `diff-policy`).
- [x] **(KOL-048) SECRET_WORD_RE requires a non-letter (or string start) immediately before the credential word, so…** (routine 2026-09-23, 7452dd1)
  Found by the grader of KOL-046 (medium, server/src/lib/producers/redactSecrets.js:73).
  SECRET_WORD_RE requires a non-letter (or string start) immediately before the credential word,
  so a key that glues the word onto a preceding letter run is not recognised by looksSecret —
  notably PGPASSWORD, the standard libpq variable. In map form (`PGPASSWORD: hunter2`, the shape
  of the fixture's own POSTGRES_PASSWORD) no rule fires — the key rule misses, INLINE_ASSIGN_RE
  needs `=`, URL_USERINFO_RE needs `://…@`, and no SECRET_SHAPE matches a plain password — so the
  value is stored verbatim in source.text, in the evidence quote, and in the TTL-less verbatim
  export. The same variable in list form (`- PGPASSWORD=hunter2`) IS redacted, because
  INLINE_ASSIGN_RE's prefix `[A-Za-z0-9_.-]*?` has no left boundary, so whether a credential leaks
  depends only on which compose syntax the file used.
- [x] **(KOL-046) The whole compose file is stored verbatim in source.text and each credential-bearing env line is…** (routine 2026-09-21, c02515f)
  Found by the grader of KOL-033 (medium, server/src/routes/drafts.js:307). The whole compose file
  is stored verbatim in source.text and each credential-bearing env line is stored as an evidence
  quote (the fixture itself yields `DATABASE_URL: postgres://app:app@postgres:5432/app`), with no
  redaction; Draft has no TTL by design, draftExporter explicitly allowlists $.source.text and
  $.items[].input.evidence.quote as verbatim (unpseudonymized) export paths, and
  COMPOSE_LOG_LEVEL=verbose prints the quote to server logs. Unlike a braindump the client
  deliberately skips the textarea, so the user never sees or edits what is uploaded — and compose
  files routinely carry POSTGRES_PASSWORD and API tokens.
- [x] **(KOL-045) parseCompose has no counterpart to normalizeDraft's MAX_ITEMS cap, so an authenticated caller can…** (routine 2026-09-21, 8c3c994)
  Found by the grader of KOL-033 (medium, server/src/lib/producers/dockerCompose.js:325).
  parseCompose has no counterpart to normalizeDraft's MAX_ITEMS cap, so an authenticated caller
  can post a 60,000-char compose file declaring thousands of services and get an unbounded draft;
  worse, the near-miss scan is O(proposed entities x workspace roster) synchronous trigram work
  (dockerCompose.js:363-374) and drafts.js re-runs the whole parse a second time when any item
  matched, so one request can block the event loop for seconds and produce a draft no reviewer can
  work through.
- [x] **(KOL-044) A non-string email silently skips the per-email counter, so the 10-per-window guessing budget col…** (routine 2026-09-21, 9d5059c)
  Found by the grader of KOL-035 (medium, server/src/routes/auth.js:124). A non-string `email`
  silently skips the per-email counter, so the 10-per-window guessing budget collapses to the
  100-per-window IP budget. `emailKey()` (auth.js:61) returns `''` for anything that is not a
  string, and `pairs()` in createAuthLimiter (attemptLimiter.js:214) drops keys whose value is
  `''` — so `POST /auth/login` with `{"email": {...}, "password": "guess"}` passes the `!email`
  guard (an object is truthy), is never counted or blocked on the email key, and still reaches
  `User.findOne({ email })` and the bcrypt compare. Because that filter is passed to mongoose
  uncast/unsanitized, an operator object such as `{"$regex": "^victim@example.test$"}` selects a
  chosen account, giving ~100 throttle-free guesses per window per source address against that
  account instead of 10 (and 100 bcrypt hashes of CPU). The route comment's claim that the key is
  counted 'before the lookup, so an unknown address is counted and blocked exactly like a known
  one' does not hold for this input; neither the HTTP nor the unit tests cover a non-string email.
- [x] **(KOL-043) The duplicate check is one-directional across the two stored id forms, so the exact attack it exi…** (routine 2026-09-21, db26166)
  Found by the grader of KOL-036 (medium, server/src/routes/auth.js:285). The duplicate check is
  one-directional across the two stored id forms, so the exact attack it exists to stop is still
  available: `credentialIdQuery(passkey.credentialID)` matches stored values equal to the new id
  or to its legacy double-encoding, but not stored values of which the new id is itself the legacy
  encoding. A crafted authenticator can choose raw credential-id bytes equal to `utf8(victimId)`,
  which @simplewebauthn reports as `credential.id === legacyEncoding(victimId)`; the victim holds
  `victimId` in the current form, so `User.exists` finds nothing and the copy is stored. Sign-in
  for the victim then runs `User.findOne(credentialIdQuery(victimId))`, whose `$in` contains
  `legacyEncoding(victimId)` and therefore matches both rows — mongod may return the attacker's,
  `findPasskey` matches it via the legacy branch, the signature check fails, and the victim is
  locked out: exactly the denial of service KOL-036 claims to close. Including
  `browserCredentialId(passkey.credentialID)` in the query's `$in` would close it. The test suite
  only exercises the covered direction (legacy-stored victim blocks a current-form copy), so
  nothing catches this.
- [x] **(KOL-041) Tag suggestions in the entity editor from `GET /tags`** (routine 2026-09-18, 541497c)
  Wishlist "Tag autocomplete on entry editor". The workspace-scoped `GET /tags` (`server/src/routes/tags.js`) exists, but no client
  code calls it. The editor's tags field is a plain comma-separated input (`client/src/components/EntityEditor.vue:28-32`,
  `tagsInput`). Build: `client/src/api/tags.js` `getTags()`, using the same `req` shape as `client/src/api/entityTypes.js`. In
  `EntityEditor.vue`, fetch once on mount and list up to 8 workspace tags matching the token after the last comma, case-insensitive
  (prefix matches first, then substring matches), excluding tags already entered. A click, or arrow keys then Enter, replaces that
  token and appends `, `; Esc closes the list without closing the editor. Use ARIA combobox attributes (`role="combobox"`,
  `aria-expanded`, `aria-controls`, `aria-activedescendant`). The input stays a text input, and a failed fetch just means no
  suggestions. Verify: new `client/src/components/EntityEditor.test.js` mocking `/tags`: typing `ca` after `alpha, ` lists the
  matching tags but not `alpha`; choosing `castle` gives `alpha, castle, `; a failed fetch renders no list and the typed tags still
  save; `cd client && yarn test && yarn build` green. Out of scope: bulk tag rename/merge, tag colours, any server change.
- [x] **(KOL-040) Mobile: leaving Settings through the tab bar must not leave the settings overlay armed** (routine 2026-09-18, 66a2186)
  Found by the KOL-021 grader and still open. The sidebar's Settings button (`openSettings`, `client/src/components/WikiLayout.vue:256`)
  sets `settingsOpen` along with `mobileTab = 'settings'`. `setMobileTab` (:248) changes only `mobileTab`, and mobile portrait has
  no ✕, so the flag stays set. Rotating to landscape, or anything else that stops the portrait query matching, then brings back the
  full-screen Settings/Delete-account overlay the user had left. Build: `setMobileTab` clears `settingsOpen` whenever the new tab is
  not `settings`. Verify: in `client/src/components/WikiLayout.test.js`, following the test at :69, emit `settings` from
  `EntitySidebar`, click the list tab, and assert the Passkeys group is unmounted; `cd client && yarn test && yarn build` green. Out
  of scope: settings layout, adding a close button on mobile.
- [x] **(KOL-039) Dedup key: trim a title before stripping its leading article** (routine 2026-09-18, 8d371cb)
  Found by the KOL-001 grader and still open. `normalizeTitle` (`server/src/lib/similarity.js:39`) strips `the|a|an` before it trims,
  so `'  The Iron Gate'` keys as `the iron gate`. That misses the exact match against an existing "The Iron Gate", and it misses the
  fuzzy fallback too (≈0.64 < `DUPLICATE_THRESHOLD` 0.72, `server/src/lib/draftNormalizer.js:17`). A padded generated title
  becomes a duplicate entity instead of an update. Callers: `draftNormalizer.js` (:157, :180, :215, :274) and
  `server/src/lib/producers/dockerCompose.js`. No model persists a normalized key, so no migration. Build: collapse and trim
  whitespace before the article strip. Verify: flip the test at `server/tests/unit/similarity.test.js:72-79`, which pins the quirk,
  to assert `normalizeTitle('  The Iron Gate  ') === normalizeTitle('The Iron Gate')`; add `server/tests/unit/draftNormalizer.test.js`,
  where `normalizeDraft` with `existingEntities: [{ _id, title: 'The Iron Gate' }]` and a raw entity titled `'  The Iron Gate'`
  yields `op: 'update'` with `matchedBy: 'exact-normalized-title'`; `cd server && yarn test` green. Out of scope: trimming the
  `proposed` titles stored on drafts (training records), and any change to the threshold.
- [x] **(KOL-038) `GET /auth/me` answers 401 and ends the session when its user no longer exists** (routine 2026-09-17, b2e740e)
  The KOL-021 Decision Log entry's known gap: after `DELETE /auth/account`, the user's other sessions still hold the deleted id.
  Tenant routes refuse them, but `GET /auth/me` (`server/src/routes/auth.js:122`) reads only the session, answers
  `{ authenticated: true }`, and so the client (`client/src/App.vue:12-20`) shows the wiki to a deleted account. Build: `/auth/me`
  checks `User.exists({ _id: req.session.userId })`. When the user is gone, it destroys the session, clears the cookie with its own
  attributes (as :495-502 does) and answers the same 401 `{ authenticated: false }` as an anonymous caller. A lookup error answers
  500, never 200. Update the comment at :497-500 and the Known gaps sentence in the Decision Log. Verify: in
  `server/tests/http/accountDeletion.test.js`, two agents sign in as one user and the first deletes the account; the second's
  `GET /auth/me` is 401 `{ authenticated: false }` and expires `connect.sid` (`clearsSessionCookie`); the `GET /auth/me` tests in
  `auth.test.js` stay green; `cd server && yarn test` green. Out of scope: finding the user's other sessions in the store (connect-mongo
  stores them serialized, not queryable by user), changes to `requireAuth`/`requireActor`.
- [x] **(KOL-037) Session cookie domain from the environment, not hardcoded to Daniel's instance** (routine 2026-09-17, 3632951)
  `createApp` sets `cookie.domain` to `'.kol-emet.danielecker.dev'` whenever `NODE_ENV=production` (`server/src/app.js:72`). This
  is the only instance domain in `server/src`, so any other deployment of the product issues cookies its browsers reject. Also,
  `POST /auth/logout` clears the cookie with a bare `res.clearCookie('connect.sid')` (`server/src/routes/auth.js:116`), which the
  comment at :494 says misses the domain-scoped production cookie. Build `server/src/lib/sessionCookie.js`:
  `sessionCookieOptions(env)` (httpOnly; secure and `sameSite: 'none'` in production, `'lax'` otherwise; `domain` from
  `SESSION_COOKIE_DOMAIN`, host-only when unset) used by `createApp`, and `clearSessionCookie(req, res)`, which reads the
  attributes from `req.session.cookie` before destroy. Logout and `DELETE /auth/account` (:495-502) both call the helper. Document
  the variable in `server/.env.example`. needs-human: Daniel sets `SESSION_COOKIE_DOMAIN=.kol-emet.danielecker.dev` on Railway
  before this deploys; otherwise signed-in browsers end up holding two `connect.sid` cookies. Verify:
  `server/tests/unit/sessionCookie.test.js` covers production with the variable, production without it, and development; in
  `server/tests/http/auth.test.js`, logout's expiring Set-Cookie carries the same Path, HttpOnly and SameSite as the login cookie;
  `grep -rn "danielecker" server/src` prints nothing; `cd server && yarn test` green. Out of scope: cookie name, CORS and WebAuthn
  settings (already env-driven).
- [x] **(KOL-036) Refuse a passkey whose credential id is already registered to any account** (routine 2026-09-17, 2200ec3)
  The known gap in the Decision Log's KOL-024 entry: `POST /auth/webauthn/register/complete` (`server/src/routes/auth.js:150`)
  pushes the verified credential without checking whether any account already holds that id, which WebAuthn §7.1 requires.
  `login/begin` lists an account's ids to anyone who knows its email, so a crafted authenticator can register a copy on a second
  account and make the sign-in lookup (`User.findOne(credentialIdQuery(...))`, :215) ambiguous. Build: after verification, and
  before `user.passkeys.push`, run `User.exists(credentialIdQuery(passkey.credentialID))` (it matches both stored forms,
  `server/src/lib/passkeyIds.js:86`). If a match is found, answer 409 `{ error: 'This passkey is already registered' }` and save
  nothing. Use the same answer whether the holder is the caller or another account. Log at light with the source route, and put the
  `shortId` at verbose. Update the Known gaps sentence in the KOL-024 Decision Log entry. Verify: in
  `server/tests/http/passkeys.test.js` (real P-256 keys, nothing stubbed), alice registers credential X; bob registering the same X
  gets 409 and still has no passkeys; alice registering X again gets 409 and keeps exactly one; X stored in the legacy
  double-encoded form on alice also blocks bob; `cd server && yarn test` green. Out of scope: a unique index on
  `passkeys.credentialID` (an Atlas index change; the check-then-push race stays a documented gap), and `login/begin`'s listing.
- [x] **(KOL-035) Throttle failed password and passkey sign-in attempts** (routine 2026-09-17, 9d9f3b2)
  Nothing limits guessing today: `POST /auth/login` (`server/src/routes/auth.js:90`) runs a bcrypt compare for every request, and
  the Decision Log (KOL-021 entry) records that the password check is not rate-limited, including the one in `DELETE /auth/account`
  (:445). Build `server/src/lib/attemptLimiter.js`: `createAttemptLimiter({ max, windowMs, now = Date.now })` with fixed-window
  counters in a `Map`, expired entries pruned on access. Count failures only: per lowercased email (default 10 per 15 min) and per
  `req.ip` (default 100 per 15 min; `trust proxy` is already set in `server/src/app.js:52`). Check before the bcrypt compare, so a
  blocked key costs no hash. Answer 429 `{ error: 'Too many attempts. Try again later.' }` with `Retry-After`, byte-identical for
  known and unknown emails (the no-enumeration rule `auth.test.js:382` pins). A successful sign-in resets that email's counter.
  Apply to `POST /auth/login`, failures of `POST /auth/webauthn/login/complete` (keyed by IP; that body has no email), and failed
  re-authentication in `DELETE /auth/account` (keyed by user id). Build the limiter inside `createApp` from an `authLimits` option
  (defaults from env) so every test app gets fresh counters. Add tiered logging `AUTH_LIMIT_LOG_LEVEL` (off/light/normal/verbose,
  shaped like `logPasskey`): light logs each block with the key kind and the source route and never the email. Add a Decision Log
  line. Verify: `server/tests/unit/attemptLimiter.test.js` with an injected clock (blocks at max+1, the window expiry unblocks,
  reset clears); a new describe in `server/tests/http/auth.test.js` on an app built with `authLimits: { perEmail: 3 }`: three wrong
  passwords, then 429 even with the right one; an unknown email gets the identical 429 body; another email is still 401; `cd server
  && yarn test` green. Out of scope: counters shared across several API instances (in-process today), CAPTCHA or signup throttling,
  account lockout, `/oauth/token`.
- [x] **(KOL-034) Backlog audit: file new candidates under Proposed** (routine 2026-09-17, 63782a7)
  A standing upkeep item, last on purpose: it runs only when nothing above it is claimable. Candidate sources, in
  order: `docs/roadmap.md`, `docs/build-plan.md`, `docs/generator-v1-plan.md` "Remaining work", `docs/wishlist.md`,
  the Decision Log in `kol_emet_spec.md`, the outcomes under Completed Items and the review files under
  `ops/routine/reviews/`, and TODO/FIXME comments. For every candidate grep the code and `git log` and confirm it
  is NOT built before filing it; re-proposing a shipped feature is the failure this item exists to prevent. File
  3–8 items under `## Proposed` in this file's exact format (next free ids, never reuse one): a one-line title,
  then an indented body with what to build, the files involved, the verify commands, and what is out of scope.
  Every item must serve the public multi-tenant product (CLAUDE.md). Tag every filed item `[proposed]` — Daniel
  promotes one by deleting the tag, and the daily update lists them. Skip anything needing a credential, a paid
  generator run, an Atlas index change or a product decision unless the item IS that decision. Then renew this
  item: append a copy of this block at the bottom of `## Workqueue Items` with the next free id and the tag
  `[not-before: <today + 7 days as YYYY-MM-DD>]`, so it runs weekly. The PR touches only FEATURES.md. Verify:
  `node <orchestrator> lint kol-emet --worktree` exits 0 (the `<orchestrator>` path is the one this runbook names
  for `diff-policy`).
- [x] **(KOL-033) First vertical-ingestion producer: a docker-compose.yml becomes a reviewable Draft** (needs KOL-030) (routine 2026-09-17, 0bc4ff9)
  `Draft.source.producer` (`server/src/models/Draft.js`) is the seam the roadmap names for vertical ingestion and has one value,
  `braindump`. Build a deterministic producer — no LLM call, no budget check, no `reserveGeneration`. Parser
  `server/src/lib/producers/dockerCompose.js`: `parseCompose(text, { existingEntities })` → `{ items, dropReasons }` in exactly the
  item shape `normalizeDraft` emits (`server/src/lib/draftNormalizer.js`: server-assigned `localKey`/`seq`, `kind`, `op`, `proposed`
  matching `entityPayloadSchema`/`relationshipPayloadSchema` in `draftItemSchema.js`, `input.evidence.quote` = the YAML line that
  produced the item, exact-normalized-title dedup via `normalizeTitle` setting `op: 'update'`, `targetEntityId`,
  `matchedBy: 'exact-normalized-title'`). Mapping: each `services.<name>` → an entity of category Service, or Data Store when `image`
  matches a short known list (postgres, mysql, mariadb, mongo, redis, memcached, elasticsearch, rabbitmq, kafka, minio), with an
  `attribute` block each for `image` and `ports`; `depends_on` (list or map form) and `links` → a "Depends on" group with
  Dependent/Dependency roles; an env value holding a URL whose host is another service name → a "Calls" group (Caller/Callee); a URL
  whose host is not a service → one External Dependency entity per host plus a "Depends on" group. Add the `yaml` package to
  `server/package.json` (the one new dependency); parse errors are a 400 naming the line. Route `POST /drafts/compose` in
  `server/src/routes/drafts.js`, body `{ text, filename? }` (the client extracts text in the browser like `importFile.js` already
  does), returning 201 with the draft: `status: 'ready'`, `source.producer: 'docker-compose'`, `producerVersion: 'docker-compose@1'`,
  `textHash` as `POST /drafts` computes it, `grounding.categories` from `getCategories`; extend the `producer` enum. Client: `.yml`/
  `.yaml` in `client/src/lib/importFile.js`, `createComposeDraft` in `client/src/api/drafts.js`, and `BraindumpInput.vue` routes a
  compose file to it and hands the result to the existing review stage in `GeneratorOverlay.vue` — `DraftReview.vue` and the applier
  are untouched. Document the route in `docs/api.md` and add the Decision Log line. Verify: `server/tests/unit/dockerCompose.test.js`
  against a fixture `server/tests/fixtures/docker-compose.yml` (web + worker with `depends_on`, postgres and redis images, a
  `DATABASE_URL` pointing at postgres, an external `https://` URL) asserting categories, the Depends-on/Calls groups, the External
  Dependency, and that a second parse against existing entities of the same titles yields updates; `server/tests/http/composeDraft.test.js`
  registering with `template: 'software-architecture'`, posting the fixture, asserting the producer fields, then `decide-clean` +
  `apply` lands the entities with those categories; `yarn test` green. Out of scope: k8s/OpenAPI/repo producers, drift detection,
  LLM enrichment of the parsed graph, any change to the review UI.
- [x] **(KOL-031) Onboarding: choose a template on signup** (needs KOL-030) (routine 2026-09-17, 5bcc3b9)
  Registration already seeds the personal workspace from the Worldbuilding template by default, and the empty states exist
  (`EntitySidebar.vue:64-80` list, `GraphView.vue:13-15` graph, the generator's input stage), so a new user never lands blank. What
  is missing is the choice. Build: a public `GET /templates` (no auth — it is shown before an account exists; mount in
  `server/src/app.js` next to `/auth`) returning `listTemplates()`; `POST /auth/register` answers 400 for a `template` that
  `hasTemplate` rejects, creating nothing, instead of silently seeding Worldbuilding via `getTemplate`'s fallback; `register` in
  `client/src/api/auth.js:15` takes an optional `template`; in `client/src/views/LoginView.vue` register mode, a radio group "Start
  with" listing the fetched templates (name + description), defaulting to worldbuilding, above the disclosure line, with the
  credential inputs and their `autocomplete` attributes untouched. Document the route in `docs/api.md`. Verify: `server/tests/http/auth.test.js` —
  register with `template: 'software-architecture'` seeds that registry, an unknown key is 400 with no `User` or `Workspace` created,
  and `GET /templates` lists both without a session; `client/src/views/LoginView.test.js` — the picker renders the fetched templates,
  defaults to worldbuilding, and `register` is called with the chosen key; `cd server && yarn test`, `cd client && yarn test && yarn build`
  green. Out of scope: switching a workspace's template later, starter-content or empty-state changes, a public template gallery.
- [x] **(KOL-030) Phase 6 step 5: ship the Software Architecture template alongside Worldbuilding** (needs KOL-027) (routine 2026-09-17, 627b0a7)
  Templates already exist as code-defined bundles: `server/src/config/templates.js` (`TEMPLATES`, `getTemplate`) holds Worldbuilding
  (today's six types with colours, 38 relationship types, two starter entities, one group, one open question) and `seedWorkspace` in
  `server/src/lib/workspaceSeeder.js` seeds it at registration (`server/src/routes/auth.js:69`, which already accepts
  `req.body.template`). The second template was withheld only because the enum would reject its names. Build: add
  `'software-architecture'` (`name: 'Software Architecture'`) with `entityTypes` Service, Data Store, API, Team, External Dependency
  (ordered, each with a `{ bg, text }` colour pair distinct from the six worldbuilding ones), `relationshipTypes` in the same
  `scope: 'group'` / `scope: 'member'` shape as Worldbuilding — group labels Depends on, Owned by, Calls, Exposes with a member-role
  pair each (e.g. Dependent/Dependency, Owner/Owned, Caller/Callee, Provider/Endpoint; `sourceCategory`/`targetCategory` hints such as
  Team → Service for Owner) — and a small starter set mirroring Worldbuilding's shape (one Service, one Data Store, one Depends-on
  group, one open question). Export `listTemplates()` returning `[{ key, name, description }]` and `hasTemplate(key)`; rewrite the
  header comment that says only the worldbuilding template is real. Verify: extend the `seeding` describe in
  `server/tests/http/entityTypes.test.js` — registering with `template: 'software-architecture'` yields exactly the five types in
  order with colours and relationship types including the four group labels, while a default registration still yields the six;
  `yarn test` green. Out of scope: a template picker on signup and a public listing route (KOL-031), changing an existing
  workspace's template, an admin UI for templates.
- [x] **(KOL-029) Phase 6 step 4: client pills, filters, pickers and colours read from /entity-types** (needs KOL-027) (routine 2026-09-17, def7dab)
  Every client category list is hardcoded: `client/src/config/categories.js` (`CATEGORIES`, `CAT_COLORS`) feeds the pill row in
  `client/src/components/EntitySidebar.vue:41,90`, the pickers in `EntityEditor.vue:17-19,123` and `EntityHeader.vue:37-38,65,75`, and
  the colours in `SidebarCard.vue:17,27` and `generator/DraftItemCard.vue:71,85`. Build: `client/src/api/entityTypes.js`
  (`getEntityTypes()` → `GET /entity-types`, same `req` shape as `client/src/api/entities.js`) and a `useEntityTypes` composable in
  `client/src/composables/` that fetches once when `WikiLayout.vue` mounts and exposes the ordered names plus a `styleFor(name)`
  returning `{ bg, color }` from the registry's `{ bg, text }` pair, with today's `{ bg: '#333', color: '#aaa' }` fallback for a name
  the registry lacks; move the five consumers onto it and delete `config/categories.js`. `client/src/components/EntityCard.vue`
  carries its own copies (:91,105) but nothing imports it — delete it rather than migrate it. `config/defaultBlocks.js` stays keyed
  by name (unknown names already get no defaults). No visual change for the six seeded types, whose colours the registry carries.
  Verify: `cd client && yarn test && yarn build` green, with a new `client/src/components/EntitySidebar.test.js` (pattern:
  `WikiLayout.test.js`) that mocks `/entity-types` and asserts the pills render the fetched names in order and a name absent from the
  registry still renders with the fallback colour; `grep -rn "config/categories" client/src` prints nothing. Out of scope: creating
  or editing types from the UI, icons (render none until a type has one), the MCP layer (KOL-028).
- [x] **(KOL-028) Phase 6 step 3: MCP and chat read entity types from the registry** (needs KOL-027) (routine 2026-09-17, dd0488c)
  `server/src/routes/mcp.js` still declares `category: z.enum(CATEGORIES)` on `search_entities` (:124), `create_entity` (:170) and
  `update_entity` (:201), and `server/src/routes/chat.js:150` hands the in-app assistant the same frozen list. Build: those three
  become `z.string()` with a `.describe()` telling the agent to call `list_entity_types` for the valid names (the schema validator
  from KOL-027 refuses anything else, so `create_entity` with an unregistered name throws its message); add a `list_entity_types`
  tool returning the workspace's types (`name`, `icon`, `color`, `order`, sorted like `GET /entity-types`) scoped by
  `mcpWorkspaceId()`; update the `create_entity`/`update_entity` descriptions; in `chat.js` build the `search_entities` tool's
  `category` enum per request from `await getCategories(req.workspaceId)` (the route has `resolveWorkspace`, `chat.js:324`) instead
  of the module constant. Docs: add the tool row to the table in `docs/architecture.md` (~line 69-81) and the MCP Tools table in
  `CLAUDE.md`; drop the `CATEGORIES` import from both routes. Verify: extend `server/tests/http/mcp.test.js` — the `tools/list`
  contract at `:582-594` goes from 13 to 14 names including `list_entity_types`; `list_entity_types` as alice returns only alice's
  types; `create_entity` with a registered custom type succeeds and with an unregistered one errors without writing; `yarn test`
  green. Out of scope: the per-user MCP identity (KOL-014), the client (KOL-029).
- [x] **(KOL-027) Phase 6 step 2: drop the Entity category enum; the EntityType registry alone gates category names** (routine 2026-09-17, 3e6d7ab)
  KOL-020/022 already built the registry, the write-time check (`categoryValidator` in `server/src/lib/entityTypeRegistry.js`, on
  `Entity.category` and `RelationshipType.sourceCategory/targetCategory`), idempotent per-workspace seeding (`seedEntityTypes` in
  `server/src/lib/workspaceSeeder.js`, tested at `server/tests/http/entityTypes.test.js:165`) and the backfill
  `server/scripts/seed-entity-types.js`. What remains is the enum itself. Build: remove `enum: CATEGORIES` from
  `server/src/models/Entity.js:22` (the validator stays and is now the only gate; keep its clear 400 message); in
  `isRegisteredCategory`, a workspace with no types is checked against `CATEGORIES` explicitly instead of returning true, so an
  unseeded or pre-registry workspace keeps today's behaviour; in `server/src/routes/entityTypes.js` drop `canonicalCategory` and
  `notACategory` (any non-blank name is creatable), and make a rename cascade — rename the type, then `updateMany` the workspace's
  `Entity.category` and `RelationshipType.sourceCategory/targetCategory` from the old name to the new — while delete keeps its
  in-use 409 and the last-type 409; `getCategories(workspaceId)` in `server/src/config/categories.js` becomes an async registry
  lookup (names sorted by `order`, falling back to `CATEGORIES` when the workspace has none) and its callers follow:
  `server/src/lib/generator.js:162` and `entityPayloadSchema`/`validateItemPayload` in `server/src/lib/draftItemSchema.js:30`
  (callers `server/src/routes/drafts.js:270` and `server/tests/unit/draftItemSchema.test.js`); `CATEGORIES` stays exported as the
  seed list. Update the tests the enum backed: `server/tests/models/entity.test.js` (an unknown category is still rejected in a
  seeded workspace and in an unseeded one), `entityTypes.test.js:212` (a custom name such as "Vehicles" is now 201 and an entity can
  use it) and `:345` (a rename of an in-use type is 200 and cascades to the entities and relationship types that named it). Update
  `docs/api.md` rows for `POST/PUT /entity-types`, the comment blocks in `EntityType.js`, `entityTypeRegistry.js`, `categories.js`
  and `config/templates.js` that say the enum stands, and add the step-2 line to the Decision Log in `kol_emet_spec.md`. Verify:
  `cd server && yarn test` green, including a rejected unknown category and the existing idempotent-seed test. Out of scope: the MCP
  and chat category lists (KOL-028), the client (KOL-029), any second template (KOL-030).
- [x] **(KOL-032) Scope the two unscoped populate() calls so a planted foreign id never resolves** (routine 2026-09-17, 05679a6)
  The known gap in `docs/data-model.md` ("Known gap", ~line 405): `Entity.open_questions` is populated unscoped in
  `server/src/routes/entities.js:52,63,121`, `server/src/routes/changelog.js:51` (rollback) and `server/src/routes/mcp.js:140,154,216`
  (`search_entities`, `get_entity`, `update_entity`); `OpenQuestion.entry_ids` in `server/src/routes/openQuestions.js:14,25,94` and
  `mcp.js:257` (`list_open_questions`). A caller who writes another tenant's id into either array reads back its title or question
  text. Build: every one of those populates takes `match: { workspaceId: <the request's or the MCP user's workspace> }` and the
  routes drop the `null` entries populate leaves for unmatched ids; `stripTenancy` in `entities.js:31` also strips `open_questions`
  and `relationships` from POST/PUT bodies, since both are server-maintained back-references written only by the open-question,
  relationship-group, applier and seeder code (rollback restores a snapshot and is untouched); `POST/PUT /open-questions` keeps only
  the `entry_ids` that exist in the caller's workspace. Then turn the two `{ todo }` tests at `server/tests/http/tenancy.test.js:402,415`
  into real tests (drop the option, keep the assertions) and add one MCP case in `server/tests/http/mcp.test.js` (`get_entity` on an
  entity carrying a foreign question id returns no foreign text). Update the "Known gap" paragraph in `docs/data-model.md` and the
  roadmap Phase 8 bullet (`docs/roadmap.md:88-91`) to say it is closed. Verify: `cd server && yarn test` green with zero `todo` tests
  left in `tenancy.test.js`. Out of scope: the per-user MCP identity (KOL-014), any change to what `resolveWorkspace` does.
- [x] **(KOL-026) The race is only fixed for UserMemory and Conversation.** (routine 2026-09-16, 8478f74)
  Found by the grader of KOL-023 (medium, server/src/lib/accountDeleter.js:36). The race is only
  fixed for UserMemory and Conversation. Workspace-scoped models (entities, relationship groups,
  open questions and the rest) have no owner guard. A request that looked up its workspace before
  deletion can still insert after the final content sweep, and that row stays forever because a
  re-run finds no workspaces left. The item's defect stays open for all workspace content; the
  diff says so and defers it.
- [x] **(KOL-025) Passkeys on phones: add, list and remove passkeys from Settings** (needs KOL-024) (routine 2026-09-13, b1ae9c6)
  The only way to add a passkey today is the one-time prompt right after signup (`LoginView.vue`,
  `step === 'passkey-prompt'`; `registerPasskey()` has no other caller). A passkey lives on the
  device or password manager that made it, so an account created on a desktop can never get one
  on a phone — cross-device QR sign-in needs the desktop at hand. Build: a "Passkeys" group in
  Settings → Account (`WikiLayout.vue` `.mobile-settings-panel`, a tab on mobile portrait) listing
  the user's passkeys — a label from `deviceType`/`backedUp` ("Synced passkey" / "This device only"),
  added date, last used — with "Add a passkey on this device" and remove. Server:
  `GET /auth/webauthn/passkeys` (`requireAuth`; never returns `publicKey`) and
  `DELETE /auth/webauthn/passkeys/:credentialID` (`requireAuth`, own passkeys only; refuse removing
  the last sign-in method on an account with no password); record `lastUsedAt` on sign-in. Keep
  passwordless "Sign in with passkey" without an email (discoverable credentials, already
  supported). Verify: HTTP tests for list and remove (ownership; `publicKey` never in a response),
  a client test that the Settings group renders and calls the routes. PR `needs-human:` on an
  Android phone and an iPhone, add a passkey from Settings and sign in with it.
- [x] **(KOL-024) Passkey sign-in: credential IDs are stored double-encoded, so no passkey is ever recognized** (routine 2026-09-13, 6bfc564)
  `@simplewebauthn/server` 13 returns `registrationInfo.credential.id` as a base64url string, and
  `POST /auth/webauthn/register/complete` stores `Buffer.from(credential.id).toString('base64url')`,
  which encodes that string a second time. Every lookup compares against the browser's raw id —
  `login/complete` (`passkeys.credentialID === req.body.id`), `login/begin`'s `allowCredentials`, and
  the account-deletion confirmation (`/auth/account/passkey-challenge`, `DELETE /auth/account`) — so
  a registered passkey is answered 401 "Passkey not recognized" on any device. Build: store
  `credential.id` as-is; one helper that matches a stored value against a browser id in both the
  correct and the legacy double-encoded form, used by all three paths; on a successful sign-in
  against a legacy value, rewrite it to the correct form (a lazy migration — no production script);
  send corrected ids in `allowCredentials`; pass `credential.id` to `verifyAuthenticationResponse` as
  the base64url string its type expects, not a Buffer. Also store `createdAt`, `deviceType` and
  `backedUp` from `registrationInfo`, which KOL-025 lists. Verify: unit tests for the helper and the
  lazy rewrite (a legacy value matches once and is rewritten; a correct one matches untouched), and
  the register → login lookup covered with the library's verify functions stubbed or the lookup
  extracted into a tested function; `yarn test` green. PR `needs-human:` sign in with a passkey on a
  real device after the deploy.
- [x] **(KOL-023) The second sweep only shrinks the concurrent-write window; it does not close it.** (routine 2026-09-12, 9e9216a)
  Found by the grader of KOL-015 (medium, server/src/lib/accountDeleter.js:146). The second sweep
  only shrinks the concurrent-write window; it does not close it. Any write that lands after it is
  orphaned for good, because a re-run finds no workspaces left to sweep. The clearest case is chat
  memory extraction, which runs in the background: it makes a slow LLM call and then does
  UserMemory.insertMany({ userId }) (memoryExtractor.js:132). UserMemory is deleted once, after
  the sweep, and never re-checked, so if a chat exchange finishes just before deletion, facts
  about the user can be written after it. That leaves personal data belonging to a hard-deleted
  account.
- [x] **(KOL-022) The 'in use' guard doesn't deliver the promise in the docs and decision log that the registry and…** (routine 2026-09-12, 0641a0f; recorded after the run exited early)
  Found by the grader of KOL-020 (medium, server/src/routes/entityTypes.js:156). The 'in use'
  guard doesn't deliver the promise in the docs and decision log that the registry and data cannot
  drift apart. It only fires when a type is renamed or deleted, and /entities still checks
  category only against the hardcoded enum. So you can delete or rename an unused default type
  (the test itself deletes alice's Timeline with a 204), then create an entity with that category,
  and it succeeds with no registry entry behind it. The reverse also happens: created or renamed
  types that aren't enum values can't be used by any entity. The check also ignores
  RelationshipType.sourceCategory/targetCategory, which store category names too.
- [x] **(KOL-020) Phase 6 step 1: `EntityType` registry model + `/entity-types` routes** (needs KOL-004) (routine 2026-09-10, 9233813)
  Mirror `RelationshipType` (`server/src/models/RelationshipType.js`, `server/src/routes/relationshipTypes.js`) per
  `docs/build-plan.md` Part A; seed the six current categories per workspace; keep the `Entity.category` enum for now
  (`getCategories` in `server/src/config/categories.js` is the seam). Tests: CRUD scoped per workspace, mirroring KOL-004.
  Off the worldbuilding-launch critical path — Daniel should confirm timing before it enters the queue.
- [x] **(KOL-021) Account deletion: the route, the confirmation, and the signup disclosure** (routine 2026-09-10, d5909a3)
  KOL-015 landed the tested cascade (`server/src/lib/accountDeleter.js`) with no caller. Build:
  `DELETE /auth/account` behind `requireActor`, requiring the current password in the body (or a
  fresh passkey assertion) and refusing with 409 when the user is a non-owner member of another
  workspace (the cascade already reports this); on success run the cascade, destroy the caller's
  session (`req.session.destroy`) and clear the cookie, return 204. Client: a "Delete account"
  action at the bottom of settings with a confirmation that requires typing the account email,
  then a signed-out landing. Signup: one line under the form — "You can delete your account and
  all of its data at any time from Settings." Verify: an HTTP test deleting a registered user shows
  every collection empty for that tenant and untouched for a second tenant, the old session cookie
  answers 401 afterwards, and a non-owner member elsewhere gets 409 with nothing deleted.
- [x] **(KOL-015) Account-deletion cascade as a tested library function** (needs KOL-004) (routine 2026-09-10, a5298f7)
  Daniel decided 2026-09-05 that account deletion hard-deletes, drafts included. Build `deleteAccount(userId)` in
  `server/src/lib/accountDeleter.js`: remove the `User`, every `Workspace` they solely own, and every document in those workspaces
  across all models carrying `workspaceId` (grep `server/src/models/`); refuse and report if the user is a non-owner member elsewhere.
  No route yet — `DELETE /auth/account`, its confirmation UI, and the signup disclosure copy are a follow-up tagged `[needs-human]`.
  Verify: `server/tests/lib/accountDeleter.test.js` shows every collection empty for the deleted tenant, untouched for a second tenant.
- [x] **(KOL-011) Sync docs and comments that still say tenancy is "stored, not enforced"** (routine 2026-09-10, 008c194)
  Enforcement shipped (mounts in `server/src/index.js`, `resolveWorkspace`). Fix `CLAUDE.md:74`, `docs/data-model.md:38`,
  `docs/roadmap.md:88` (Phase 8 bullet → done), `docs/wishlist.md:21`, the "Not yet mounted" paragraph in
  `server/src/middleware/workspace.js`, and `docs/architecture.md:90-91` (providers now include OpenRouter and `steadfast` — see
  `server/src/lib/aiProviders.js`). Add `resolveWorkspace` to every guarded row of the `docs/api.md` mount table. No behaviour change.
  Verify — must print nothing: `grep -rn -i "not yet enforced\|not yet filtered\|stored today, not filtered\|Not yet mounted\|known future addition" CLAUDE.md docs server/src`
- [x] **(KOL-010) Add Vitest to the client and test the login form's credential-manager attributes** (routine 2026-09-10, 909e68e)
  Add `vitest`, `@vue/test-utils`, `jsdom` devDependencies and `"test": "vitest run"` to `client/package.json`; a
  `test: { environment: 'jsdom' }` block in `client/vite.config.js`. First test `client/src/views/LoginView.test.js`: the email
  input has `autocomplete="email"`; the password input has `current-password` in login mode and `new-password` in register mode;
  the form has `autocomplete="on"` — the CLAUDE.md password-manager rule made executable. Verify: `cd client && yarn test` green
  and `yarn build` still succeeds. Out of scope: passkey flows, any visual change.
- [x] **(KOL-009) Unit tests for draft validation and the export tripwire** (needs KOL-001) (routine 2026-09-10, 5c2efe5)
  `server/tests/unit/draftItemSchema.test.js`: `validateItemPayload` accepts a minimal entity / relationship / open_question; rejects
  unknown keys (`.strict()`), a relationship with < 2 members, and a member carrying both `localKey` and `refId`; unknown kind →
  `{ ok: false }`. `server/tests/unit/draftExporter.test.js`: `makePseudonymizer` throws without a secret and is deterministic with
  one; `assertScrubbed` throws naming the path when a 24-hex id survives; `toJsonl` on a hand-built draft yields one line whose
  `schema === EXPORT_SCHEMA` with no ObjectId anywhere. Pure — no DB. Verify: `yarn test` green. Out of scope: `normalizeDraft` (KOL-016).
- [x] **(KOL-008) Unit tests for the SSE broadcaster and the pricing table** (needs KOL-001) (routine 2026-09-09, 822f840)
  `server/tests/unit/broadcaster.test.js` with fake `res` objects: `broadcast` without `workspaceId` writes to nobody; delivers only
  to clients in the matching workspace; honours `excludeClientId`; a throwing `res.write` evicts that client. Call `.unref()` on the
  keep-alive `setInterval` in `server/src/lib/broadcaster.js` so the test process can exit (no production effect — the HTTP server
  keeps the loop alive). `server/tests/unit/pricing.test.js`: `costMicros` rounds up (1 token ≥ 1 micro), unknown model → `FALLBACK_PRICE`,
  provider `steadfast` → `SELF_HOSTED_PRICE`, `isEstimatedPrice` false for self-hosted, `formatMicros(3_500_000) === '$3.5000'`. Verify: `yarn test` green. Out of scope: `usageMeter` DB paths.
- [x] **(KOL-007) Fail closed on /mcp when MCP_BEARER_TOKEN is unset in production** (needs KOL-006) (routine 2026-09-09, 5cd2160)
  The auth middleware in `server/src/routes/mcp.js` skips the check entirely when the token is unset ("dev mode"). Keep that when
  `NODE_ENV !== 'production'`; in production answer 503 `{ error: 'MCP not configured' }` and log once at startup. `requireAuth`
  (`server/src/middleware/auth.js`) needs no change — an unset `BEARER_TOKEN` can never match — add a test proving exactly that.
  Verify: new cases in `mcp.test.js` (prod+unset → 503, dev+unset → 200) pass; `yarn test` green. Out of scope: token rotation.
- [x] **(KOL-006) MCP endpoint tests: auth gate, tool list, workspace scoping** (needs KOL-004) (routine 2026-09-09, b06b8ff)
  `server/tests/http/mcp.test.js`: listen on port 0 with `createApp` and drive `/mcp` using the SDK's `Client` +
  `StreamableHTTPClientTransport` (`@modelcontextprotocol/sdk` is already a dependency). With `MCP_BEARER_TOKEN` set: missing/wrong
  token → 401; correct token → `tools/list` returns the 13 names in `docs/architecture.md`; after `setMcpUser(A)`
  (`server/src/lib/mcpUserStore.js`) `search_entities` returns only A's entities and `get_entity` on B's id throws.
  Verify: `yarn test` green. Out of scope: the identity model itself (KOL-014).
- [x] **(KOL-005) Auth route tests: registration, login, logout, session** (needs KOL-003) (routine 2026-09-09, 071fd0b)
  `server/tests/http/auth.test.js`: duplicate email → 409; email stored lowercased (`server/src/models/User.js`); wrong password and
  unknown email return byte-identical 401 bodies (no account enumeration); `GET /auth/me` is 401, 200 after login, 401 after
  `POST /auth/logout`; registration creates exactly one `Workspace` whose `members[0].role === 'owner'` and at least one seeded
  `RelationshipType`. Verify: `yarn test` green. Out of scope: WebAuthn ceremonies (need a browser authenticator); any auth change.
- [x] **(KOL-004) Tenancy isolation integration test across two registered users** (needs KOL-003) (routine 2026-09-08, 2b85c43)
  `server/tests/http/tenancy.test.js` with `createApp` + memory DB + two supertest agents: register A and B through the real
  `POST /auth/register` (real `seedWorkspace`); A creates an entity; B `GET /entities/:id` → 404 (not 403, per
  `server/src/routes/entities.js`), B's `GET /entities` never lists it, B's `PUT`/`DELETE` → 404; a `POST /entities` from B carrying
  A's `workspaceId` lands in B's workspace (`stripTenancy`). Same shape for one `/relationship-groups` and one `/open-questions` route.
  Verify: `yarn test` green, and the suite FAILS with `resolveWorkspace` removed from a mount in `server/src/app.js` (try locally, restore). Out of scope: MCP tenancy (KOL-006).
- [x] **(KOL-003) Add an in-memory MongoDB harness and the first model tests** (needs KOL-002) (routine 2026-09-08, c36de46)
  Add `mongodb-memory-server` devDependency and `server/tests/helpers/db.js` exporting `connect()`/`clear()`/`disconnect()` (one
  `MongoMemoryServer` per test file, collections dropped between tests). If the mongod binary download fails in the routine's
  sandbox, record this item as Blocked — never substitute a live URI. `server/tests/models/entity.test.js`: `Entity` rejects an
  unknown `category` and an unknown block `type` (`BLOCK_TYPES`, `server/src/models/Entity.js`); `Workspace.aiBudget.grantedMicros`
  defaults to `AI_TRIAL_GRANT_MICROS`. Verify: `cd server && yarn test` green. Out of scope: route tests.
- [x] **(KOL-002) Extract an app factory and add the first HTTP tests (OAuth PKCE)** (needs KOL-001) (routine 2026-09-08, db59a43)
  Move everything in `server/src/index.js` except `mongoose.connect` + `app.listen` into `server/src/app.js` exporting
  `createApp({ sessionStore })` (default = the existing `MongoStore`; tests pass `new session.MemoryStore()` so no DB is touched);
  `index.js` becomes a bootstrap importing it — mount order and middleware unchanged. Add `supertest` as a devDependency;
  `server/tests/http/oauth.test.js`: discovery doc lists `S256`; `POST /oauth/token` with a wrong verifier → 400 `pkce mismatch`; a
  consumed code reused → 400; `GET /entities` with no session/token → 401. Verify: `yarn test` green; `yarn start` still boots. Out of scope: DB tests.
- [x] **(KOL-001) Add the server test runner and the first unit test (trigram similarity)** (routine 2026-09-08, c4d607e)
  Add `"test": "node --test \"tests/**/*.test.js\""` to `server/package.json` — Node's built-in `node:test` + `node:assert/strict`,
  no new dependency (Node 22+ for the glob; the dev box runs 24). Create `server/tests/unit/similarity.test.js` covering
  `similarity`, `normalizeTitle`, `findSimilar` from `server/src/lib/similarity.js`: identical strings → 1, empty vs non-empty → 0,
  "The Iron Gate" and "iron gate" normalize to one key, `findSimilar` drops exact case-insensitive matches.
  Verify: `cd server && yarn test` exits 0 with 6+ passing tests. Out of scope: DB, HTTP, or client tests.
