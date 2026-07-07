-- 032 — Customer extensions + invoice status enum + settings for accounting module.
--
-- Customer fields the brief asked for (business name already exists as `company`).
-- Adding billing_address, shipping_address, tax_number, and a status flag.
ALTER TABLE customers ADD COLUMN billing_address TEXT;
ALTER TABLE customers ADD COLUMN shipping_address TEXT;
ALTER TABLE customers ADD COLUMN tax_number TEXT;
ALTER TABLE customers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'; -- active | archived
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);

-- Invoice status enum expansion (existing rows are kept; new statuses accepted).
-- Existing status column is TEXT (no CHECK constraint in 001) so adding values is forward-only.
-- We document the new allowed values in schema.md and validate at the route layer.

-- Accounting module settings — custom invoice prefix.
-- (The settings table already exists from migration 001.)
-- No new table needed; key/value settings are read by /api/accounting/* routes.
