-- 031 — Accounting MVP module
-- Adds: tax_rates, products, expenses, expense_categories, payments,
-- payment_events (for Stripe + manual), and expands audit_log usage.
-- Designed for solo owner, but role-based structure exists in `users` (via auth).

-- --- tax_rates ---
-- Owner-defined tax rates (GST 5%, PST 7%, HST 13%, custom 0–100%).
CREATE TABLE IF NOT EXISTS tax_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                  -- 'GST', 'PST', 'HST', 'QST', 'Custom'
  rate_bps INTEGER NOT NULL,           -- basis points (5% = 500). Stored as int to avoid float drift.
  is_compound INTEGER NOT NULL DEFAULT 0,
  jurisdiction TEXT,                   -- e.g. 'CA-BC', 'CA-ON', null for custom
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tax_rates_active ON tax_rates(active);

-- --- products (goods & services catalog) ---
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  taxable INTEGER NOT NULL DEFAULT 1,        -- 1 = tax applies by default
  default_tax_rate_id INTEGER REFERENCES tax_rates(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);

-- --- expense_categories ---
CREATE TABLE IF NOT EXISTS expense_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  tax_rate_id INTEGER REFERENCES tax_rates(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- --- expenses ---
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor TEXT NOT NULL,
  expense_date TEXT NOT NULL,                -- ISO date (YYYY-MM-DD)
  category_id INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL,             -- total including tax
  tax_cents INTEGER NOT NULL DEFAULT 0,
  tax_rate_id INTEGER REFERENCES tax_rates(id) ON DELETE SET NULL,
  payment_method TEXT NOT NULL DEFAULT 'other', -- cash | cheque | e_transfer | card | other
  business_use INTEGER NOT NULL DEFAULT 1,
  receipt_path TEXT,                          -- relative path under data/attachments/
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id);
CREATE INDEX IF NOT EXISTS idx_expenses_vendor ON expenses(vendor);

-- --- payments (invoice payments) ---
-- Each row is a payment event against an invoice. Stripe payment_intent ids
-- and manual payments both land here so payment history is uniform.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL,                       -- stripe | cash | cheque | e_transfer | other
  stripe_payment_intent_id TEXT,              -- null for non-Stripe
  stripe_charge_id TEXT,
  status TEXT NOT NULL DEFAULT 'succeeded',   -- pending | succeeded | failed | refunded
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_pi ON payments(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payments_received ON payments(received_at);

-- --- payment_events (Stripe webhook + manual) ---
-- Append-only event log so the same source-of-truth handles both webhooks
-- and manual payment entries, with idempotency on Stripe event id.
CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_event_id TEXT UNIQUE,                -- idempotency key for Stripe webhooks
  source TEXT NOT NULL,                       -- stripe | manual
  event_type TEXT NOT NULL,                   -- payment_intent.succeeded | manual.cash | ...
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  payload TEXT,                               -- JSON
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payment_events_invoice ON payment_events(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_type ON payment_events(event_type);
