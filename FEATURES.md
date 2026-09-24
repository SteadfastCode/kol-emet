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
- [x] **(KOL-042) Backlog audit: file new candidates under Proposed** [not-before: 2026-09-24]
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

## Blocked Items

## Completed Items

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
