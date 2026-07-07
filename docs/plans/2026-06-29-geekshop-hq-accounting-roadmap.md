---
title: "GeekShop HQ billing/accounting replacement roadmap"
date: 2026-06-29
status: draft
category: docs/plans
slug: geekshop-hq-accounting-roadmap
---

# Plan: GeekShop HQ billing/accounting replacement roadmap

## Goal

Turn GeekShop HQ into Byron's long-term billing and lightweight accounting source of truth, replacing QuickBooks rather than syncing to it. The roadmap is split into independently verifiable slices so each change can be built, browser-tested, documented, and committed without a risky big-bang rewrite.

## Strategic direction

- **Do not make QuickBooks the source of truth.** QuickBooks sync/export is not the desired product direction.
- GeekShop HQ should own invoices, payments, expenses, taxes, customer statements, and accountant handoff exports.
- External payment processors may still be useful as payment rails, but GeekShop HQ should preserve the canonical ledger/audit trail locally.

## Current state

Grounded from the current docs/codebase as of 2026-06-29:

- `README.md` lists Money, Time, Customers, Public Booking, Mission Control, and Accounting as existing pages.
- `docs/api.md` documents invoices, billing draft previews, time-entry invoicing, and `/api/accounting/*` MVP routes.
- `docs/schema.md` has `customers`, `tickets`, `ticket_messages`, `pending_emails`, `appointments`, `invoices`, `time_entries`, `settings`, and `agent_tasks` documented.
- `docs/mission-control-agents.md` documents existing Mission Control tabs and open followups like bulk task actions, reply streaming, and filter chips.
- The repo currently has uncommitted accounting-related work in progress, including `client/src/pages/Accounting.jsx`, `server/routes/accounting.js`, `server/db/migrations/031_accounting.sql`, `server/db/migrations/032_customer_extend_and_invoice_status.sql`, and supporting accounting/build scripts/tests. Do not overwrite or discard this work.

## Proposed phased backlog

### Phase 1 — Revenue leakage dashboard

**Goal:** Surface billable work and cash leaks before they are forgotten.

**Likely scope:**

- Add a dashboard/Money/Accounting widget for:
  - uninvoiced time entries
  - resolved tickets with uninvoiced time
  - stale draft invoices
  - overdue sent invoices
  - customers with billable activity and no recent invoice
- Add explicit `not_billable` / `write_off` handling only if needed; otherwise defer to Phase 3.
- Add tests around query correctness and invoice/time-entry edge cases.
- Browser-test the full user-facing flow.

**Primary files likely touched:**

- `server/routes/dashboard.js`
- `server/routes/accounting.js` or `server/routes/money.js`
- `client/src/pages/Accounting.jsx`
- `client/src/pages/Money.jsx`
- `docs/api.md`, `docs/schema.md`, `docs/changelog.md`

### Phase 2 — Customer 360 timeline

**Goal:** Make the customer detail page the single operational history screen.

**Likely scope:**

- Add a server endpoint returning normalized timeline events for a customer:
  - tickets
  - ticket messages
  - appointments
  - time entries
  - invoices/payments once available
  - customer memory/notes
- Add filters and compact event rendering in `CustomerDetail`.
- Preserve privacy: never expose raw secrets, Gmail headers, or internal-only metadata unnecessarily.

**Primary files likely touched:**

- `server/routes/customers.js`
- `client/src/pages/CustomerDetail.jsx`
- `docs/api.md`, `docs/schema.md`, `docs/changelog.md`

### Phase 3 — Payments ledger + invoice state upgrades

**Goal:** Track money received independently of QuickBooks.

**Likely scope:**

- Add `payments` table with invoice/customer linkage, amount, method, received date, reference, notes, and audit fields.
- Upgrade invoice states to support partial payments, paid, overdue, void/write-off if needed.
- Add payment entry UI from Money/Accounting and invoice detail contexts.
- Add integer-cent math tests and state transition tests.

**Primary files likely touched:**

- `server/db/migrations/<next>_payments.sql`
- `server/routes/invoices.js`
- `server/routes/accounting.js`
- `client/src/pages/Money.jsx`
- `client/src/pages/Accounting.jsx`
- `docs/schema.md`, `docs/api.md`, `docs/security.md`, `docs/changelog.md`

### Phase 4 — Expense/receipt capture

**Goal:** Track business expenses with receipt attachments and tax splits.

**Likely scope:**

- Add `expenses` and `expense_attachments` tables or equivalent.
- Expense fields: vendor, date, category, subtotal/tax/total cents, payment method, receipt path, notes.
- Add receipt upload/import from Inbox attachments where practical.
- Keep uploads size-limited and stored outside webroot.

**Primary files likely touched:**

- `server/db/migrations/<next>_expenses.sql`
- `server/routes/accounting.js`
- `server/lib/attachments.js` if attachment reuse is needed
- `client/src/pages/Accounting.jsx`
- `docs/schema.md`, `docs/api.md`, `docs/security.md`, `docs/changelog.md`

### Phase 5 — Tax summary reports

**Goal:** Produce GST/PST/HST collection and expense-tax summaries for remittance periods.

**Likely scope:**

- Add date-range report endpoints for:
  - tax collected on invoices/payments
  - tax paid on expenses
  - net remittance summary
- Export CSV/PDF-ready tables.
- Ensure all values are integer cents and tax model behavior is documented.

**Primary files likely touched:**

- `server/routes/accounting.js`
- `server/lib/tax.js`
- `client/src/pages/Accounting.jsx`
- `docs/api.md`, `docs/schema.md`, `docs/changelog.md`

### Phase 6 — Accountant export bundle

**Goal:** Give Byron/accountant a practical handoff package without QuickBooks dependency.

**Likely scope:**

- Export invoices, payments, expenses, customers, and tax summaries as CSV.
- Optional ZIP bundle endpoint if needed.
- Include date range, generated timestamp, and schema notes.
- Explicitly avoid leaking secrets or unrelated Gmail contents.

**Primary files likely touched:**

- `server/routes/accounting.js`
- `client/src/pages/Accounting.jsx`
- `docs/api.md`, `docs/security.md`, `docs/changelog.md`

### Phase 7 — Mission Control inline Telegram buttons

**Goal:** Reduce friction for approving/requeueing/cancelling completed worker tasks.

**Likely scope:**

- Wire Telegram `reply_markup` support in the gateway/tool path if available, or add a narrow HQ-side sender path if not.
- Use existing `/api/agent-tasks/callback` endpoint with `action`, `id`, and token.
- Ensure callbacks are token-checked and state-guarded.
- Keep alert/error messages sober and operational.

**Primary files likely touched:**

- Hermes gateway integration or HQ Telegram send helper
- `server/routes/agent-tasks.js` only if callback contract needs adjustment
- `docs/mission-control-agents.md`, `docs/api.md`, `docs/security.md`, `docs/changelog.md`

## Risk surface

- **Accounting correctness:** Invoice/payment/expense math must use integer cents and be covered by tests.
- **Data migration risk:** New accounting tables must be additive and reversible where possible. Back up `data/hq.db` before migration testing against live data.
- **User-facing regression risk:** Accounting, Money, Customers, and Mission Control are admin-facing but core. Browser testing is mandatory for every UI change.
- **Security/privacy:** Expenses/receipts/customer messages may contain PII. Attachment handling must keep content outside public webroot and avoid exposing arbitrary files.
- **Existing dirty repo state:** There is active uncommitted accounting work. Execution must inspect and preserve it rather than assume a clean base.

## Rollback

- Before each phase that touches the DB, copy `data/hq.db` to `data/backups/` with an ISO timestamp.
- Each DB phase gets a numbered migration. If a migration is not safely reversible in SQLite, document the exact restore-from-backup path.
- Code rollback is `git revert <phase-commit>` after each verified phase commit.
- Never delete existing customer/accounting data as part of cleanup without explicit confirmation.

## Verification plan

For every phase:

1. Run targeted server tests from `server/`.
2. Run full server test suite when practical.
3. Build the client using the direct Vite binary workaround if the terminal blocks `npm run build`:
   `node ./node_modules/vite/bin/vite.js build`
4. Browser-test the changed admin page(s): navigate, interact with the new controls, verify loading/empty/error states.
5. Update docs in the same iteration:
   - `docs/schema.md` for every DB change
   - `docs/api.md` for every endpoint change
   - `docs/security.md` for accounting/privacy/security behavior
   - `docs/changelog.md` for every shipped phase
6. Commit and push only after verification, preserving Byron's direct-push rule and avoiding secrets.

## Effort estimate

XL overall. Build as 7 medium-sized phases, not one monolithic push.

## Open questions

Resolved:

- **QuickBooks direction:** Byron wants GeekShop HQ to eventually replace QuickBooks for his own billing/accounting, not sync with QuickBooks.

Still to decide before Phase 4/5 if not obvious by then:

- Payment methods to support first: cash, e-transfer, card, cheque, other?
- Expense categories Byron wants initially.
- Whether Stripe/payment rails are in scope now or later. Payment rails are separate from accounting source-of-truth.

## Execution status

- 2026-06-29: Plan created. No feature code executed from this plan yet.
- 2026-06-29: **Phase 1 — Revenue leakage dashboard — executed** (T-ED62EC). Endpoint, UI panel, tests, and docs shipped. Five buckets per the plan, integer cents, defensive joins.
- 2026-06-29: **Phase 2 — Customer 360 timeline — executed** (T-F073BA). `GET /customers/:id/timeline`, CustomerDetail Timeline tab, 11/11 tests pass, `api.md` / `schema.md` / `security.md` / `changelog.md` updated.
- 2026-06-29: **Phase 3 — Payments ledger + invoice state upgrades — executed** (T-E1D19D). Added `partial` / `viewed` / `cancelled` to the invoice state machine; `GET /api/accounting/payments/summary`, `POST /api/accounting/payments/reconcile`, `PUT /api/accounting/payments/:id`; idempotent `idx_invoices_due_at_partial` index in migration `034_invoice_payment_states.sql`; 11/11 vitest cases green for partial / paid / refund / sticky `paid_at` / integer-cent math / reconciler / `cancelled`-stays-terminal; PaymentsTab UI + Record-payment modal + invoice-detail payment widget.
- 2026-06-30: **Phase 7 — Mission Control inline Telegram buttons — executed** (T-61CE00). Wired `notifyTaskForApproval()` to attach `✅ Approve / 🔄 Requeue / ❌ Cancel` inline_keyboard rows to review Telegram pings. `callback_data = action=…&id=…&token=<uid>` lands on the existing `POST /api/agent-tasks/callback` (no route change required — same token + state guards as `/decision`). 12/12 new vitest cases green (callback contract + button builder + non-review skip); `mission-control-agents.md` / `api.md` / `security.md` / `changelog.md` updated.
- 2026-06-30: **Phase 4 — Expense / receipt capture — executed** (T-74ED50). `/api/accounting/expenses` full CRUD (zod-validated, integer cents, payment-method allowlist) plus `POST/GET/DELETE /api/accounting/expenses/:id/receipt`; migration `035_expense_amount_checks.sql` adds `amount_cents >= 0`, `tax_cents >= 0`, `tax_cents <= amount_cents` CHECKs at the DB level (defense in depth); 24/24 vitest cases in `test/phase4-expenses.test.js` green covering allowlist, mime-spoof rejection, oversize 413, path-traversal, outside-webroot storage, audit log; `ExpensesTab` UI with date-range + vendor + category filters, KPIs, modal with receipt upload; `schema.md` / `api.md` / `security.md` / `changelog.md` updated.
- 2026-06-30: **Phase 6 — Accountant export bundle — executed** (T-3AF33F). Seven new admin-gated endpoints under `/api/accounting/export/*` (`invoices.csv`, `payments.csv`, `expenses.csv`, `customers.csv`, `tax-summary.csv`, `manifest.json`, `bundle.zip`) — every CSV echoes `from` / `to` / `generated_at` on every row; money exported as integer cents + derived decimal string; `stripe_payment_intent_id` / `stripe_charge_id` / Gmail message bodies / `password_*` / `session_id` all intentionally excluded; bad `?from` / `?to` fall back to `1970-01-01..2999-12-31` rather than 500ing. New `lib/zip.js` is a zero-dependency stored-only ZIP writer (no compression — CSVs are already plain ASCII). New `ExportTab` UI on `/accounting` with date range, "All time" shortcut, manifest viewer, per-file Preview + Download, and bundle download via the server's `Content-Disposition` filename. 13/13 vitest cases green in `test/phase6-export.test.js` (individual CSVs, manifest, ZIP structure, no-secret token list, edge cases, integer-cent invariant, audit log). `api.md` / `security.md` / `changelog.md` updated.
