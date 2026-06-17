# Architecture

GeekShop HQ is a local-first business dashboard for GeekShop Computers.

## Components

- **Frontend:** React + Vite + Tailwind, served on `5173` in dev.
- **Backend:** Fastify API on `5050`.
- **Database:** SQLite file at `data/hq.db`, migrations in `server/db/migrations/`.
- **Email:** Gmail IMAP for inbound scanning/import, SMTP for outbound replies.
- **AI:** MiniMax M3 primary local provider, heuristic fallback.
- **Mission Control:** Durable task queue (`agent_tasks` table) + worker cron
  (`GeekShop agent task worker`, every 2 min) + React UI at `/mission-control`.
  Byron's "real-time back-end view" of tasks running, waiting review, blocked,
  done. See `docs/api.md#mission-control-agent-task-queue` for the full
  contract.
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

### Mission Control → worker → review

1. A task is enqueued (HQ UI, Telegram bridge, or future email ingest).
2. The worker cron ticks every 2 min. It first runs the stuck-requeue sweep
   (bounce tasks with stale heartbeats back to `queued` / `failed`).
3. It claims the next task via `agent-task-cli.js claim` (atomic; never
   double-claims even with two overlapping ticks).
4. It heartbeats while it works, then transitions the row to `review`
   (all acceptance criteria pass) or `blocked` (some fail), writing the
   `review_checklist` and `result_summary`.
5. It pings Byron on Telegram with a `[J5][agent-task] <uid> → <status>`
   summary + the checklist rendered with ✓ / ✗.
6. Byron approves / sends back / cancels from `/mission-control` (or, in
   a future gateway patch, from inline Telegram buttons). The decision
   is recorded on the row.

### Telegram → task (bridge)

Two paths, both v1-ready:

- **Session-level:** in the active Telegram chat with `@john5wizbot`,
  typing `queue <description>` (or `/queue <description>`) causes the
  session to call the enqueue CLI and confirm the task is queued.
- **CLI / API:** any process that can reach the HQ DB or the API can
  create a task with `source: 'telegram'` and a `source_ref` (the
  originating Telegram message id).

Inbound message-bus polling is not in v1 — that would require a gateway
hook that intercepts every incoming DM, classify it, and decide whether
to enqueue. The session-level path gives the same UX with no gateway
modification.
