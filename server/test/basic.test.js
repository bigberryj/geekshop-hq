/**
 * Basic backend smoke tests.
 * Run: cd server && npm test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../db/migrate.js';
import { aiCall, testProvider } from '../lib/ai.js';
import { maskSensitive, newSessionId } from '../lib/security.js';
import { buildIcs } from '../lib/email.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db;

beforeAll(async () => {
  db = await runMigrations(':memory:');
});

describe('lib/security.js', () => {
  it('masks sensitive keys', () => {
    const out = maskSensitive({ smtp_pass: 'secret', openai_api_key: 'sk-xxx', name: 'Byron' });
    expect(out.smtp_pass).toBe('***');
    expect(out.openai_api_key).toBe('***');
    expect(out.name).toBe('Byron');
  });
  it('newSessionId returns 48 hex chars', () => {
    const id = newSessionId();
    expect(id).toMatch(/^[0-9a-f]{48}$/);
  });
});

describe('lib/email.js', () => {
  it('buildIcs produces valid VCALENDAR', () => {
    const ics = buildIcs({
      uid: 'test-123',
      start: '2026-06-15T10:00:00Z',
      end: '2026-06-15T11:00:00Z',
      summary: 'Test',
      description: 'A test event',
    });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('SUMMARY:Test');
    expect(ics).toContain('DTSTART:20260615T100000Z');
  });
});

describe('lib/ai.js', () => {
  it('aiCall returns a string from the heuristic fallback when no provider is set', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    const result = await aiCall('cheap_classify', 'test', { task: 'urgency_tag' });
    expect(result.output).toBe('normal');
    expect(['heuristic', 'gemini', 'minimax']).toContain(result.provider);
  });

  it('aiCall handles overdue classification via heuristic', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    const result = await aiCall('cheap_classify', 'this is overdue and bad', { task: 'classify_overdue' });
    expect(result.output).toBe('overdue');
  });

  it('testProvider returns a structured result', async () => {
    const result = await testProvider('heuristic');
    expect(result).toHaveProperty('ok');
    expect(result).toHaveProperty('latency_ms');
  });
});

describe('db/migrate.js', () => {
  it('creates all 11 tables', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((t) => t.name).filter((n) => !n.startsWith('_') && n !== 'sqlite_sequence');
    expect(tables.sort()).toEqual([
      'appointments', 'audit_log', 'customer_memory', 'customers', 'invoices', 'recurring_patterns', 'sessions', 'settings', 'ticket_messages', 'tickets', 'time_entries',
    ]);
  });

  it('tables have expected columns', () => {
    const customerCols = db.prepare("PRAGMA table_info(customers)").all().map((c) => c.name);
    expect(customerCols).toContain('id');
    expect(customerCols).toContain('name');
    expect(customerCols).toContain('email');

    const ticketCols = db.prepare("PRAGMA table_info(tickets)").all().map((c) => c.name);
    expect(ticketCols).toContain('ticket_uid');
    expect(ticketCols).toContain('status');
    expect(ticketCols).toContain('priority');
  });
});

describe('CRUD round-trips', () => {
  it('create customer + ticket + message', () => {
    const c = db.prepare(`INSERT INTO customers (name, email) VALUES (?, ?)`).run('Test', 't@x.com').lastInsertRowid;
    const t = db.prepare(`INSERT INTO tickets (ticket_uid, customer_id, subject) VALUES (?, ?, ?)`).run('G-TEST', c, 'Hi').lastInsertRowid;
    const m = db.prepare(`INSERT INTO ticket_messages (ticket_id, sender, body) VALUES (?, 'customer', ?)`).run(t, 'help').lastInsertRowid;
    expect(db.prepare('SELECT * FROM ticket_messages WHERE id = ?').get(m)).toBeTruthy();
  });

  it('invoice status transitions: draft -> sent -> paid', () => {
    const c = db.prepare(`INSERT INTO customers (name) VALUES (?)`).run('InvTest').lastInsertRowid;
    const i = db.prepare(`INSERT INTO invoices (invoice_uid, customer_id, line_items, subtotal_cents, tax_cents, total_cents) VALUES (?, ?, '[]', 0, 0, 0)`).run('INV-T', c).lastInsertRowid;
    db.prepare("UPDATE invoices SET status='sent', sent_at=CURRENT_TIMESTAMP WHERE id=?").run(i);
    expect(db.prepare('SELECT status FROM invoices WHERE id=?').get(i).status).toBe('sent');
    db.prepare("UPDATE invoices SET status='paid', paid_at=CURRENT_TIMESTAMP WHERE id=?").run(i);
    expect(db.prepare('SELECT status FROM invoices WHERE id=?').get(i).status).toBe('paid');
  });
});
