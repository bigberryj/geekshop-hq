-- 035 — Phase 4 (billing/accounting roadmap): Expense / receipt capture.
--
-- The `expenses` table and all of its columns already exist from migration
-- 031_accounting.sql — Phase 4's "Likely scope" called for `expenses` and
-- `expense_attachments` tables "or equivalent". We use the existing
-- `expenses.receipt_path` column + the `data/attachments/expenses/<id>/`
-- bucket as that equivalent (no separate attachment table; same pattern
-- as the email-attachments path documented under
-- docs/solutions/build-it/).
--
-- This migration is additive and defense-in-depth. It is a *new* check
-- constraint pair, applied via table-recreate, to guarantee:
--   * amount_cents and tax_cents are non-negative integers
--   * tax_cents never exceeds amount_cents (a sanity bound; if a future
--     bug ever inverted the two columns, the DB would refuse the write
--     instead of silently saving nonsense totals)
--
-- Migration is idempotent and safe on a populated table: every existing
-- expense row in the live DB has amount_cents > 0 and
-- 0 <= tax_cents <= amount_cents (verified by SELECT before writing
-- this). If you have an existing row that violates the new bound, the
-- INSERT below will fail loudly — fix the row first, then re-run.
--
-- The recreate approach is the standard SQLite pattern for adding
-- constraints to existing tables:
--   1. CREATE TABLE __new_expenses (...) with the constraints
--   2. INSERT INTO __new_expenses SELECT ... FROM expenses
--   3. DROP TABLE expenses
--   4. ALTER TABLE __new_expenses RENAME TO expenses
--   5. Recreate indexes
--
-- db/migrate.js wraps this whole file in a transaction; we therefore
-- must NOT add our own BEGIN/COMMIT (SQLite forbids nested transactions).

CREATE TABLE __new_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor TEXT NOT NULL,
  expense_date TEXT NOT NULL,                -- ISO date (YYYY-MM-DD)
  category_id INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  tax_cents INTEGER NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  tax_rate_id INTEGER REFERENCES tax_rates(id) ON DELETE SET NULL,
  payment_method TEXT NOT NULL DEFAULT 'other', -- cash | cheque | e_transfer | card | other
  business_use INTEGER NOT NULL DEFAULT 1,
  receipt_path TEXT,                          -- relative path under data/attachments/
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (tax_cents <= amount_cents)
);

INSERT INTO __new_expenses (
  id, vendor, expense_date, category_id, amount_cents, tax_cents, tax_rate_id,
  payment_method, business_use, receipt_path, notes, created_at, updated_at
)
SELECT
  id, vendor, expense_date, category_id, amount_cents, tax_cents, tax_rate_id,
  payment_method, business_use, receipt_path, notes, created_at, updated_at
FROM expenses;

DROP TABLE expenses;
ALTER TABLE __new_expenses RENAME TO expenses;

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id);
CREATE INDEX IF NOT EXISTS idx_expenses_vendor ON expenses(vendor);
