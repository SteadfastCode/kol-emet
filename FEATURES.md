# FEATURES.md — kol-emet workqueue

This file is the ONLY source of automated work for kol-emet: an unattended hourly routine takes the first unchecked item under
Workqueue Items, implements exactly that one item, verifies it with the commands the item names, opens a PR, merges to `main`, and
moves the item to Completed Items. Priority is file position — nothing else. Ids are permanent and never renumbered; new items
continue the sequence. Every item serves the public multi-tenant product (CLAUDE.md): nothing here simplifies auth, gates
registration, or removes a feature.

## Workqueue Items

- [ ] **(KOL-010) Add Vitest to the client and test the login form's credential-manager attributes**
  Add `vitest`, `@vue/test-utils`, `jsdom` devDependencies and `"test": "vitest run"` to `client/package.json`; a
  `test: { environment: 'jsdom' }` block in `client/vite.config.js`. First test `client/src/views/LoginView.test.js`: the email
  input has `autocomplete="email"`; the password input has `current-password` in login mode and `new-password` in register mode;
  the form has `autocomplete="on"` — the CLAUDE.md password-manager rule made executable. Verify: `cd client && yarn test` green
  and `yarn build` still succeeds. Out of scope: passkey flows, any visual change.
- [ ] **(KOL-011) Sync docs and comments that still say tenancy is "stored, not enforced"**
  Enforcement shipped (mounts in `server/src/index.js`, `resolveWorkspace`). Fix `CLAUDE.md:74`, `docs/data-model.md:38`,
  `docs/roadmap.md:88` (Phase 8 bullet → done), `docs/wishlist.md:21`, the "Not yet mounted" paragraph in
  `server/src/middleware/workspace.js`, and `docs/architecture.md:90-91` (providers now include OpenRouter and `steadfast` — see
  `server/src/lib/aiProviders.js`). Add `resolveWorkspace` to every guarded row of the `docs/api.md` mount table. No behaviour change.
  Verify — must print nothing: `grep -rn -i "not yet enforced\|not yet filtered\|stored today, not filtered\|Not yet mounted\|known future addition" CLAUDE.md docs server/src`
- [ ] **(KOL-012) GitHub Actions CI running both test suites and the client build** (needs KOL-003, KOL-010) [needs-human]
  Create `.github/workflows/ci.yml`: on push + pull_request, ubuntu-latest, Node 22 via `actions/setup-node` with yarn caching; job
  `server` = `yarn install --frozen-lockfile && yarn test` in `server/`; job `client` = the same plus `yarn build` in `client/`.
  Cache `~/.cache/mongodb-binaries` so `mongodb-memory-server` downloads once. Verify: `gh pr checks` on the routine's own PR shows
  both jobs green before merge. Out of scope: deploys, branch protection (a repo setting Daniel must flip — flag it in the PR).
  needs-human because `.github/**` is denylisted for automated runs (a run may never add or edit its own CI); Daniel adds this one.

## Proposed

- [ ] **(KOL-013) Refresh dependencies against the 50 open Dependabot advisories** (needs KOL-004, KOL-010, KOL-012)
  `yarn upgrade` within existing semver ranges in `server/` and `client/`; keep the `qs` 6.16.0 pin and express 4 (`_comment_qs_pin`
  in `server/package.json`); no major bumps. Verify: `yarn audit --level high` count drops, both `yarn test` suites and `yarn build`
  green, `yarn start` boots. Proposed because an unattended dependency refresh deserves one explicit nod from Daniel even with tests.
- [ ] **(KOL-014) Per-user MCP identity instead of the global Settings.mcpUserId singleton** [needs-human]
  Today `POST /authorize` (`server/src/routes/oauth.js`) overwrites the single `Settings.mcpUserId` and `/oauth/token` hands every
  connector the same `MCP_BEARER_TOKEN` — a second user authorizing the Claude.ai connector re-points everyone's MCP traffic at their
  own workspace; `resolveUserId` in `server/src/middleware/workspace.js` inherits the same limit for `BEARER_TOKEN`. Proposal:
  per-authorization opaque tokens stored with `userId` + `workspaceId`, resolved by the `/mcp` middleware and `requireAuth`; env tokens
  keep working during migration. Design approval first (storage, rotation, re-authorization UX), then 2–3 workqueue items; verify with an extended `mcp.test.js` where A and B each authorize and see only their own entities.
- [ ] **(KOL-015) Account-deletion cascade as a tested library function** (needs KOL-004)
  Daniel decided 2026-09-05 that account deletion hard-deletes, drafts included. Build `deleteAccount(userId)` in
  `server/src/lib/accountDeleter.js`: remove the `User`, every `Workspace` they solely own, and every document in those workspaces
  across all models carrying `workspaceId` (grep `server/src/models/`); refuse and report if the user is a non-owner member elsewhere.
  No route yet — `DELETE /auth/account`, its confirmation UI, and the signup disclosure copy are a follow-up tagged `[needs-human]`.
  Verify: `server/tests/lib/accountDeleter.test.js` shows every collection empty for the deleted tenant, untouched for a second tenant.
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
- [ ] **(KOL-020) Phase 6 step 1: `EntityType` registry model + `/entity-types` routes** (needs KOL-004)
  Mirror `RelationshipType` (`server/src/models/RelationshipType.js`, `server/src/routes/relationshipTypes.js`) per
  `docs/build-plan.md` Part A; seed the six current categories per workspace; keep the `Entity.category` enum for now
  (`getCategories` in `server/src/config/categories.js` is the seam). Tests: CRUD scoped per workspace, mirroring KOL-004.
  Off the worldbuilding-launch critical path — Daniel should confirm timing before it enters the queue.

## Blocked Items

## Completed Items

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
