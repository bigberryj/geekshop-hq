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

import { fetchUnread, fetchByMessageId, inboxConfig } from './email-inbox.js';

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
 * Insert unread + (optionally) starred Gmail messages into the queue. Returns counts:
 *   { fetched, inserted, skipped_existing, errors, window }
 *
 * Options:
 *   - since:     Date   earliest message date to include. Default = now - 24h.
 *   - until:     Date   latest message date to include. Default = no upper bound.
 *   - includeStarred: boolean  if true (default), also pull messages with the
 *                      \Flagged IMAP flag, even if read. Used by the manual
 *                      "Scan Gmail now" button.
 *   - limit:     number max messages to fetch. Default 25. Hard cap 100.
 */
export async function scanPendingEmails(db, {
  since,
  until,
  includeStarred = true,
  limit = 25,
} = {}) {
  if (!(since instanceof Date)) since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const cappedLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const messages = await fetchUnread({ since, until, includeStarred, limit: cappedLimit });
  const result = {
    fetched: messages.length,
    inserted: 0,
    skipped_existing: 0,
    errors: [],
    window: { since: since.toISOString(), until: until ? until.toISOString() : null, includeStarred, limit: cappedLimit },
  };
  for (const m of messages) {
    try {
      // Match by message-id header first, then fall back to UID.
      // Some older rows were inserted with the IMAP UID stored as their
      // `message_id` (because the body fetch was skipped and we had no
      // real header). Those rows would never match a re-scan by message-id
      // because the new scan returns the real <…@…> header. The UID match
      // lets the backfill repair them. After backfill we update message_id
      // to the real header so future scans match cleanly.
      const existing = db.prepare(`
        SELECT id, flagged, from_email, from_name, subject, message_id, uid
        FROM pending_emails
        WHERE message_id = ? OR (uid = ? AND uid != '')
        ORDER BY id DESC LIMIT 1
      `).get(m.messageId, String(m.uid || ''));
      if (existing) {
        // Backfill any fields that are now known but weren't when the row
        // was first inserted. Common case: an older row had no body so no
        // from/subject, then the user re-scanned with starred=on and we
        // happened to fetch metadata for the same message. We only fill
        // empty fields, never overwrite real data.
        const updates = [];
        const params = [];
        if (!existing.from_email && m.fromEmail) { updates.push('from_email = ?'); params.push(m.fromEmail); }
        if (!existing.from_name && m.from) { updates.push('from_name = ?'); params.push(m.from); }
        // Backfill subject if missing OR if it's a stale placeholder from a
        // prior scan version (e.g. "(older — no body fetched)" before we
        // captured envelope metadata).
        const staleSubject = !existing.subject || existing.subject === '(no subject)' || /no body fetched/i.test(existing.subject);
        if (staleSubject && m.subject && m.subject !== '(no subject)') { updates.push('subject = ?'); params.push(m.subject); }
        if (m.flagged && !existing.flagged) { updates.push('flagged = 1'); }
        // Backfill snippet when it's still the legacy placeholder. The new
        // fetch always produces a real snippet (truncated body or subject).
        const staleSnippet = !existing.snippet || /no body fetched/i.test(existing.snippet);
        if (staleSnippet && m.snippet) { updates.push('snippet = ?'); params.push(m.snippet); }
        // If the row was originally inserted with a UID in message_id, swap
        // it to the real message-id header now that we have it. This lets
        // future scans match cleanly by message_id.
        if (existing.message_id !== m.messageId && m.messageId && !String(m.messageId).match(/^\d+$/)) {
          updates.push('message_id = ?');
          params.push(m.messageId);
        }
        if (updates.length) {
          params.push(existing.id);
          db.prepare(`UPDATE pending_emails SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        }
        result.skipped_existing += 1;
        continue;
      }
      db.prepare(`
        INSERT INTO pending_emails (message_id, uid, from_name, from_email, subject, body, snippet, received_at, status, flagged)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        m.messageId,
        String(m.uid || ''),
        m.from || null,
        m.fromEmail || null,
        m.subject || '(no subject)',
        m.body || '',
        m.snippet || '',
        m.date ? new Date(m.date).toISOString() : null,
        m.flagged ? 1 : 0,
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
 *
 * Async because if the pending row has no body stored (because the scan
 * skipped body fetch for messages beyond the 25 most recent), we re-fetch
 * the body from Gmail on demand. This keeps scan times fast without
 * sacrificing import fidelity.
 */
export async function importPendingEmail(db, pendingId) {
  const row = db.prepare('SELECT * FROM pending_emails WHERE id = ?').get(pendingId);
  if (!row) throw new Error('pending email not found');
  if (row.status === 'imported') {
    return { ticket: db.prepare('SELECT * FROM tickets WHERE id = ?').get(row.imported_ticket_id), customer: null, already_imported: true };
  }
  if (row.status === 'dismissed') throw new Error('pending email was dismissed');

  // Fetch body from Gmail on demand if we don't have it. Fall back to
  // snippet/subject gracefully if Gmail is down.
  let body = row.body;
  if (!body && row.message_id) {
    try {
      const full = await fetchByMessageId(row.message_id);
      if (full && (full.body || full.subject)) {
        body = full.body || full.subject;
        // Persist for next time (in case the import is undone somehow)
        db.prepare('UPDATE pending_emails SET body = ?, snippet = ? WHERE id = ?')
          .run(full.body || '', (full.body || full.subject || '').slice(0, 200).replace(/\s+/g, ' ').trim(), pendingId);
      }
    } catch (e) {
      console.warn('[inbox] on-demand body fetch failed:', e.message);
    }
  }

  const customer = findOrCreateCustomer(db, { email: row.from_email, name: row.from_name });
  const uid = nextTicketUid(db);
  const tInfo = db.prepare(`
    INSERT INTO tickets (ticket_uid, customer_id, subject, priority, source, source_message_id, last_message_at)
    VALUES (?, ?, ?, 'normal', 'email', ?, CURRENT_TIMESTAMP)
  `).run(uid, customer.id, row.subject, row.message_id);
  db.prepare(`
    INSERT INTO ticket_messages (ticket_id, sender, body) VALUES (?, 'customer', ?)
  `).run(tInfo.lastInsertRowid, body || row.snippet || row.subject);
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

export function listPendingEmails(db, { status = 'pending', limit = 50, offset = 0, since, until } = {}) {
  // Optional date filtering: the list can be restricted to a window without
  // re-running the scan. The scan window is the "what we asked Gmail for";
  // this list window is "what we're looking at right now".
  let sql = `
    SELECT id, message_id, uid, from_name, from_email, subject, snippet, received_at, status, imported_ticket_id, fetched_at, flagged
    FROM pending_emails
    WHERE status = ?
  `;
  const args = [status];
  if (since) { sql += ' AND received_at >= ?'; args.push(since); }
  if (until) { sql += ' AND received_at <= ?'; args.push(until); }
  // Newest email at the top. `received_at` is the email's actual send time;
  // `id DESC` breaks ties when multiple rows share a second (common with
  // batched IMAP fetches) so the ordering is fully deterministic.
  sql += ' ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?';
  args.push(limit, offset);
  return db.prepare(sql).all(...args);
}

export { inboxConfig };
