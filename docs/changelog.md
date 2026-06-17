# Changelog

## 2026-06-17 — Mission Control: silent-on-no-op delivery

The Mission Control worker was delivering its own cron failure reports to
Telegram every 2 min because the cron's `deliver` target was `telegram` and
the upstream model was being rate-limited (HTTP 429). That was wrong on two
counts: a 2-min tick should not auto-spam, and the 429 is an infrastructure
problem, not a per-task failure.

### Changes

- **Cron `deliver` target changed to `local`.** The worker itself decides
  whether to send a Telegram ping, and the gateway only delivers when the
  worker's final response is not the literal `[SILENT]`.
- **Empty queue → `[SILENT]`.** No more "queue empty" pings.
- **Rate-limit (429) → `[SILENT]` + cooldown stamp.** The worker writes
  `~/.hermes/state/agent-task-worker/rate_limited_until` (epoch 15 min in
  the future) on the first 429, and `preflight.sh` reads it on every
  subsequent tick to short-circuit before the LLM even gets called. A
  pending task in `running` state with no heartbeat is left alone — the
  stuck-requeue sweep on the next tick will requeue it (or fail it if
  `attempts >= max_attempts`).
- **`preflight.sh`** (`server/scripts/agent-task-worker/preflight.sh`):
  runs the stuck-requeue sweep, checks the cooldown stamp, and prints
  `OK` or `RATE_LIMITED`. The worker prompt calls it as step 1.
- **Renamed** the cron from `GeekShop agent task worker` to
  `Mission Control worker` to make the scope clear in `hermes cron list`.

### Verified

- Two forced ticks: 0 Telegram sends (confirmed via `journalctl`), 1 local
  output file each (audit trail only). The 429 still happens because the
  upstream is still throttled, but it's invisible to the user.
- Manual `preflight.sh` test: `OK` normally, `RATE_LIMITED` with a stamp.

### What you will and won't see in Telegram

| Case | Telegram |
|---|---|
| Empty queue | nothing |
| 429 rate-limited | nothing |
| Stuck-requeue only | nothing |
| Real work, all criteria pass | one `[J5][agent-task] <uid> → review` ping |
| Real work, some criteria fail | one `[J5][agent-task][BLOCKED] <uid> → blocked` ping |
| Worker exception | one `[J5][agent-task][FAILED] <uid> → failed` ping |

## 2026-06-17 — Mission Control: durable task queue + worker + UI

The "I asked J5 to do something and need to know if it's actually done" loop, end-to-end. Durable queue, self-reviewing worker cron, real-time HQ page, Telegram bridge.

### What's new

- **`agent_tasks` table** (migration `029_agent_tasks.sql`): durable queue with a state-machine (`queued → running → review | blocked | failed → done | cancelled | requeued`), per-row heartbeat for stuck detection, attempt counter, and a self-review checklist stored alongside the result.
- **REST API** (`/api/agent-tasks`):
  - `GET /api/agent-tasks?status=…` list, `GET /api/agent-tasks/summary` for the dashboard widget.
  - `POST /api/agent-tasks` enqueue. `title` capped at 240 chars, `prompt` at 32 KiB. `acceptance_criteria` accepted as `[{ req, kind }]`.
  - `GET /api/agent-tasks/:id` full task incl. `prompt` and `review_checklist`.
  - `POST /api/agent-tasks/:id/decision` with `action: approve | requeue | cancel` and an optional `note`. State-guarded: 409 on transition conflict.
  - `POST /api/agent-tasks/callback` (token-in-query) for future Telegram inline-button support.
  - Dashboard endpoint now includes `agent_tasks: { queued, running, review, blocked, failed, done, cancelled, total }` for the widget.
- **Mission Control UI** (`/mission-control`): live-polling table (5s) with summary cards, status filter pills, and a side drawer showing the original ask, worker's `result_summary`, self-review checklist (✓/✗ icons), timestamps, and Approve / Send-back / Cancel buttons. New entry in the sidebar nav (Bot icon).
- **Worker CLI** (`server/scripts/agent-task-worker/agent-task-cli.js`): atomic `claim`, `heartbeat`, `finish` / `mark-review` / `mark-blocked` / `mark-failed`, `stuck-requeue`. The CLI prints `NO_TASK` when the queue is empty so the worker prompt can short-circuit cleanly.
- **Enqueue CLI** (`server/scripts/agent-task-worker/enqueue-task.js`): one-liner to enqueue from the terminal (stdin or argv) with `source` / `priority` / `source_ref` flags. Used by the session-level Telegram bridge.
- **Worker cron** (`Mission Control worker`, every 2 min, deliver to Telegram): reads the operating manual at `server/scripts/agent-task-worker/WORKER_PROMPT.md` on every tick, runs the stuck-requeue sweep, claims the next task, does the work, self-reviews, transitions to `review` or `blocked`, and pings Byron on Telegram with a `[J5][agent-task] <uid> → <status>` summary + checklist.
  - **Delivery discipline (v2):** the cron's `deliver` target is `local`. The worker itself decides whether to send a Telegram ping. Empty queue, rate-limit cooldown, and stuck-requeue-only paths all return `[SILENT]` and produce no message. Real work produces exactly one ping. `preflight.sh` runs the stuck-requeue sweep and reads the `rate_limited_until` stamp at the start of every tick.
- **Telegram → queue bridge** (v1, session-level): typing `queue <description>` in the `@john5wizbot` chat enqueues a task. (Telegram-bus polling not wired in v1 — that needs a gateway hook; the session-level path gives the same UX with no gateway modification.)
- **19 new unit tests** for `lib/agent-tasks.js` (claim atomicity, heartbeat, finish state-guards, decide state-machine, stuck-requeue with max-attempts, list ordering, summary counts). All 185/185 tests pass.
- **Docs:** `docs/schema.md` (table + ER diagram), `docs/api.md` (full endpoint reference), `docs/architecture.md` (data flow + Telegram bridge), `docs/security.md` (blast radius, what the worker cannot do, input validation, stuck-task requeue, dashboard projection).

### Security notes

- The worker can run any tool the Hermes agent has, but cannot enqueue new tasks, cannot decide tasks, and cannot run other crons. The worker CLI deliberately doesn't expose `create` / `enqueue` / `approve` / `cancel`.
- Inbound tasks come from Byron-owned paths only (HQ UI, Telegram chat, terminal). No email-bus auto-ingest in v1.
- Every decision is on the row with `decided_by` and a `decision_note` for audit.
- API auth posture unchanged: loopback / LAN / Tailscale, same as every other HQ endpoint.

### Verified

- Full E2E cycle: enqueue → claim → heartbeat → do work → mark-review with real checklist → state transitions → Telegram notification path.
- Browser-tested: Mission Control page renders summary cards, status pills, table with live duration / age / attempts. Drawer shows original ask, worker summary, self-review with green check / red X, decision buttons. Approve action takes review → done with note recorded.
- Callback endpoint: valid token → 200, bad token → 400, bad action → 400, transition conflict → 409.
- Migration applies clean on boot against the existing `hq.db`; older tests still 185/185 green.

### Known limitations / parked for v2

- **Inline Telegram buttons** for Approve / Send-back / Cancel need a small gateway patch — the `send_message` tool doesn't currently expose `reply_markup`. Callback endpoint is in place and waiting.
- **Gmail → task ingest** is not wired (intentional; would let an untrusted sender enqueue). Easy follow-up if you want it.
- **Worker cron currently rate-limited (HTTP 429)** by the same provider throttle affecting the other two HQ-area crons. When the limit clears, the worker will start picking up tasks automatically.

## 2026-06-17 — Gmail reply sync, inline graphics, outbound signature, 30-min poll

### Reply sync (customer replies land on the right ticket)

- The reply matcher (`server/lib/replies.js`) is now wired into **both** code paths that turn a Gmail message into a ticket message:
  - The poller (`server/index.js`): every 30 minutes, new Gmail messages are checked against existing open tickets for the same customer. Matches are appended to the existing ticket and the Gmail message is marked `\Seen`.
  - The manual **Import** button (`server/lib/pending-emails.js::importPendingEmail`): clicking Import on a Gmail reply that belongs to an existing ticket now appends to the existing ticket instead of creating a duplicate. Returns `merged_into_existing: true` in the response.
- Matching strategy, in order, first hit wins:
  1. **Thread match:** the message's `In-Reply-To` / `References` headers (parsed by `mailparser`) match any open ticket's `source_message_id`.
  2. **Sender + subject match:** the same customer has an open ticket whose subject (with `Re:` / `Fwd:` prefixes stripped) is contained in the new message's stripped subject. Handles `Re: Fwd: Re: Volunteer Cowichan` → `Volunteer Cowichan` correctly.
- **Idempotency:** `ticket_messages.gmail_message_id` (migration 013) is unique. A re-scan or a re-import of the same Gmail message hits the `already_appended` branch and does **not** create a duplicate message or ticket.
- **Mark read on import:** every successful import (new ticket OR merged reply) calls `markImportedRead` to set the Gmail `\Seen` flag. The inbox stays in sync with the dashboard. Best-effort; never throws.

### Inline graphics in the ticket conversation

- Imported Gmail HTML is now sanitized and rendered inside a sandboxed iframe in `TicketDetail`. Inline `<img src="cid:…">` references are rewritten to our `/api/attachments/:id/raw` endpoint so inline screenshots render in the conversation, the way they look in Gmail.
- Sanitizer (`sanitizeEmailHtml` in `server/lib/attachments.js`): strips `<script>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<style>`, `on*` handlers, `javascript:` URLs. Renders inside an iframe with `sandbox="allow-same-origin"` and no `allow-scripts` — defense in depth. See `docs/security.md` for the full threat model.
- New migrations:
  - `013_ticket_message_gmail_id.sql` — adds `ticket_messages.gmail_message_id` (unique index) for reply-match idempotency.
  - `014_ticket_message_source_message_id.sql` — adds `ticket_messages.source_message_id` for the `In-Reply-To` / `References` cross-reference.

### Outbound email signature

- New `settings.email_signature` setting (plain text, multi-line). Appended to every outbound ticket reply (`Email customer` and `Reply & resolve`) as both plain-text (`--` separator) and a small styled HTML footer.
- Settings page → "Outbound email signature" section: textarea with live preview (sample reply + your signature, side-by-side). Saves on blur or button click.
- Plain text only by design — see `docs/security.md` for the rationale (HTML-escape is simpler and safer than a signature sanitizer).

### 30-minute Gmail poll interval

- `BYRON_GMAIL_POLL_INTERVAL_MIN` bumped from `5` to `30` in `server/.env` and `server/.env.example`. The poller still runs in `pending_queue` mode — no auto-import.
- 30 minutes is a deliberate trade-off: less IMAP chatter (Gmail rate limits are tighter than they used to be) at the cost of up to 30 min delay before a customer reply shows up in the dashboard. The matcher's idempotency guarantees the merge is correct regardless.

### Test suite

- `166/166 passing in 2.23s` (was `153/154` + a 5s timeout in `inbox-scan.test.js`).
- New: `server/test/signature.test.js` (8 tests), `server/test/import-merge.test.js` (4 tests).
- Fix: `server/test/inbox-scan.test.js` was awaiting a real LLM call in a test that only asserts option-forwarding. Passing `autoDismissJunk: false` in the test stops the LLM from being called, the test now finishes in <50ms.

### Other fixes from the same window

- Fixed `inbox-scan.test.js` 5s timeout (LLM-await-in-option-forwarding-test).
- Fixed missing `source_message_id` column that the reply matcher's `INSERT` was depending on (migration 014). This bug was caught by the merge smoke test before commit.

## 2026-06-16 — Hermes rate-limit queue + email preview fix + tickets filter

### Hermes rate-limit queue (new)

- Created `~/.hermes/queue/` with a JSONL append-only log of parked tasks.
- `hermes-queue` CLI (`/home/byron/.local/bin/hermes-queue`) with `add`, `list`, `pause`, `resume`, `done`, `fail`, `now`, `tick`.
- Exponential backoff (1m → 30m cap) with per-provider Retry-After respect.
- `lib/ai.js` 429 hook: when `aiCall(..., { parkKey })` hits a 429, the call is parked in the queue so a cron tick can resume it when the rate limit lifts.
- `server/routes/tickets.js` now passes `parkKey: ghq-ai-draft-<ticket_id>` so AI draft 429s survive a session restart.
- Cron `hermes-queue-tick` runs every 30 min, reports status to Telegram.

### Email preview modal fix (Inbox → Preview)

- **Root cause:** preview route only re-fetched from Gmail when both `body` and `snippet` were empty, but real rows often had a whitespace-only `body` (e.g. PlayStation's envelope-only body), so the modal rendered blank and users thought it was a "not found" error.
- Added `pending_emails.body_html` + `pending_emails.body_fetched_at` columns (migration 012). The route persists Gmail's HTML on the first on-demand fetch so subsequent previews are instant.
- `body_text` now falls back to the fresh Gmail body when the stored body is whitespace-only.
- Plain-text fallback wraps the body in a styled `<pre>` so the iframe still renders cleanly.
- Replaced three `require()` calls inside ESM routes with proper top-level imports.
- Added 3 regression tests (`inbox-preview.test.js`).

### Tickets page: default filter to open + pending

- Old behaviour: `?status=` defaulted to "all" (open + pending + resolved), so resolved tickets cluttered the default view.
- New behaviour: defaults to **open + pending**. Three checkbox toggles (open / pending / resolved) and a "show all" link.
- Hash-based persistence: `?status=open,resolved` survives a refresh. The default hash is empty (i.e. open + pending).
- Multi-status API: `GET /api/tickets?status=open,pending` now uses `IN (?, ?)`.
- 4 new tests in `tickets-filter.test.js`.

### Timer (previous patch, still active)

- Already in `v0.1.0` changelog. Tests 154/154 passing.

## 2026-06-16 — Ticket timer pause/resume fix

- **Fixed the TicketDetail timer button.** Root cause: the React page had `const running = ticket.messages && false`, so the button always acted as "Start timer" and never read the actual timer state.
- Added backend timer state support: `running`, `paused`, `stopped`, with new `paused_at` column and accumulated `duration_seconds` semantics.
- Added `POST /api/tickets/:id/time/pause` and `POST /api/tickets/:id/time/resume`; `start` is now idempotent for the same ticket and no longer creates duplicate active rows on repeat clicks.
- Updated TicketDetail UI to show a live `HH:MM:SS` elapsed timer, `Pause`, `Resume`, and `Stop` controls.
- Fixed browser elapsed math for SQLite `CURRENT_TIMESTAMP` UTC strings so timers don't sit at `00:00:00` due timezone parsing.
- Verification: backend tests green at 146/146; client production build green; browser-tested Start → live elapsed → Pause freezes → Resume continues → Stop returns to Start.

## 2026-06-16 — Gmail junk classifier: backfill, fixes, and settings tuning

- **Fixed `isLikelyHuman` over-trigger bug.** The old heuristic treated the email local part as a display name when `from_name` was empty, so senders like `invoice+statements+acct_1HNrvlCJoPsRzQsd@stripe.com` (Stripe receipts) and `catch@payments.interac.ca` (Interac e-Transfer alerts) were being scored 0.0 and never auto-dismissed. The fix only inspects the explicit `from_name` field.
- **Backfilled classification on the 554 un-classified legacy rows.** A one-shot admin action at `POST /api/inbox/pending/backfill-classify` (also exposed as a **Classify legacy** button in the Inbox UI) ran the rules-first classifier on every un-classified row, persisted the classification JSON, and auto-dismissed 62 of them with `dismissed_by='auto_junk'`. Queue went from `556 pending / 213 dismissed` → `494 pending / 275 dismissed`. Idempotent.
- **Added a security/account-recovery always-keep list.** Subjects like "Your Google Account is no longer recoverable", "Security alert", "Unrecognized device signed in" are now never auto-dismissed, even if the sender is a noreply@.
- **Added Google-ecosystem and transactional/receipt subject patterns.** `*noreply@google.com`, `accounts.google.com`, `docs.google.com`, plus "payment posted", "thank you for your payment", "auto deposited", "e-Transfer" subjects now score 0.4–0.5 on their own, which combines with brand + unsubscribe to push them over the 0.8 threshold.
- **Added a settings-backed tuning surface** in the Settings page (under "Gmail moderation (junk classifier)"). Three CSV lists:
  - `auto_dismiss_domains` — exact-match domains that always count as junk (adds 0.6 to the score).
  - `auto_keep_subjects` — substrings of subjects that are NEVER auto-dismissed.
  - `agent_mailbox_from` — from_email values that are operational agent traffic.
- **Added a "Hide agent mail" toggle in the Inbox UI.** Persists in localStorage. When on, the agent-mailbox list is hidden from the human-pending view (the data is still in the DB and the toggle does not affect server data). Header reports `(... agent mail hidden)` so the queue size doesn't lie.
- **Tests:** 144/144 passing (was 117/117). Added 27 new tests for the bug fix, new always-keep list, Google ecosystem signals, transactional subject patterns, settings-backed overrides, the `isAgentMail` helper, and the backfill function.
- **Docs:** `docs/schema.md`, `docs/api.md`, `docs/security.md` updated. Changelog + solution doc updated.

## 2026-06-16 — Gmail moderation, Contacts enrichment, and invoice minimum charge

- Added strict Gmail junk classification for pending scan entries. Obvious junk is soft-dismissed with `dismissed_by`, `dismissed_reason`, `classification` JSON, and `dismissed_at`; ambiguous/client-like mail stays pending.
- Added Gmail queue bulk moderation UI: row checkboxes, **Dismiss N selected**, **Show dismissed**, dismissed status badges, and **Restore**.
- Added Google Contacts enrichment after import: server finds a likely contact via the existing OAuth token and the UI prompts before applying blank-field customer updates. Nothing overwrites existing customer data automatically.
- Added private minimum-charge support for time-based invoice drafts:
  - `settings.minimum_charge_cents` controls the default floor.
  - Money page now opens an invoice draft preview modal instead of creating immediately.
  - The admin can toggle/override the floor per invoice.
  - The floor is folded into labour line prices and never appears as a customer-visible “minimum charge” line.
- Fixed invoice math to treat `line_items[].total_cents` as the cents source of truth when present, avoiding fractional-hour/rounded-rate drift.
- Added/updated docs: `docs/schema.md`, `docs/api.md`, `docs/security.md`.
- Verification: backend test suite green at 117/117; client production build green; browser-tested Inbox bulk dismiss/show dismissed/restore, Settings minimum-charge field, and Money minimum-charge preview modal.

## 2026-06-15 — Inbox fix: Gmail scan returns 0 messages

- **Root cause:** `imapflow`'s `client.fetch(uidArray, { uid: true, ... })` was returning zero messages on this Gmail mailbox — server said `OK Success` but emitted no `* N FETCH (...)` response lines. UIDVALIDITY was stable, UIDs were valid (205967 = uidNext-1), but the FETCH iterator never yielded.
- **Fix:** switched `fetchUnread` from UID-list fetch to sequence-range fetch (`uids:false` on search → `client.fetch("848:850", ...)`). 25 messages now come back from a single scan call instead of zero. The message `uid` field is still populated by the server, so downstream code (de-dup, import) keeps working.
- **Secondary fix:** `GET /api/inbox/pending` was hard-capped at 100 rows. Mary's email (`marmcintyre@hotmail.com`, "your worse nightmare Mary") was at id ~217 and never reached the UI even when scan worked. Bumped default to 250, added `?limit` (1–500) and `?offset` query params, response now `{ items, total, limit, offset }`.
- **Tertiary fix:** ordering was `ORDER BY fetched_at DESC`, which is non-deterministic when 218 messages share an identical `fetched_at` (they do, after a bulk scan). Switched to `ORDER BY id DESC` for stable reverse-chronological order.
- **UI:** `GmailReviewQueue` now reads `r.items || r.rows` so it works with the new wrapped shape and is also backward-compatible with any client expecting a flat array. Header reads "(N of M pending)" when M > N.
- **Tests:** 37/37 passing (added 2 regression tests that exercise the 100-cap and ordering fixes with a fresh in-memory DB).
- **Verified end-to-end through the browser:** Inbox now shows 218 pending. Mary and Linda's company (Live Edge Design, 17 emails from Donna / Emily / Katie, including a $1,365 Interac deposit) are both visible.

## 2026-06-15 — Queue cleanup: MiniMax, booking, invoices, dashboard automation

- Installed MiniMax API key locally in `server/.env` and `~/.hermes/.env`; verified `testProvider('cheap_classify')` returns MiniMax `PONG`.
- Fixed MiniMax auth header spelling to `X-Api-Key`.
- Added Inbox source filter pills: All, Email, Manual, Booking.
- Added safe cron/monitor visibility to Inbox dashboard:
  - Hermes cron job summary (enabled count, last status, next run).
  - Appointment monitor last runs and pending slot count.
  - Starred client email suggestions last run and count.
  - Prompt bodies/scripts/secrets are intentionally not exposed.
- Added public `/book/:slug` React page with available 90-minute time slots.
- Added booking slot generation helper and `/api/booking/:slug` `available_slots` payload.
- Added printable invoice HTML route at `/api/invoices/:id/print` with browser Print/Save PDF support.
- Refactored invoice rendering into `lib/invoice-renderer.js` for shared email/plain-text/print output.
- Fixed Gmail import path to persist `tickets.source_message_id`, enabling later Gmail thread lookup/archive.
- Verified UFW already allows GeekShop HQ dev/API ports on Tailscale (`5173`, `5050`).
- Added unit tests for booking slot generation, invoice renderer, and cron status projection.

## 2026-06-15 — Billing: labour rate + Canadian tax model

- New `lib/tax.js` module: 6 Canadian tax models (none / GST 5% / BC GST+PST / QC GST+QST / HST ON 13% / HST NB-NS-PE 15%) with per-line tax breakdown.
- New setting `default_tax_model` (default: `gst_pst_bc`).
- New setting `labour_rate_cents_per_hour` (default: $125/hr).
- New endpoint `POST /api/invoices/draft-from-time` — turns a customer's un-invoiced time entries into invoice line items at the configured rate, then computes tax.
- New endpoint `POST /api/time-entries/mark-invoiced` — atomic flag so time entries don't double-invoice.
- `POST /api/invoices` now accepts `tax_model` (per-invoice override) and `tax_cents_override` (e.g. tax-exempt customer = 0).
- Printable HTML now shows per-line tax breakdown (e.g. "GST 5% — $3.13" and "PST 7% — $4.38" separately), business name + email from settings.
- Time-revenue report uses the configured labour rate.
- Settings page UI: new "Billing & tax" section with tax model dropdown + labour rate input (commits on blur/Enter, not per keystroke).
- Money page UI: "Draft invoice from time" card with one button per customer; creates the invoice, marks the time entries invoiced, opens the printable view.
- 15 new tests for tax math, rounding, model coverage, override path, and labour rate conversion.

## 2026-06-15 — Gmail housekeeping + reply/resolve

- Added Gmail thread housekeeping on resolve: mark read, apply `GeekShop/Done`, archive from inbox when source is email.
- Added `Email customer` and `Reply & resolve` actions in TicketDetail.
- Added `TicketLabel` component to keep internal `G-NNNNNN` IDs subtle and admin-only.

## 2026-06-15 — Customer-facing language cleanup

- Removed customer-facing "ticket" wording from resolution emails.
- Resolution emails now use `Re: <subject>` to thread naturally.
