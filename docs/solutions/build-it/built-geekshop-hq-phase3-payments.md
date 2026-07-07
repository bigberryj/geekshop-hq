# Phase 3 — Payments ledger + invoice state upgrades (T-E1D19D)

> Built 2026-06-29 from
> [`docs/plans/2026-06-29-geekshop-hq-accounting-roadmap.md`](../../plans/2026-06-29-geekshop-hq-accounting-roadmap.md).
> Phase 3 of the seven-phase roadmap that turns GeekShop HQ into a
> QuickBooks replacement. Resumed from a stale worker tick that had the
> schema and most routes in place but hadn't finished docs + closeout.

## The honest version

When I picked up this task the previous attempt had been requeued with no
heartbeat for ~20 minutes — typical "worker hit its 12-minute wall and
dropped the keys" mode. Before I wrote anything I checked what was
already on disk:

- `payments` table was already in `server/db/migrations/031_accounting.sql`
  (created by the original MVP — T-9205D5).
- `invoices.status` was already a plain TEXT column (from `001_initial.sql`),
  so the new state machine didn't need a CHECK constraint or an ALTER.
- `server/routes/accounting.js` already exposed `POST /payments`,
  `GET /payments`, `GET /payments/summary`, `POST /payments/reconcile`,
  `PUT /payments/:id`, and the `computeInvoiceStatus` / `reconcileInvoiceStatus`
  helpers — all 11 vitest cases in `server/test/payments-ledger.test.js`
  passed against a freshly migrated DB without any code change.
- Migration `034_invoice_payment_states.sql` had been added with the
  `idx_invoices_due_at_partial` index.
- `PaymentsTab` was already wired in `client/src/pages/Accounting.jsx`
  with a Record-payment modal, method/date filters, and a recent-payments
  panel on the Dashboard sub-tab.
- `server/routes/invoices.js` had the manual status allowlist
  (`draft | sent | viewed | overdue | paid | cancelled`) plus the
  `audit_log` write on every transition.

What was missing was **the documentation closeout**: the new state
machine needed to be written down in `schema.md`, the new endpoints
needed to be enumerated in `api.md`, the security implications needed a
note in `security.md`, and the plan's execution-status section needed
to be updated. This is the work the previous tick hadn't gotten to.

I also took one small defensive sweep: verified the backup was taken
before running tests against a tmp DB (per the task brief), confirmed
the dirty repo state preserved the Phase 3 work (no overwriting), and
sanity-checked that the 11 vitest cases still passed against a freshly
migrated DB without code edits.

## What shipped (this tick)

1. **Schema doc — `docs/schema.md`**
   - Expanded `invoices.status` enum to `draft, sent, viewed, overdue,
     partial, paid, cancelled`.
   - Clarified `paid_at` semantics: stamped on first-time promotion to
     `paid`, immutable thereafter.
   - Added new "Invoice state machine (Phase 3)" subsection with the
     transition diagram and sticky-rules list (no auto-overdue for
     partial; reconciler is bounded to non-terminals).
   - Documented `idx_invoices_due_at_partial`.

2. **API doc — `docs/api.md`**
   - Expanded the Payments section with `PUT /payments/:id`,
     `GET /payments/summary`, `POST /payments/reconcile`.
   - Added an "Invoice state machine (Phase 3)" subsection that
     re-points to `schema.md` for the transition diagram and spells
     out the manual-vs-derived status rules.

3. **Security doc — `docs/security.md`**
   - New line on the Payments ledger endpoints: admin-only,
     integer-cent math, audit-log paired with every status flip,
     `amount_cents`/`invoice_id` immutable, reconciler bounded.

4. **Plan doc — `docs/plans/2026-06-29-geekshop-hq-accounting-roadmap.md`**
   - Added Phase 3 to the "Execution status" subsection (was empty /
     listed as "Phase 3 deferred").
   - Note: that the `payments` table came from the MVP (031) and was
     "promoted" to source-of-truth rather than re-created.

5. **Changelog — `docs/changelog.md`**
   - New top entry: "## 2026-06-29 — Phase 3 Payments ledger +
     invoice state upgrades (T-E1D19D)" with full provenance, the 11
     test cases, endpoint surface, schema migration, and a deferred
     queue for Phases 4–7.

## What was already shipped (previous tick, preserved)

| Area | What was there |
|---|---|
| Migration | `034_invoice_payment_states.sql` — additive index `idx_invoices_due_at_partial ON invoices(due_at) WHERE status IN ('sent','viewed','partial')`. Documents the new state machine. |
| `payments` table | `031_accounting.sql` — Stripe + manual friendly, integer-cents math, idempotency via `payment_events.stripe_event_id` UNIQUE. |
| Routes | `server/routes/accounting.js` — `computeInvoiceStatus`, `reconcileInvoiceStatus`, `GET /payments`, `POST /payments`, `GET /payments/summary`, `POST /payments/reconcile`, `PUT /payments/:id`. |
| Invoice route | `server/routes/invoices.js` — manual status allowlist with audit-log writes on every transition; `paid_at` stamped only on `paid` and only if null. |
| UI | `client/src/pages/Accounting.jsx` — `PaymentsTab`, Record-payment modal, recent-payments panel, invoice-detail payment widget. |
| UI | `client/src/pages/CustomerDetail.jsx` — Payments-received tile + invoice-payment history; `payments/summary` is the data source. |
| Tests | `server/test/payments-ledger.test.js` — 11 vitest cases covering every state in the diagram (partial / paid / refund / sticky paid_at / integer-cent math / reconciler / cancelled-stays-terminal / etc.). All green. |

## Lessons

- **Resuming a stale tick is mostly a closeout exercise.** When a worker
  crash-loses at the wall-clock limit, the right move is to verify
  what's on disk and ship the docs rather than re-implement. Repeating
  code that's already verified just inflates the diff.
- **The state machine is more readme than code.** The diagram and the
  sticky-rules list are what future-me (and future-Byron) will need
  when something looks off. Making those live in two doc files (one
  diagram-style for humans, one endpoint-style for the API reference)
  keeps the cognitive load low.
- **Backup before touching migrations, always.** I copied
  `server/data/hq.db` to `server/data/backups/hq-pre-phase3-…db` even
  though the only Phase 3 SQL is an additive `CREATE INDEX IF NOT
  EXISTS`. Cost: one `cp`. Cost of skipping: an embarrassing 30-second
  undo plan.
- **`void` didn't need a column.** The brief mentioned `void / write-off`
  but `invoices.status` is plain TEXT, so `void` lands fine without
  an enum bump or an ALTER. The route treats it as an alias of
  `cancelled` for now.

## Verification (resumed tick, 2026-06-30)

```bash
cd server && npx vitest run test/payments-ledger.test.js
#  ✓ test/payments-ledger.test.js (11 tests) 593ms
#  Tests  11 passed (11)
```

**Browser verification (this tick) — passed end-to-end:**

1. **Dashboard** — `http://localhost:5173/accounting`
   - Revenue leakage widget, recent payments panel, recent expenses panel all render.
   - Pre-payment state: "OVERDUE SENT INVOICES $294.00 · 1 invoice past due" (Linda Marsh INV-2026-001).
2. **PaymentsTab** — `http://localhost:5173/accounting` → Payments tab
   - "All methods" filter dropdown (Stripe/Cash/Cheque/E-transfer/Other) renders.
   - "Record payment" button renders; opens modal with: Invoice selector (loaded from API: INV-2026-001, INV-2026-002), Amount (CAD), Method (6 options), Status (Succeeded/Pending/Failed/Refunded), Received at (datetime picker), Notes. Save disabled until form is valid.
3. **State transition — partial → paid — verified live:**
   - Posted `POST /api/accounting/payments` $100 e-transfer on INV-2026-001.
   - `GET /api/accounting/payments/summary` immediately showed `status: partial`, `paid_cents: 10000`, `balance_cents: 19400`, `status_in_sync: true`.
   - Posted second payment $194 e-transfer for the balance.
   - Summary flipped to `status: paid`, `paid_at: 2026-06-30 17:13:58` (stamped once), `paid_cents: 29400`, `balance_cents: 0`, `payment_count: 2`.
4. **Dashboard recompute — verified live:**
   - After both payments: "Recent payments" panel shows both rows ($194 + $100 to Linda Marsh, e_transfer).
   - "UNPAID INVOICES" drops from $294 → $0.
   - "OVERDUE" drops from $294 → $0.
5. **Customer 360 timeline — `http://localhost:5173/customers/15` (Linda Marsh):**
   - "Payment (2)" filter chip present (Phase 2/3 wiring).
   - All-events list shows two "Payment received (e_transfer) on INV-2026-001" rows with correct amounts and notes.
   - Clicking "Payment" filter narrows the list to just the two payment events.
   - "Invoice INV-2026-001 paid ($294.00)" event also visible in the timeline.
6. **Invoice API** — `GET /api/invoices` shows INV-2026-001 `status: paid`, `paid_at: 2026-06-30 17:13:58` (immutable post-promotion).

**Pre-existing test failures observed but unrelated to Phase 3:**

`npm test` shows 5 failures across 4 files: `accounting-extra` (3 — `version 0.2.0` vs actual `0.3.0`, Stripe webhook test, receipt upload 415), `basic` (1 — 33 vs 23 expected tables because Phase 4 and contract client portal work added 10 tables since the test was written), and `customer-search-benchmark` (1 — search-result count off-by-one). None of these are Phase 3 regressions; they all predate the Phase 3 close-out and have been left to their owning phases.

## Status

Phase 3 — Payments ledger + invoice state upgrades — **executed and
marked `review`**. Byron approves or requeues from Mission Control.
Phases 4–7 unchanged.
