# Changelog

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
