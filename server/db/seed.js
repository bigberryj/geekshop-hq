/**
 * Seed sample data so the dashboard isn't empty on first run.
 * Idempotent: drops + re-inserts demo data.
 *
 * Run: node server/db/seed.js
 */

import Database from 'better-sqlite3';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './migrate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..', '..');
const dbPath = process.argv[2] || resolve(rootDir, 'data/hq.db');

const db = await runMigrations(dbPath);

// Clear (only demo data — not real data)
const tables = ['time_entries', 'invoices', 'recurring_patterns', 'customer_memory', 'ticket_messages', 'tickets', 'appointments', 'settings', 'audit_log', 'sessions'];
for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
db.prepare('DELETE FROM customers').run();

const now = new Date().toISOString();
const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
const oneWeekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
const tomorrow = new Date(Date.now() + 86400000).toISOString();
const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString();

// Customers
const c1 = db.prepare(`INSERT INTO customers (name, company, email, phone, notes) VALUES (?, ?, ?, ?, ?)`).run('Linda Marsh', 'Marsh Designs', 'linda@marshdesigns.com', '250-555-0101', 'Prefers morning calls. Hard of hearing — type instead of voicemails.').lastInsertRowid;
const c2 = db.prepare(`INSERT INTO customers (name, company, email, phone, notes) VALUES (?, ?, ?, ?, ?)`).run('Brian Chen', null, 'brian@example.com', '250-555-0102', 'Allergic to upsells. Just fix it.').lastInsertRowid;
const c3 = db.prepare(`INSERT INTO customers (name, company, email, phone, notes) VALUES (?, ?, ?, ?, ?)`).run('Powell River Computers', 'Powell River Computers', 'admin@prc.bc.ca', '604-555-0103', 'B2B account. Billing contact: Sandra.').lastInsertRowid;

// Customer memory
const mem = db.prepare(`INSERT INTO customer_memory (customer_id, category, key, value, source, confidence) VALUES (?, ?, ?, ?, ?, ?)`);
mem.run(c1, 'equipment', 'router', 'UniFi Dream Machine + 2x AP-AC-Pro', 'manual', 1.0);
mem.run(c1, 'history', null, '2026-05-12: AP replacement ($280)', 'manual', 1.0);
mem.run(c1, 'preference', 'call_time', 'mornings only, 9-11am weekdays', 'manual', 1.0);
mem.run(c2, 'preference', 'upsells', 'no upsells ever', 'manual', 1.0);
mem.run(c3, 'relationship', 'billing_contact', 'Sandra (sandra@prc.bc.ca)', 'manual', 1.0);

// Tickets
const t1 = db.prepare(`INSERT INTO tickets (ticket_uid, customer_id, subject, status, priority, last_message_at) VALUES (?, ?, ?, ?, ?, ?)`).run('G-000001', c1, 'Wi-Fi drops in the upstairs office', 'open', 'high', oneDayAgo).lastInsertRowid;
db.prepare(`INSERT INTO ticket_messages (ticket_id, sender, body, created_at) VALUES (?, 'customer', 'Hey, the Wi-Fi keeps dropping in the upstairs office. About 4-5 times a day for the last 2 weeks.', ?)`).run(t1, new Date(Date.now() - 2 * 86400000).toISOString());
db.prepare(`INSERT INTO ticket_messages (ticket_id, sender, body, created_at) VALUES (?, 'admin', 'Hi Linda — sorry to hear that. Can you check the LED color on the AP-AC-Pro upstairs when it drops?', ?)`).run(t1, oneDayAgo);

const t2 = db.prepare(`INSERT INTO tickets (ticket_uid, customer_id, subject, status, priority, last_message_at) VALUES (?, ?, ?, ?, ?, ?)`).run('G-000002', c2, 'Email not sending', 'pending', 'normal', oneWeekAgo).lastInsertRowid;
db.prepare(`INSERT INTO ticket_messages (ticket_id, sender, body, created_at) VALUES (?, 'customer', 'Outlook says "not sending" when I hit the button. Tried restarting. Help.', ?)`).run(t2, oneWeekAgo);

// Time entries (one running, one done)
db.prepare(`INSERT INTO time_entries (ticket_id, started_at, stopped_at, duration_seconds, note) VALUES (?, ?, ?, ?, ?)`).run(t1, new Date(Date.now() - 2 * 3600000).toISOString(), new Date(Date.now() - 1.5 * 3600000).toISOString(), 1800, 'Initial triage');
db.prepare(`INSERT INTO time_entries (ticket_id, started_at) VALUES (?, ?)`).run(t2, new Date(Date.now() - 600000).toISOString());

// Invoices
db.prepare(`INSERT INTO invoices (invoice_uid, customer_id, status, line_items, subtotal_cents, tax_cents, total_cents, sent_at, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  'INV-2026-001', c1, 'overdue',
  JSON.stringify([{ description: 'AP replacement + install', qty: 1, unit_price: 28000 }]),
  28000, 1400, 29400,
  new Date(Date.now() - 14 * 86400000).toISOString(),
  new Date(Date.now() - 7 * 86400000).toISOString()
);
db.prepare(`INSERT INTO invoices (invoice_uid, customer_id, status, line_items, subtotal_cents, tax_cents, total_cents) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
  'INV-2026-002', c3, 'draft',
  JSON.stringify([{ description: 'Monthly IT support — May', qty: 4, unit_price: 12500 }]),
  50000, 2500, 52500
);

// Appointments
db.prepare(`INSERT INTO appointments (customer_id, starts_at, ends_at, status, notes) VALUES (?, ?, ?, ?, ?)`).run(
  c1, tomorrow, new Date(Date.now() + 86400000 + 3600000).toISOString(), 'confirmed', 'Site visit — Wi-Fi AP troubleshooting'
);
db.prepare(`INSERT INTO appointments (customer_id, starts_at, ends_at, status, notes) VALUES (?, ?, ?, ?, ?)`).run(
  c3, nextWeek, new Date(Date.now() + 7 * 86400000 + 2 * 3600000).toISOString(), 'scheduled', 'Quarterly maintenance'
);

// Recurring pattern (we detected the quarterly thing for Powell River)
db.prepare(`INSERT INTO recurring_patterns (customer_id, pattern_type, frequency_days, last_occurrence, next_occurrence) VALUES (?, ?, ?, ?, ?)`).run(
  c3, 'appointment', 90, new Date(Date.now() - 90 * 86400000).toISOString(), nextWeek
);

// Settings (defaults)
db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_high_provider', 'codex')`).run();
db.prepare(`INSERT INTO settings (key, value) VALUES ('ai_cheap_provider', 'minimax')`).run();
db.prepare(`INSERT INTO settings (key, value) VALUES ('business_name', 'GeekShop Computers')`).run();
db.prepare(`INSERT INTO settings (key, value) VALUES ('booking_slug', 'general')`).run();
db.prepare(`INSERT INTO settings (key, value) VALUES ('booking_title', 'Book a GeekShop appointment')`).run();

console.log(`Seeded demo data into ${dbPath}`);
console.log(`  - 3 customers (Linda, Brian, Powell River Computers)`);
console.log(`  - 5 memory entries`);
console.log(`  - 2 tickets (G-000001 open, G-000002 pending)`);
console.log(`  - 2 time entries (1 done, 1 running)`);
console.log(`  - 2 invoices (1 overdue, 1 draft)`);
console.log(`  - 2 appointments (1 tomorrow, 1 next week)`);
console.log(`  - 1 detected recurring pattern`);
