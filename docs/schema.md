# Schema Notes

The current database is SQLite at `data/hq.db` in development. Migrations live in `server/db/migrations/` and are applied by `server/db/migrate.js`.

## ER diagram

```mermaid
erDiagram
  customers ||--o{ tickets : has
  customers ||--o{ invoices : billed_to
  tickets ||--o{ time_entries : tracks
  tickets ||--o{ ticket_messages : contains
  ticket_messages ||--o{ ticket_message_attachments : has
  pending_emails ||--o| tickets : imports_to
  invoices ||--o{ time_entries : marks_invoiced
  settings ||--|| settings : key_value
```

## `customers`

| Column | Type | Null | Default | Notes |
|---|---|---:|---|---|
| id | INTEGER | NO | AUTOINCREMENT | PK |
| name | TEXT | NO | — | Customer/person name |
| email | TEXT | YES | — | Used for matching/imports |
| phone | TEXT | YES | — | May be enriched from Google Contacts after user approval |
| company | TEXT | YES | — | May be enriched from Google Contacts after user approval |
| notes | TEXT | YES | — | May include approved Google Contacts notes/address |
| created_at | TEXT | NO | CURRENT_TIMESTAMP | |
| updated_at | TEXT | YES | — | Updated by edit endpoint |

## `tickets`

| Column | Type | Null | Default | Notes |
|---|---|---:|---|---|
| id | INTEGER | NO | AUTOINCREMENT | PK |
| ticket_uid | TEXT | NO | — | Internal admin reference only (`G-NNNNNN`), never sent to customers |
| customer_id | INTEGER | NO | — | FK → `customers.id` |
| source | TEXT | NO | `manual` | `manual`, `email`, or `booking` |
| source_message_id | TEXT | YES | — | Gmail Message-ID header for imported email requests; used for Gmail thread lookup/archive |
| status | TEXT | NO | `open` | Open/resolved workflow state |
| priority | TEXT | YES | — | Admin priority |
| subject | TEXT | NO | — | Customer-facing emails use original subject, not ticket wording |
| last_message_at | TEXT | YES | — | Ordering/health |
| resolved_at | TEXT | YES | — | Resolution timestamp |

## `pending_emails`

Migration: `server/db/migrations/008_junk_classification.sql` adds the dismissal/classification fields.

| Column | Type | Null | Default | Notes |
|---|---|---:|---|---|
| id | INTEGER | NO | AUTOINCREMENT | PK |
| message_id | TEXT | NO | — | Unique Gmail Message-ID or UID fallback |
| uid | TEXT | YES | — | Gmail UID |
| from_name | TEXT | YES | — | Sender display name |
| from_email | TEXT | YES | — | Sender email |
| subject | TEXT | YES | — | Email subject |
| body | TEXT | YES | — | Email body/snippet source |
| snippet | TEXT | YES | — | Queue preview |
| received_at | TEXT | YES | — | Email date; list ordering/filtering uses this |
| status | TEXT | NO | `pending` | `pending`, `imported`, or `dismissed` |
| imported_ticket_id | INTEGER | YES | — | FK-ish pointer to created ticket after import |
| fetched_at | TEXT | NO | CURRENT_TIMESTAMP | Scan timestamp |
| decided_at | TEXT | YES | — | Import/dismiss decision timestamp |
| flagged | INTEGER | NO | `0` | Gmail starred/flagged marker |
| dismissed_by | TEXT | YES | — | `user`, `auto_junk`, or `auto_ai` |
| dismissed_reason | TEXT | YES | — | Human-readable rule/AI reason |
| classification | TEXT | YES | — | JSON: `{ score, signals[], should_dismiss, reason, decided_at }` |
| dismissed_at | TEXT | YES | — | Dismiss timestamp |

Indexes:

- `idx_pending_emails_status (status, fetched_at DESC)`
- `idx_pending_emails_msgid (message_id)` unique

Notes:

- Gmail scan parks messages here first. Nothing creates a customer/request until the admin clicks **Import**.
- `include_dismissed=true` exposes dismissed rows for review/restore.
- Auto-dismiss is intentionally strict: existing customers, likely humans, personal replies, calendar invites, and ambiguous messages stay visible.

## `appointments`

| Column | Type | Null | Default | Notes |
|---|---|---:|---|---|
| id | INTEGER | NO | AUTOINCREMENT | PK |
| customer_name | TEXT | NO | — | Public booking form |
| customer_email | TEXT | NO | — | Public booking form |
| starts_at | TEXT | NO | — | Slot start |
| ends_at | TEXT | NO | — | Slot end |
| notes | TEXT | YES | — | Booking notes |
| booking_slug | TEXT | YES | `general` | Public booking page slug |
| status | TEXT | NO | `scheduled` | Non-cancelled rows block future slots |

## `invoices`

| Column | Type | Null | Default | Notes |
|---|---|---:|---|---|
| id | INTEGER | NO | AUTOINCREMENT | PK |
| invoice_uid | TEXT | NO | — | `INV-YYYY-NNN` |
| customer_id | INTEGER | NO | — | FK → `customers.id` |
| line_items | TEXT | NO | — | JSON invoice lines; labour lines may include `source_time_entry_id`, `type: 'labour'`, and integer `total_cents` |
| subtotal_cents | INTEGER | NO | — | Integer cents; uses `line_items[].total_cents` where present |
| tax_cents | INTEGER | NO | — | Integer cents |
| total_cents | INTEGER | NO | — | Integer cents |
| status | TEXT | NO | `draft` | `draft`, `sent`, `paid`, `overdue` |
| due_at | TEXT | YES | — | Due date |
| notes | TEXT | YES | — | Internal/customer invoice notes |
| sent_at | TEXT | YES | — | Set when emailed |
| paid_at | TEXT | YES | — | Set by manual mark-paid; future QBO sync should own this |
| created_at | TEXT | NO | CURRENT_TIMESTAMP | |

Notes:

- Minimum charge is not stored as a customer-visible invoice line. When applied, labour line unit prices/totals are privately boosted before invoice creation.
- The floor configuration lives in `settings.minimum_charge_cents`; `0` or missing means disabled.

## `time_entries`

| Column | Type | Null | Default | Notes |
|---|---|---:|---|---|
| id | INTEGER | NO | AUTOINCREMENT | PK |
| ticket_id | INTEGER | NO | — | FK-ish pointer to `tickets.id` |
| started_at | TEXT | NO | — | |
| stopped_at | TEXT | YES | — | Set when timer is finalized/stopped |
| paused_at | TEXT | YES | — | Set while the active timer is paused |
| duration_seconds | INTEGER | YES | `0` for active timers | Accumulated elapsed seconds while paused/running; final elapsed seconds after stop |
| note | TEXT | YES | — | Invoice line description seed |
| invoiced_at | TEXT | YES | — | Set after invoice creation to avoid double billing |

Timer state:

- Active timers have `stopped_at IS NULL`.
- Running timers have `stopped_at IS NULL AND paused_at IS NULL`; elapsed time is `duration_seconds + (now - started_at)`.
- Paused timers have `stopped_at IS NULL AND paused_at IS NOT NULL`; elapsed time is frozen in `duration_seconds`.
- Stopped timers have `stopped_at IS NOT NULL`; `duration_seconds` is the final billable elapsed time.

## `settings`

| Key | Value type | Default | Notes |
|---|---|---|---|
| `business_name` | string | `GeekShop Computers` | Invoice print/email |
| `business_email` | string | `byron@geekshop.ca` | Invoice print/email |
| `booking_slug` | string | `general` | Public booking URL |
| `default_tax_model` | string | `gst_pst_bc` | One of the six Canadian tax models |
| `labour_rate_cents_per_hour` | integer cents | `10000` fallback | Money/time revenue and invoice drafts |
| `minimum_charge_cents` | integer cents | `0` fallback | Private per-invoice floor; only applied when selected/enabled |
| `email_signature` | plain text | (empty) | Appended to every outbound ticket reply (text + escaped HTML). Plain text only by design — see `docs/security.md`. |
| `agent_mailbox_from` | CSV | `johnn5wizbot@gmail.com` | From-addresses treated as operational agent traffic |
| `auto_dismiss_domains` | CSV | (empty) | Domains that always count as junk (+0.6 score) |
| `auto_keep_subjects` | CSV | (empty) | Subject substrings that are NEVER auto-dismissed |
| `ai_high_provider` / `ai_cheap_provider` | string | `minimax` | Two-tier AI provider routing |

## `ticket_messages`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | INTEGER | NO | AUTOINCREMENT | PK |
| ticket_id | INTEGER | NO | — | FK → `tickets.id` |
| sender | TEXT | NO | — | `admin`, `customer`, or `system` |
| body | TEXT | NO | — | Plain-text body (canonical) |
| body_html | TEXT | YES | — | Sanitized HTML for iframe rendering (cid: → `/api/attachments/:id/raw` already rewritten) |
| subject | TEXT | YES | — | Per-message subject (set for the first message of a thread; used for thread re-creation) |
| gmail_message_id | TEXT | YES | — | Idempotency key — unique index. Used by the reply matcher to detect "already appended" on re-scan. |
| source_message_id | TEXT | YES | — | The Gmail `In-Reply-To` / `References` header that placed this message in the thread. Audit / cross-reference. |
| ai_draft | INTEGER | NO | `0` | 1 if this admin message was an AI-drafted reply |
| created_at | TEXT | NO | CURRENT_TIMESTAMP | |

Indexes:

- `idx_messages_ticket (ticket_id, created_at)`
- `idx_ticket_messages_gmail_msgid` unique (when `gmail_message_id IS NOT NULL`)
- `idx_ticket_messages_source_msgid` (when `source_message_id IS NOT NULL`)

Notes:

- `body_html` is sanitized on write (`sanitizeEmailHtml` in `lib/attachments.js`): strips `<script>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `on*` handlers, `javascript:` URLs. Renders inside a sandboxed iframe in the UI.
- The reply matcher (`lib/replies.js`) appends new customer messages here when a Gmail message is recognized as a reply to an existing open ticket. The poller and the manual Import button both go through this path.

## Tax models

Implemented in `server/lib/tax.js`:

- `none`
- `gst`
- `gst_pst_bc`
- `gst_qst_qc`
- `hst_on_13`
- `hst_nb_ns_pe_15`
