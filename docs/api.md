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
  - Returns poller configuration.

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
  - Returns `{ ticket, customer, contactMatch? }`.
  - `contactMatch` is best-effort Google Contacts enrichment data; the frontend must still ask for an explicit Apply click before updating customer fields.
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
- `POST /tickets/:id/resolve-with-reply`
  - Body: `{ reply_body }`
  - Sends customer email, marks request resolved, and archives Gmail thread when source is email.
- `POST /tickets/:id/resolve`
  - Sends a short no-ticket-wording resolution email and archives Gmail thread when source is email.

## Customers

- `GET /customers`
- `GET /customers/:id`
- `PUT /customers/:id` / `PATCH /customers/:id`
  - Whitelisted editable fields only: name, email, phone, company, notes.
  - Unknown/protected fields are ignored.
  - Empty `name` is rejected.
  - Audit log records changed fields.

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

## AI

- MiniMax M3 is the primary configured provider for current local development.
- The API key is read from `MINIMAX_API_KEY` and is never committed.
- OpenAI is optional and only used if `OPENAI_API_KEY` is present.
