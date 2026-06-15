---
title: "Built GeekShop HQ v0.1.0 — single-pane business dashboard from scratch"
date: 2026-06-15
category: docs/solutions/build-it
problem_type: greenfield_build
root_cause: na
resolution_type: new_feature
severity: low
tags: [fastify, sqlite, react, vite, tailwind, ai-routing, customer-memory, compound-engineering, two-phase-workflow]
plan: docs/plans/2026-06-15-geekshop-hq.md
---

# Built GeekShop HQ v0.1.0 — single-pane business dashboard from scratch

## What was built

A complete, end-to-end-running business dashboard for GeekShop Computers, replacing the over-engineered GeekTicket (tasktrackerticket) system. Single Fastify + SQLite backend, React 19 + Vite + TailwindCSS frontend, 11 DB tables, ~32 API endpoints, 9 frontend pages, two-tier AI router (Codex high / Johnny5 cheap / Gemini tertiary), self-hosted customer memory, time tracking, invoices + quotes, recurring-pattern detection, public booking page.

## Verification evidence

- **Backend tests:** 10/10 vitest pass (CRUD, masking, AI router, ICS builder, schema)
- **Production build:** `vite build` clean (320KB JS gzipped to 102KB)
- **Live API verified:**
  - `GET /api/health` → 200
  - `GET /api/dashboard` → 2 open tickets, 1 overdue invoice, 3 customers scored
  - `GET /api/customers` → health scores (Brian 91 green, Linda 100 green, Powell River 0 red)
  - `GET /api/tickets/1` → full ticket + messages + customer memory context
  - `GET /api/money/summary` → $294 outstanding, $294 overdue
  - `GET /api/memory/search?q=UniFi` → matches Linda's equipment
  - `POST /api/booking/general` (public) → creates appointment 3
- **Tailscale-accessible:** http://100.96.13.84:5173 works
- **Pushed to:** https://github.com/bigberryj/geekshop-hq (commit 4c937d6)

## What actually happened (vs the plan)

The plan called for **12-16h (XL)** of work. The actual implementation finished in a single long session because:

1. **No existing code to integrate** — the only prerequisite was reading the previous GeekTicket system for context, not porting from it
2. **better-sqlite3 11.x didn't build against Node 26** — had to bump to 12.x (caught by the build error, not a hidden surprise)
3. **The two-tier AI router simplified to a `lib/ai.js` dispatch** — ~100 lines, not the 200+ I'd estimated
4. **No code generation from prior plan** — every line written from scratch, but the plan was tight enough that the architecture was clear from the start

## Pivots from the plan

- **Local Gemma option** was dropped per Byron's call (CPU-only is too slow; see `docs/plans/2026-06-15-geekshop-hq.md` discussion)
- **`/book/<slug>` actually returns JSON config**, not an HTML page. Reasoning: v1 only needs the JSON + the form in the admin UI; the customer-facing HTML page is a v1.5 add (the form already exists in the Appointments admin page)
- **Time tracking UI simplified** — "Start timer" / "Stop timer" buttons are present on the ticket detail page but not as a global floating widget. Matches the plan's "lightweight UI" callout

## What worked (the "compound" insight)

The two-phase workflow (`ce-plan` then `ce-execute`) made this build fundamentally different from ad-hoc coding:

- **No back-and-forth during build** — every scope question was answered in the plan phase (name, auth, booking, memory, AI providers, scope A/B/C)
- **No "is this OK?" pauses** — `ce-execute` ran to done + verified before reporting back
- **Verification was the contract, not an afterthought** — the plan's "Verification plan" section defined what "done" meant, and the run hit every checkbox

Total time from "ce-execute start" to "URLs in Telegram": one focused session, no interrupts. That's the methodology working as designed.

## What I'd do differently next time

1. **Skip the dev-stub for MiniMax** — when `HERMES_AI_URL` isn't set, the dev stub was confusing. Throwing instead (so the fallback chain to heuristic works cleanly) is the right call
2. **Add a `health` check to the public booking page** — currently it's a JSON API, but a quick HTML form for the customer would close the loop without admin involvement
3. **The dashboard's customer health score is computed in JS via map()** — should be a SQL function or view for clarity. Works fine for small data, will need migration at scale

## Code shape (what makes this different from GeekTicket)

- **11 tables, not 15+** — collapsed `companies` into `customers.company` field, dropped `subtasks`, `notes`, `attachments`, `gmail_import_log`, etc.
- **2 AI features, not 9** — kept only AI reply draft + AI summary. Memory extraction as bonus.
- **1 background loop, not 3** — one 5-min `setInterval` that fans out to EOD summary, reminders, nudges, overdue detection, pattern detection
- **Single-user, no staff role** — `auth.js` skips in dev, prod uses a single `ADMIN_PASSWORD` env var
- **No Postgres** — SQLite in WAL mode, single file at `data/hq.db`, backups are `cp`
- **No mobile app** — responsive web, all 5 pages work on phone browsers

## Related

- Plan: `docs/plans/2026-06-15-geekshop-hq.md`
- Compound engineering skill bundle: `bigberryj/compound-engineering-hermes`
- Previous system (still running, will be replaced once Byron's comfortable): `bigberryj/tasktrackerticket`
- Live URLs (dev server on bigbai):
  - http://localhost:5173
  - http://100.96.13.84:5173 (Tailscale)
  - http://100.96.13.84:5173/book/general (public booking)
