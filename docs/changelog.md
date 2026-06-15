# Changelog

## 2026-06-15 — Queue cleanup: MiniMax, booking, invoices, dashboard automation

- Installed MiniMax API key locally in `server/.env` and `~/.hermes/.env`; verified `testProvider('cheap_classify')` returns MiniMax `PONG`.
- Fixed MiniMax auth header spelling to `X-Api-Key`.
- Added Inbox source filter pills: All, Email, Manual, Booking.
- Added safe cron/monitor visibility to Inbox:
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

## 2026-06-15 — Gmail housekeeping + reply/resolve

- Added Gmail thread housekeeping on resolve: mark read, apply `GeekShop/Done`, archive from inbox when source is email.
- Added `Email customer` and `Reply & resolve` actions in TicketDetail.
- Added `TicketLabel` component to keep internal `G-NNNNNN` IDs subtle and admin-only.

## 2026-06-15 — Customer-facing language cleanup

- Removed customer-facing "ticket" wording from resolution emails.
- Resolution emails now use `Re: <subject>` to thread naturally.
