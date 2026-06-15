-- GeekShop HQ — Initial Schema
-- 11 tables: customers, tickets, ticket_messages, appointments, customer_memory,
--            time_entries, invoices, recurring_patterns, settings, audit_log, sessions

CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company TEXT,
  email TEXT,
  phone TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_customers_email ON customers(email);
CREATE INDEX idx_customers_name ON customers(name);

CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_uid TEXT NOT NULL UNIQUE,           -- e.g. G-000001
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',       -- open | pending | resolved
  priority TEXT NOT NULL DEFAULT 'normal',   -- low | normal | high | urgent
  ai_summary TEXT,
  last_message_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_tickets_customer ON tickets(customer_id);
CREATE INDEX idx_tickets_status ON tickets(status);
CREATE INDEX idx_tickets_last_message ON tickets(last_message_at);

CREATE TABLE ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,                       -- 'admin' | 'customer' | 'system'
  body TEXT NOT NULL,
  ai_draft INTEGER NOT NULL DEFAULT 0,        -- 1 if this message was an AI-drafted reply
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_messages_ticket ON ticket_messages(ticket_id, created_at);

CREATE TABLE appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT,                         -- captured from /book page even without account
  customer_email TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | confirmed | completed | cancelled
  notes TEXT,
  booking_slug TEXT,                          -- which /book page it came from
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_appointments_starts ON appointments(starts_at);
CREATE INDEX idx_appointments_status ON appointments(status);

CREATE TABLE customer_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  category TEXT NOT NULL,                     -- preference | equipment | history | relationship | note
  key TEXT,
  value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',      -- manual | ai
  confidence REAL NOT NULL DEFAULT 1.0,       -- 0.0 - 1.0
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_memory_customer ON customer_memory(customer_id);
CREATE INDEX idx_memory_category ON customer_memory(category);

CREATE TABLE time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  duration_seconds INTEGER,                   -- null while still running
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_time_ticket ON time_entries(ticket_id, started_at);

CREATE TABLE invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_uid TEXT NOT NULL UNIQUE,           -- e.g. INV-2026-001
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft',       -- draft | sent | overdue | paid
  line_items TEXT NOT NULL DEFAULT '[]',     -- JSON: [{description, qty, unit_price}]
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  due_at TEXT,
  paid_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_due ON invoices(due_at);

CREATE TABLE recurring_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  pattern_type TEXT NOT NULL,                 -- 'ticket' | 'appointment'
  frequency_days INTEGER NOT NULL,            -- e.g. 90 for quarterly
  last_occurrence TEXT,
  next_occurrence TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,       -- 1 if user has accepted
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_recurring_customer ON recurring_patterns(customer_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL DEFAULT 'admin',
  action TEXT NOT NULL,
  target TEXT,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_audit_target ON audit_log(target, created_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                        -- random session id (cookie value)
  admin_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);
