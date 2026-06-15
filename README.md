# GeekShop HQ

> A single-pane business dashboard for [GeekShop Computers](https://geekshop.ca). Tickets, appointments, customers, money, time tracking, AI-assisted replies, customer memory — all in one place, no Postgres required.

Built as a deliberate rebuild of the previous `GeekTicket` (a.k.a. `tasktrackerticket`) system. The new system is **~10× simpler** while keeping the day-to-day features that matter.

## What you get

- **8 pages**: Inbox, Tickets, Appointments, Customers, Money, Time, Memory search, Settings
- **11 DB tables** (SQLite, single file at `data/hq.db`)
- **~32 API endpoints**
- **2 AI features** powered by your existing subscriptions (Codex for high-reasoning, Johnny5/MiniMax for cheap/fast, Gemini as optional tertiary)
- **Self-hosted customer memory** — preferences, equipment, history, relationships, notes per customer
- **Time tracking** per ticket (one-click start/stop)
- **Invoices + quotes** with status tracking and overdue reminders
- **Recurring pattern detection** (e.g. "this customer calls every 90 days")
- **Public booking page** at `/book/<slug>` so customers can self-book

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
#   OPENAI_API_KEY=...  (for Codex high-reasoning tier)
#   HERMES_AI_URL=...   (for Johnny5 / MiniMax cheap tier)

# Start with a process manager (pm2, systemd, etc.)
cd server && NODE_ENV=production node index.js
```

Serve the `client/dist/` directory from any static file host (nginx, Caddy, Railway static, etc.) and proxy `/api` + `/book` to the backend.

## Tech stack

- **Backend:** Node.js + [Fastify 5](https://fastify.dev/) + [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) + [pino](https://getpino.io/) + [nodemailer](https://nodemailer.com/) + [OpenAI](https://www.npmjs.com/package/openai) (for Codex)
- **Frontend:** React 19 + [Vite 6](https://vitejs.dev/) + [TailwindCSS 3](https://tailwindcss.com/) + [lucide-react](https://lucide.dev/) + [react-router 7](https://reactrouter.com/)
- **DB:** SQLite (WAL mode, file-based)
- **Tests:** [Vitest](https://vitest.dev/) — 10/10 passing

## AI provider routing

Two tiers, both on your existing subscriptions (zero new API bills by default):

| Tier | Provider | Used for |
|---|---|---|
| **High-reasoning** | **Codex GPT-5.5** (ChatGPT sub) | AI reply drafts, ticket summary, memory extraction, EOD summary |
| **Cheap / fast** | **Johnny5 (MiniMax M3)** | Overdue classification, follow-up nudges, urgency tags, health scores |
| **Tertiary fallback** (optional) | **Gemini** | Only if you set the key and pick it |

Configuration in `Settings → AI provider`. Each tier has a Test button. The fallback chain per tier is `primary → secondary → local heuristic → 503`.

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
