# Phase 1 Revenue Leakage — evidence

**Task:** T-ED62EC (Phase 1 of `docs/plans/2026-06-29-geekshop-hq-accounting-roadmap.md`)
**Date:** 2026-06-29
**Status:** All acceptance criteria met.

## Files in this drop

- `server/routes/accounting.js` — `/api/accounting/leakage` endpoint, all five buckets.
- `client/src/pages/Accounting.jsx` — `LeakagePanel` + `LeakageCard`, rendered as the first section on the Dashboard tab.
- `server/test/leakage.test.js` — 13 vitest cases (all green).
- `docs/api.md` — `### Revenue leakage (Phase 1 of billing/accounting roadmap)` section added.
- `docs/changelog.md` — entry dated `2026-06-29 — Phase 1 Revenue leakage dashboard (T-ED62EC)`.
- `docs/security.md` — updated to flip the QuickBooks direction note and add a leakage-specific security note.
- `docs/plans/2026-06-29-geekshop-hq-accounting-roadmap.md` — `Execution status` line for Phase 1 added.
- `data/evidence/T-ED62EC/leakage.png` — full-page screenshot of the rendered panel.

## Tests run

- `vitest run test/leakage.test.js` — **13/13 pass**.
- `vitest run` (full suite) — **254/257 pass**. Three pre-existing failures are unrelated to this work:
  - `tests/accounting.test.js > reports > tax-collected sums invoice tax_cents` — seeded tax rate did not produce a non-empty response; predates T-ED62EC.
  - `tests/accounting-extra.test.js > Stripe webhook signature` — `stripe.webhooks.generateTestHeaderString` is undefined in the installed `stripe` mock version; predates T-ED62EC.
  - `tests/customer-search-benchmark.test.js` — pre-existing `expectedCount: 1, got 2`; predates T-ED62EC.
  None of these touch the leakage code path; the leakage endpoint has its own green test file.
- Client build (`vite build`) — clean, 1670 modules, no warnings introduced by leakage.

## Browser run-through (Chromium against vite preview @ 127.0.0.1:4173)

Live render verified with real seed data; visual snapshot of all five cards is in `leakage.png`.

- `GET /accounting` loads the Dashboard tab with `<LeakagePanel />` as the first section above "Module status" and below the "Solo business accounting…" subtitle.
- Card 1 — **Uninvoiced time**: $1927.72 across 16 entries, top 5 tickets with per-row values, "resolved" badges on resolved tickets, "running" badges on running timers (with $0.00 valuation).
- Card 2 — **Resolved with unbilled time**: $8.02 across 2 tickets; both names appear in the sub-list of card 1 with the same dollar values.
- Card 3 — **Stale draft invoices**: $665.02 across 3 invoices older than 14d. Each row links to `/api/invoices/:id/pdf`.
- Card 4 — **Overdue sent invoices**: $294.00 across 1 invoice (INV-2026-001, 20d late).
- Card 5 — **Dormant customers**: 7 active customers with billable activity and no recent invoice; each row links to the customer page.
- Tunable `Stale drafts >` changed from 14 → 60: card 3 flipped to $0.00 / 0 invoices with empty-state copy "No drafts have been sitting longer than the cutoff." Header total re-sums to $2229.74 (delta matches).
- Tunable `No invoice in >` unchanged at 30 (dormant customer count stable).
- Refresh button works (re-fetched on click, totals re-rendered).
- No JS errors in the console (`browser_console` returned 0 errors across reload + tunable change + refresh).
- Labour rate reads from the `labour_rate_cents_per_hour` setting — UI shows "valued at $75/h" because the seed sets that rate; defaults to $100/h if the setting is absent (covered by `leakage.test.js`).

## Acceptance criteria

| Criterion | Status |
|---|---|
| `/api/accounting/leakage` exists and returns all five buckets | ✓ |
| Five widgets on the Accounting dashboard | ✓ |
| Integer-cent math (no floats) | ✓ |
| Defensive against older line_items-only invoices | ✓ |
| Running timers report $0 (no fabricated billables) | ✓ |
| Tunable stale-draft and stale-invoice thresholds | ✓ |
| Refresh button works | ✓ |
| Empty states render correctly | ✓ |
| Admins-only (same gate as rest of `/api/accounting/*`) | ✓ |
| Docs updated: api.md, changelog.md, security.md, plan status | ✓ |
| Tests pass | ✓ (13/13 leakage; 254/257 full suite, 3 unrelated pre-existing) |
| Client build clean | ✓ |
| Browser run-through passes | ✓ |
| No QuickBooks sync direction added | ✓ |
