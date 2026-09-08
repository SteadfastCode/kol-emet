# kol-emet — routine runbook (repo-specific)

Read after the shared runbook. Where they conflict, this file wins.

## What this is

Kol Emet: a multi-tenant SaaS wiki/knowledge-graph platform under the Steadfast Code brand. Vue 3
client (`client/`, Vite), Express API (`server/`), MongoDB, and an MCP endpoint served from inside
the Express app at `/mcp` (Streamable HTTP, OAuth for the Claude.ai connector). Daniel's own
instance (danielecker.dev) is the first deployment, not the target. **Public repo.** Pre-alpha.

## The one rule that overrides taste

Every implementation decision serves the public multi-tenant product (see `CLAUDE.md`). Never
simplify auth, gate registration, scope a feature to one user, tie the MCP layer to one model
provider, or remove a feature to make something else easier. Significant technical decisions go
in the Decision Log in `kol_emet_spec.md` with reasoning.

## Verify

- `cd client && yarn install --frozen-lockfile && yarn build`.
- `cd server && yarn install --frozen-lockfile && node --check index.js`, plus whatever test
  runner the first queue item adds (`yarn test` once it exists). There are no tests today; anything
  touching auth, tenancy isolation, the entity/relationship model, or the MCP endpoint adds one.
- The data model is documented in `docs/data-model.md`: content is an ordered `blocks` array
  (no `body` field); relationships and open questions are their own collections.

## Deploy

Netlify (client) and Railway (API) are configured in their dashboards, not in the repo; the
`deploy-status` check reports the latest deploy state. Confirm both deploy from `main` before
treating a merge as a deploy. Secrets (`BEARER_TOKEN` and friends) live in Daniel's password
manager and the Railway environment — never in the repo.
