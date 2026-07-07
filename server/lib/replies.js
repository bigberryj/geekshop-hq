/**
 * Reply matcher
 * -------------
 * When a new Gmail message lands, decide whether it is a reply to an
 * existing ticket thread. If yes, append it to the ticket and return
 * the ticket id so the caller can mark the Gmail message read. If no,
 * return null so the caller falls through to the pending queue.
 *
 * Matching strategy (in order, first hit wins):
 *
 *   1. Exact `tickets.source_message_id` match. The thread started by
 *      a specific Gmail message — any reply in that thread references
 *      the same Message-ID. We use the poller's enriched
 *      `msg.references` (parsed by mailparser) and the standard
 *      `In-Reply-To` header to detect this.
 *   2. Sender + subject match. The customer (matched by email) has an
 *      open ticket whose subject (after stripping `Re:`, `Fwd:`,
 *      whitespace) is contained in the new message's subject.
 *
 * The matcher is **idempotent**: if a `ticket_messages` row already
 * exists with the same `gmail_message_id`, we return that ticket and
 * flag `already_appended: true` so the caller knows the message has
 * been seen.
 *
 * No external deps. Pure DB.
 */

import { simpleParser } from 'mailparser';
import { fetchByMessageId, markRead } from './email-inbox.js';
import { persistAttachment, readAttachmentBuffer } from './attachments.js';

const RE_FWD = /^\s*(re|fwd|fw)\s*:\s*/i;
const MAX_AUTOLINK_SUBJECT_LEN = 200;

function stripReFwd(subject) {
  if (!subject) return '';
  let s = String(subject);
  // Strip up to 5 Re:/Fwd: prefixes in case of "Re: Fwd: Re: ...".
  for (let i = 0; i < 5; i++) {
    if (RE_FWD.test(s)) s = s.replace(RE_FWD, '');
    else break;
  }
  return s.trim().toLowerCase();
}

function stripQuotedReplyBody(body) {
  if (!body) return '';
  // Gmail-style replies prefix the new content; the rest is the
  // quoted history. We keep the new content for matching but we
  // only use it for body text, not for the matcher itself.
  return String(body);
}

/**
 * Match a Gmail message against existing open tickets.
 *
 * Input: `msg` is the shape returned by fetchUnread/fetchByMessageId:
 *   { messageId, from, fromEmail, subject, date, body, html, attachments, uid, flagged }
 *
 * Returns one of:
 *   { ticket_id, source: 'thread'|'sender_subject', already_appended: boolean }
 *   null when no match
 */
export async function matchReplyToTicket(db, msg) {
  if (!msg || !msg.messageId) return null;
  const fromEmail = (msg.fromEmail || msg.from_email || '').toLowerCase();
  if (!fromEmail) return null;

  // Idempotency: if this message already produced a ticket_message
  // somewhere, return that ticket id and tell the caller to skip.
  const existing = db.prepare(
    'SELECT ticket_id FROM ticket_messages WHERE gmail_message_id = ?'
  ).get(msg.messageId);
  if (existing) {
    return { ticket_id: existing.ticket_id, source: 'thread', already_appended: true };
  }

  // Strategy 1: thread match by source_message_id of any open ticket.
  // We accept any of the message's In-Reply-To / References headers
  // as a match against tickets.source_message_id. Soft-deleted tickets
  // are excluded — a deleted thread shouldn't auto-reopen on the next
  // customer reply. (The customer can still send a new message that
  // will land in the pending queue, where the operator can restore
  // the original ticket or open a fresh one.)
  const threadRefs = await collectThreadReferences(msg);
  if (threadRefs.length) {
    const placeholders = threadRefs.map(() => '?').join(',');
    const ticket = db.prepare(`
      SELECT id, customer_id, subject FROM tickets
      WHERE source_message_id IN (${placeholders})
        AND status != 'resolved'
        AND deleted_at IS NULL
      ORDER BY last_message_at DESC LIMIT 1
    `).get(...threadRefs);
    if (ticket) {
      const result = await appendReply(db, ticket, msg);
      return { ticket_id: ticket.id, source: 'thread', already_appended: result.already_appended };
    }
  }

  // Strategy 2: sender + subject match against open tickets.
  // We require the customer to have sent from the same email AND the
  // new subject (with Re:/Fwd: stripped) to contain the ticket's
  // stripped subject. Both directions checked to handle both
  // "Re: Volunteer Cowichan" matching "Volunteer Cowichan" and
  // truncated subjects on the ticket side. Soft-deleted tickets are
  // skipped for the same reason as Strategy 1.
  const stripped = stripReFwd(msg.subject);
  if (!stripped) return null;
  const customer = db.prepare('SELECT id FROM customers WHERE LOWER(email) = ?').get(fromEmail);
  if (!customer) return null;
  const candidates = db.prepare(`
    SELECT id, subject FROM tickets
    WHERE customer_id = ? AND status != 'resolved' AND deleted_at IS NULL
    ORDER BY last_message_at DESC LIMIT 25
  `).all(customer.id);

  for (const t of candidates) {
    const tStripped = stripReFwd(t.subject);
    if (!tStripped) continue;
    if (stripped.includes(tStripped) || tStripped.includes(stripped)) {
      const result = await appendReply(db, t, msg);
      return { ticket_id: t.id, source: 'sender_subject', already_appended: result.already_appended };
    }
  }
  return null;
}

/**
 * Pull In-Reply-To and References headers from a message. The poller
 * doesn't currently parse these, so we ask the simpleParser to read
 * just the headers (fast — no body) when called.
 */
async function collectThreadReferences(msg) {
  const refs = new Set();
  if (msg.inReplyTo) refs.add(stripBrackets(msg.inReplyTo));
  if (Array.isArray(msg.references)) {
    for (const r of msg.references) refs.add(stripBrackets(r));
  } else if (typeof msg.references === 'string') {
    for (const r of msg.references.split(/\s+/)) refs.add(stripBrackets(r));
  }
  // If the poller didn't pre-parse headers, fetch+parse on demand.
  if (refs.size === 0 && msg.messageId) {
    try {
      const full = await fetchByMessageId(msg.messageId);
      if (full) {
        if (full.inReplyTo) refs.add(stripBrackets(full.inReplyTo));
        if (Array.isArray(full.references)) {
          for (const r of full.references) refs.add(stripBrackets(r));
        } else if (typeof full.references === 'string') {
          for (const r of full.references.split(/\s+/)) refs.add(stripBrackets(r));
        }
      }
    } catch (e) {
      // best effort; thread match is opportunistic
    }
  }
  return [...refs].filter(Boolean);
}

function stripBrackets(s) {
  if (!s) return null;
  return String(s).replace(/^<|>$/g, '').trim();
}

/**
 * Append a Gmail message as a new ticket_message on the given ticket.
 * Idempotent: if a ticket_message already has this gmail_message_id,
 * skip and return { already_appended: true }.
 */
async function appendReply(db, ticket, msg) {
  const dupe = db.prepare('SELECT id FROM ticket_messages WHERE gmail_message_id = ?').get(msg.messageId);
  if (dupe) return { already_appended: true };

  // Fetch full body+attachments if the poller didn't bring them.
  let body = msg.body || null;
  let html = msg.html || null;
  let attachments = Array.isArray(msg.attachments) ? msg.attachments : null;
  if ((!body || !html) && msg.messageId) {
    try {
      const full = await fetchByMessageId(msg.messageId);
      if (full) {
        body = body || full.body || null;
        html = html || full.html || null;
        if (!attachments && Array.isArray(full.attachments)) attachments = full.attachments;
      }
    } catch (e) {
      // continue with what we have
    }
  }

  const msgInfo = db.prepare(`
    INSERT INTO ticket_messages (ticket_id, sender, body, body_html, subject, gmail_message_id, source_message_id)
    VALUES (?, 'customer', ?, ?, ?, ?, ?)
  `).run(
    ticket.id,
    stripQuotedReplyBody(body) || msg.subject || '(empty)',
    html,
    msg.subject || null,
    msg.messageId,
    msg.messageId,
  );
  const ticketMessageId = msgInfo.lastInsertRowid;

  // Persist attachments to the ticket bucket.
  if (attachments && attachments.length) {
    const liveAttachInsert = db.prepare(`
      INSERT INTO ticket_message_attachments (ticket_message_id, filename, mime_type, size_bytes, content_id, disposition, storage_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const a of attachments) {
      if (!a || !a.buffer) continue;
      try {
        const persisted = persistAttachment({
          scope: 'tickets',
          rowId: ticket.id,
          filename: a.filename,
          mimeType: a.mimeType,
          buffer: a.buffer,
          contentId: a.contentId,
          disposition: a.disposition,
        });
        liveAttachInsert.run(
          ticketMessageId,
          persisted.filename,
          persisted.mimeType,
          persisted.sizeBytes,
          persisted.contentId,
          persisted.disposition,
          persisted.storagePath,
        );
      } catch (e) {
        console.warn('[replies] attachment skipped', a.filename, e.message);
      }
    }
  }

  // Bump the ticket's last_message_at so it surfaces at the top of
  // the dashboard.
  db.prepare(`UPDATE tickets SET last_message_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), ticket.id);

  db.prepare(
    "INSERT INTO audit_log (actor, action, target, payload) VALUES ('system', 'ticket.reply_appended', ?, ?)"
  ).run(String(ticket.id), JSON.stringify({ from_email: msg.fromEmail || msg.from_email, gmail_message_id: msg.messageId }));

  return { already_appended: false, ticket_message_id: ticketMessageId };
}

/**
 * Mark a Gmail message read (no archive). Best-effort: returns
 * { ok, error? } and never throws so it can be called from request
 * handlers without breaking the user's main action.
 */
export async function markImportedRead(messageId) {
  if (!messageId) return { ok: false, reason: 'no messageId' };
  try {
    return await markRead({ messageId, archive: false });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
