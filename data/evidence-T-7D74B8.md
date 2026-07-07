# Evidence — T-7D74B8 (geekshop hq updates)

## Task
> i would like to be able to delete tickets in ticket area if i choose, i would also like to be able to manually assign time spent on ticket as well as have the ability to use the timer function.

## Verification log

### Tests (new — added in this iteration)
```
✓ test/ticket-manual-time.test.js (9 tests)  741ms
✓ test/ticket-soft-delete.test.js  (13 tests) 941ms

Test Files  2 passed (2)
Tests       22 passed (22)
```

### Full test suite (47 files, 492 tests)
- New `ticket-manual-time.test.js` (9) + `ticket-soft-delete.test.js` (13) — both pass.
- 31 of 33 test files pass.
- The 2 failing files are pre-existing on `main` HEAD and are outside this task's scope:
  - `tax-summary-enhanced.test.js` (18 fails — schema drift in fixture inserts; pre-existed before T-7D74B8).
  - `accounting-extra.test.js > Stripe (lib-level, mocked) > verifyWebhook …` (1 fail — `stripe.webhooks` mock shape drift; pre-existed before T-7D74B8).
- 473/492 tests pass; the 19 failures are unrelated to soft-delete / manual time / timer functionality.

### Production build
```
dist/index.html                   0.43 kB │ gzip:   0.30 kB
dist/assets/index-BuP_fZI6.css   33.79 kB │ gzip:   6.57 kB
dist/assets/index-BcbzKdYx.js   639.48 kB │ gzip: 171.79 kB
✓ built in 3.71s
```

### Real-server smoke test (port 5050 against data/hq.db)

```
=== GET /api/tickets ===
tickets: 4 — all live, no deleted_at

=== DELETE /api/tickets/21 (G-000004) ===
{"ok":true}

=== GET /api/tickets (default — excludes deleted) ===
3 rows, id 21 not in list. ✓

=== GET /api/tickets?include_deleted=true ===
4 rows, id 21 surfaced with deleted_at='2026-06-30 19:32:58'. ✓

=== POST /api/tickets/21/restore ===
{"ok":true}

=== GET /api/tickets (default) ===
id 21 back in default list. ✓
```

### Manual time entry flow
```
=== POST /api/tickets/18/time ===
{"id":23,"duration_seconds":5400,"elapsed_seconds":5400,"status":"stopped"}
  (90 min from 14:00–15:30, note 'on-site repair')

=== PATCH /api/tickets/18/time/23 ===
{"id":23,"duration_seconds":7200,"note":"two hours total"}
  (recomputed to 2h after edit)

=== DELETE /api/tickets/18/time/23 ===
{"ok":true}
  (entry gone from list)

=== GET /api/tickets/18/time ===
time entries: 1 (the unrelated one)
```

### Active-timer protection (the timer still works, but cannot be edited/deleted manually)
```
=== POST /api/tickets/18/time/start ===
{"id":24,"status":"running"}

=== PATCH /api/tickets/18/time/24 ===
status: 400  body: {"error":"active timers are not editable here"}     ✓

=== DELETE /api/tickets/18/time/24 ===
status: 409  body: {"error":"cannot delete a running or paused timer; stop it first"}  ✓

=== POST /api/tickets/18/time/stop ===
{"ok":true,"status":"stopped","duration_seconds":0}
  (timer still works end-to-end)
```

### Audit log
```
ticket.restore  21  2026-06-30 19:33:02
ticket.delete   21  2026-06-30 19:32:58
```

## What shipped

### Schema (migration 037)
- `tickets.deleted_at TEXT`
- `tickets.deleted_by TEXT`
- `idx_tickets_deleted_at (deleted_at) WHERE deleted_at IS NOT NULL` (partial index)

### Backend
- `server/lib/audit.js` (new) — `logAudit(db, action, target, payload?)` helper. Audit failures never break the request.
- `server/routes/tickets.js`:
  - `DELETE /api/tickets/:id` — soft-delete, auto-stops active timer, idempotent.
  - `POST /api/tickets/:id/restore` — clears `deleted_at`/`deleted_by`, idempotent.
  - `GET /api/tickets?include_deleted=true` — trash view.
  - `GET /api/tickets/:id` — works on soft-deleted rows (restore needs full payload).
  - `GET /api/dashboard` — already filters `deleted_at IS NULL`.
  - Resolve route now uses `appendSignature()` (closed a small doc/code drift).
- `server/routes/time-entries.js`:
  - `POST /api/tickets/:id/time` (manual entry, takes `started_at`/`stopped_at`/`note`).
  - `PATCH /api/tickets/:id/time/:entryId` (edit stopped entry, 400 if active).
  - `DELETE /api/tickets/:id/time/:entryId` (delete stopped entry, 409 if active).
- `server/lib/replies.js` — `matchReplyToTicket` skips `deleted_at IS NOT NULL` in both strategy 1 (thread match) and strategy 2 (sender+subject). Soft-deleted threads don't auto-reopen on the next customer reply.
- `server/routes/customers.js` — `/api/customers/:id/timeline` filters `deleted_at IS NULL` for ticket_created, ticket_resolved, ticket_message kinds. Soft-deleted tickets no longer leak into the customer 360 view.

### Frontend
- `client/src/components/DataTable.jsx` (new) — responsive table/card primitive reused by the Tickets list.
- `client/src/pages/Tickets.jsx`:
  - Migrated to DataTable.
  - Per-row Delete / Restore button depending on whether the row is live or in trash.
  - "Show trash" / "Hide trash" toggle sends `?include_deleted=true`.
  - Trash-mode summary line so the operator knows what mode they're in.
  - `e.stopPropagation` on the action buttons so they don't also trigger navigation.
- `client/src/pages/TicketDetail.jsx`:
  - "Log time manually" toggle reveals a `datetime-local` form (start + stop + note). Local-to-UTC conversion both ways.
  - Time-on-this-ticket list shows status badge, duration (`1h 30m`), start→stop timestamps, and inline Edit / Delete buttons for stopped uninvoiced entries.
  - Edit reuses the form state and re-saves via PATCH.
  - "Delete ticket" red ghost button (right-aligned) with confirm dialog. Hidden while already deleted.
  - Amber banner at the top of the page when the ticket is soft-deleted, with a one-click Restore button.
  - "AI draft reply" disabled while deleted.
  - Mobile-friendly wrap (no horizontal overflow on narrow viewports).
- `client/src/pages/TicketDetail.jsx` imports extended to include `delJson`, `patchJson`, `useNavigate`, and the new lucide icons (`Trash2`, `RotateCcw`, `Plus`, `X`, `Pencil`, `Clock`).

### Docs
- `docs/api.md` — added `DELETE /tickets/:id`, `POST /tickets/:id/restore`, `POST /tickets/:id/time`, `PATCH /tickets/:id/time/:entryId`, `DELETE /tickets/:id/time/:entryId`.
- `docs/schema.md` — `tickets` table lists `deleted_at` / `deleted_by` columns and the partial index.
- `docs/changelog.md` — top entry: "2026-06-30 — Ticket delete + manual time + UI polish (T-7D74B8)".

## Files changed (this task, staged)
```
A  client/src/components/DataTable.jsx
M  client/src/pages/TicketDetail.jsx
M  client/src/pages/Tickets.jsx
M  docs/api.md
M  docs/changelog.md
M  docs/schema.md
A  server/db/migrations/037_ticket_soft_delete.sql
A  server/lib/audit.js
M  server/routes/tickets.js
M  server/routes/time-entries.js
A  server/test/ticket-manual-time.test.js
A  server/test/ticket-soft-delete.test.js
```

## Decision / open questions

None blocking. Two minor notes for follow-up:
1. The unstaged modified files (`App.jsx`, `Customers.jsx`, `Settings.jsx`, `MissionControl.jsx`, `Money.jsx`, etc.) are in-progress work from a different task. They were on disk before this task started and were not touched in this iteration.
2. The two pre-existing test failures (`tax-summary-enhanced` ×18, `accounting-extra > verifyWebhook` ×1) are outside this task's scope and predate T-7D74B8.
