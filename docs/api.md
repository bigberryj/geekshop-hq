# API Notes

Base URL in development: `http://localhost:5050/api`

## Dashboard / Inbox

- `GET /dashboard`
  - Returns open requests, today's appointments, overdue invoices, customer health, cron status, and monitor status.
- `GET /dashboard?source=email|manual|booking`
  - Filters `open_tickets` by source for the Inbox pills.

Returned status fields are intentionally safe projections:

- `cron_status.jobs[]`: `name`, `enabled`, `last_status`, `next_run_at`
- `monitor_status.appointments`: last read-only monitor runs + pending slot count
- `monitor_status.starred_email_suggestions`: last read-only starred-email suggestion runs

No cron prompts, scripts, or secrets are exposed.

## Booking

- `GET /booking/:slug`
  - Returns public booking page config plus `available_slots`.
  - Slot shape: `{ starts_at, ends_at, label }`.
  - Defaults: Monday-Friday, 10am-6pm, 90 minute slots.
- `POST /booking/:slug`
  - Body: `{ name, email, starts_at, ends_at, notes? }`
  - Creates an appointment if the slot does not conflict.

## Inbox / Gmail import

- `GET /inbox/unread?limit=25`
  - Lists recent unread Gmail messages through IMAP.
- `POST /inbox/import-as-ticket`
  - Body: `{ messageId?, customerId?, fromEmail?, from?, subject?, body? }`
  - Creates a ticket with `source='email'` and persists `source_message_id` for Gmail thread lookup.
- `POST /inbox/test`
  - Tests Gmail IMAP connection.
- `GET /inbox/status`
  - Returns poller configuration: `{ hasCreds, pollIntervalMin, autoCreate, moderation_mode }`.
  - `pollIntervalMin` reflects `BYRON_GMAIL_POLL_INTERVAL_MIN` (default 30 min). The poller checks Gmail for new messages on this cadence.

### Gmail pending queue

- `GET /inbox/pending?status=pending&limit=250&offset=0`
  - Lists pending Gmail scan entries ordered by `received_at DESC, id DESC`.
  - Response: `{ items, total, limit, offset }`.
- `GET /inbox/pending?include_dismissed=true&since=<iso>&until=<iso>`
  - Returns pending + dismissed rows for review/restore.
  - `since`/`until` filter on `received_at`; invalid dates return `400`.
- `POST /inbox/scan`
  - Body: `{ since?, until?, include_starred?, limit? }`.
  - Default window is last 24 hours; manual scans can include starred mail.
  - Parks messages in `pending_emails`; does not create customers/requests automatically.
  - Applies strict junk classification before insert. Obvious junk is stored as `status='dismissed'` with classification metadata; ambiguous messages remain pending.
- `POST /inbox/pending/:id/import`
  - Creates/links a customer and creates a request from a pending email.
  - Returns `{ ticket, customer, contactMatch?, merged_into_existing?, already_imported? }`.
  - `contactMatch` is best-effort Google Contacts enrichment data; the frontend must still ask for an explicit Apply click before updating customer fields.
  - **Reply-merge behaviour (2026-06-17):** before creating a brand-new ticket, the import path runs the reply matcher (`lib/replies.js`). If the Gmail message is recognized as a reply to an existing open ticket for the same customer (matched by `In-Reply-To` / `References` thread id, or by sender + stripped `Re:`/`Fwd:` subject), the message is appended to the existing ticket, the pending row is flipped to `imported`, the Gmail message is marked `\Seen`, and the response carries `merged_into_existing: true` with the existing ticket.
  - **Idempotency:** if the matcher reports `already_appended` (the message already produced a `ticket_messages` row in a prior run), the pending row is still flipped to `imported` but the response carries `already_imported: true` and **no** new ticket is created.
  - After a successful import (new or merged), the source Gmail message is marked read via `imapflow` (`\Seen` flag, no archive). Best-effort — never throws.
- `GET /inbox/pending/:id/preview`
  - Returns `{ id, message_id, from_name, from_email, subject, date, body_text, body_html, attachments }`.
  - `body_html` is sanitized (`sanitizeEmailHtml`) and has `cid:` image references rewritten to `/api/attachments/:id/raw`.
  - On-demand fetches from Gmail if the cached body is empty or whitespace-only.
- `POST /inbox/pending/:id/dismiss`
  - Marks one pending email dismissed by the user.
- `POST /inbox/pending/bulk-dismiss`
  - Body: `{ ids: number[], by?: string, reason?: string }`.
  - Returns `{ dismissed, skipped }`.
  - Idempotent: already-dismissed/imported rows are counted as skipped, not failures.
- `POST /inbox/pending/:id/restore`
  - Restores a dismissed row to `status='pending'` and clears dismissal fields.

### Gmail moderation settings

- `GET /inbox/moderation-settings`
  - Returns the three settings the junk classifier reads at scan time:
    `{ auto_dismiss_domains, auto_keep_subjects, agent_mailbox_from }`.
- `POST /inbox/pending/backfill-classify`
  - Body: `{ threshold?: number (0..1, default 0.8), status?: 'pending' | 'all' (default 'pending'), limit?: number (1..100000) }`.
  - One-shot admin action. Classifies every un-classified pending row with the current rules, persists the classification JSON, and auto-dismisses any scoring ≥ `threshold`. Idempotent — safe to re-run after tuning the rules.
  - Returns `{ examined, classified, dismissed, threshold, samples }`. `samples` is up to 25 (subject, from, score, signals) examples for audit.

## Tickets

- `POST /tickets/:id/email-reply`
  - Body: `{ body }`
  - Sends a normal customer email with subject `Re: <original subject>` and keeps the request open.
  - The admin's `email_signature` setting is appended to both the plain-text and HTML body. If the signature is empty, the body is sent as-is.
- `POST /tickets/:id/resolve-with-reply`
  - Body: `{ reply_body }`
  - Sends customer email (signature appended), marks request resolved, and archives Gmail thread when source is email.
- `POST /tickets/:id/resolve`
  - Sends a short no-ticket-wording resolution email (signature appended) and archives Gmail thread when source is email.

### Ticket timers

- `GET /tickets/:id/time`
  - Returns time entries for a ticket, newest first.
  - Each row includes `status` (`running`, `paused`, `stopped`) and `elapsed_seconds`.
- `POST /tickets/:id/time/start`
  - Starts a timer for the ticket. Idempotent for the same ticket: if an active timer already exists, returns it instead of creating a duplicate.
  - Maintains the single-active-timer model by finalizing active timers on other tickets.
- `POST /tickets/:id/time/pause`
  - Freezes the active timer and stores accumulated elapsed time in `duration_seconds`.
- `POST /tickets/:id/time/resume`
  - Resumes a paused timer from the accumulated elapsed value.
- `POST /tickets/:id/time/stop`
  - Finalizes the active timer, paused or running, and returns the stopped row.

## Customers

- `GET /customers`
- `GET /customers/:id`
- `PUT /customers/:id` / `PATCH /customers/:id`
  - Whitelisted editable fields only: name, email, phone, company, notes.
  - Unknown/protected fields are ignored.
  - Empty `name` is rejected.
  - Audit log records changed fields.

### Customer 360 timeline (Phase 2 of accounting roadmap)

- `GET /customers/:id/timeline`
  - Returns a normalized, time-ordered feed of everything HQ knows about a customer, newest first. Powers the **Timeline** tab on `/customers/:id`.
  - Eight event kinds, all sourced from existing tables (no new writes):
    - `ticket_created` — a new ticket was opened
    - `ticket_resolved` — ticket moved to resolved state
    - `ticket_message` — inbound or outbound message on a ticket thread
    - `appointment` — booking from the public `/book` page (matched by `customer_id` **or** case-folded email fallback for legacy `customer_id IS NULL` rows)
    - `time_entry` — timer start/stop, with running entries surfacing as `running`
    - `invoice` — every state transition on an invoice (created, sent, paid) emits its own event row so a paid invoice shows as 3 dots in chronological order
    - `payment` — payment received against an invoice (Stripe + manual)
    - `memory` — admin-curated or AI-extracted `customer_memory` entry
  - Response shape:
    ```
    { customer: { id, name, email, status },
      events: [ { id, kind, at, title, summary, href, meta } ],
      counts: { ticket_created: N, ... },        // per-kind totals over the FULL eligible set, not the limited events[] list
      generated_at: '2026-…Z' }
    ```
  - Filters (all optional, all defensive — invalid values produce no error):
    - `?kinds=ticket,ticket_message` — comma-separated allow-list from the eight kinds above; unknown names are dropped
    - `?from=ISO8601`, `?to=ISO8601` — inclusive / exclusive date bounds on the per-kind `at` column
    - `?limit=N` — default 200, clamped to `[1, 1000]`
  - Privacy guarantees — these are never projected into the response payload:
    - `ticket_messages.body_html` (may contain PII / customer PII)
    - `ticket_messages.gmail_message_id`, `ticket_messages.source_message_id` (Gmail audit headers)
    - `payments.stripe_payment_intent_id`, `payments.stripe_charge_id` (Stripe audit keys)
    - Bodies are truncated server-side at 240 chars before they leave the API; the client renders them plain-text only (`whitespace-pre-wrap`, no `dangerouslySetInnerHTML`).
  - Status codes:
    - `400 invalid customer id` — non-integer `:id`
    - `404 customer not found` — valid id but no row
    - `200` — happy path, including zero events (empty `events[]` + `counts: {}`)

## Invoices

- `GET /invoices`
- `GET /invoices/:id`
- `POST /invoices`
  - Body: `{ customer_id, line_items, tax_model?, tax_cents_override?, due_at?, notes? }`
  - `tax_model` defaults to the `default_tax_model` setting.
  - `tax_cents_override` skips the model (e.g. `0` for tax-exempt).
  - `line_items[].total_cents`, when present, is treated as the cents source of truth to avoid fractional-hour rounding drift.
- `POST /invoices/:id/send`
- `POST /invoices/:id/paid`
- `GET /invoices/:id/print`
  - Printable HTML invoice. Use browser Print → Save as PDF.

## Billing

- `POST /invoices/draft-from-time`
  - Body: `{ customer_id, tax_model?, min_charge_apply?, min_charge_cents_override? }`.
  - Pulls un-invoiced time entries for the customer, converts them to line items at the configured `labour_rate_cents_per_hour`, optionally applies the private minimum-charge floor, applies tax model, and returns a preview.
  - Response includes `{ line_items, subtotal_cents, tax_lines, tax_cents, total_cents, rate_cents_per_hour, floor }`.
  - `floor` shape: `{ applied, configured_cents, effective_cents, original_labour_subtotal_cents, boosted_labour_subtotal_cents }`.
  - 400 if no un-invoiced time entries.
- `POST /invoices/draft-preview`
  - Same request/response as `draft-from-time`; preview-only alias used by the Money modal.
- `POST /time-entries/mark-invoiced`
  - Body: `{ time_entry_ids: number[] }`.
  - Sets `invoiced_at = now` on those rows. Idempotent: only sets if currently null.

## Tax models (`lib/tax.js`)

`none` (0%), `gst` (5% only), `gst_pst_bc` (5+7=12% two-line), `gst_qst_qc` (5+9.975% two-line), `hst_on_13` (13% single line), `hst_nb_ns_pe_15` (15% single line). Default: `gst_pst_bc`.

## Settings

- `GET /settings`
  - Returns all settings as a flat `{ key: value }` object. Sensitive fields (`smtp_pass`) are masked.
- `PUT /settings/:key`
  - Body: `{ value }`.
  - Upserts a single key/value pair. Used by the Settings page for everything from `business_name` to `email_signature`.
- `POST /settings/test-ai/:provider`
  - Probes the named AI provider (`minimax`, `codex`, `gemini`) and returns `{ ok, latency_ms }` or `{ ok: false, error }`.

### Outbound email signature

- Stored as `settings.email_signature` (plain text).
- Appended to every outbound ticket reply (both `email-reply` and `resolve-with-reply`).
- Plain text only by design — see `docs/security.md` for the rationale.

## Mission Control (agent task queue)

A durable queue of tasks Byron asks J5 to do. Surfaces in the HQ UI at
`/mission-control` with live polling, search/source filters, an evidence-first
operator-focus panel, task templates, explicit done-contract criteria, a drawer
showing the original ask + worker self-review, and Approve / Send-back /
Cancel buttons. Review rows can also be approved from the table's quick-action
column when no extra note is needed.

### Endpoints

- `GET    /api/agent-tasks?status=all|open|review|blocked|running|queued|failed|done|cancelled&limit=100&offset=0`
  - List tasks, paged. `open` = `queued|running|review|blocked` (everything that needs eyes).
  - Response: `{ items, total, limit, offset }`. Items do **not** include `prompt` (use `GET /:id` for that).
- `GET    /api/agent-tasks/summary`
  - Cheap counts per status for the dashboard widget. `{ queued, running, review, blocked, failed, done, cancelled, total }`.
- `POST   /api/agent-tasks`
  - Body: `{ title, prompt, source?, source_ref?, priority?, max_attempts?, acceptance_criteria? }`
  - `source` ∈ `hq_ui` (default) | `telegram` | `email` | `voice` | `seed`.
  - `prompt` capped at 32 KiB; `title` at 240 chars. Exceeding returns 400.
  - `acceptance_criteria`: array of `{ req, kind? }`. Empty / missing → worker infers 2–5 criteria. The HQ New Task form now treats this as a done contract and offers starter templates for verification, parallel research/audit, and reusable-learning capture.
  - Returns 201 with the new task (full detail including `prompt`).
- `GET    /api/agent-tasks/:id`
  - Full task including `prompt`, `acceptance_criteria`, `review_checklist`. 404 if missing.
- `POST   /api/agent-tasks/:id/decision`
  - Body: `{ action: 'approve' | 'requeue' | 'cancel', note? }`.
  - Allowed only when the task is in `review` or `blocked`. Terminal tasks (`done` / `cancelled`) and pre-worker tasks (`queued` / `running`) return 409.
  - The worker's `running → review` transition leaves `decision = null`; `approve` here sets `decision = 'approve'` and `decided_by = 'byron'`.
- `POST   /api/agent-tasks/:id/requeue`
  - Body: `{ note? }`. Alias for `decision` with `action: 'requeue'`. Same state guard.
- `POST   /api/agent-tasks/callback`
  - Lightweight shape designed for Telegram inline-button callbacks (and any other push-style client where JSON bodies are awkward).
  - Query params: `action`, `id`, `token` (the task's `uid` for sanity). Body fields are accepted as a fallback for clients that prefer JSON.
  - Returns the updated task on success, 409 on transition conflict, 400 on bad token / unknown action, 404 on missing task.
  - Wired by `notifyTaskForApproval()` to the Approve/Requeue/Cancel inline buttons on review-triggered Telegram pings. See `docs/mission-control-agents.md#inline-approval-buttons-telegram`.

### Worker contract

The worker cron (`GeekShop agent task worker`, every 2 min) reads its operating
manual at `server/scripts/agent-task-worker/WORKER_PROMPT.md` and uses
`server/scripts/agent-task-worker/agent-task-cli.js` to talk to the table:

```
node server/scripts/agent-task-worker/agent-task-cli.js claim
node server/scripts/agent-task-worker/agent-task-cli.js heartbeat <id>
node server/scripts/agent-task-worker/agent-task-cli.js mark-review <id> --summary="..." --checklist='[...]' --evidence=...
node server/scripts/agent-task-worker/agent-task-cli.js mark-blocked <id> --summary="..." --checklist='[...]' --error="..."
node server/scripts/agent-task-worker/agent-task-cli.js mark-failed <id> --summary="..." --error="..."
node server/scripts/agent-task-worker/agent-task-cli.js stuck-requeue --ms=600000
```

The CLI prints `NO_TASK` (single line) when the queue is empty. When a
task is claimed, it prints the full task JSON on stdout. Heartbeat
re-issues are how the worker keeps the stuck-detector from bouncing a
slow but live task.

### Status flow

```
  queued  ──┐
            ▼
         running ─── heartbeat ──→  running
            │
            ├── all pass  → review    (Byron approves → done, or sends back → queued, or cancels)
            ├── some fail → blocked   (Byron approves → done, or sends back → queued, or cancels)
            └── crash     → failed    (terminal, no further decision)
```

`done` and `cancelled` are terminal. `failed` is also terminal but a
requeue is possible by manual SQL or a future "rescue" endpoint — not
exposed in the v1 UI by design (failed tasks are usually worth a
human-in-the-loop look at the cause before retrying).

### Self-review gate

Before the worker transitions to `review`, it must build a
`review_checklist` (JSON array of `{ req, pass, note }`) covering every
acceptance criterion. If **any** `pass: false` exists, the task goes to
`blocked`, not `review`. This is the only thing standing between
"ran without errors" and "actually did what was asked" — Byron's eyes
on the checklist in the Mission Control drawer are the final word.

## AI

- MiniMax M3 is the primary configured provider for current local development.
- The API key is read from `MINIMAX_API_KEY` and is never committed.
- OpenAI is optional and only used if `OPENAI_API_KEY` is present.
## Accounting module (MVP, /api/accounting/*)
Solo-owner accounting scaffold on top of the existing customers + invoices.
All routes require an authenticated admin session (same `requireAdmin`
pattern as the rest of HQ).

### Status
- `GET /api/accounting/status` — Returns which features are wired up vs deferred.

### Tax rates
- `GET /api/accounting/tax-rates` — list
- `POST /api/accounting/tax-rates` — create `{ name, rate_bps, jurisdiction?, is_compound?, active? }`. `rate_bps` is basis points (5% = 500). Stored as integer.
- `PUT /api/accounting/tax-rates/:id` — update

### Products (catalog)
- `GET /api/accounting/products?active=1&q=foo` — list / search
- `POST /api/accounting/products` — create. Returns 409 on duplicate SKU.
- `PUT /api/accounting/products/:id` — update

### Expense categories
- `GET /api/accounting/expense-categories` — list (joined with tax rate)
- `POST /api/accounting/expense-categories` — create `{ name, tax_rate_id? }`

### Expenses
- `GET /api/accounting/expenses?from=YYYY-MM-DD&to=YYYY-MM-DD&category_id=&vendor=` — list with filters
- `POST /api/accounting/expenses` — create
- `PUT /api/accounting/expenses/:id` — update
- `DELETE /api/accounting/expenses/:id` — delete an expense and its receipt attachment
- `POST /api/accounting/expenses/:id/receipt` — upload receipt attachment (multipart/form-data)
- `GET /api/accounting/expenses/:id/receipt` — download receipt attachment
- `DELETE /api/accounting/expenses/:id/receipt` — delete receipt attachment

### Payments
- `GET /api/accounting/payments?invoice_id=&method=&status=` — list
- `POST /api/accounting/payments` — create. `method` is `stripe|cash|cheque|e_transfer|other`. Stripe `payment_intent.id` stored + appended to `payment_events` (unique-key idempotency). After every successful insert, `reconcileInvoiceStatus()` is run; the invoice's `status` is auto-promoted to `partial` (some money covered) or `paid` (covered in full) accordingly. `paid_at` is stamped on first-time promotion to `paid` and preserved thereafter.
- `PUT /api/accounting/payments/:id` — adjust `notes`, `received_at`, or `status` (`pending|succeeded|failed|refunded`). `amount_cents` and `invoice_id` are intentionally immutable — corrections use a fresh row or a refund. Status edits re-run the reconciler because a refund flips the invoice back to `partial`.
- `GET /api/accounting/payments/summary?invoice_id=&customer_id=&status=&since=&until=` — invoice rollup with payment totals. Returns one row per invoice including:
  - `total_cents`, `paid_cents`, `pending_cents`, `refunded_cents`, `balance_cents = max(0, total - paid)` — all integer cents, ref never raises balance.
  - `computed_status` — live status from the ledger (`sent|viewed|overdue|partial|paid`).
  - `status_in_sync` — `true` when the persisted `invoices.status` matches the computed one. `false` rows need a reconciler pass.
  - `last_payment_at`, `payment_count` — operator-facing freshness markers.
  Ordered by overdue-first, partial-second, then `created_at DESC`. Limit 500.
- `POST /api/accounting/payments/reconcile` — sweeps every invoice whose status is NOT (`cancelled`, `paid`, `draft`) and reapplies `reconcileInvoiceStatus()`. Idempotent. Returns `{ count, updated: [{id, from, to}] }`. Use after bulk edits or whenever `status_in_sync = false` shows up widely.

### Invoice state machine (Phase 3)

See `docs/schema.md` for the full transition diagram. The route layer enforces these rules:

- Manual `POST /api/invoices/:id/status` accepts `{draft | sent | viewed | overdue | paid | cancelled}`. `partial` is intentionally NOT in the allowlist — it is derived only from the ledger.
- `paid_at` is set the first time the invoice's succeeded payments reach `total_cents` and is preserved across refunds/demotions. The audit log entry (`invoice.status_auto`) records every auto flip.
- A past-due `partial` does NOT auto-promote to `overdue`; the partial is the steady state while money continues to arrive.

### Reports
- `GET /api/accounting/reports/pnl?from=&to=` — income, expense, net
- `GET /api/accounting/reports/sales-by-customer?from=&to=`
- `GET /api/accounting/reports/expenses-by-category?from=&to=`
- `GET /api/accounting/reports/tax-collected?from=&to=`
- `GET /api/accounting/reports/outstanding` — sent/overdue invoices
- `GET /api/accounting/tax/summary?from=&to=&format=` — tax collected on invoices/payments, tax paid on expenses, net remittance summary. Format can be 'csv' for CSV export.
- `GET /api/accounting/tax/pdf-ready?from=&to=` — PDF-ready payload for tax remittance summary.

### Dashboard rollup
- `GET /api/accounting/dashboard` — unpaid/overdue counts, MTD income/expense, net, recent payments/expenses.

### Revenue leakage (Phase 1 of billing/accounting roadmap)
- `GET /api/accounting/leakage?stale_draft_days=14&stale_invoice_days=30` — single-call rollup of the five leakage buckets. `stale_draft_days` and `stale_invoice_days` are clamped to `[1, 365]` and default to 14 and 30 respectively. Labour rate is read from the `labour_rate_cents_per_hour` setting (falls back to $100/h).
  - `uninvoiced_time.entries[]` — each row has `id`, `ticket_id`, `ticket_uid`, `duration_seconds`, `running`, `value_cents`, timestamps. `by_ticket[]` groups by ticket and sums value.
  - `resolved_tickets_with_uninvoiced_time.groups[]` — subset of `by_ticket` where the parent ticket's status is `resolved`. Highest-signal bucket (work is done and won't reopen).
  - `stale_draft_invoices.invoices[]` — draft invoices older than `stale_draft_days`.
  - `overdue_sent_invoices.invoices[]` — sent/overdue invoices with `due_at < now`; each row has `days_overdue`.
  - `dormant_customers.customers[]` — active customers with open tickets or uninvoiced time whose most recent invoice is missing OR older than `stale_invoice_days`. Each row exposes `open_tickets`, `uninvoiced_entries`, `uninvoiced_seconds`, `last_invoice_at`, `last_paid_or_sent_at`.
  - All amounts use integer cents. Running timers report `value_cents: 0` (elapsed is unknown) rather than guessing.
  - Renders as the `LeakagePanel` on `/accounting` (Dashboard tab). Same endpoint is reusable from Money/Inbox later without server changes.

### Deferred (explicitly out of scope for the MVP)
- PDF invoice generation (existing text+HTML renderer exists; needs PDF backend)
- Stripe Checkout / Payment Links (gated on STRIPE_SECRET_KEY)
- Stripe webhook receiver (gated on STRIPE_WEBHOOK_SECRET; payment_events schema is ready)
- QuickBooks Online import (needs QBO OAuth + mapping UI; CSV import is the v0.2 step)

## Contract Clients — admin (`/api/contract-clients/*`)

Multi-location corporate clients with monthly support contracts. Replaces
the Google Sheets "Contract Clients" workbook. All routes require admin
auth (`hq_sid` cookie in production; open in development). Returns JSON.

- `GET    /api/contract-clients?status=&search=` — list clients (default `status=active`)
- `POST   /api/contract-clients` — create (`name` required)
- `GET    /api/contract-clients/:id` — client detail (locations, contact summary, counts, recent 25 requests)
- `PATCH  /api/contract-clients/:id` — update any of the editable fields
- `POST   /api/contract-clients/:id/archive` — soft-archive
- `GET    /api/contract-clients/:id/locations` — list locations with counts
- `POST   /api/contract-clients/:id/locations` — add location (`label` required)
- `PATCH  /api/contract-clients/:id/locations/:lid` — update location
- `GET    /api/contract-clients/:id/locations/:lid/contacts` — list contacts
- `POST   /api/contract-clients/:id/locations/:lid/contacts` — add contact
- `PATCH  /api/contract-clients/contacts/:ctid` — edit a contact (name, email, phone, role, is_office_manager, notify_on_request, status, location_id). Cross-client moves rejected with 400; moving to a location outside the contact's current client also rejected with 400. Audit-logged as `client_contact.update`.
- `DELETE /api/contract-clients/contacts/:ctid` — remove a contact. Returns 409 `contact_in_use` if the contact submitted any `contract_requests` (history integrity — submitting_contact_id FK is `ON DELETE RESTRICT`); portal credentials and invites referencing the contact cascade to `NULL` (those FKs are `ON DELETE SET NULL`). Audit-logged as `client_contact.delete`.
- `GET    /api/contract-clients/:id/requests?status=&location_id=` — list requests; `location_id` (optional) restricts to one location of this client — the server verifies the location belongs to the client before applying the filter, and an empty/blank value is treated as no filter. Priority values are `low | normal | high | urgent`.
- `GET    /api/contract-clients/requests/:rid` — request detail with events
- `POST   /api/contract-clients/:id/requests` — admin-raised request (auto-creates a request_uid like `CR-000123`)
- `PATCH  /api/contract-clients/:id/requests/:rid` — admin edits (status, assigned_to, priority, category)
- `POST   /api/contract-clients/requests/:rid/cancel` — admin cancel (uses same `canCancel()` rule as portal)
- `GET    /api/contract-clients/:id/assets?location_id=` — list assets
- `POST   /api/contract-clients/:id/assets` — add asset (`location_id`, `type` required)
- `PATCH  /api/contract-clients/assets/:aid` — update asset
- `GET    /api/contract-clients/:id/portal-users` — list portal credentials
- `POST   /api/contract-clients/:id/invites` — create magic-link invite token (returns `{ token, expires_at, ... }`)

## Client Portal (`/api/portal/*`)

The public-facing surface for office managers. Uses the `hq_csid` cookie
(set by `/api/portal/login`); never share the admin `hq_sid`. Every
read/write is scoped server-side via `locationScopeFragment()` so a
location_manager can never see data outside their scope.

- `POST /api/portal/login` — `{ email, password }` → sets `hq_csid` cookie
- `POST /api/portal/logout` — clears the cookie
- `GET  /api/portal/me` — current session summary: client name, scope, visible locations
- `GET  /api/portal/assets?location_id=` — devices at locations you can see
- `GET  /api/portal/contacts` — contacts in your scope (for picking the request submitter)
- `GET  /api/portal/requests` — visible requests; uses `location_id` scoped to the credential
- `GET  /api/portal/requests/:rid` — detail with events (admin-only fields hidden)
- `POST /api/portal/requests` — submit a new request. Validates that the chosen `location_id`, `contact_id`, and optional `asset_id` are all in the session's scope. Auto-mints a `CR-NNNNNN` uid.
- `POST /api/portal/requests/:rid/cancel` — cancel-eligible check via `canCancel()`. Returns `409 { reason }` when not eligible (terminal, already-assigned to staff, cross-client, etc).
- `GET  /api/portal/redeem/:token` — peek invite (returns `client`, `email`, `scope_type`)
- `POST /api/portal/redeem/:token` — `{ password }` → consumes the invite, creates the credential, logs the user in (cookie set)

### Cancel rules (admin + portal)

`canCancel(credential, requestRow)` in `lib/contract-clients.js`:

- Admin (no credential): any non-terminal request.
- Submitting contact in scope: cancellable when status ∈ {open, in_progress} AND `assigned_to IS NULL`.
- Submitting contact once assigned: cancelled only by admin.
- Non-submitter office manager at the same client: cancellable until staff assigns (`assigned_to IS NULL`).
- Terminal (`resolved`, `cancelled`): never cancellable.
- Cross-client: never.
- Disabled credential (`disabled_at`): never.
