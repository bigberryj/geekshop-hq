-- 004 — Billing: time-entry invoiced flag + invoice tax breakdown persistence.
ALTER TABLE time_entries ADD COLUMN invoiced_at TEXT;
CREATE INDEX idx_time_invoiced ON time_entries(invoiced_at);
-- Optional per-invoice tax breakdown (so old totals don't change shape)
ALTER TABLE invoices ADD COLUMN tax_lines TEXT;  -- JSON: [{label, rate, amount_cents}]
