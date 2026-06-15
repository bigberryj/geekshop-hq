# Schema Notes

The current database is SQLite at `data/hq.db` in development. Migrations live in `server/db/migrations/` and are applied by `server/db/migrate.js`.

No schema changes were made during the 2026-06-15 queue cleanup. The important existing fields used by this pass are:

## `tickets`

- `ticket_uid` — internal admin reference only (`G-NNNNNN`), never sent to customers.
- `source` — `manual`, `email`, or `booking`.
- `source_message_id` — Gmail Message-ID header for imported email requests; used for Gmail thread lookup/archive.
- `status`, `priority`, `subject`, `customer_id`, `last_message_at`, `resolved_at`.

## `appointments`

- Public booking writes appointments with `customer_name`, `customer_email`, `starts_at`, `ends_at`, `notes`, `booking_slug`.
- Available slot generation reads upcoming non-cancelled appointments to avoid conflicts.

## `invoices`

- Invoice print/export reads `line_items`, `subtotal_cents`, `tax_cents`, `total_cents`, `due_at`, and customer join fields.
