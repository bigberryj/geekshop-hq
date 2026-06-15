# Architecture

GeekShop HQ is a local-first business dashboard for GeekShop Computers.

## Components

- **Frontend:** React + Vite + Tailwind, served on `5173` in dev.
- **Backend:** Fastify API on `5050`.
- **Database:** SQLite file at `data/hq.db`, migrations in `server/db/migrations/`.
- **Email:** Gmail IMAP for inbound scanning/import, SMTP for outbound replies.
- **AI:** MiniMax M3 primary local provider, heuristic fallback.
- **Automation visibility:** Hermes cron job state and selected monitor logs are read from `~/.hermes` and surfaced in the Inbox dashboard as read-only status.

## Data flow highlights

### Email → request

1. Gmail IMAP fetches unread/starred/client messages.
2. `POST /api/inbox/import-as-ticket` creates a ticket with `source='email'`.
3. Gmail `Message-ID` is persisted as `source_message_id`.
4. Resolving the request can mark the Gmail thread read, label it `GeekShop/Done`, and archive it.

### Public booking → appointment

1. Customer visits `/book/:slug`.
2. Frontend calls `GET /api/booking/:slug` for available 90-minute slots.
3. Customer submits name/email/notes and chosen slot.
4. Backend conflict-checks and inserts an appointment.

### Invoice → PDF/print

1. Admin opens Money page.
2. `Print/PDF` opens `/api/invoices/:id/print` in a new tab.
3. Browser Print dialog can print or save PDF.
