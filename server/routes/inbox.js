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

  // Manual "check Gmail now" button for the admin
  app.post('/api/inbox/scan', async (req, reply) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 25, 100);
      const result = await scanPendingEmails(app.db, { limit });
      return result;
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  app.get('/api/inbox/pending', async (req) => {
    const status = (req.query.status || 'pending').toString();
    return listPendingEmails(app.db, { status, limit: 100 });
  });

  app.post('/api/inbox/pending/:id/import', async (req, reply) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid id' });
      const result = importPendingEmail(app.db, id);
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
