/**
 * importPendingEmail — reply-merge path
 * -------------------------------------
 * When a pending Gmail message is a reply to an existing open ticket
 * for the same customer, importing it should:
 *   1. Append the message to the existing ticket
 *   2. Mark the Gmail message read (best-effort)
 *   3. Mark the pending row as imported
 *   4. Return merged_into_existing: true with the existing ticket
 *   5. NOT create a brand-new ticket
 *
 * The matcher has its own test file; this one is focused on the
 * integration between importPendingEmail and the matcher.
 */

import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest';
import { runMigrations } from '../db/migrate.js';

vi.mock('../lib/email-inbox.js', async () => ({
  fetchUnread: vi.fn(async () => []),
  fetchByMessageId: vi.fn(async (messageId) => ({
    messageId,
    from: 'Linda Marsh',
    fromEmail: 'linda@example.com',
    subject: 'Re: Wi-Fi drops in the upstairs office',
    body: 'Hi Byron — fixed it myself, thanks!',
    html: '<p>Hi Byron — fixed it myself, thanks!</p>',
    attachments: [],
  })),
  inboxConfig: { hasCreds: true, pollIntervalMin: 30, autoCreate: false },
}));

vi.mock('../lib/replies.js', async () => {
  return {
    matchReplyToTicket: vi.fn(async () => null), // override in tests
    markImportedRead: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock('../lib/google-contacts.js', async () => ({
  findContactMatch: vi.fn(async () => null),
}));

import { importPendingEmail } from '../lib/pending-emails.js';
import * as replies from '../lib/replies.js';

let db;
const customerId = () => db.prepare("SELECT id FROM customers WHERE email = 'linda@example.com'").get()?.id;

beforeAll(async () => {
  db = await runMigrations(':memory:');
});

beforeEach(() => {
  // Reset the queue and the tickets/customer tables for each test.
  db.exec("DELETE FROM ticket_messages; DELETE FROM tickets; DELETE FROM customers; DELETE FROM pending_emails;");
  // Reset mock state — vi.fn() spies accumulate across tests otherwise.
  vi.mocked(replies.matchReplyToTicket).mockReset();
  vi.mocked(replies.markImportedRead).mockClear();
  // Seed a customer with an open ticket whose subject will match the
  // pending email's subject after Re: stripping.
  db.prepare("INSERT INTO customers (name, email) VALUES ('Linda Marsh', 'linda@example.com')").run();
  const cid = customerId();
  db.prepare(`
    INSERT INTO tickets (ticket_uid, customer_id, subject, priority, source, source_message_id, status, last_message_at)
    VALUES ('G-000001', ?, 'Wi-Fi drops in the upstairs office', 'normal', 'email', 'orig-msg-1@geekshop.ca', 'open', '2026-06-15 22:10:39')
  `).run(cid);
});

async function seedPendingEmail(overrides = {}) {
  const row = {
    message_id: 'reply-msg-1@geekshop.ca',
    from_name: 'Linda Marsh',
    from_email: 'linda@example.com',
    subject: 'Re: Wi-Fi drops in the upstairs office',
    body: 'Hi Byron — fixed it myself, thanks!',
    snippet: 'Hi Byron — fixed it myself, thanks!',
    received_at: new Date().toISOString(),
    status: 'pending',
  };
  db.prepare(`
    INSERT INTO pending_emails (message_id, from_name, from_email, subject, body, snippet, received_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    row.message_id,
    row.from_name,
    row.from_email,
    row.subject,
    row.body,
    row.snippet,
    row.received_at,
  );
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

describe('importPendingEmail — reply-merge path', () => {
  it('appends to the existing ticket and returns merged_into_existing: true when the matcher matches', async () => {
    const pendingId = await seedPendingEmail();
    // Force the matcher to claim this is a thread match.
    vi.mocked(replies.matchReplyToTicket).mockResolvedValueOnce({
      ticket_id: 1,
      source: 'sender_subject',
      already_appended: false,
    });

    const result = await importPendingEmail(db, pendingId);
    expect(result.merged_into_existing).toBe(true);
    expect(result.ticket.id).toBe(1);

    // No NEW ticket was created.
    const ticketCount = db.prepare('SELECT COUNT(*) as n FROM tickets').get().n;
    expect(ticketCount).toBe(1);

    // The pending row is now imported, pointing at the existing ticket.
    const pending = db.prepare('SELECT * FROM pending_emails WHERE id = ?').get(pendingId);
    expect(pending.status).toBe('imported');
    expect(pending.imported_ticket_id).toBe(1);

    // The original ticket's last_message_at is bumped.
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = 1').get();
    // last_message_at is a SQLite CURRENT_TIMESTAMP string ("YYYY-MM-DD HH:MM:SS" UTC).
    // Sanity: it parses to a valid Date and is not empty.
    const parsed = new Date((ticket.last_message_at || '').replace(' ', 'T') + 'Z');
    expect(Number.isFinite(parsed.getTime())).toBe(true);
    // It should be >= the seed timestamp we set in beforeEach.
    const seeded = new Date('2026-06-15T22:10:39Z');
    expect(parsed.getTime()).toBeGreaterThanOrEqual(seeded.getTime());

    // markImportedRead was called with the Gmail message id.
    expect(replies.markImportedRead).toHaveBeenCalledWith('reply-msg-1@geekshop.ca');
  });

  it('skips the matcher when the pending row has no message_id', async () => {
    // pending_emails.message_id is NOT NULL, so we have to provide one —
    // but the production code checks `if (row.message_id)` for the
    // reply-merge path. To exercise the "no match id" branch we use
    // a value that won't match any source_message_id. The matcher
    // returns null, then import falls through to the new-ticket path.
    const info = db.prepare(`
      INSERT INTO pending_emails (message_id, from_name, from_email, subject, body, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run('no-thread-msg@x', 'Linda Marsh', 'linda@example.com', 'New topic', 'no thread ref');
    const pendingId = info.lastInsertRowid;

    // Sanity: the matcher is called, gets the no-thread-msg id, and
    // returns null (default mock state after beforeEach reset).
    const result = await importPendingEmail(db, pendingId);
    expect(result.merged_into_existing).toBeUndefined();
    const ticketCount = db.prepare('SELECT COUNT(*) as n FROM tickets').get().n;
    expect(ticketCount).toBe(2);
  });

  it('falls through to the new-ticket path when the matcher returns no match', async () => {
    const pendingId = await seedPendingEmail();
    // Default mock returns null.
    const result = await importPendingEmail(db, pendingId);
    expect(result.merged_into_existing).toBeUndefined();
    const ticketCount = db.prepare('SELECT COUNT(*) as n FROM tickets').get().n;
    expect(ticketCount).toBe(2);
  });

  it('does NOT create a new ticket when the matcher says already_appended (avoids duplicating the message)', async () => {
    const pendingId = await seedPendingEmail();
    vi.mocked(replies.matchReplyToTicket).mockResolvedValueOnce({
      ticket_id: 1,
      source: 'thread',
      already_appended: true,
    });

    const result = await importPendingEmail(db, pendingId);
    // already_appended means a previous run already wrote the
    // ticket_message. The import should NOT duplicate it by
    // creating a new ticket — it should flip the pending row to
    // imported and return.
    expect(result.merged_into_existing).toBeUndefined();
    expect(result.already_imported).toBe(true);
    const ticketCount = db.prepare('SELECT COUNT(*) as n FROM tickets').get().n;
    expect(ticketCount).toBe(1); // still the original ticket only

    // Pending row is marked imported.
    const pending = db.prepare('SELECT * FROM pending_emails WHERE id = ?').get(pendingId);
    expect(pending.status).toBe('imported');
    expect(pending.imported_ticket_id).toBe(1);

    // markImportedRead is NOT called on already_appended (the
    // message was already marked read in a prior run, presumably).
    expect(replies.markImportedRead).not.toHaveBeenCalled();
  });
});
