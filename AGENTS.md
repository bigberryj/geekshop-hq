# GeekShop HQ

> Single-pane business dashboard for [GeekShop Computers](https://geekshop.ca).

**Start here:** `README.md` covers quick start, env vars, and the AI provider routing.

**Architecture & decisions:**
- `docs/architecture.md` — system overview, data flow
- `docs/schema.md` — current DB schema notes
- `docs/database-choice.md` — why SQLite, why no ORM
- `docs/security.md` — customer-facing ID policy, secrets
- `docs/deployment.md` — local ops + Tailscale + UFW
- `docs/api.md` — endpoint reference
- `docs/changelog.md` — what changed each iteration

**Solutions & learnings:**
- `docs/solutions/build-it/built-geekshop-hq.md` — full build record, evidence, pivots
- `docs/solutions/build-it/built-geekshop-hq-v0.1.0.md` — original v0.1.0 solution doc (kept for history)

**Conventions:**
- Schema migrations are in `server/db/migrations/` as numbered `.sql` files; applied by `server/db/migrate.js`
- Tests are in `server/test/`, run with `npm test` from `server/`
- **All user-facing changes must be browser-tested before "done"** (API smoke tests are necessary but not sufficient)
- **No secrets in commits.** Real keys only in local `server/.env` (git-ignored)
- **No new paid APIs without asking.** Default: free / Hermes-routed / already-paid
