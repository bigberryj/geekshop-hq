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
  listPendingEmails,
} from '../lib/pending-emails.js';

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

  app.get('/api/inbox/pending', async (req) => {
    const status = (req.query.status || 'pending').toString();
    const limit = Math.min(Math.max(Number(req.query.limit) || 250, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    // Wrap the array in an object so we can include pagination metadata.
    // Backward compat: existing UI reads `result.length` and `result.map(...)`,
    // so we put the array as the `items` field, not the top-level value.
    // If the UI is updated to consume `items`, we can drop the alias `rows`.
    const items = listPendingEmails(app.db, { status, limit, offset });
    return {
      items,
      rows: items, // alias for any client that still expects a flat array
      total: app.db.prepare('SELECT COUNT(*) as n FROM pending_emails WHERE status = ?').get(status).n,
      limit, offset,
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
}
