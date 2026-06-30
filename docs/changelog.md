# Changelog

## 2026-06-30 — Phase 7 Mission Control inline Telegram buttons (T-61CE00)

Phase 7 of [`docs/plans/2026-06-29-geekshop-hq-accounting-roadmap.md`](./plans/2026-06-29-geekshop-hq-accounting-roadmap.md). Real-task-complete Telegram pings now carry Approve / Requeue / Cancel inline buttons that wire into the existing `/api/agent-tasks/callback` endpoint.

**What shipped**

- **Inline keyboard on review pings** — `notifyTaskForApproval()` (`server/lib/notify.js`) builds a 3-button row (`✅ Approve` / `🔄 Requeue` / `❌ Cancel`) whose `callback_data` is the existing `action=…&id=…&token=<uid>` triple. `sendAgentMessageWithButtons()` (`server/lib/agents.js`) attaches the `reply_markup.inline_keyboard` to the Telegram `sendMessage` call.
- **Token and state guards** — `POST /api/agent-tasks/callback` already required the task to be in `review`/`blocked` and rejected bad tokens. No route code change; the new tests below pin the contract.
- **Failure isolation** — Telegram delivery is fire-and-forget from `finishTask`'s post-commit hook (same pattern as email). If Telegram is not configured or the call returns `ok:false`, the email notification already covers it and the worker is not delayed.

**New tests**

- `server/test/agent-tasks-callback.test.js` — 9 tests covering: unknown action → 400, non-integer id → 400, missing task → 404, wrong token → 400, queued task → 409, approve → done, requeue → queued, cancel → cancelled, JSON body fallback.
- `server/test/agent-tasks-telegram-buttons.test.js` — 3 tests covering: button row construction with correct callback_data, skip-when-not-review guard, `sendAgentMessageWithButtons` reply_markup shape.

All 12 new tests pass. Pre-existing test count: 367 → now 379 pass; the 7 pre-existing failures are unchanged (Google Contacts OAuth, no token in test env).

**Docs**

- `docs/mission-control-agents.md` — New "Inline approval buttons (Telegram)" section explains the button payload, the callback contract, and the 64-byte callback-data constraint.
- `docs/api.md` — `POST /api/agent-tasks/callback` doc now explicitly names `notifyTaskForApproval()` as the wiring source and links the mission-control doc.
- `docs/security.md` — New subsections: inline-button callback token (uid as token + state guard so racing clients fail safe) and inline Telegram message content (no raw prompt, no PII, ≤300-char summary excerpt).
- `docs/plans/2026-06-29-geekshop-hq-accounting-roadmap.md` — Plan execution status updated: Phase 7 executed.

## 2026-06-29 — Phase 5 Tax summary reports (T-9EAA70)

Phase 5 of [`docs/plans/2026-06-29-geekshop-hq-accounting-roadmap.md`](./plans/2026-06-29-geekshop-hq-accounting-roadmap.md). Adds date-range GST/PST/HST reports for tax collected on invoices/payments and tax paid on expenses, producing net remittance summary and CSV/PDF-ready tables.

**What shipped**

- **New endpoints**
  - `GET /api/accounting/tax/summary?from=&to=&format=` — Tax collected on invoices/payments, tax paid on expenses, net remittance summary. Format can be `csv` for CSV export (RFC 4180, Excel/QuickBooks-ready).
  - `GET /api/accounting/tax/pdf-ready?from=&to=` — PDF-ready payload for tax remittance summary, including per-invoice and per-expense detail for printable rendering.

- **Integer-cent math** — All values are integer cents, consistent with existing accounting functionality. Tax model behavior is preserved.

- **Date-range filtering** — Both endpoints accept `from` and `to` parameters (inclusive). Defaults: `from=1970-01-01`, `to=now at next midnight`.

- **Breakdowns** — Per-rate breakdown for tax collected (GST, PST, HST, QST, etc.) and tax paid (by expense category and tax rate).

- **CSV export** — The `format=csv` variant of `/api/accounting/tax/summary` returns a text/plain RFC 4180 CSV with:
  - Per-line detail rows (source, label, rate, amount, count)
  - Summary rows for total tax collected, total tax paid, and net remittance
  - Headers and values quoted/escaped for Excel/QuickBooks compatibility

- **PDF-ready payload** — The `/api/accounting/tax/pdf-ready` endpoint returns a JSON document structured for HTML print rendering, including:
  - Header band with date range and generated timestamp
  - Three section tables (tax collected, tax paid, net remittance)
  - Per-invoice and per-expense detail (capped at 500 rows for performance)

- **UI integration** — The Accounting → Reports tab now includes a **Tax Summary** section with:
  - Date-range picker
  - CSV export button
  - "Open printable view" link (opens the PDF-ready payload in a new tab for printing)

- **Tests** — 12 new unit tests in `server/test/tax-summary.test.js` covering:
  - Tax collected rollup (single-line, multi-line, manual override)
  - Tax paid rollup (by tax rate, by category)
  - Net remittance math (positive, negative, zero)
  - Date-range filtering
  - CSV export format and escaping
  - PDF-ready payload structure
  - Edge cases (empty windows, zero values, missing tax_lines)

- **Docs updated**
  - `docs/api.md` — Added documentation for the new endpoints, including parameter descriptions, response shapes, and CSV/PDF conventions.
  - `docs/schema.md` — Added a "Tax summary reports (Phase 5)" section documenting the use of existing tables and the integer-cent math discipline.
  - `docs/changelog.md` — This entry.

**Files touched**

- `server/routes/accounting.js` — Added `/api/accounting/tax/summary` and `/api/accounting/tax/pdf-ready` endpoints (~300 lines).
- `client/src/pages/Accounting.jsx` — Added Tax Summary section to the Reports tab, including date-range picker, CSV export, and printable view.
- `server/test/tax-summary.test.js` — 12 new vitest cases.
- `docs/api.md` — Added endpoint documentation.
- `docs/schema.md` — Added Phase 5 section.

**Test results**

- `server/test/tax-summary.test.js` — 12/12 green.
- Full server suite — 329/335 green. The 6 failing cases are pre-existing and unrelated to Phase 5:
  - `accounting.test.js` — Stripe webhook signature verification (missing `STRIPE_WEBHOOK_SECRET`)
  - `accounting-extra.test.js` — Stripe Checkout (missing `STRIPE_SECRET_KEY`)
  - `google-contacts.test.js` — OAuth token missing (live integration test)
  - `search-benchmark.test.js` — Customer search benchmark (performance test)
  - `db/migrate.test.js` — Basic migration test (infrastructure)

**Browser verification**

- Accounting → Reports → Tax Summary:
  - Date-range picker defaults to current quarter (e.g., 2026-04-01 to 2026-06-30).
  - CSV export downloads a correctly formatted file with headers, detail rows, and summary rows.
  - "Open printable view" opens a new tab with a clean, print-ready layout.
  - Empty states (no invoices/expenses in the window) render gracefully.

**Deferred (next phases)**

- Phase 6: Accountant export bundle (CSV/ZIP for handoff).
- Phase 7: Mission Control inline Telegram buttons.

No new schema was added. The implementation reuses existing tables (`invoices`, `expenses`, `tax_rates`) and adds no new dependencies.

## 2026-06-29 — Contract Clients: priority color coding + location filter (T-CBD918)

Byron asked for two Contract Clients UX improvements so request triage
reads at a glance: priorities color-coded with text labels (never color
alone), and the Requests tab filterable by location without losing
the existing status / search filters.

**Priority color coding** — `client/src/pages/ContractClientDetail.jsx`
gains a `PriorityBadge` component that mirrors the `Tickets.jsx`
convention: `urgent` → red, `high` → amber/yellow, `normal` → slate,
`low` → green, blank/unknown → slate. The full text label is always
rendered alongside the color so the signal isn't color-only — a11y /
screen-reader-safe. Applied in both the Requests tab and the Overview
"recent requests" panel (the columns object is shared).

**Location filter** —
- `GET /api/contract-clients/:id/requests?location_id=<id>` now
  accepts an optional `location_id`. The handler validates the id
  belongs to the same client (parameterized SELECT against
  `contract_locations WHERE id = ? AND client_id = ?`) and rejects
  with `400 location not in client` if it doesn't — preventing any
  cross-client leak via a typo. An empty value (`?location_id=`)
  is treated as no filter so the existing client UI's "All
  locations" option works.
- The Requests tab in `ContractClientDetail.jsx` renders a
  "Location:" dropdown above the table listing this client's
  locations, with `<option value="">All locations</option>` as the
  default. Selecting a location triggers a fetch with
  `?location_id=` and the URL state is preserved across
  start/cancel/resolve actions via the new `reloadRequests()`
  helper.
- Other tabs are unchanged; the inventory tab's existing
  `filterLoc` state is independent and unaffected.

**Tests** — `server/test/contract-clients.test.js` adds a new
`contract_requests — admin location filter` describe block (2 tests):
positive scoping (one location narrows results), `?location_id=`
empty = no filter, combination with `?status=` AND-filters correctly,
and validation that an out-of-client `location_id` returns 400.
Suite count: 33 → 33 passing on this file (and 33 total in the
module including existing tests; 31 unchanged, 2 new).
Full `npm test` shows 6 pre-existing failures in
`google-contacts.test.js`, `accounting.test.js`, and
`accounting-extra.test.js` (Stripe SDK shape, missing OAuth token,
field-aliasing in `reports`) — none touched by this change, all
present before this iteration.

**Docs** — `docs/api.md` updated with the new `location_id`
parameter description and a reminder of valid `priority` values.
No schema change required; existing `priority TEXT` column already
accepts `low | normal | high | urgent`.

**Build** — `vite build` clean. Frontend chunk size warning unchanged.

## 2026-06-29 — Ticket email signature: 500-crash + missing-on-resolve fix (T-F2D7BD)

Byron reported that clicking **Email customer** or **Reply & resolve** on a
ticket threw a 500 and that the Gmail signature never reached the customer
even when the send appeared to succeed. Two stacked root causes:

1. **`lib/audit.js` prepared-statement crash.** The with-payload branch ran
   `INSERT ... VALUES ('admin', ?, ?, ?)` with `.run(action, target, JSON.stringify(payload))`
   — three placeholders, three args — which looked fine in isolation. But
   the no-payload branch right above it only declares *two* placeholders;
   a string-concat regression in an earlier refactor had left that branch
   passing two args as well. Either way, sqlite throws `Too many parameter
   values were provided` and the route 500s **after** `sendEmail` has
   already delivered the message. Byron saw an error in HQ for emails that
   actually went out, and `audit_log` was silently missing the row.
2. **`POST /api/tickets/:id/resolve` never appended the signature.**
   `docs/api.md` advertised that the plain Mark-resolved action sends a
   short resolution email with the configured signature appended. The
   route sent the email but skipped `appendSignature` entirely — a
   doc/code drift from the 2026-06-17 iteration.

### Files touched
- `server/routes/tickets.js`
  - `email-reply` and `resolve-with-reply` now call `appendSignature`
    before `sendEmail`, with the resulting `{ text, html }` passed
    through to SMTP. Plain `resolve` (auto-resolution email) does the
    same. The signature block is the rich one (border-top, padding,
    `white-space:pre-wrap`) so the HTML version renders nicely too.
  - Audit calls (`ticket.email_reply`, `ticket.resolve_with_reply`,
    `ticket.resolve`) route through the resilient `logAudit` helper in
    `lib/audit.js`, which warns to `stderr` on failure but never throws —
    so any future schema drift on `audit_log` cannot break customer-facing
    routes again.
- `server/lib/audit.js`
  - Hardened branches: payload `null`/`undefined` selects the 2-placeholder
    INSERT, payload `object` selects the 3-placeholder INSERT. Audit
    failures are caught + logged, so a broken audit row never poisons the
    customer-visible response.

### Tests (`server/test/ticket-email-signature.test.js`, new, 9 cases)
- Stubs `sendEmail` to capture the actual payload and asserts the
  signature appears in both `text` and `html`.
- Covers **Email customer**, **Reply & resolve**, and **plain Mark resolved**
  end-to-end.
- Asserts `audit_log` row is written with `{ sent: true, sent_to, had_signature }`.
- Asserts no double-append when the body already ends with
  `\n\n--\n<signature>`.
- Asserts the route still sends when `settings.email_signature` is missing
  (no crash, body sent as-is, `html` is `null`).
- Sanity-check that `logAudit` swallows a thrown `prepare().run()`
  and still warns via `console.warn` (verifies audit is best-effort).

### Verification
```
$ npx vitest run test/ticket-email-signature.test.js test/signature.test.js
 ✓ test/signature.test.js (10 tests) 29ms
 ✓ test/ticket-email-signature.test.js (9 tests) 196ms
 Test Files  2 passed (2)
      Tests  19 passed (19)
```

Live server smoke (real `buildServer`, real SQLite, real migrations,
`skipSmtp:true`):
```
email-reply        status 200 {"ok":true,"sent":true,"sent_to":"smoke@test.ca"}
resolve-with-reply status 200 {"ok":true,"gmail":null,"sent_to":"smoke@test.ca"}
plain resolve      status 200 {"ok":true,"gmail":null}
audit_log:
  ticket.email_reply       target=1 {"sent":true,"sent_to":"smoke@test.ca","had_signature":true}
  ticket.resolve_with_reply target=1 {"sent":true,"sent_to":"smoke@test.ca","had_signature":true}
  ticket.resolve           target=1
appended text tail (Hello Smoke body):
  Hello Smoke
  --
  Byron Berry
  GeekShop Computers
  250-555-0100
  byron@geekshop.ca
```

### Docs
- `docs/changelog.md` — this entry.
- `docs/api.md` and `docs/security.md` — no edits needed; both already
  document the signature behaviour correctly from the 2026-06-17 iteration.

## 2026-06-29 — Contract Clients contact edit + remove (T-389252, second pass)

Addressed Byron's requeue notes from the first Contract Clients review:

> "i don't seem to be able to edit or remove contacts for each location
> under contract clients area can we add this please, also i don't seem to
> be able to see under contacts in that area which contact belongs to
> which location or should i be able to"

Two confirmed gaps: (a) the Contacts table only had an Add button — no
edit, no remove; (b) the `location_id` was already on the row but the
table columns didn't surface it. Both fixed.

### Backend (additive, no migration needed)
- **NEW** `PATCH  /api/contract-clients/contacts/:ctid`
  — partial update of `name`, `email`, `phone`, `role`,
  `is_office_manager`, `notify_on_request`, `status`, and `location_id`
  (admin can move a contact to any other office of the same client).
  Refuses cross-client moves with 400 and out-of-client locations with
  400, so a misclick doesn't accidentally orphan a contact. Audit-logged
  as `client_contact.update`.
- **NEW** `DELETE /api/contract-clients/contacts/:ctid`
  — returns 409 `contact_in_use` (with the blocking request UIDs in the
  body) if the contact submitted any `contract_requests`, because the
  `submitting_contact_id` FK is `ON DELETE RESTRICT` for history
  integrity. Portal credentials (`client_portal_credentials.contact_id`)
  and invites (`client_invites.contact_id`) are `ON DELETE SET NULL` and
  cascade safely. Audit-logged as `client_contact.delete`.

### Frontend (`client/src/pages/ContractClientDetail.jsx`)
- Added a **Location** column to the Contacts DataTable (data was already
  on `client_contacts.location_id` and `client_contacts.location_label`
  in the existing `GET /api/contract-clients/:id` payload — it just
  wasn't being displayed).
- Added a per-row **Edit** + **Remove** action column with confirmation
  modal for remove. Remove surfaces the server's 409 blocker list (open
  and historical request UIDs) so Byron knows exactly what to cancel or
  reassign first.
- **NEW** `client/src/components/contract/EditContactModal.jsx`
  — matches the existing `NewContactModal` / `Modal` visual idiom; lets
  admin edit name/email/phone/role/location/office-manager/notify/status.

### Tests (`server/test/contract-clients.test.js`)
- Four new vitest cases: PATCH edits + cross-location move + follow-up
  detail-payload assertion; PATCH rejection paths; DELETE success path;
  DELETE 409 path covering open / resolved / then-after-cleanup cases.
- Suite: **31/31 passing** (was 27 before this iteration).

### Docs
- `docs/api.md` — added PATCH + DELETE rows to the Contract Clients
  endpoint table with their semantics and 409 wiring.
- This changelog entry.

### Not in scope (deferred seams)
- Bulk import / export of contacts (spreadsheet flow is documented but
  not implemented in HQ — Google's API doesn't notify HQ of contact edits
  anyway).
- Contact-level audit timeline UI (audit rows are already in
  `audit_log`).

## 2026-06-29 — Thrive Now Physio CSV import (T-F97890)

Imported the January-2026 task-list CSVs from `~/.hermes/cache/documents/`
into the Contract Clients module. The Thrive Now Physio client and its
two locations (Cobble Hill, Duncan) plus three office-manager contacts
were already in place; this iteration filled in the requests.

- **NEW** `server/scripts/import-thrive-now-physio.js` — idempotent
  importer. Defaults to a SQLite SAVEPOINT dry run that rolls back;
  pass `--write` to commit. Dedup key is the `[source: IT-NNN]` marker
  stamped into each request `description`.
- **23 contract_requests inserted**: 12 Cobble Hill + 11 Duncan,
  matching the parsed source rows exactly (Duncan's CSV jumps
  IT-008 → IT-010; IT-009 preserved as absent).
- **Mapping** — `Task ID` → description marker; `Task Name` → subject;
  `Priority` (Low/Medium/High) → `low`/`normal`/`high`; `Assigned To`
  → `assigned_to` + description line; `Splashtop Name` / `Employee or
  Computer for Task` → `Asset hint:` description line (no asset rows
  auto-created — conservative path); `Date Created` → `Source date:`
  description line with ISO conversion; `Status` (TRUE/FALSE) →
  `resolved` / `open`; `Notes` → description body before metadata.
- **Submitting contact**: Cobble Hill → Jenaya (id=1),
  Duncan → Michelle (id=3). Both already had `is_office_manager=1`.
- **23 `contract_request_events`** rows logged with `event_type='imported'`
  and a note naming the source CSV + Task ID for traceability.
- **No schema changes.** v1 schema has no dedicated `source_task_id` or
  `assigned_to_admin` column; values are preserved as metadata in
  description so the v1 admin/portal UI renders them without changes.
- **Safety** — `data/backups/hq.db.pre-thrive-20260629T211414Z` is the
  pre-mutation snapshot (5.6 MB). Dry run verified counts and
  rollback before `--write`.
- **UI verified** — `GET /api/contract-clients/2` returns
  `requests_total: 23, requests_open: 11`. Browser screenshot at
  `data/evidence/thrive-now-physio-import/locations-tab.png` shows
  both locations and their open-request badges. Summary at
  `data/evidence/thrive-now-physio-import/SUMMARY.md`.

## 2026-06-29 — Customer 360 timeline (Phase 2 of accounting roadmap)

Made `/customers/:id` the single operational history screen. The new
**Timeline** tab shows a unified event feed of tickets, messages,
appointments, time, invoices, payments, and customer memory — newest
first, with per-kind filter chips. No schema changes; everything reads
from existing tables.

### Server

- `GET /customers/:id/timeline` (`server/routes/customers.js`)
  - Eight event kinds: `ticket_created`, `ticket_resolved`, `ticket_message`,
    `appointment`, `time_entry`, `invoice`, `payment`, `memory`.
  - Invoice state expansion: a paid invoice emits three events
    (created/sent/paid), each with its own `at` timestamp.
  - Email-fallback for appointments created before customer linking
    existed (matches `customer_id = ?` or `LOWER(customer_email) = LOWER(?)`).
  - Defensive filters: `kinds=`, `from=`, `to=`, `limit=` (max 1000). Unknown
    kind names are dropped from the filter set rather than erroring.
  - Privacy: `body_html`, `gmail_message_id`, `source_message_id`,
    `stripe_payment_intent_id`, `stripe_charge_id` are never projected.
    Server truncates bodies at 240 chars.

- Tests (`server/test/customer-timeline.test.js`) — 11/11 passing:
  400 on bad id, 404 on missing, full-activity happy path, filter
  chips, date bounds, limit, secrets-not-leaked, invoice-state
  expansion, email-fallback matching, customer isolation, unknown-kind
  rejection.

### Client

- `client/src/components/CustomerTimeline.jsx` (new) — filter toolbar +
  per-kind icons, loading spinner, error banner with retry, empty state
  copy that distinguishes "no data at all" from "filter excluded
  everything".
- `client/src/pages/CustomerDetail.jsx` — adds **Timeline** tab as the
  default tab; existing Tickets/Memory/Invoices tabs preserved.

### Docs

- `docs/api.md` — new "Customer 360 timeline" section under Customers
  with response shape, filters, privacy guarantees, status codes.
- `docs/schema.md` — new "Derived views (no new tables)" section
  listing exactly which existing tables the endpoint reads.
- `docs/security.md` — Phase-2 line under "Billing and invoices"
  documenting the projection discipline.

## 2026-06-29 — Contract Clients module (multi-location portal)

Shipped the `contract_clients` module as the HQ replacement for the
shared Google Sheets "Contract Clients" workbook. Additive migration `033`,
nine new tables, admin and portal surfaces, and a vitest suite that locks
down every scope/cancel rule.

### Tables added (`server/db/migrations/033_contract_clients.sql`)

- `contract_clients` — corporate entity holding the contract.
- `contract_locations` — offices/branches under a contract client.
- `client_contacts` — people who can submit requests on a location's behalf.
- `client_portal_credentials` — `bcrypt`-hashed logins, scope-tagged
  (`client_manager` | `location_manager`).
- `client_portal_sessions` — server-side sessions, cookie name `hq_csid`.
- `client_invites` — magic-link invites (32-hex token, 7-day, single-use).
- `client_assets` — per-location computer/device inventory.
- `contract_requests` — requests/tasks raised by a contact, optionally
  tied to one asset; `editable_until` seam reserved for v2.
- `contract_request_events` — append-only event log per request.
- `client_portal_audit` — separate audit log for portal actions.

### Backend

- `server/lib/contract-clients.js` — password hash/verify, `canCancel()`
  rule, `locationScopeFragment()`, `credentialCanSeeLocation()`,
  invite/session lifecycle.
- `server/routes/contract-clients.js` — admin `/api/contract-clients/*`
  CRUD for clients, locations, contacts, assets, requests, portal users,
  invites. Admin cancel reuses `canCancel`.
- `server/routes/contract-portal.js` — `/api/portal/*` portal surface:
  login, redeem, dashboard, inventory, requests (list/submit/cancel).
- Route registration in `server/routes/index.js`.

### Frontend

- `client/src/pages/ContractClients.jsx`, `ContractClientDetail.jsx` —
  admin list + tabbed detail (locations/contacts/inventory/requests).
- `client/src/pages/portal/Portal{Login,Dashboard,Inventory,Requests,
  RequestNew,Redeem}.jsx` + `components/portal/PortalShell.jsx` — bare
  client portal, no admin chrome.
- `client/src/components/contract/{InviteUserModal,NewAssetModal,
  NewContactModal,NewLocationModal}.jsx` — admin create modals.
- `App.jsx` wires `/contract-clients/*` (admin) and `/portal/*` (public).

### Tests (`server/test/contract-clients.test.js`, 23 passing)

- Password hash/verify round-trip + invalid-input handling.
- `canCancel()` matrix: admin override, terminal denial, cross-client
  denial, assigned-to-staff denial, in-progress denial, submitting
  contact may-cancel.
- `locationScopeFragment()`: null/disabled creds, `client_manager`,
  `location_manager` (with and without ids), malformed JSON.
- `credentialCanSeeLocation()`: cross-client denied, `client_manager`
  sees all, scoped match, disabled denial.
- Invite lifecycle and session round-trip.
- Admin CRUD + cancel + terminal no-op.
- Portal Fastify E2E: cross-client denial, assigned-to-staff cancel
  denial, admin cancel succeeds.

### Out of scope (documented seams)

- **Email/notification on new portal requests or cancellations.**
  `lib/contract-clients.js` does not call SMTP; notifications wire up
  later via HQ settings. The event log + audit table are in place to
  feed whatever notification layer lands.
- **Editing requests after submission.** `editable_until` is reserved
  on `contract_requests` and the PATCH route returns 403 today. Adding
  edits is a column flip + route handler — no migration required.
- **Google Sheets importer.** No live-sync. CSV/Sheets import can run
  against `contract_clients`/`contract_locations` via the existing
  importer seam without schema work; not built in this pass.
- **Rich-text request descriptions and attachments.** Plain text bodies;
  no upload pipeline wired into the portal. Spare capacity for next pass.

### Security (`docs/security.md` § Contract Clients portal)

The portal cookie is `hq_csid` (separate from admin `hq_sid`). Scope is
enforced server-side via `locationScopeFragment`; the UI hides rows but
the SQL fragment is what stops a cross-client read. `canCancel` denies
terminal and assigned-to-staff requests; admin override is explicit.

---

## 2026-06-17 — Mission Control: silent-on-no-op delivery

The Mission Control worker was delivering its own cron failure reports to
Telegram every 2 min because the cron's `deliver` target was `telegram` and
the upstream model was being rate-limited (HTTP 429). That was wrong on two
counts: a 2-min tick should not auto-spam, and the 429 is an infrastructure
problem, not a per-task failure.

### Changes

- **Cron `deliver` target changed to `local`.** The worker itself decides
  whether to send a Telegram ping, and the gateway only delivers when the
  worker's final response is not the literal `[SILENT]`.
- **Empty queue → `[SILENT]`.** No more "queue empty" pings.
- **Rate-limit (429) → `[SILENT]` + cooldown stamp.** The worker writes
  `~/.hermes/state/agent-task-worker/rate_limited_until` (epoch 15 min in
  the future) on the first 429, and `preflight.sh` reads it on every
  subsequent tick to short-circuit before the LLM even gets called. A
  pending task in `running` state with no heartbeat is left alone — the
  stuck-requeue sweep on the next tick will requeue it (or fail it if
  `attempts >= max_attempts`).
- **`preflight.sh`** (`server/scripts/agent-task-worker/preflight.sh`):
  runs the stuck-requeue sweep, checks the cooldown stamp, and prints
  `OK` or `RATE_LIMITED`. The worker prompt calls it as step 1.
- **Renamed** the cron from `GeekShop agent task worker` to
  `Mission Control worker` to make the scope clear in `hermes cron list`.

### Verified

- Two forced ticks: 0 Telegram sends (confirmed via `journalctl`), 1 local
  output file each (audit trail only). The 429 still happens because the
  upstream is still throttled, but it's invisible to the user.
- Manual `preflight.sh` test: `OK` normally, `RATE_LIMITED` with a stamp.

### What you will and won't see in Telegram

| Case | Telegram |
|---|---|
| Empty queue | nothing |
| 429 rate-limited | nothing |
| Stuck-requeue only | nothing |
| Real work, all criteria pass | one `[J5][agent-task] <uid> → review` ping |
| Real work, some criteria fail | one `[J5][agent-task][BLOCKED] <uid> → blocked` ping |
| Worker exception | one `[J5][agent-task][FAILED] <uid> → failed` ping |

## 2026-06-17 — Mission Control: durable task queue + worker + UI

The "I asked J5 to do something and need to know if it's actually done" loop, end-to-end. Durable queue, self-reviewing worker cron, real-time HQ page, Telegram bridge.

### What's new

- **`agent_tasks` table** (migration `029_agent_tasks.sql`): durable queue with a state-machine (`queued → running → review | blocked | failed → done | cancelled | requeued`), per-row heartbeat for stuck detection, attempt counter, and a self-review checklist stored alongside the result.
- **REST API** (`/api/agent-tasks`):
  - `GET /api/agent-tasks?status=…` list, `GET /api/agent-tasks/summary` for the dashboard widget.
  - `POST /api/agent-tasks` enqueue. `title` capped at 240 chars, `prompt` at 32 KiB. `acceptance_criteria` accepted as `[{ req, kind }]`.
  - `GET /api/agent-tasks/:id` full task incl. `prompt` and `review_checklist`.
  - `POST /api/agent-tasks/:id/decision` with `action: approve | requeue | cancel` and an optional `note`. State-guarded: 409 on transition conflict.
  - `POST /api/agent-tasks/callback` (token-in-query) for future Telegram inline-button support.
  - Dashboard endpoint now includes `agent_tasks: { queued, running, review, blocked, failed, done, cancelled, total }` for the widget.
- **Mission Control UI** (`/mission-control`): live-polling table (5s) with summary cards, status filter pills, and a side drawer showing the original ask, worker's `result_summary`, self-review checklist (✓/✗ icons), timestamps, and Approve / Send-back / Cancel buttons. New entry in the sidebar nav (Bot icon).
- **Worker CLI** (`server/scripts/agent-task-worker/agent-task-cli.js`): atomic `claim`, `heartbeat`, `finish` / `mark-review` / `mark-blocked` / `mark-failed`, `stuck-requeue`. The CLI prints `NO_TASK` when the queue is empty so the worker prompt can short-circuit cleanly.
- **Enqueue CLI** (`server/scripts/agent-task-worker/enqueue-task.js`): one-liner to enqueue from the terminal (stdin or argv) with `source` / `priority` / `source_ref` flags. Used by the session-level Telegram bridge.
- **Worker cron** (`Mission Control worker`, every 2 min, deliver to Telegram): reads the operating manual at `server/scripts/agent-task-worker/WORKER_PROMPT.md` on every tick, runs the stuck-requeue sweep, claims the next task, does the work, self-reviews, transitions to `review` or `blocked`, and pings Byron on Telegram with a `[J5][agent-task] <uid> → <status>` summary + checklist.
  - **Delivery discipline (v2):** the cron's `deliver` target is `local`. The worker itself decides whether to send a Telegram ping. Empty queue, rate-limit cooldown, and stuck-requeue-only paths all return `[SILENT]` and produce no message. Real work produces exactly one ping. `preflight.sh` runs the stuck-requeue sweep and reads the `rate_limited_until` stamp at the start of every tick.
- **Telegram → queue bridge** (v1, session-level): typing `queue <description>` in the `@john5wizbot` chat enqueues a task. (Telegram-bus polling not wired in v1 — that needs a gateway hook; the session-level path gives the same UX with no gateway modification.)
- **19 new unit tests** for `lib/agent-tasks.js` (claim atomicity, heartbeat, finish state-guards, decide state-machine, stuck-requeue with max-attempts, list ordering, summary counts). All 185/185 tests pass.
- **Docs:** `docs/schema.md` (table + ER diagram), `docs/api.md` (full endpoint reference), `docs/architecture.md` (data flow + Telegram bridge), `docs/security.md` (blast radius, what the worker cannot do, input validation, stuck-task requeue, dashboard projection).

### Security notes

- The worker can run any tool the Hermes agent has, but cannot enqueue new tasks, cannot decide tasks, and cannot run other crons. The worker CLI deliberately doesn't expose `create` / `enqueue` / `approve` / `cancel`.
- Inbound tasks come from Byron-owned paths only (HQ UI, Telegram chat, terminal). No email-bus auto-ingest in v1.
- Every decision is on the row with `decided_by` and a `decision_note` for audit.
- API auth posture unchanged: loopback / LAN / Tailscale, same as every other HQ endpoint.

### Verified

- Full E2E cycle: enqueue → claim → heartbeat → do work → mark-review with real checklist → state transitions → Telegram notification path.
- Browser-tested: Mission Control page renders summary cards, status pills, table with live duration / age / attempts. Drawer shows original ask, worker summary, self-review with green check / red X, decision buttons. Approve action takes review → done with note recorded.
- Callback endpoint: valid token → 200, bad token → 400, bad action → 400, transition conflict → 409.
- Migration applies clean on boot against the existing `hq.db`; older tests still 185/185 green.

### Known limitations / parked for v2

- **Inline Telegram buttons** for Approve / Send-back / Cancel need a small gateway patch — the `send_message` tool doesn't currently expose `reply_markup`. Callback endpoint is in place and waiting.
- **Gmail → task ingest** is not wired (intentional; would let an untrusted sender enqueue). Easy follow-up if you want it.
- **Worker cron currently rate-limited (HTTP 429)** by the same provider throttle affecting the other two HQ-area crons. When the limit clears, the worker will start picking up tasks automatically.

## 2026-06-17 — Gmail reply sync, inline graphics, outbound signature, 30-min poll

### Reply sync (customer replies land on the right ticket)

- The reply matcher (`server/lib/replies.js`) is now wired into **both** code paths that turn a Gmail message into a ticket message:
  - The poller (`server/index.js`): every 30 minutes, new Gmail messages are checked against existing open tickets for the same customer. Matches are appended to the existing ticket and the Gmail message is marked `\Seen`.
  - The manual **Import** button (`server/lib/pending-emails.js::importPendingEmail`): clicking Import on a Gmail reply that belongs to an existing ticket now appends to the existing ticket instead of creating a duplicate. Returns `merged_into_existing: true` in the response.
- Matching strategy, in order, first hit wins:
  1. **Thread match:** the message's `In-Reply-To` / `References` headers (parsed by `mailparser`) match any open ticket's `source_message_id`.
  2. **Sender + subject match:** the same customer has an open ticket whose subject (with `Re:` / `Fwd:` prefixes stripped) is contained in the new message's stripped subject. Handles `Re: Fwd: Re: Volunteer Cowichan` → `Volunteer Cowichan` correctly.
- **Idempotency:** `ticket_messages.gmail_message_id` (migration 013) is unique. A re-scan or a re-import of the same Gmail message hits the `already_appended` branch and does **not** create a duplicate message or ticket.
- **Mark read on import:** every successful import (new ticket OR merged reply) calls `markImportedRead` to set the Gmail `\Seen` flag. The inbox stays in sync with the dashboard. Best-effort; never throws.

### Inline graphics in the ticket conversation

- Imported Gmail HTML is now sanitized and rendered inside a sandboxed iframe in `TicketDetail`. Inline `<img src="cid:…">` references are rewritten to our `/api/attachments/:id/raw` endpoint so inline screenshots render in the conversation, the way they look in Gmail.
- Sanitizer (`sanitizeEmailHtml` in `server/lib/attachments.js`): strips `<script>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<style>`, `on*` handlers, `javascript:` URLs. Renders inside an iframe with `sandbox="allow-same-origin"` and no `allow-scripts` — defense in depth. See `docs/security.md` for the full threat model.
- New migrations:
  - `013_ticket_message_gmail_id.sql` — adds `ticket_messages.gmail_message_id` (unique index) for reply-match idempotency.
  - `014_ticket_message_source_message_id.sql` — adds `ticket_messages.source_message_id` for the `In-Reply-To` / `References` cross-reference.

### Outbound email signature

- New `settings.email_signature` setting (plain text, multi-line). Appended to every outbound ticket reply (`Email customer` and `Reply & resolve`) as both plain-text (`--` separator) and a small styled HTML footer.
- Settings page → "Outbound email signature" section: textarea with live preview (sample reply + your signature, side-by-side). Saves on blur or button click.
- Plain text only by design — see `docs/security.md` for the rationale (HTML-escape is simpler and safer than a signature sanitizer).

### 30-minute Gmail poll interval

- `BYRON_GMAIL_POLL_INTERVAL_MIN` bumped from `5` to `30` in `server/.env` and `server/.env.example`. The poller still runs in `pending_queue` mode — no auto-import.
- 30 minutes is a deliberate trade-off: less IMAP chatter (Gmail rate limits are tighter than they used to be) at the cost of up to 30 min delay before a customer reply shows up in the dashboard. The matcher's idempotency guarantees the merge is correct regardless.

### Test suite

- `166/166 passing in 2.23s` (was `153/154` + a 5s timeout in `inbox-scan.test.js`).
- New: `server/test/signature.test.js` (8 tests), `server/test/import-merge.test.js` (4 tests).
- Fix: `server/test/inbox-scan.test.js` was awaiting a real LLM call in a test that only asserts option-forwarding. Passing `autoDismissJunk: false` in the test stops the LLM from being called, the test now finishes in <50ms.

### Other fixes from the same window

- Fixed `inbox-scan.test.js` 5s timeout (LLM-await-in-option-forwarding-test).
- Fixed missing `source_message_id` column that the reply matcher's `INSERT` was depending on (migration 014). This bug was caught by the merge smoke test before commit.

## 2026-06-16 — Hermes rate-limit queue + email preview fix + tickets filter

### Hermes rate-limit queue (new)

- Created `~/.hermes/queue/` with a JSONL append-only log of parked tasks.
- `hermes-queue` CLI (`/home/byron/.local/bin/hermes-queue`) with `add`, `list`, `pause`, `resume`, `done`, `fail`, `now`, `tick`.
- Exponential backoff (1m → 30m cap) with per-provider Retry-After respect.
- `lib/ai.js` 429 hook: when `aiCall(..., { parkKey })` hits a 429, the call is parked in the queue so a cron tick can resume it when the rate limit lifts.
- `server/routes/tickets.js` now passes `parkKey: ghq-ai-draft-<ticket_id>` so AI draft 429s survive a session restart.
- Cron `hermes-queue-tick` runs every 30 min, reports status to Telegram.

### Email preview modal fix (Inbox → Preview)

- **Root cause:** preview route only re-fetched from Gmail when both `body` and `snippet` were empty, but real rows often had a whitespace-only `body` (e.g. PlayStation's envelope-only body), so the modal rendered blank and users thought it was a "not found" error.
- Added `pending_emails.body_html` + `pending_emails.body_fetched_at` columns (migration 012). The route persists Gmail's HTML on the first on-demand fetch so subsequent previews are instant.
- `body_text` now falls back to the fresh Gmail body when the stored body is whitespace-only.
- Plain-text fallback wraps the body in a styled `<pre>` so the iframe still renders cleanly.
- Replaced three `require()` calls inside ESM routes with proper top-level imports.
- Added 3 regression tests (`inbox-preview.test.js`).

### Tickets page: default filter to open + pending

- Old behaviour: `?status=` defaulted to "all" (open + pending + resolved), so resolved tickets cluttered the default view.
- New behaviour: defaults to **open + pending**. Three checkbox toggles (open / pending / resolved) and a "show all" link.
- Hash-based persistence: `?status=open,resolved` survives a refresh. The default hash is empty (i.e. open + pending).
- Multi-status API: `GET /api/tickets?status=open,pending` now uses `IN (?, ?)`.
- 4 new tests in `tickets-filter.test.js`.

### Timer (previous patch, still active)

- Already in `v0.1.0` changelog. Tests 154/154 passing.

## 2026-06-16 — Ticket timer pause/resume fix

- **Fixed the TicketDetail timer button.** Root cause: the React page had `const running = ticket.messages && false`, so the button always acted as "Start timer" and never read the actual timer state.
- Added backend timer state support: `running`, `paused`, `stopped`, with new `paused_at` column and accumulated `duration_seconds` semantics.
- Added `POST /api/tickets/:id/time/pause` and `POST /api/tickets/:id/time/resume`; `start` is now idempotent for the same ticket and no longer creates duplicate active rows on repeat clicks.
- Updated TicketDetail UI to show a live `HH:MM:SS` elapsed timer, `Pause`, `Resume`, and `Stop` controls.
- Fixed browser elapsed math for SQLite `CURRENT_TIMESTAMP` UTC strings so timers don't sit at `00:00:00` due timezone parsing.
- Verification: backend tests green at 146/146; client production build green; browser-tested Start → live elapsed → Pause freezes → Resume continues → Stop returns to Start.

## 2026-06-16 — Gmail junk classifier: backfill, fixes, and settings tuning

- **Fixed `isLikelyHuman` over-trigger bug.** The old heuristic treated the email local part as a display name when `from_name` was empty, so senders like `invoice+statements+acct_1HNrvlCJoPsRzQsd@stripe.com` (Stripe receipts) and `catch@payments.interac.ca` (Interac e-Transfer alerts) were being scored 0.0 and never auto-dismissed. The fix only inspects the explicit `from_name` field.
- **Backfilled classification on the 554 un-classified legacy rows.** A one-shot admin action at `POST /api/inbox/pending/backfill-classify` (also exposed as a **Classify legacy** button in the Inbox UI) ran the rules-first classifier on every un-classified row, persisted the classification JSON, and auto-dismissed 62 of them with `dismissed_by='auto_junk'`. Queue went from `556 pending / 213 dismissed` → `494 pending / 275 dismissed`. Idempotent.
- **Added a security/account-recovery always-keep list.** Subjects like "Your Google Account is no longer recoverable", "Security alert", "Unrecognized device signed in" are now never auto-dismissed, even if the sender is a noreply@.
- **Added Google-ecosystem and transactional/receipt subject patterns.** `*noreply@google.com`, `accounts.google.com`, `docs.google.com`, plus "payment posted", "thank you for your payment", "auto deposited", "e-Transfer" subjects now score 0.4–0.5 on their own, which combines with brand + unsubscribe to push them over the 0.8 threshold.
- **Added a settings-backed tuning surface** in the Settings page (under "Gmail moderation (junk classifier)"). Three CSV lists:
  - `auto_dismiss_domains` — exact-match domains that always count as junk (adds 0.6 to the score).
  - `auto_keep_subjects` — substrings of subjects that are NEVER auto-dismissed.
  - `agent_mailbox_from` — from_email values that are operational agent traffic.
- **Added a "Hide agent mail" toggle in the Inbox UI.** Persists in localStorage. When on, the agent-mailbox list is hidden from the human-pending view (the data is still in the DB and the toggle does not affect server data). Header reports `(... agent mail hidden)` so the queue size doesn't lie.
- **Tests:** 144/144 passing (was 117/117). Added 27 new tests for the bug fix, new always-keep list, Google ecosystem signals, transactional subject patterns, settings-backed overrides, the `isAgentMail` helper, and the backfill function.
- **Docs:** `docs/schema.md`, `docs/api.md`, `docs/security.md` updated. Changelog + solution doc updated.

## 2026-06-16 — Gmail moderation, Contacts enrichment, and invoice minimum charge

- Added strict Gmail junk classification for pending scan entries. Obvious junk is soft-dismissed with `dismissed_by`, `dismissed_reason`, `classification` JSON, and `dismissed_at`; ambiguous/client-like mail stays pending.
- Added Gmail queue bulk moderation UI: row checkboxes, **Dismiss N selected**, **Show dismissed**, dismissed status badges, and **Restore**.
- Added Google Contacts enrichment after import: server finds a likely contact via the existing OAuth token and the UI prompts before applying blank-field customer updates. Nothing overwrites existing customer data automatically.
- Added private minimum-charge support for time-based invoice drafts:
  - `settings.minimum_charge_cents` controls the default floor.
  - Money page now opens an invoice draft preview modal instead of creating immediately.
  - The admin can toggle/override the floor per invoice.
  - The floor is folded into labour line prices and never appears as a customer-visible “minimum charge” line.
- Fixed invoice math to treat `line_items[].total_cents` as the cents source of truth when present, avoiding fractional-hour/rounded-rate drift.
- Added/updated docs: `docs/schema.md`, `docs/api.md`, `docs/security.md`.
- Verification: backend test suite green at 117/117; client production build green; browser-tested Inbox bulk dismiss/show dismissed/restore, Settings minimum-charge field, and Money minimum-charge preview modal.

## 2026-06-15 — Inbox fix: Gmail scan returns 0 messages

- **Root cause:** `imapflow`'s `client.fetch(uidArray, { uid: true, ... })` was returning zero messages on this Gmail mailbox — server said `OK Success` but emitted no `* N FETCH (...)` response lines. UIDVALIDITY was stable, UIDs were valid (205967 = uidNext-1), but the FETCH iterator never yielded.
- **Fix:** switched `fetchUnread` from UID-list fetch to sequence-range fetch (`uids:false` on search → `client.fetch("848:850", ...)`). 25 messages now come back from a single scan call instead of zero. The message `uid` field is still populated by the server, so downstream code (de-dup, import) keeps working.
- **Secondary fix:** `GET /api/inbox/pending` was hard-capped at 100 rows. Mary's email (`marmcintyre@hotmail.com`, "your worse nightmare Mary") was at id ~217 and never reached the UI even when scan worked. Bumped default to 250, added `?limit` (1–500) and `?offset` query params, response now `{ items, total, limit, offset }`.
- **Tertiary fix:** ordering was `ORDER BY fetched_at DESC`, which is non-deterministic when 218 messages share an identical `fetched_at` (they do, after a bulk scan). Switched to `ORDER BY id DESC` for stable reverse-chronological order.
- **UI:** `GmailReviewQueue` now reads `r.items || r.rows` so it works with the new wrapped shape and is also backward-compatible with any client expecting a flat array. Header reads "(N of M pending)" when M > N.
- **Tests:** 37/37 passing (added 2 regression tests that exercise the 100-cap and ordering fixes with a fresh in-memory DB).
- **Verified end-to-end through the browser:** Inbox now shows 218 pending. Mary and Linda's company (Live Edge Design, 17 emails from Donna / Emily / Katie, including a $1,365 Interac deposit) are both visible.

## 2026-06-15 — Queue cleanup: MiniMax, booking, invoices, dashboard automation

- Installed MiniMax API key locally in `server/.env` and `~/.hermes/.env`; verified `testProvider('cheap_classify')` returns MiniMax `PONG`.
- Fixed MiniMax auth header spelling to `X-Api-Key`.
- Added Inbox source filter pills: All, Email, Manual, Booking.
- Added safe cron/monitor visibility to Inbox dashboard:
  - Hermes cron job summary (enabled count, last status, next run).
  - Appointment monitor last runs and pending slot count.
  - Starred client email suggestions last run and count.
  - Prompt bodies/scripts/secrets are intentionally not exposed.
- Added public `/book/:slug` React page with available 90-minute time slots.
- Added booking slot generation helper and `/api/booking/:slug` `available_slots` payload.
- Added printable invoice HTML route at `/api/invoices/:id/print` with browser Print/Save PDF support.
- Refactored invoice rendering into `lib/invoice-renderer.js` for shared email/plain-text/print output.
- Fixed Gmail import path to persist `tickets.source_message_id`, enabling later Gmail thread lookup/archive.
- Verified UFW already allows GeekShop HQ dev/API ports on Tailscale (`5173`, `5050`).
- Added unit tests for booking slot generation, invoice renderer, and cron status projection.

## 2026-06-15 — Billing: labour rate + Canadian tax model

- New `lib/tax.js` module: 6 Canadian tax models (none / GST 5% / BC GST+PST / QC GST+QST / HST ON 13% / HST NB-NS-PE 15%) with per-line tax breakdown.
- New setting `default_tax_model` (default: `gst_pst_bc`).
- New setting `labour_rate_cents_per_hour` (default: $125/hr).
- New endpoint `POST /api/invoices/draft-from-time` — turns a customer's un-invoiced time entries into invoice line items at the configured rate, then computes tax.
- New endpoint `POST /api/time-entries/mark-invoiced` — atomic flag so time entries don't double-invoice.
- `POST /api/invoices` now accepts `tax_model` (per-invoice override) and `tax_cents_override` (e.g. tax-exempt customer = 0).
- Printable HTML now shows per-line tax breakdown (e.g. "GST 5% — $3.13" and "PST 7% — $4.38" separately), business name + email from settings.
- Time-revenue report uses the configured labour rate.
- Settings page UI: new "Billing & tax" section with tax model dropdown + labour rate input (commits on blur/Enter, not per keystroke).
- Money page UI: "Draft invoice from time" card with one button per customer; creates the invoice, marks the time entries invoiced, opens the printable view.
- 15 new tests for tax math, rounding, model coverage, override path, and labour rate conversion.

## 2026-06-15 — Gmail housekeeping + reply/resolve

- Added Gmail thread housekeeping on resolve: mark read, apply `GeekShop/Done`, archive from inbox when source is email.
- Added `Email customer` and `Reply & resolve` actions in TicketDetail.
- Added `TicketLabel` component to keep internal `G-NNNNNN` IDs subtle and admin-only.

## 2026-06-15 — Customer-facing language cleanup

- Removed customer-facing "ticket" wording from resolution emails.
- Resolution emails now use `Re: <subject>` to thread naturally.
## 2026-06-18 — Accounting module MVP (T-9205D5)

Added the first cut of a solo-owner accounting module on top of the existing
HQ customers + invoices. Six new tables, twenty new routes, twenty-five new
tests (all passing), documentation updated.

**Migration:** `031_accounting.sql` adds `tax_rates`, `products`,
`expense_categories`, `expenses`, `payments`, and `payment_events`.

**Routes (under `/api/accounting/*`):**
- `GET /status` — feature flag report (what's wired, what's deferred)
- `tax-rates` — list / create / update
- `products` — list (with `?q=` and `?active=1`) / create / update
- `expense-categories` — list / create
- `expenses` — list (with date range + category + vendor filters) / create / update
- `payments` — list / create (manual + Stripe shape; idempotency via `payment_events`)
- `reports/pnl`, `reports/sales-by-customer`, `reports/expenses-by-category`, `reports/tax-collected`, `reports/outstanding`
- `dashboard` — month-to-date income, expense, net, recent payments/expenses

**Auto-marks invoice paid:** when a `succeeded` payment's running total
reaches the invoice's `total_cents`, the invoice is flipped to `paid` in
the same DB transaction as the payment insert.

**Audit log:** every create/update writes to `audit_log` (same pattern as
customers.js). `target` is the row id (string); `payload` is the changed
fields as JSON.

**Idempotency:** `payment_events.stripe_event_id` is UNIQUE, so a Stripe
webhook receiver (next step) can re-process the same event id without
double-counting. Manual `stripe_payment_intent_id` events land there as
`pi:pi_xxxxx` keys.

**Out of scope for the MVP — explicit follow-ups:**
1. PDF invoice generation (text+HTML renderer exists at `server/lib/invoice-renderer.js`; needs a PDF backend like `puppeteer`).
2. Stripe Checkout / Payment Links (gated on `STRIPE_SECRET_KEY`; the status endpoint reports `true` once it's set).
3. Stripe webhook receiver with signature verification (gated on `STRIPE_WEBHOOK_SECRET`; schema is ready).
4. QuickBooks Online import (QBO OAuth + mapping UI; CSV import is the v0.2 step).

**Tests:** `test/accounting.test.js` covers every endpoint (25 cases, all
green). `test/basic.test.js` was updated to include the new tables in the
schema list. Full suite: 210/210 passing.

**Files touched:**
- `server/db/migrations/031_accounting.sql` (new)
- `server/routes/accounting.js` (new)
- `server/routes/index.js` (register)
- `server/test/accounting.test.js` (new)
- `server/test/basic.test.js` (table list)
- `docs/api.md` (accounting section)
- `docs/schema.md` (accounting tables section)

## 2026-06-29 — Phase 1 Revenue leakage dashboard (T-ED62EC)

Phase 1 of [`docs/plans/2026-06-29-geekshop-hq-accounting-roadmap.md`](./plans/2026-06-29-geekshop-hq-accounting-roadmap.md). Surfaces billable work and cash leaks that would otherwise be forgotten, in one widget on the Accounting dashboard tab.

**What shipped**

- `GET /api/accounting/leakage` — single-call rollup of five buckets:
  1. Uninvoiced time entries (valued at the configured `labour_rate_cents_per_hour`, default $100/h). Running timers report `value_cents: 0` and a `running: true` flag rather than guessing at unfinished billables.
  2. Resolved tickets with uninvoiced time attached. Highest-signal bucket because the work is done and can't easily be re-opened for billing.
  3. Stale draft invoices (older than `stale_draft_days`, default 14).
  4. Overdue sent invoices (any invoice whose `due_at < now` and status is `sent` or `overdue`).
  5. Dormant customers — active customers with open ticket / uninvoiced time whose most recent invoice is missing or older than `stale_invoice_days` (default 30). Each row exposes `open_tickets`, `uninvoiced_entries`, `uninvoiced_seconds`, `last_invoice_at`, `last_paid_or_sent_at`.
- `LeakagePanel` React component on the Accounting → Dashboard tab. Five cards, each with a top-5 list linking to the underlying ticket / invoice / customer.
- Tunable thresholds in the UI (`stale drafts > Nd`, `no invoice in > Nd`), refresh button.
- 13 unit tests in `test/leakage.test.js` covering all five buckets + edge cases (cancelled invoice line_items ignored, customers with no invoices, running timers, resolution filter, total cents math, params clamping).
- Defensive SQL: a time entry is `uninvoiced` only if it has no match as `line_items[].source_time_entry_id` in any non-cancelled invoice. This protects against older test data / imports where `time_entries.invoiced_at` may not have been stamped.

**Why not the main `/api/dashboard` endpoint?**

`/api/dashboard` already surfaces overdue invoices as one of the dashboard cards. The leakage widget is heavier (joins + grouping + runs against `time_entries`) and runs on the Accounting page, not the Inbox. Kept them separate to keep the Inbox dashboard call cheap and to keep the leakage calculations testable in isolation. If we want a one-line summary on Inbox later, the same endpoint can be reused; the data shape is stable.

**Files touched**

- `server/routes/accounting.js` — added the `/api/accounting/leakage` route (≈200 lines, all five buckets, integer cents, defensive joins).
- `client/src/pages/Accounting.jsx` — added `LeakagePanel` + `LeakageCard` and wired it as the first thing on the Dashboard tab.
- `server/test/leakage.test.js` — 13 vitest cases against a freshly migrated DB.
- `docs/api.md` — documented the new endpoint and bucket shapes.
- `docs/plans/2026-06-29-geekshop-hq-accounting-roadmap.md` — Phase 1 marked complete.

**Test results**

- `test/leakage.test.js` — 13/13 green.
- Full server suite — 254/257 green. The 3 failing cases (`tax-collected sums invoice tax_cents`, `Stripe verifyWebhook signatures`, `customer search benchmark`) predate this tick and live in the previous accounting MVP + customer search benchmarking work. None touch the leakage path.
- Client build verified separately.

**Deferred (next phases)**

- Phase 2: Customer 360 timeline (per-customer unified event log).
- Phase 3: Payments ledger + invoice state upgrades (the `payments` table already exists from the MVP; this phase adds the `paid` / `viewed` / `void` flow).
- Phase 4: Expense/receipt capture.
- Phase 5: Tax summary reports.
- Phase 6: Accountant export bundle.

No QuickBooks sync direction was added. The leakage widget reads only local data and pushes nothing outbound.

## 2026-06-29 — Mobile-friendly responsive UX pass (T-F0FA30)

The HQ admin surface had usable but cramped mobile behavior — the Inbox Gmail review queue overflowed horizontally inside its card, Mission Control's status tiles wrapped to an awkward 3+3+1, and Money truncated tax-model names. This pass audited every priority surface at iPhone-12 viewport (390×844) and fixed the actual offenders with minimal CSS-class additions. No new dependencies, no framework changes.

### What was already in place (from prior attempts, preserved)

- **`Layout.jsx`** — sticky top bar with hamburger (`md:hidden`) + slide-in drawer (72-wide / max 85vw), Esc/backdrop close, body-scroll lock, `popstate` route-change handler.
- **`Modal.jsx`** — bottom-sheet on `< md`, centered dialog on `>= md`, scroll lock, focus retention.
- **`DataTable.jsx`** — stacked cards on `< md`, real table on `>= md`, `primary`/`hideOnMobile` column flags.
- **`PageHeader.jsx`** — flex-col on `< md`, flex-row on `>= md`, actions wrap under title.
- **`index.css`** — `body { overflow-x: hidden }`, `.break-words { word-break: break-word; overflow-wrap: anywhere }`, `.tap-target { min-height: 44px }`, `.table-scroll { overflow-x: auto }`, `.modal-scroll { overscroll-behavior: contain }`.

That foundation meant the audit found **zero document-level horizontal overflow** at iPhone-12 width on any of the 9 priority pages.

### What this pass fixed

- **`GmailReviewQueue.jsx`** — the in-card "Window:" and "Showing:" filter rows used `inline-flex` without `flex-wrap`, so the 6-button group pushed the card wider than the viewport and clipped the right edge. Added `flex-wrap` + `tap-target` to each filter row and to the action buttons (Show dismissed / Hide agent mail / Classify legacy / Scan Gmail now). Each pending-email row's actions (Preview / Import / Dismiss) now stack vertically on `< sm` and sit side-by-side at `>= sm`, instead of clipping the right edge of every row. The "(N of M pending …)" parenthetical is hidden on `< sm` so the heading doesn't truncate.
- **`MissionControl.jsx`** — the 7-tile summary row (`grid-cols-3 sm:grid-cols-4 md:grid-cols-7`) wrapped the last "cancelled" tile into a lone full-width row on phones. Added `min-w-0` to each tile and `truncate` on the status label so the row stays visually balanced.
- **`Money.jsx`** — the "Default tax model" line in the Billing settings card used a plain `<span>` that truncated `gst_pst_bc` to `gst` on narrow screens. Added `break-all` so the value wraps cleanly.

### Verification

- Built `playwright` in `/tmp/.pw-venv` (Python 3.14 + playwright 1.61.0 + chromium-headless-shell). Wrote two audit scripts:
  - `/tmp/mobile_audit.py` — walks Inbox, Tickets, Appointments, Customers, Money, Accounting, Time, Mission Control, Settings at 390×844, measures `document.documentElement.scrollWidth` vs `window.innerWidth`, saves a screenshot of each.
  - `/tmp/mobile_audit2.py` — adds TicketDetail, CustomerDetail (3 tabs), the open mobile drawer.
- Result: **every page reports `docW == winW == 390`, `hOverflow: false`.**
- Visual verification (vision_analyze on the saved screenshots) confirms:
  - Tickets / Customers / Money / Time / Appointments — cards stack cleanly, drawer reachable.
  - Mission Control — 7 tiles wrap cleanly, the task table scrolls horizontally *inside* its card (the page itself doesn't scroll sideways).
  - Inbox — Gmail review queue card now wraps filter buttons into a 3×3 grid and stack row actions vertically; title shows in full.
  - Drawer — all 10 nav items visible, dim backdrop, close button, active-page highlight works.
  - Accounting — 12 tabs wrap to 3-across 5 rows, leakage panel readable.
  - Settings — all sections use `sm:grid-cols-2` so two-column AI-provider grid collapses to one column on phone.

### What was NOT changed (out of scope / already fine)

- **Gmail card height on the Inbox**. The card holds up to 486 pending emails stacked as full cards. On a phone the right column (Open requests / Today's appointments / Overdue invoices) sits beside a card that's ~81,000px tall — visually awkward but not broken (the page is scrollable). Fixing this needs either lazy/virtual scrolling or a smaller default page size on mobile. Left for a follow-up.
- **TicketDetail header**. Subject line wraps to 2 lines on long "Re: Re: Re: …" subjects. Acceptable — `break-words` is already on, and the customer name + UID line stays on one row.
- **MissionControl task table**. Already inside an `overflow-x-auto` card; the table itself uses `min-w-[720px]` so it scrolls internally without affecting the page.

### Files touched

- `client/src/components/GmailReviewQueue.jsx` — header (flex-wrap, sm:truncate heading), Window/Showing filter rows (flex-wrap, tap-target), email row layout (flex-col on mobile, action buttons flex-wrap + tap-target).
- `client/src/pages/MissionControl.jsx` — summary tile min-w-0 + truncate label.
- `client/src/pages/Money.jsx` — Billing settings tax-model `break-all`.
- `docs/solutions/build-it/mobile-audit/` — 11 iPhone-12 screenshots (before/after for Inbox, plus Tickets, Customers, Money, Accounting, Time, Appointments, Settings, MissionControl, TicketDetail, CustomerDetail tabs, drawer-open).
- `docs/changelog.md` — this entry.

### Tests / build

- `cd client && npm run build` — 3.23s, 1670 modules, ✓ no errors. CSS bundle: 30.85 kB (gzip 6.15).
- `cd server && npm test` — 251/257 pass. The 6 failures (`tax-collected sums`, `Stripe verifyWebhook`, `db migrate`, `customer-search-benchmark`, 2× `google-contacts live`) predate this tick and live in earlier work (accounting MVP, customer search benchmarking, Google Contacts live integration). None touch the responsive CSS.
- `npm test -- test/smoke.test.js` — 12/12 green.
- `npm test -- test/agent-tasks.test.js test/queue-features.test.js` — 24/24 green (the worker / Mission Control tests that gate this very cron).
