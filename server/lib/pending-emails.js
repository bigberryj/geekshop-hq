/**
 * Gmail moderation queue.
 *
 * The "happy path" is no longer auto-import. Instead, the poller (or a manual
 * scan) inserts new Gmail messages into `pending_emails` with status='pending'.
 * The admin then reviews them in the Inbox UI and either imports or dismisses.
 *
 * Customers are auto-created at import time when missing, but only after
 * the admin has chosen to import.
 */

import { fetchUnread, inboxConfig } from './email-inbox.js';

function findOrCreateCustomer(db, { email, name }) {
  if (email) {
    const existing = db.prepare('SELECT * FROM customers WHERE email = ?').get(email);
    if (existing) return existing;
  }
  const info = db.prepare(`
    INSERT INTO customers (name, email) VALUES (?, ?)
  `).run(name || email?.split('@')[0] || 'Unknown', email || null);
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
}

function nextTicketUid(db) {
  const last = db.prepare("SELECT ticket_uid FROM tickets ORDER BY id DESC LIMIT 1").get();
  const n = last ? Number(last.ticket_uid.split('-')[1]) + 1 : 1;
  return `G-${String(n).padStart(6, '0')}`;
}

/**
 * Insert unread Gmail messages into the queue. Returns counts:
 *   { fetched, inserted, skipped_existing, errors }
 */
export async function scanPendingEmails(db, { limit = 25 } = {}) {
  const messages = await fetchUnread(limit);
  const result = { fetched: messages.length, inserted: 0, skipped_existing: 0, errors: [] };
  for (const m of messages) {
    try {
      const existing = db.prepare('SELECT id FROM pending_emails WHERE message_id = ?').get(m.messageId);
      if (existing) { result.skipped_existing += 1; continue; }
      db.prepare(`
        INSERT INTO pending_emails (message_id, uid, from_name, from_email, subject, body, snippet, received_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `).run(
        m.messageId,
        String(m.uid || ''),
        m.from || null,
        m.fromEmail || null,
        m.subject || '(no subject)',
        m.body || '',
        m.snippet || '',
        m.date ? new Date(m.date).toISOString() : null,
      );
      result.inserted += 1;
    } catch (e) {
      result.errors.push({ messageId: m.messageId, error: e.message });
    }
  }
  return result;
}

/**
 * One-shot "do the moderation step" function used by the import route.
 * Returns { ticket, customer } so the route can return the new ticket id.
 */
export function importPendingEmail(db, pendingId) {
  const row = db.prepare('SELECT * FROM pending_emails WHERE id = ?').get(pendingId);
  if (!row) throw new Error('pending email not found');
  if (row.status === 'imported') {
    return { ticket: db.prepare('SELECT * FROM tickets WHERE id = ?').get(row.imported_ticket_id), customer: null, already_imported: true };
  }
  if (row.status === 'dismissed') throw new Error('pending email was dismissed');

  const customer = findOrCreateCustomer(db, { email: row.from_email, name: row.from_name });
  const uid = nextTicketUid(db);
  const tInfo = db.prepare(`
    INSERT INTO tickets (ticket_uid, customer_id, subject, priority, source, source_message_id, last_message_at)
    VALUES (?, ?, ?, 'normal', 'email', ?, CURRENT_TIMESTAMP)
  `).run(uid, customer.id, row.subject, row.message_id);
  db.prepare(`
    INSERT INTO ticket_messages (ticket_id, sender, body) VALUES (?, 'customer', ?)
  `).run(tInfo.lastInsertRowid, row.body || row.snippet || row.subject);
  db.prepare("UPDATE pending_emails SET status='imported', imported_ticket_id=?, decided_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(tInfo.lastInsertRowid, pendingId);
  db.prepare("INSERT INTO audit_log (actor, action, target, payload) VALUES ('admin', 'pending_email.import', ?, ?)")
    .run(String(tInfo.lastInsertRowid), JSON.stringify({ pending_id: pendingId, from_email: row.from_email }));
  return { ticket: db.prepare('SELECT * FROM tickets WHERE id = ?').get(tInfo.lastInsertRowid), customer, already_imported: false };
}

export function dismissPendingEmail(db, pendingId) {
  const row = db.prepare('SELECT * FROM pending_emails WHERE id = ?').get(pendingId);
  if (!row) throw new Error('pending email not found');
  if (row.status !== 'pending') throw new Error(`cannot dismiss ${row.status} email`);
  db.prepare("UPDATE pending_emails SET status='dismissed', decided_at=CURRENT_TIMESTAMP WHERE id=?").run(pendingId);
  db.prepare("INSERT INTO audit_log (actor, action, target) VALUES ('admin', 'pending_email.dismiss', ?)").run(String(pendingId));
  return { ok: true };
}

export function listPendingEmails(db, { status = 'pending', limit = 50 } = {}) {
  return db.prepare(`
    SELECT id, message_id, uid, from_name, from_email, subject, snippet, received_at, status, imported_ticket_id, fetched_at
    FROM pending_emails
    WHERE status = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(status, limit);
}

export { inboxConfig };
