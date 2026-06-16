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
    fetchByMessageId: vi.fn(async (messageId) => ({
      messageId,
      from: 'Bob', fromEmail: 'bob@x.com',
      subject: 'No body',
      body: 'body from Gmail for ' + messageId,
      date: new Date('2026-06-14T00:00:00Z'),
    })),
    inboxConfig: { hasCreds: true, pollIntervalMin: 5, autoCreate: false },
  };
});

// Stub the Google Contacts lookup so unit tests don't make real API calls.
// Tests that need to exercise the enrichment logic should override this.
vi.mock('../lib/google-contacts.js', async () => {
  return {
    findContactMatch: vi.fn(async () => ({ ok: false, reason: 'no_match' })),
    buildEnrichmentDiff: vi.fn(() => null),
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
    const result = await importPendingEmail(db, first.id);
    expect(result.customer.email).toBe('alice@x.com');
    expect(result.customer.id).toBeGreaterThan(0);
    expect(result.ticket.source).toBe('email');
    expect(result.ticket.source_message_id).toBe('m1@x');
    expect(result.ticket.customer_id).toBe(result.customer.id);

    // Re-importing the same pending row returns the original ticket and does not duplicate.
    const again = await importPendingEmail(db, first.id);
    expect(again.already_imported).toBe(true);
    expect(again.ticket.id).toBe(result.ticket.id);
    const tickets = db.prepare('SELECT COUNT(*) as c FROM tickets WHERE customer_id = ?').get(result.customer.id);
    expect(tickets.c).toBe(1);
  });

  it('dismiss marks the row dismissed and blocks import', async () => {
    const list = listPendingEmails(db, { status: 'pending' });
    const row = list.find((r) => r.from_email === 'bob@vendor.com');
    dismissPendingEmail(db, row.id);
    await expect(importPendingEmail(db, row.id)).rejects.toThrow(/dismissed/);
  });

  it('importing an already-known email reuses the existing customer', async () => {
    const result = await importPendingEmail(db, db.prepare("SELECT id FROM pending_emails WHERE message_id='m1@x'").get().id);
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

  it('orders by received_at DESC, id DESC (newest email first)', () => {
    // received_at is the email's actual send time. id DESC is a tiebreaker
    // for the common case where multiple rows share a second.
    const list = listPendingEmails(db2, { status: 'pending', limit: 100 });
    expect(list.length).toBe(100);
    for (let i = 1; i < list.length; i++) {
      const prev = new Date(list[i - 1].received_at).getTime();
      const cur = new Date(list[i].received_at).getTime();
      // Primary: received_at non-increasing
      expect(prev).toBeGreaterThanOrEqual(cur);
      // Tiebreaker: id non-increasing when received_at is equal
      if (prev === cur) expect(list[i - 1].id).toBeGreaterThanOrEqual(list[i].id);
    }
  });

  it('orders mixed received_at correctly (newest email, not newest insert, wins)', () => {
    // Regression: prior code ordered by id, so an old email that arrived
    // just now (and got a high id) would sit on top of a newer email that
    // was scanned earlier (and got a lower id). received_at fixes that.
    const fresh = listPendingEmails(db2, { status: 'pending', limit: 500 });
    const oldId = fresh[fresh.length - 1].id; // lowest id
    const newId = fresh[0].id; // highest id
    // Bump the OLDEST message to a future date — it should now appear first.
    db2.prepare('UPDATE pending_emails SET received_at = ? WHERE id = ?')
      .run('2027-01-01T00:00:00Z', oldId);
    const reordered = listPendingEmails(db2, { status: 'pending', limit: 5 });
    expect(reordered[0].id).toBe(oldId); // the date-bumped one is now on top
    // And the newId is no longer first
    expect(reordered[0].id).not.toBe(newId);
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

describe('pending_emails import with bodyless row (regression: scan body cap)', () => {
  let db3;
  beforeAll(async () => {
    db3 = await runMigrations(':memory:');
    // Row with body + snippet (the normal "top 25" case)
    db3.prepare(`
      INSERT INTO pending_emails (message_id, uid, from_name, from_email, subject, body, snippet, received_at, status)
      VALUES ('with-body@x', '1', 'Alice', 'alice@x.com', 'Has body', 'full body text', 'snippet', '2026-06-15T00:00:00Z', 'pending')
    `).run();
    // Row without body (the "older than 25" case)
    db3.prepare(`
      INSERT INTO pending_emails (message_id, uid, from_name, from_email, subject, body, snippet, received_at, status)
      VALUES ('no-body@x', '2', 'Bob', 'bob@x.com', 'No body', '', 'just snippet', '2026-06-14T00:00:00Z', 'pending')
    `).run();
  });

  it('imports a row that already has body without calling fetchByMessageId', async () => {
    const id = db3.prepare("SELECT id FROM pending_emails WHERE message_id='with-body@x'").get().id;
    const r = await importPendingEmail(db3, id);
    expect(r.already_imported).toBe(false);
    expect(r.ticket.source).toBe('email');
    // The first message body must be 'full body text' (not the snippet)
    const msg = db3.prepare("SELECT body FROM ticket_messages WHERE ticket_id = ?").get(r.ticket.id);
    expect(msg.body).toBe('full body text');
  });

  it('imports a bodyless row by fetching the body from Gmail on demand', async () => {
    // The mock returns a body for any messageId, so the import should
    // succeed and the new ticket's first message should contain it.
    const id = db3.prepare("SELECT id FROM pending_emails WHERE message_id='no-body@x'").get().id;
    const r = await importPendingEmail(db3, id);
    expect(r.already_imported).toBe(false);
    expect(r.ticket.source).toBe('email');
    const msg = db3.prepare("SELECT body FROM ticket_messages WHERE ticket_id = ?").get(r.ticket.id);
    // fetchByMessageId is mocked to return a body, so we get the body
    expect(msg.body).toContain('body from Gmail');
  });
});

describe('pending_emails backfill on re-scan (regression: flagged/from_email not refreshed)', () => {
  let db4;
  beforeAll(async () => {
    db4 = await runMigrations(':memory:');
  });

  it('flips flagged=1 on an existing row when the new scan reports it as starred', async () => {
    // Insert a row that was originally fetched without starred info
    db4.prepare(`
      INSERT INTO pending_emails (message_id, uid, from_name, from_email, subject, body, snippet, received_at, status, flagged)
      VALUES ('star-now@x', '1', 'Sender', 's@x.com', 'Hi', 'body', 's', '2026-06-15T00:00:00Z', 'pending', 0)
    `).run();
    const fetchUnread = (await import('../lib/email-inbox.js')).fetchUnread;
    fetchUnread.mockResolvedValueOnce([
      { messageId: 'star-now@x', uid: '1', from: 'Sender', fromEmail: 's@x.com', subject: 'Hi', body: 'body', snippet: 's', date: new Date('2026-06-15T00:00:00Z'), flagged: true },
    ]);
    const r = await scanPendingEmails(db4, { since: new Date('2026-06-14'), includeStarred: true, limit: 10 });
    expect(r.inserted).toBe(0);
    expect(r.skipped_existing).toBe(1);
    const row = db4.prepare("SELECT flagged FROM pending_emails WHERE message_id='star-now@x'").get();
    expect(row.flagged).toBe(1);
  });

  it('backfills from_email on an existing bodyless row', async () => {
    db4.prepare(`
      INSERT INTO pending_emails (message_id, uid, from_name, from_email, subject, body, snippet, received_at, status, flagged)
      VALUES ('no-from@x', '2', null, '', '(no subject)', '', '', '2026-06-15T00:00:00Z', 'pending', 0)
    `).run();
    const fetchUnread = (await import('../lib/email-inbox.js')).fetchUnread;
    fetchUnread.mockResolvedValueOnce([
      { messageId: 'no-from@x', uid: '2', from: 'Now Known', fromEmail: 'now@x.com', subject: 'Now known', body: 'b', snippet: 's', date: new Date('2026-06-15T00:00:00Z'), flagged: false },
    ]);
    await scanPendingEmails(db4, { since: new Date('2026-06-14'), includeStarred: true, limit: 10 });
    const row = db4.prepare("SELECT from_email, from_name, subject FROM pending_emails WHERE message_id='no-from@x'").get();
    expect(row.from_email).toBe('now@x.com');
    expect(row.from_name).toBe('Now Known');
    expect(row.subject).toBe('Now known');
  });

  it('matches an existing row by UID when message_id was stored as a UID (legacy orphan rows)', async () => {
    // Legacy rows from a prior code version stored the IMAP UID in `message_id`
    // (because the body fetch was skipped and we had no real <…@…> header).
    // A re-scan returns the real message-id header, so the lookup must fall
    // back to matching by uid — otherwise the row would never get backfilled.
    db4.prepare(`
      INSERT INTO pending_emails (message_id, uid, from_name, from_email, subject, body, snippet, received_at, status, flagged)
      VALUES ('99', '99', null, '', '(older — no body fetched)', '', '', '2026-06-15T00:00:00Z', 'pending', 0)
    `).run();
    const fetchUnread = (await import('../lib/email-inbox.js')).fetchUnread;
    fetchUnread.mockResolvedValueOnce([
      { messageId: '<real-header-99@x>', uid: 99, from: 'Recovered Sender', fromEmail: 'recovered@x.com', subject: 'Real subject recovered', body: 'b', snippet: 's', date: new Date('2026-06-15T00:00:00Z'), flagged: true },
    ]);
    await scanPendingEmails(db4, { since: new Date('2026-06-14'), includeStarred: true, limit: 10 });
    const row = db4.prepare("SELECT from_email, from_name, subject, message_id, flagged FROM pending_emails WHERE uid='99'").get();
    expect(row.from_email).toBe('recovered@x.com');
    expect(row.from_name).toBe('Recovered Sender');
    expect(row.subject).toBe('Real subject recovered');
    expect(row.message_id).toBe('<real-header-99@x>'); // upgraded to real header
    expect(row.flagged).toBe(1);
  });

  it('does not overwrite existing real data', async () => {
    db4.prepare(`
      INSERT INTO pending_emails (message_id, uid, from_name, from_email, subject, body, snippet, received_at, status, flagged)
      VALUES ('has-data@x', '3', 'Original', 'orig@x.com', 'Original subject', 'b', 's', '2026-06-15T00:00:00Z', 'pending', 1)
    `).run();
    const fetchUnread = (await import('../lib/email-inbox.js')).fetchUnread;
    fetchUnread.mockResolvedValueOnce([
      { messageId: 'has-data@x', uid: '3', from: 'New Sender', fromEmail: 'new@x.com', subject: 'New subject', body: 'b', snippet: 's', date: new Date('2026-06-15T00:00:00Z'), flagged: false },
    ]);
    await scanPendingEmails(db4, { since: new Date('2026-06-14'), includeStarred: true, limit: 10 });
    const row = db4.prepare("SELECT from_email, from_name, subject, flagged FROM pending_emails WHERE message_id='has-data@x'").get();
    expect(row.from_email).toBe('orig@x.com'); // not overwritten
    expect(row.from_name).toBe('Original');
    expect(row.subject).toBe('Original subject');
    expect(row.flagged).toBe(1); // not downgraded
  });
});
