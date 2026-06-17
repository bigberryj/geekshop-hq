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
import { findContactMatch } from './google-contacts.js';
import { classifyEmail, scoreEmail, isAgentMail } from './junk-classifier.js';
import { persistAttachment, deleteAttachment, readAttachmentBuffer, sanitizeEmailHtml } from './attachments.js';

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
  // Default ON: auto-dismiss obvious junk during scan. Set false to
  // disable (e.g. for batch reprocessing or testing).
  autoDismissJunk = true,
} = {}) {
  if (!(since instanceof Date)) since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const cappedLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const messages = await fetchUnread({ since, until, includeStarred, limit: cappedLimit });
  const result = {
    fetched: messages.length,
    inserted: 0,
    auto_dismissed: 0,
    skipped_existing: 0,
    errors: [],
    window: { since: since.toISOString(), until: until ? until.toISOString() : null, includeStarred, limit: cappedLimit },
  };

  // Pre-load the set of customer emails so the classifier can keep
  // existing-customer emails out of the auto-dismiss bucket.
  const customerEmails = new Set(
    db.prepare("SELECT email FROM customers WHERE email IS NOT NULL AND email != ''").all().map((r) => r.email.toLowerCase())
  );
  // Pre-load moderation settings (junk override lists + agent mailbox)
  // so the same rules the backfill uses are applied during a live scan.
  const moderationSettings = readModerationSettings(db);

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
      // Classify before inserting. If the classifier says auto-dismiss,
      // we insert with status='dismissed' and a dismissed_by='auto_junk'.
      // Existing customers, real humans with personal subjects, and
      // first-touch potential clients are protected by the rules.
      const classification = autoDismissJunk
        ? await classifyEmail({
            fromName: m.from,
            fromEmail: m.fromEmail,
            subject: m.subject,
            body: m.body,
          }, { customerEmails, settings: moderationSettings })
        : { shouldDismiss: false, score: 0, signals: ['auto_dismiss_disabled'], reason: 'auto-dismiss off', classifiedBy: 'rules' };

      const isAutoJunk = classification.shouldDismiss;
      const status = isAutoJunk ? 'dismissed' : 'pending';
      const dismissedBy = isAutoJunk ? (classification.classifiedBy === 'llm' ? 'auto_ai' : 'auto_junk') : null;

      db.prepare(`
        INSERT INTO pending_emails (message_id, uid, from_name, from_email, subject, body, snippet, received_at, status, flagged, dismissed_by, dismissed_reason, classification)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        m.messageId,
        String(m.uid || ''),
        m.from || null,
        m.fromEmail || null,
        m.subject || '(no subject)',
        m.body || '',
        m.snippet || '',
        m.date ? new Date(m.date).toISOString() : null,
        status,                          // col 9: status
        m.flagged ? 1 : 0,                // col 10: flagged
        dismissedBy,                      // col 11: dismissed_by
        isAutoJunk ? classification.reason : null,  // col 12: dismissed_reason
        JSON.stringify({ score: classification.score, signals: classification.signals, classified_by: classification.classifiedBy, classified_at: new Date().toISOString() }),  // col 13: classification
      );
      const pendingId = db.prepare('SELECT last_insert_rowid() AS id').get().id;

      // Persist any attachments to disk + DB. We do this only for
      // non-auto-junk rows because auto-dismissed mail gets deleted
      // (along with its files) on the next sweep. Inline images that
      // make it into the queue will be picked up by the preview + import
      // path; oversized or unsupported attachments are silently skipped
      // (logged, never thrown — the scan should never break on a
      // malformed attachment).
      if (!isAutoJunk && Array.isArray(m.attachments) && m.attachments.length) {
        const insertAttach = db.prepare(`
          INSERT INTO pending_email_attachments (pending_email_id, filename, mime_type, size_bytes, content_id, disposition, storage_path)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const a of m.attachments) {
          if (!a || !a.buffer) continue;
          try {
            const persisted = persistAttachment({
              scope: 'pending',
              rowId: pendingId,
              filename: a.filename,
              mimeType: a.mimeType,
              buffer: a.buffer,
              contentId: a.contentId,
              disposition: a.disposition,
            });
            insertAttach.run(
              pendingId,
              persisted.filename,
              persisted.mimeType,
              persisted.sizeBytes,
              persisted.contentId,
              persisted.disposition,
              persisted.storagePath,
            );
          } catch (e) {
            console.warn('[inbox] attachment skipped', a.filename, e.message);
          }
        }
      }
      if (isAutoJunk) {
        result.auto_dismissed += 1;
        db.prepare("INSERT INTO audit_log (actor, action, target, payload) VALUES ('auto', 'pending_email.auto_dismiss', ?, ?)")
          .run(m.messageId, JSON.stringify({ from: m.fromEmail, subject: m.subject, score: classification.score, reason: classification.reason, classified_by: classification.classifiedBy }));
      } else {
        result.inserted += 1;
      }
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
    return { ticket: db.prepare('SELECT * FROM tickets WHERE id = ?').get(row.imported_ticket_id), customer: null, already_imported: true, contactMatch: null };
  }
  if (row.status === 'dismissed') throw new Error('pending email was dismissed');

  // On-demand body fetch from Gmail. The original scan only pulled
  // bodies for the 25 most recent messages, so anything older (or
  // anything where the first fetch failed) needs this re-pull.
  // The re-pull returns the full body, html, AND attachments — we
  // persist all three so the imported ticket page can render the
  // email exactly as it looked in Gmail (with inline images etc).
  let body = row.body;
  let bodyHtml = null;
  let liveAttachments = null; // array, when re-pulled from Gmail
  if (row.message_id) {
    try {
      const full = await fetchByMessageId(row.message_id);
      if (full && (full.body || full.html || full.subject || Array.isArray(full.attachments))) {
        // If the pending row already had a full text body, keep it as the
        // canonical plain-text import body. We still re-pull Gmail to capture
        // HTML/attachments for rich rendering, but we must not overwrite a
        // known-good body with a later mock/fallback fetch result.
        if (!body && (full.body || full.subject)) {
          body = full.body || full.subject;
        }
        bodyHtml = full.html || null;
        liveAttachments = Array.isArray(full.attachments) ? full.attachments : null;
        // Persist the body so subsequent previews / re-imports don't
        // re-hit Gmail, but only fill blanks.
        if (!row.body && full.body) {
          db.prepare(`
            UPDATE pending_emails
            SET body = ?, snippet = ?
            WHERE id = ?
          `).run(
            full.body || '',
            (full.body || full.subject || '').slice(0, 200).replace(/\s+/g, ' ').trim(),
            pendingId
          );
        }
      }
    } catch (e) {
      console.warn('[inbox] on-demand body fetch failed:', e.message);
    }
  }

  // Reply-merge path. Before creating a brand-new ticket, ask the
  // matcher whether this Gmail message is a reply to an existing
  // open ticket for the same customer. If so, append the message to
  // that ticket, mark the Gmail message read, mark the pending row
  // imported, and return — the new-ticket path is skipped entirely.
  // This keeps the manual "Import" button behaviour identical to the
  // poller's auto-append behaviour.
  if (row.message_id) {
    try {
      const { matchReplyToTicket, markImportedRead } = await import('./replies.js');
      const matcherMsg = {
        messageId: row.message_id,
        fromEmail: row.from_email,
        from: row.from_name,
        subject: row.subject,
        body,
        html: bodyHtml,
        attachments: liveAttachments,
        date: row.received_at ? new Date(row.received_at) : new Date(),
      };
      const matched = await matchReplyToTicket(db, matcherMsg);
      if (matched) {
        if (!matched.already_appended) {
          // Mark Gmail message read. Best-effort; never throws.
          markImportedRead(row.message_id).catch(() => {});
        }
        // Always flip the pending row to imported (whether we just
        // appended it via the matcher, or a previous run already
        // appended it). This prevents the new-ticket path from
        // duplicating the message on the existing ticket.
        db.prepare("UPDATE pending_emails SET status='imported', imported_ticket_id=?, decided_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(matched.ticket_id, pendingId);
        db.prepare("INSERT INTO audit_log (actor, action, target, payload) VALUES ('admin', ?, ?, ?)")
          .run(
            matched.already_appended ? 'pending_email.reply_already_appended' : 'pending_email.reply_merged',
            String(matched.ticket_id),
            JSON.stringify({ pending_id: pendingId, from_email: row.from_email, source: matched.source }),
          );
        const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(matched.ticket_id);
        return {
          ticket,
          customer: null,
          already_imported: matched.already_appended,
          contactMatch: null,
          ...(matched.already_appended ? {} : { merged_into_existing: true }),
        };
      }
    } catch (e) {
      console.warn('[inbox] reply matcher on import failed:', e.message);
      // fall through to the new-ticket path
    }
  }

  const customer = findOrCreateCustomer(db, { email: row.from_email, name: row.from_name });
  const uid = nextTicketUid(db);
  const tInfo = db.prepare(`
    INSERT INTO tickets (ticket_uid, customer_id, subject, priority, source, source_message_id, last_message_at)
    VALUES (?, ?, ?, 'normal', 'email', ?, CURRENT_TIMESTAMP)
  `).run(uid, customer.id, row.subject, row.message_id);
  const ticketId = tInfo.lastInsertRowid;

  // Insert the customer message. body_html is null if Gmail was
  // unreachable OR if the email was plain-text only. The UI shows
  // `body` (text) when body_html is null and a sandboxed iframe of
  // body_html when present.
  const msgInfo = db.prepare(`
    INSERT INTO ticket_messages (ticket_id, sender, body, body_html, subject)
    VALUES (?, 'customer', ?, ?, ?)
  `).run(ticketId, body || row.snippet || row.subject, bodyHtml, row.subject);
  const messageId = msgInfo.lastInsertRowid;
  // Persist attachments. Two sources:
  //   1. liveAttachments — if we just re-pulled from Gmail. These are
  //      the source of truth; ignore any pending_email_attachments
  //      rows that already exist (they're stale envelopes).
  //   2. pending_email_attachments — anything the original scan
  //      captured. Use these when no live re-pull happened.
  const liveAttachInsert = db.prepare(`
    INSERT INTO ticket_message_attachments (ticket_message_id, filename, mime_type, size_bytes, content_id, disposition, storage_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  if (liveAttachments && liveAttachments.length) {
    // Wipe the old envelope-only rows first.
    const oldRows = db.prepare('SELECT storage_path FROM pending_email_attachments WHERE pending_email_id = ?').all(pendingId);
    for (const r of oldRows) deleteAttachment(r.storage_path);
    db.prepare('DELETE FROM pending_email_attachments WHERE pending_email_id = ?').run(pendingId);
    for (const a of liveAttachments) {
      if (!a || !a.buffer) continue;
      try {
        const persisted = persistAttachment({
          scope: 'tickets',
          rowId: ticketId,
          filename: a.filename,
          mimeType: a.mimeType,
          buffer: a.buffer,
          contentId: a.contentId,
          disposition: a.disposition,
        });
        liveAttachInsert.run(
          messageId,
          persisted.filename,
          persisted.mimeType,
          persisted.sizeBytes,
          persisted.contentId,
          persisted.disposition,
          persisted.storagePath,
        );
      } catch (e) {
        console.warn('[inbox] import: attachment skipped', a.filename, e.message);
      }
    }
  } else {
    // No live re-pull — copy the pending attachments into the ticket bucket.
    const pending = db.prepare(`
      SELECT filename, mime_type, size_bytes, content_id, disposition, storage_path
      FROM pending_email_attachments WHERE pending_email_id = ?
    `).all(pendingId);
    for (const a of pending) {
      try {
        const persisted = persistAttachment({
          scope: 'tickets',
          rowId: ticketId,
          filename: a.filename,
          mimeType: a.mimeType,
          // Re-persist from the existing on-disk file. We re-read it
          // here so the same content lives under tickets/ too —
          // simpler than a "move" because the on-demand path also
          // writes back to pending/ on a re-import.
          buffer: readAttachmentBuffer(a.storage_path),
          contentId: a.content_id,
          disposition: a.disposition,
        });
        liveAttachInsert.run(
          messageId,
          persisted.filename,
          persisted.mimeType,
          persisted.sizeBytes,
          persisted.contentId,
          persisted.disposition,
          persisted.storagePath,
        );
      } catch (e) {
        console.warn('[inbox] import: attachment copy failed', a.filename, e.message);
      }
    }
  }

  // Sanitize the imported body_html and rewrite cid: image references
  // to our /api/attachments/:id/raw route so inline graphics render
  // inside the ticket page's sandboxed iframe. We re-write the row
  // with the sanitized HTML so the ticket page can render it directly
  // without re-sanitizing at request time.
  if (bodyHtml) {
    const cidMap = new Map();
    for (const a of db.prepare(`
      SELECT id, content_id FROM ticket_message_attachments
      WHERE ticket_message_id = ? AND content_id IS NOT NULL
    `).all(messageId)) {
      const cleanCid = String(a.content_id).replace(/^<|>$/g, '');
      if (cleanCid) cidMap.set(cleanCid, a.id);
    }
    const sanitized = sanitizeEmailHtml(bodyHtml, (cid) => cidMap.get(cid) || null);
    db.prepare('UPDATE ticket_messages SET body_html = ? WHERE id = ?')
      .run(sanitized, messageId);
    bodyHtml = sanitized;
  }

  db.prepare("UPDATE pending_emails SET status='imported', imported_ticket_id=?, decided_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(ticketId, pendingId);
  db.prepare("INSERT INTO audit_log (actor, action, target, payload) VALUES ('admin', 'pending_email.import', ?, ?)")
    .run(String(ticketId), JSON.stringify({ pending_id: pendingId, from_email: row.from_email }));
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);

  // Mark Gmail message read. Best-effort; never throws, never blocks
  // the import. This keeps the inbox visually in sync with what we've
  // already imported into the dashboard.
  if (row.message_id) {
    try {
      const { markImportedRead } = await import('./replies.js');
      // Don't await — the response should return to the user ASAP.
      markImportedRead(row.message_id).catch(() => {});
    } catch { /* lib not loaded yet — non-fatal */ }
  }

  // Look up the sender in Google Contacts so the admin can pre-populate
  // missing customer fields (phone, company, address). Best-effort:
  // never throws, never blocks the import. Returns `contactMatch: null`
  // if the lookup wasn't possible / no hit, in which case the UI just
  // skips the enrichment modal.
  let contactMatch = null;
  try {
    contactMatch = await findContactMatch({
      email: row.from_email,
      name: row.from_name,
      existingCustomer: customer,
    });
  } catch (e) {
    console.warn('[inbox] contact lookup failed:', e.message);
  }

  return { ticket, customer, already_imported: false, contactMatch };
}

export function dismissPendingEmail(db, pendingId) {
  const row = db.prepare('SELECT * FROM pending_emails WHERE id = ?').get(pendingId);
  if (!row) throw new Error('pending email not found');
  if (row.status !== 'pending') throw new Error(`cannot dismiss ${row.status} email`);
  db.prepare("UPDATE pending_emails SET status='dismissed', dismissed_by='user', dismissed_at=CURRENT_TIMESTAMP, decided_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(pendingId);
  db.prepare("INSERT INTO audit_log (actor, action, target) VALUES ('admin', 'pending_email.dismiss', ?)").run(String(pendingId));
  return { ok: true };
}

/**
 * Bulk-dismiss multiple pending emails. Whitelists the dismiss path: any
 * ID that doesn't exist or isn't 'pending' is skipped (not an error).
 * Returns counts so the UI can show "dismissed 5 of 7".
 */
export function bulkDismissPendingEmails(db, pendingIds) {
  if (!Array.isArray(pendingIds) || pendingIds.length === 0) {
    return { requested: 0, dismissed: 0, skipped: 0, errors: [] };
  }
  const ids = pendingIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return { requested: pendingIds.length, dismissed: 0, skipped: 0, errors: [] };

  const check = db.prepare(`SELECT id, status FROM pending_emails WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const found = new Map(check.map((r) => [r.id, r.status]));
  const dismissable = ids.filter((id) => found.get(id) === 'pending');
  const skipped = ids.length - dismissable.length;

  if (dismissable.length > 0) {
    db.prepare(`UPDATE pending_emails SET status='dismissed', dismissed_by='user', dismissed_at=CURRENT_TIMESTAMP, decided_at=CURRENT_TIMESTAMP WHERE id IN (${dismissable.map(() => '?').join(',')})`)
      .run(...dismissable);
    db.prepare(`INSERT INTO audit_log (actor, action, target, payload) VALUES ('admin', 'pending_email.bulk_dismiss', NULL, ?)`)
      .run(JSON.stringify({ ids: dismissable, count: dismissable.length }));
  }
  return { requested: ids.length, dismissed: dismissable.length, skipped, errors: [] };
}

/**
 * Restore a dismissed email back to pending. Used by the "Restore" button
 * on the "Show dismissed" view. Logs the action so we have an audit trail
 * of mistakes (and corrections).
 */
export function restorePendingEmail(db, pendingId) {
  const row = db.prepare('SELECT * FROM pending_emails WHERE id = ?').get(pendingId);
  if (!row) throw new Error('pending email not found');
  if (row.status !== 'dismissed') throw new Error(`cannot restore ${row.status} email — only dismissed rows can be restored`);
  db.prepare("UPDATE pending_emails SET status='pending', dismissed_by=NULL, dismissed_reason=NULL, dismissed_at=NULL, decided_at=NULL WHERE id=?")
    .run(pendingId);
  db.prepare("INSERT INTO audit_log (actor, action, target, payload) VALUES ('admin', 'pending_email.restore', ?, ?)")
    .run(String(pendingId), JSON.stringify({ was_dismissed_by: row.dismissed_by, reason: row.dismissed_reason }));
  return { ok: true };
}

export function listPendingEmails(db, { status = 'pending', limit = 50, offset = 0, since, until } = {}) {
  // Optional date filtering: the list can be restricted to a window without
  // re-running the scan. The scan window is the "what we asked Gmail for";
  // this list window is "what we're looking at right now".
  // `status` can be a string (single status) or array of statuses.
  let sql = `
    SELECT id, message_id, uid, from_name, from_email, subject, snippet, received_at, status, imported_ticket_id, fetched_at, flagged, dismissed_by, dismissed_reason, classification
    FROM pending_emails
    WHERE 1=1
  `;
  const args = [];
  if (Array.isArray(status)) {
    if (status.length === 0) return [];
    sql += ` AND status IN (${status.map(() => '?').join(',')})`;
    args.push(...status);
  } else if (status) {
    sql += ' AND status = ?';
    args.push(status);
  }
  if (since) { sql += ' AND received_at >= ?'; args.push(since); }
  if (until) { sql += ' AND received_at <= ?'; args.push(until); }
  // Newest email at the top. `received_at` is the email's actual send time;
  // `id DESC` breaks ties when multiple rows share a second (common with
  // batched IMAP fetches) so the ordering is fully deterministic.
  sql += ' ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?';
  args.push(limit, offset);
  return db.prepare(sql).all(...args);
}

/**
 * List attachments for a pending email. Returns [{ id, filename,
 * mime_type, size_bytes, content_id, disposition }] without the
 * raw bytes (those are served via /raw on a separate request).
 */
export function listPendingAttachments(db, pendingId) {
  return db.prepare(`
    SELECT id, filename, mime_type, size_bytes, content_id, disposition
    FROM pending_email_attachments
    WHERE pending_email_id = ?
    ORDER BY id ASC
  `).all(pendingId);
}

/**
 * Read the moderation settings (junk classifier overrides + agent
 * mailbox) from the `settings` table and return them in a shape
 * scoreEmail() / isAgentMail() understand. Single source of truth so
 * the classifier never reads the DB directly.
 */
export function readModerationSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    auto_dismiss_domains: map.auto_dismiss_domains || '',
    auto_keep_subjects: map.auto_keep_subjects || '',
    agent_mailbox_from: map.agent_mailbox_from || 'johnn5wizbot@gmail.com',
  };
}

/**
 * Backfill classification on all pending rows that don't yet have one
 * (`classification IS NULL` or empty). Byron-iter 2026-06-16: the
 * classifier was wired into `scanPendingEmails` after the existing 554
 * rows were inserted, so they have null classification. This is the
 * catch-up pass.
 *
 * For each row:
 *   - run scoreEmail() (rules only, no LLM cost — this is a one-shot
 *     admin action, not a hot path)
 *   - if the score is >= `dismiss_threshold` (default 0.8), auto-dismiss
 *     the row (status='dismissed', dismissed_by='auto_junk', reason=
 *     the classifier's reason text). Writes audit_log.
 *   - always persist the classification JSON so future audits can
 *     see what the rules thought.
 *
 * Options:
 *   dismiss_threshold: number (default 0.8) — only auto-dismiss rows
 *     scoring at or above this. Use a higher value for more conservative
 *     backfill, lower to be more aggressive. Even rows below the
 *     threshold get their classification persisted.
 *   status: 'pending' | 'all' (default 'pending') — which rows to
 *     re-classify. 'all' also re-classifies already-dismissed rows
 *     (useful after tuning the rules).
 *   limit: number (default Infinity) — safety cap. Big DBs may want
 *     to backfill in batches.
 *
 * Returns:
 *   { examined, classified, dismissed, skipped, threshold, samples }
 *     - examined: total rows looked at
 *     - classified: rows that had a fresh classification computed
 *     - dismissed: rows newly auto-dismissed by this pass
 *     - skipped: rows that already had classification (and were not
 *       touched unless `status === 'all'`)
 *     - threshold: the threshold used
 *     - samples: up to 25 (subject, from, score, signals) examples
 *       for the audit log / admin review
 */
export function backfillClassifyPendingEmails(db, { dismiss_threshold = 0.8, status = 'pending', limit = Infinity } = {}) {
  const settings = readModerationSettings(db);
  const customerEmails = new Set(
    db.prepare("SELECT email FROM customers WHERE email IS NOT NULL AND email != ''").all().map((r) => r.email.toLowerCase())
  );

  // Pick the candidate rows. Two cases:
  //  - status='pending' (default): only pending rows, only those with
  //    NULL/empty classification (so we don't redo work).
  //  - status='all': re-classify every row, including already-dismissed.
  let sql = `SELECT id, message_id, COALESCE(from_name,'') AS from_name, COALESCE(from_email,'') AS from_email, COALESCE(subject,'') AS subject, COALESCE(body,'') AS body, COALESCE(snippet,'') AS snippet, COALESCE(classification,'') AS classification, status FROM pending_emails`;
  const args = [];
  if (status === 'pending') {
    sql += ` WHERE status = 'pending' AND (classification IS NULL OR classification = '')`;
  }
  sql += ` ORDER BY id ASC LIMIT ?`;
  args.push(Number.isFinite(limit) ? limit : 1_000_000);

  const candidates = db.prepare(sql).all(...args);
  const result = { examined: candidates.length, classified: 0, dismissed: 0, skipped: 0, threshold: dismiss_threshold, samples: [] };

  const updateStmt = db.prepare(`
    UPDATE pending_emails
    SET classification = ?
    WHERE id = ?
  `);
  const dismissStmt = db.prepare(`
    UPDATE pending_emails
    SET status = 'dismissed',
        dismissed_by = 'auto_junk',
        dismissed_reason = ?,
        dismissed_at = CURRENT_TIMESTAMP,
        decided_at = COALESCE(decided_at, CURRENT_TIMESTAMP),
        classification = ?
    WHERE id = ?
  `);
  const auditStmt = db.prepare(`
    INSERT INTO audit_log (actor, action, target, payload)
    VALUES ('auto', 'pending_email.backfill_classify', ?, ?)
  `);

  for (const r of candidates) {
    const classification = scoreEmail(
      {
        fromName: r.from_name,
        fromEmail: r.from_email,
        subject: r.subject,
        body: r.body,
      },
      { customerEmails, settings }
    );
    const json = JSON.stringify({
      score: classification.score,
      signals: classification.signals,
      classified_by: 'rules',
      classified_at: new Date().toISOString(),
    });
    if (classification.shouldDismiss && r.status === 'pending') {
      dismissStmt.run(classification.reason, json, r.id);
      auditStmt.run(String(r.id), JSON.stringify({
        from: r.from_email,
        subject: r.subject,
        score: classification.score,
        signals: classification.signals,
        threshold: dismiss_threshold,
        reason: classification.reason,
      }));
      result.dismissed += 1;
    } else {
      updateStmt.run(json, r.id);
    }
    result.classified += 1;
    if (result.samples.length < 25) {
      result.samples.push({
        id: r.id,
        from_email: r.from_email,
        subject: r.subject,
        score: classification.score,
        should_dismiss: classification.shouldDismiss,
        signals: classification.signals,
      });
    }
  }
  return result;
}

/**
 * Returns true if a pending row's from_email is in the agent mailbox
 * settings list. Thin wrapper so the UI doesn't import the settings
 * table directly.
 */
export function pendingEmailIsAgentMail(db, row) {
  return isAgentMail(row?.from_email || '', readModerationSettings(db));
}

export { inboxConfig };
