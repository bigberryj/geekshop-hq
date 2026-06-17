# GeekShop HQ

> A single-pane business dashboard for [GeekShop Computers](https://geekshop.ca). Tickets, appointments, customers, money, time tracking, AI-assisted replies, customer memory — all in one place, no Postgres required.

Built as a deliberate rebuild of the previous `GeekTicket` (a.k.a. `tasktrackerticket`) system. The new system is **~10× simpler** while keeping the day-to-day features that matter.

## What you get

- **10 pages**: Inbox, Tickets, Appointments, Customers, Money, Time, Memory search, Settings, Public Booking, **Mission Control**
- **12 DB tables** (SQLite, single file at `data/hq.db`)
- **Mission Control** — durable task queue with a worker cron, self-review
  gate, and a real-time UI at `/mission-control`. Byron enqueues a task in
  the UI, in Telegram (`queue <description>`), or via the API; the worker
  picks it up every 2 min, runs it, self-reviews against acceptance
  criteria, and pings for approval.
- **~38 API endpoints**
- **2 AI features** powered by MiniMax M3 locally, with OpenAI optional if an `OPENAI_API_KEY` is provided
- **Self-hosted customer memory** — preferences, equipment, history, relationships, notes per customer
- **Time tracking** per ticket (one-click start/stop)
- **Invoices + quotes** with status tracking and overdue reminders
- **Recurring pattern detection** (e.g. "this customer calls every 90 days")
- **Public booking page** at `/book/<slug>` with visible 90-minute available slots
- **Printable invoices** via browser Print / Save PDF
- **Automation status widgets** for appointment monitoring, starred-email suggestions, and Hermes cron health
- **Mission Control** — durable task queue, self-reviewing worker, real-time UI. See `docs/api.md#mission-control-agent-task-queue` and `docs/architecture.md#mission-control--worker--review`.

## Mission Control in 30 seconds

1. Open http://localhost:5173/mission-control
2. Click **+ New task**, give it a title, full prompt (acceptance criteria are auto-inferred if you don't supply any), and submit.
3. The worker cron picks it up on the next 2-min tick. You can force it with `hermes cron run e6034f45874f`.
   - **Silent by default.** The cron uses `deliver: local`. The worker pings you on Telegram only when a real task is done. Empty queue, rate-limit cooldown, and stuck-requeue ticks produce no message at all — the worker returns `[SILENT]`. This is by design: the system is on a 2-min tick, and the last thing you want is a "nothing to do" message every 2 min.
4. The worker writes a `result_summary` and a self-review checklist. You see the row go `queued → running → review` in real time. A Telegram ping lands in `@john5wizbot` with the checklist.
5. Click the row in HQ to **Approve**, **Send back**, or **Cancel**.

Telegram shortcut: in the bot chat, type `queue <description>` and the session enqueues it for you.

## Quick start (dev)

Requires Node 22+ (tested on Node 26).

```bash
git clone https://github.com/bigberryj/geekshop-hq.git
cd geekshop-hq
bash start.sh
```

That script:
1. Seeds sample data on first run (3 customers, 2 tickets, 5 memory entries, 2 invoices, 2 appointments)
2. Starts the Fastify backend on `0.0.0.0:5050`
3. Starts the Vite frontend on `0.0.0.0:5173`

Open:
- **Dashboard:** http://localhost:5173 (or http://100.96.13.84:5173 from Tailscale)
- **Public booking:** http://localhost:5173/book/general

No login required in dev mode (NODE_ENV=development skips auth).

## Production setup

```bash
# Build the frontend
cd client && npm run build && cd ..

# Set env vars (see .env.example for the full list)
cp .env.example .env
# Edit .env — at minimum set:
#   NODE_ENV=production
#   ADMIN_PASSWORD=<long-random-string>
#   SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM
#   MINIMAX_API_KEY=... (for AI drafts/summaries/classification)
#   OPENAI_API_KEY=...  (optional secondary provider)

# Start with a process manager (pm2, systemd, etc.)
cd server && NODE_ENV=production node index.js
```

Serve the `client/dist/` directory from any static file host (nginx, Caddy, Railway static, etc.) and proxy `/api` + `/book` to the backend.

## Tech stack

- **Backend:** Node.js + [Fastify 5](https://fastify.dev/) + [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) + [pino](https://getpino.io/) + [nodemailer](https://nodemailer.com/) + MiniMax/OpenAI-compatible AI calls
- **Frontend:** React 19 + [Vite 6](https://vitejs.dev/) + [TailwindCSS 3](https://tailwindcss.com/) + [lucide-react](https://lucide.dev/) + [react-router 7](https://reactrouter.com/)
- **DB:** SQLite (WAL mode, file-based)
- **Tests:** [Vitest](https://vitest.dev/) — 10/10 passing

## AI provider routing

Two tiers, MiniMax-first:

| Tier | Provider | Used for |
|---|---|---|
| **High-reasoning** | MiniMax M3 by default; OpenAI optional if `OPENAI_API_KEY` exists | AI reply drafts, ticket summaries |
| **Cheap / fast** | MiniMax M3 | Urgency tags, simple classification |
| **Fallback** | Local heuristic | Keeps the app usable if providers fail |

Configuration is via local environment variables (`MINIMAX_API_KEY`, optional `OPENAI_API_KEY`). Secrets are never committed. The fallback chain per tier is `provider → heuristic`.

## What we kept from GeekTicket

- Tickets (the core abstraction)
- Customers + companies
- Appointments
- AI-assisted reply drafting
- AI ticket summary
- Email notifications
- In-app audit log
- Multi-channel contact (web + email)

## What we dropped (intentionally)

- Gmail auto-import (high noise, low value)
- Google Chat DM integration (overkill, breaks often)
- React Native mobile app (not needed for daily ops)
- FCM push notifications (email + in-app is enough)
- 7 of 9 AI features (sentiment, dup detection, trend analysis, self-service, follow-up Qs, email cleanup, resolution-time estimation)
- 60-second background sync workers
- Staff role + complex permissions
- Sub-tasks, internal notes, ticket attachments

## Repository

- GitHub: https://github.com/bigberryj/geekshop-hq
- Plan doc: `~/.hermes/skills/compound-engineering/docs/plans/2026-06-15-geekshop-hq.md` (read this for the why)
- Built by Johnny5 with [compound engineering](https://github.com/EveryInc/compound-engineering) (port at `bigberryj/compound-engineering-hermes`)

## License

MIT
