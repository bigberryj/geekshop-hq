/**
 * Pending-email queue tests: prove the moderation loop works end-to-end
 * without ever hitting Gmail.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { scanPendingEmails, importPendingEmail, dismissPendingEmail, listPendingEmails } from '../lib/pending-emails.js';
import { vi } from 'vitest';

// Stub the IMAP fetcher so tests don't touch Gmail.
vi.mock('../lib/email-inbox.js', async () => {
  return {
    fetchUnread: vi.fn(async () => {
      return [
        { messageId: 'm1@x', uid: '10', from: 'Alice Customer', fromEmail: 'alice@x.com', subject: 'Help with my Wi-Fi', body: 'It keeps dropping.', snippet: 'It keeps dropping.', date: new Date('2026-06-15T18:00:00Z') },
        { messageId: 'm2@x', uid: '11', from: 'Bob Vendor', fromEmail: 'bob@vendor.com', subject: 'Receipt for invoice #99', body: 'Thanks', snippet: 'Thanks', date: new Date('2026-06-15T18:05:00Z') },
      ];
    }),
    inboxConfig: { hasCreds: true, pollIntervalMin: 5, autoCreate: false },
  };
});

let db;

beforeAll(async () => {
  db = await runMigrations(':memory:');
});

describe('pending_emails queue', () => {
  it('migrations create pending_emails table', () => {
    const cols = db.prepare("PRAGMA table_info(pending_emails)").all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'message_id', 'from_email', 'subject', 'body', 'status', 'imported_ticket_id']));
  });

  it('scan inserts new pending rows and is idempotent', async () => {
    const first = await scanPendingEmails(db);
    expect(first.fetched).toBe(2);
    expect(first.inserted).toBe(2);
    expect(first.skipped_existing).toBe(0);

    const second = await scanPendingEmails(db);
    expect(second.inserted).toBe(0);
    expect(second.skipped_existing).toBe(2);
  });

  it('import creates a customer (when missing) and a ticket with source=email', async () => {
    const list = listPendingEmails(db, { status: 'pending' });
    expect(list.length).toBe(2);

    const first = list.find((r) => r.from_email === 'alice@x.com');
    const result = importPendingEmail(db, first.id);
    expect(result.customer.email).toBe('alice@x.com');
    expect(result.customer.id).toBeGreaterThan(0);
    expect(result.ticket.source).toBe('email');
    expect(result.ticket.source_message_id).toBe('m1@x');
    expect(result.ticket.customer_id).toBe(result.customer.id);

    // Re-importing the same pending row returns the original ticket and does not duplicate.
    const again = importPendingEmail(db, first.id);
    expect(again.already_imported).toBe(true);
    expect(again.ticket.id).toBe(result.ticket.id);
    const tickets = db.prepare('SELECT COUNT(*) as c FROM tickets WHERE customer_id = ?').get(result.customer.id);
    expect(tickets.c).toBe(1);
  });

  it('dismiss marks the row dismissed and blocks import', () => {
    const list = listPendingEmails(db, { status: 'pending' });
    const row = list.find((r) => r.from_email === 'bob@vendor.com');
    dismissPendingEmail(db, row.id);
    expect(() => importPendingEmail(db, row.id)).toThrow(/dismissed/);
  });

  it('importing an already-known email reuses the existing customer', async () => {
    const result = importPendingEmail(db, db.prepare("SELECT id FROM pending_emails WHERE message_id='m1@x'").get().id);
    expect(result.already_imported).toBe(true);
    const customers = db.prepare("SELECT COUNT(*) as c FROM customers WHERE email = 'alice@x.com'").get();
    expect(customers.c).toBe(1);
  });
});

describe('pending_emails list shape (regression: 100-cap bug)', () => {
  let db2;
  beforeAll(async () => {
    // Fresh in-memory DB so we control state precisely. Insert 250 messages
    // all sharing the same fetched_at to mimic the real bug scenario.
    db2 = await runMigrations(':memory:');
    const stmt = db2.prepare(`
      INSERT INTO pending_emails (message_id, uid, from_name, from_email, subject, body, snippet, received_at, status, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '2026-06-15 18:00:00')
    `);
    for (let i = 0; i < 250; i++) {
      stmt.run(`m${i}@x`, String(i), `Customer ${i}`, `c${i}@x.com`, `Subject ${i}`, 'body', 'snippet', '2026-06-15T18:00:00Z');
    }
  });

  it('orders by id DESC (newest first), not fetched_at', () => {
    // The prior code ordered by `fetched_at DESC`, which for messages
    // bulk-fetched in the same call is non-deterministic. After the
    // imapflow-uid-bug scan, all 218 messages share an identical fetched_at,
    // so the order is fully driven by id.
    const list = listPendingEmails(db2, { status: 'pending', limit: 100 });
    expect(list.length).toBe(100);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].id).toBeGreaterThanOrEqual(list[i].id);
    }
  });

  it('supports a high limit to fetch the whole queue (cap was 100)', () => {
    // Prior cap was 100, so customer emails below the top 100 (e.g. Mary
    // McIntyre at id ~217) were invisible in the UI.
    const list = listPendingEmails(db2, { status: 'pending', limit: 500 });
    expect(list.length).toBe(250);
    for (const row of list) {
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('message_id');
      expect(row).toHaveProperty('from_email');
      expect(row).toHaveProperty('subject');
      expect(row).toHaveProperty('status');
    }
  });
});
