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

## Tickets

- `POST /tickets/:id/email-reply`
  - Body: `{ body }`
  - Sends a normal customer email with subject `Re: <original subject>` and keeps the request open.
- `POST /tickets/:id/resolve-with-reply`
  - Body: `{ reply_body }`
  - Sends customer email, marks request resolved, and archives Gmail thread when source is email.
- `POST /tickets/:id/resolve`
  - Sends a short no-ticket-wording resolution email and archives Gmail thread when source is email.

## Invoices

- `GET /invoices`
- `GET /invoices/:id`
- `POST /invoices`
  - Body: `{ customer_id, line_items, tax_model?, tax_cents_override?, due_at?, notes? }`
  - `tax_model` defaults to the `default_tax_model` setting
  - `tax_cents_override` skips the model (e.g. `0` for tax-exempt)
- `POST /invoices/:id/send`
- `POST /invoices/:id/paid`
- `GET /invoices/:id/print`
  - Printable HTML invoice. Use browser Print → Save as PDF.

## Billing

- `POST /invoices/draft-from-time` — Body: `{ customer_id, tax_model? }`
  - Pulls un-invoiced time entries for the customer, converts to line items
    at the configured `labour_rate_cents_per_hour`, applies tax model,
    returns `{ line_items, subtotal_cents, tax_lines, tax_cents, total_cents }`.
  - 400 if no un-invoiced time entries.
- `POST /time-entries/mark-invoiced` — Body: `{ time_entry_ids: number[] }`
  - Sets `invoiced_at = now` on those rows. Idempotent: only sets if currently null.

## Tax models (`lib/tax.js`)

`none` (0%), `gst` (5% only), `gst_pst_bc` (5+7=12% two-line), `gst_qst_qc` (5+9.975% two-line), `hst_on_13` (13% single line), `hst_nb_ns_pe_15` (15% single line). Default: `gst_pst_bc`.

## AI

- MiniMax M3 is the primary configured provider for current local development.
- The API key is read from `MINIMAX_API_KEY` and is never committed.
- OpenAI is optional and only used if `OPENAI_API_KEY` is present.
