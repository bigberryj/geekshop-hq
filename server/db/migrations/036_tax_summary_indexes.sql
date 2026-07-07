-- 036 — Phase 5 (billing/accounting roadmap): Tax summary reports.
--
-- The Phase 5 endpoints aggregate across `invoices.tax_lines` (JSON) and
-- `expenses.tax_cents` / `expenses.tax_rate_id` for date windows. Three
-- indexes are added to keep those queries fast as the ledger grows:
--
--   1. expenses(expense_date, tax_rate_id) — for expense-tax rolls
--   2. payments(received_at, status, invoice_id) — for "tax collected per
--      payment window" rollups that mirror accounting calendars (the
--      alternative would be scanning the whole payments table per window)
--   3. invoices(created_at) WHERE status IN (...) — already partially
--      covered by idx_invoices_due_at_partial, but tax-collected reports
--      key on created_at. Use a partial index to keep it small.
--
-- No new columns. The existing tax_lines JSON column on invoices
-- (migration 004) already stores the breakdown rows; Phase 5 just reads it.

CREATE INDEX IF NOT EXISTS idx_expenses_date_tax_rate
  ON expenses(expense_date, tax_rate_id);

CREATE INDEX IF NOT EXISTS idx_payments_received_status_invoice
  ON payments(received_at, status, invoice_id);

CREATE INDEX IF NOT EXISTS idx_invoices_created_tax
  ON invoices(created_at)
  WHERE status IN ('sent', 'paid', 'overdue', 'partial', 'viewed');
