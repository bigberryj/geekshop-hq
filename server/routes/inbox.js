/**
 * Inbox routes — Gmail moderation queue.
 *
 * GET    /api/inbox/status                 Poller status + config
 * POST   /api/inbox/test                   Test Gmail IMAP connection
 * POST   /api/inbox/scan                   One-shot fetch from Gmail into the pending queue
 * GET    /api/inbox/pending?status=...     List pending rows
 * POST   /api/inbox/pending/:id/import     Move pending email into a real ticket + customer
 * POST   /api/inbox/pending/:id/dismiss    Mark pending email as ignored
 *
 * Auto-create behaviour (BYRON_GMAIL_AUTO_CREATE_TICKETS) is now opt-in: when set,
 * the background poller will still insert into the pending queue rather than
 * creating tickets directly, so the admin always has the final say.
 */

import { testConnection, inboxConfig } from '../lib/email-inbox.js';
import {
  scanPendingEmails,
  importPendingEmail,
  dismissPendingEmail,
  bulkDismissPendingEmails,
  restorePendingEmail,
  listPendingEmails,
  backfillClassifyPendingEmails,
  readModerationSettings,
  listPendingAttachments,
} from '../lib/pending-emails.js';
import { fetchByMessageId } from '../lib/email-inbox.js';
import { readFileSync } from 'node:fs';
import {
  resolveAttachmentPath,
  attachmentSize,
  ATTACHMENT_MAX_BYTES,
  sanitizeEmailHtml,
  persistAttachment,
  deleteAttachment,
} from '../lib/attachments.js';
import { findAttachmentById } from '../lib/attachment-lookup.js';

export async function inboxRoutes(app) {
  app.get('/api/inbox/status', async () => ({
    ...inboxConfig,
    moderation_mode: 'pending_queue',
  }));

  app.post('/api/inbox/test', async () => testConnection());

  // Manual "check Gmail now" button for the admin.
  //
  // Query params (all optional):
  //   since           ISO date string  earliest message date (default: now - 24h)
  //   until           ISO date string  latest message date (default: none)
  //   include_starred "true"|"false"   include \Flagged (starred) messages (default: true)
  //   limit           number 1..100     max messages to fetch (default: 25)
  app.post('/api/inbox/scan', async (req, reply) => {
    try {
      // Accept params from either query string or JSON body (the UI form
      // will send JSON; curl-friendly callers can use either).
      const src = { ...(req.query || {}), ...((req.body && typeof req.body === 'object') ? req.body : {}) };
      const parseDate = (v, fallback) => {
        if (v == null || v === '') return fallback;
        const d = new Date(v);
        if (isNaN(d.getTime())) throw new Error(`invalid date: ${v}`);
        return d;
      };
      const since = parseDate(src.since, new Date(Date.now() - 24 * 60 * 60 * 1000));
      const until = parseDate(src.until, null);
      const includeStarred = String(src.include_starred ?? src.includeStarred ?? 'true').toLowerCase() !== 'false';
      const limit = Math.min(Math.max(Number(src.limit) || 25, 1), 100);
      if (since && until && since.getTime() > until.getTime()) {
        return reply.code(400).send({ error: 'since must be before until' });
      }
      const result = await scanPendingEmails(app.db, { since, until, includeStarred, limit });
      return result;
    } catch (err) {
      // 400 for caller-fixable errors (bad date, inverted range), 500 for
      // anything else (IMAP down, DB error).
      const status = /invalid date|since must be/i.test(err.message) ? 400 : 500;
      return reply.code(status).send({ error: err.message });
    }
  });

  app.get('/api/inbox/pending', async (req, reply) => {
    const status = (req.query.status || 'pending').toString();
    const limit = Math.min(Math.max(Number(req.query.limit) || 250, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    // include_dismissed=true returns BOTH pending and dismissed rows.
    // Used by the "Show dismissed" toggle in the UI. When true, the
    // `status` param is ignored (we always return both).
    const includeDismissed = String(req.query.include_dismissed || '').toLowerCase() === 'true';
    // Optional date window — ISO date strings, applied to received_at.
    // Bad date strings return 400 rather than silently ignoring the filter.
    const parseDate = (v) => {
      if (v == null || v === '') return null;
      const d = new Date(v);
      if (isNaN(d.getTime())) throw new Error(`invalid date: ${v}`);
      return d.toISOString();
    };
    let since, until;
    try {
      since = parseDate(req.query.since);
      until = parseDate(req.query.until);
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
    if (since && until && new Date(since).getTime() > new Date(until).getTime()) {
      return reply.code(400).send({ error: 'since must be before until' });
    }
    // When include_dismissed, query both statuses. Pass as a list.
    const effectiveStatus = includeDismissed ? ['pending', 'dismissed'] : status;
    const items = listPendingEmails(app.db, { status: effectiveStatus, limit, offset, since, until });
    // `total` is the count under the same filter so the UI can show
    // "X of Y" correctly when the user has narrowed the date window.
    const baseWhere = includeDismissed
      ? `(status IN ('pending','dismissed'))`
      : `status = ?`;
    const baseArgs = includeDismissed ? [] : [status];
    const whereParts = [baseWhere];
    const whereArgs = [...baseArgs];
    if (since) { whereParts.push('received_at >= ?'); whereArgs.push(since); }
    if (until) { whereParts.push('received_at <= ?'); whereArgs.push(until); }
    const total = app.db.prepare(`SELECT COUNT(*) as n FROM pending_emails WHERE ${whereParts.join(' AND ')}`).get(...whereArgs).n;
    return {
      items,
      rows: items, // alias for any client that still expects a flat array
      total,
      limit, offset,
      filter: { since, until, includeDismissed },
    };
  });

  app.post('/api/inbox/pending/:id/import', async (req, reply) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid id' });
      const result = await importPendingEmail(app.db, id);
      return { ok: true, ...result, already_imported: Boolean(result.already_imported) };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post('/api/inbox/pending/:id/dismiss', async (req, reply) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid id' });
      dismissPendingEmail(app.db, id);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Bulk-dismiss multiple pending emails at once. UI sends a list of
  // {id: number} objects in the body. Returns counts so the UI can show
  // "dismissed 5 of 7" with the skipped rows explained.
  app.post('/api/inbox/pending/bulk-dismiss', async (req, reply) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids)) return reply.code(400).send({ error: 'ids array required' });
    if (ids.length > 500) return reply.code(400).send({ error: 'too many ids (max 500)' });
    try {
      const result = bulkDismissPendingEmails(app.db, ids);
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Restore a dismissed email back to pending. Used by the "Restore"
  // button on the "Show dismissed" view.
  app.post('/api/inbox/pending/:id/restore', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid id' });
    try {
      restorePendingEmail(app.db, id);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Read the moderation settings (junk classifier overrides + agent mailbox)
  // for the UI. Exposed read-only.
  app.get('/api/inbox/moderation-settings', async () => readModerationSettings(app.db));

  // Attachment metadata for a pending email. No raw bytes here.
  app.get('/api/inbox/pending/:id/attachments', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid id' });
    const row = app.db.prepare('SELECT id, status FROM pending_emails WHERE id = ?').get(id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    return { items: listPendingAttachments(app.db, id) };
  });

  // Raw bytes of a pending-email attachment.
  app.get('/api/inbox/pending/:id/attachments/:aid/raw', async (req, reply) => {
    const id = Number(req.params.id);
    const aid = Number(req.params.aid);
    if (!Number.isInteger(id) || !Number.isInteger(aid)) return reply.code(400).send({ error: 'invalid id' });
    const row = app.db.prepare('SELECT storage_path, mime_type, filename FROM pending_email_attachments WHERE id = ? AND pending_email_id = ?').get(aid, id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    const abs = resolveAttachmentPath(row.storage_path);
    if (!abs) return reply.code(404).send({ error: 'file missing' });
    reply.header('Content-Type', row.mime_type || 'application/octet-stream');
    reply.header('Content-Length', String(attachmentSize(row.storage_path)));
    reply.header('Content-Disposition', `inline; filename="${(row.filename || 'attachment').replace(/"/g, '')}"`);
    return reply.send(readFileSync(abs));
  });

  // Raw bytes of a ticket-message attachment (used by the email
  // render on the ticket page, and by AI vision to fetch bytes).
  app.get('/api/attachments/:id/raw', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid id' });
    const att = findAttachmentById(app.db, id);
    if (!att) return reply.code(404).send({ error: 'not found' });
    const abs = resolveAttachmentPath(att.storage_path);
    if (!abs) return reply.code(404).send({ error: 'file missing' });
    reply.header('Content-Type', att.mime_type || 'application/octet-stream');
    reply.header('Content-Length', String(attachmentSize(att.storage_path)));
    reply.header('Content-Disposition', `inline; filename="${(att.filename || 'attachment').replace(/"/g, '')}"`);
    return reply.send(readFileSync(abs));
  });

  // Email preview (sanitized HTML with inline images rewritten).
  // On-demand fetches from Gmail if we don't yet have a body/html
  // stored on the row. Returns { subject, from_*, date, body_text,
  // body_html (sanitized), attachments, missing_inline_cids[] }.
  app.get('/api/inbox/pending/:id/preview', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid id' });
    const row = app.db.prepare('SELECT * FROM pending_emails WHERE id = ?').get(id);
    if (!row) return reply.code(404).send({ error: 'not found' });

    // Helper: the original scan only stored bodies for the 25 most recent
    // messages. Older rows and rows that had only a snippet/empty body
    // still need a Gmail refetch. Treat any non-string / whitespace-only
    // body as missing so the refetch actually fires.
    const isMissing = (v) => typeof v !== 'string' || v.trim() === '';

    let html = row.body_html || null;
    let freshBody = null;
    if (!html && row.message_id) {
      try {
        const full = await fetchByMessageId(row.message_id);
        if (full) {
          html = full.html || null;
          freshBody = full.body || null;
          // Persist the body so subsequent previews / re-imports don't
          // re-hit Gmail.
          app.db.prepare(`
            UPDATE pending_emails
            SET body = COALESCE(NULLIF(?, ''), body),
                snippet = CASE WHEN snippet IS NULL OR snippet = '' THEN ? ELSE snippet END,
                body_html = ?,
                body_fetched_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(
            full.body || '',
            (full.body || full.subject || '').slice(0, 200).replace(/\s+/g, ' ').trim(),
            html,
            id
          );
          // Persist any attachments we just pulled.
          if (Array.isArray(full.attachments) && full.attachments.length) {
            const insertAttach = app.db.prepare(`
              INSERT INTO pending_email_attachments (pending_email_id, filename, mime_type, size_bytes, content_id, disposition, storage_path)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            // Clean any stale envelope rows.
            const old = app.db.prepare('SELECT storage_path FROM pending_email_attachments WHERE pending_email_id = ?').all(id);
            for (const r of old) deleteAttachment(r.storage_path);
            app.db.prepare('DELETE FROM pending_email_attachments WHERE pending_email_id = ?').run(id);
            for (const a of full.attachments) {
              if (!a || !a.buffer) continue;
              try {
                const p = persistAttachment({
                  scope: 'pending',
                  rowId: id,
                  filename: a.filename,
                  mimeType: a.mimeType,
                  buffer: a.buffer,
                  contentId: a.contentId,
                  disposition: a.disposition,
                });
                insertAttach.run(id, p.filename, p.mimeType, p.sizeBytes, p.contentId, p.disposition, p.storagePath);
              } catch (e) {
                console.warn('[inbox] preview: attachment skipped', a.filename, e.message);
              }
            }
          }
        }
      } catch (e) {
        console.warn('[inbox] preview: on-demand fetch failed:', e.message);
      }
    }

    const attachments = listPendingAttachments(app.db, id);
    // Build the cid -> attachment_id lookup. We use the content_id
    // value (with angle brackets stripped) as the key.
    const cidMap = new Map();
    for (const a of attachments) {
      if (a.content_id) {
        const clean = String(a.content_id).replace(/^<|>$/g, '');
        cidMap.set(clean, a.id);
      }
    }
    // Rewrite `cid:` references to point at our raw-bytes endpoint, then
    // sanitize. If there is no html but we do have a text body, fall
    // back to a tiny wrapped HTML doc so the modal can still render in
    // its iframe and keep styling consistent.
    let displayHtml = '';
    if (html) {
      displayHtml = sanitizeEmailHtml(html, (cid) => cidMap.get(cid) || null);
    } else if (!isMissing(row.body)) {
      const escaped = String(row.body).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      displayHtml = `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escaped}</pre>`;
    }
    return {
      id: row.id,
      message_id: row.message_id,
      from_name: row.from_name,
      from_email: row.from_email,
      subject: row.subject,
      date: row.received_at,
      body_text: !isMissing(row.body) ? row.body : (freshBody || row.snippet || ''),
      body_html: displayHtml,
      attachments,
    };
  });

  // Backfill classification on pending rows that don't have one yet.
  // Byron-iter 2026-06-16: the legacy queue has 554 un-classified rows
  // from before the classifier shipped. This is the catch-up.
  //
  // Body: { threshold?: number (0..1, default 0.8),
  //         status?: 'pending' | 'all' (default 'pending'),
  //         limit?: number (default 100000) }
  //
  // Returns: { examined, classified, dismissed, threshold, samples }
  //   - `samples` is up to 25 examples of what got scored + dismissed.
  app.post('/api/inbox/pending/backfill-classify', async (req, reply) => {
    const body = req.body || {};
    const threshold = Number(body.threshold);
    const status = String(body.status || 'pending');
    const limit = Number(body.limit);
    if (status !== 'pending' && status !== 'all') {
      return reply.code(400).send({ error: "status must be 'pending' or 'all'" });
    }
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      return reply.code(400).send({ error: 'threshold must be a number in [0, 1]' });
    }
    if (!Number.isFinite(limit) || limit < 1 || limit > 100000) {
      return reply.code(400).send({ error: 'limit must be 1..100000' });
    }
    try {
      const result = backfillClassifyPendingEmails(app.db, { dismiss_threshold: threshold, status, limit });
      // Audit the admin invocation too (the per-row dismisses each get their
      // own audit_log row inside the function).
      app.db.prepare(
        "INSERT INTO audit_log (actor, action, target, payload) VALUES ('admin', 'pending_email.backfill_classify.run', NULL, ?)"
      ).run(JSON.stringify({ threshold, status, limit, examined: result.examined, classified: result.classified, dismissed: result.dismissed }));
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });
}
