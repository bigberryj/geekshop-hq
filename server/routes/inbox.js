/**
 * Inbox routes — Gmail-backed ticket ingestion.
 *
 * GET    /api/inbox/unread?limit=25       List recent unread messages
 * POST   /api/inbox/import-as-ticket      Body: { messageId, customerId, subject, body }
 * POST   /api/inbox/test                  Test Gmail connection
 * GET    /api/inbox/status                Poller status + config
 */

import { fetchUnread, fetchByMessageId, testConnection, inboxConfig } from '../lib/email-inbox.js';
import { aiCall } from '../lib/ai.js';

function nextTicketUid(db) {
  const last = db.prepare("SELECT ticket_uid FROM tickets ORDER BY id DESC LIMIT 1").get();
  const n = last ? Number(last.ticket_uid.split('-')[1]) + 1 : 1;
  return `G-${String(n).padStart(6, '0')}`;
}

function findOrCreateCustomer(db, { email, name }) {
  if (email) {
    const existing = db.prepare('SELECT * FROM customers WHERE email = ?').get(email);
    if (existing) return existing;
  }
  const info = db.prepare(`
    INSERT INTO customers (name, email, first_seen_at, last_seen_at, health_score)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 70)
  `).run(name || email?.split('@')[0] || 'Unknown', email || null);
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
}

export async function inboxRoutes(app) {
  // Status / config
  app.get('/api/inbox/status', async () => inboxConfig);

  // Connection test
  app.post('/api/inbox/test', async () => testConnection());

  // List unread
  app.get('/api/inbox/unread', async (req, reply) => {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    try {
      const messages = await fetchUnread(limit);
      return { count: messages.length, messages };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  /**
   * Import a message as a new ticket.
   * Body: { messageId, customerId? }
   * - If messageId omitted, treats req.body as already-parsed { fromEmail, from, subject, body }
   */
  app.post('/api/inbox/import-as-ticket', async (req, reply) => {
    const { messageId, customerId } = req.body || {};
    let msg = null;
    if (messageId) {
      msg = await fetchByMessageId(messageId).catch((e) => null);
    } else {
      // Use payload as-is
      msg = {
        messageId: req.body.messageId || `manual-${Date.now()}`,
        from: req.body.from || req.body.fromName,
        fromEmail: req.body.fromEmail,
        subject: req.body.subject || '(no subject)',
        body: req.body.body || '',
        date: new Date(),
      };
    }
    if (!msg) return reply.code(404).send({ error: 'message not found or fetch failed' });

    // Find or create customer
    let customer;
    if (customerId) {
      customer = app.db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    }
    if (!customer) {
      customer = findOrCreateCustomer(app.db, { email: msg.fromEmail, name: msg.from });
    }

    // Classify priority with AI (cheap tier)
    let priority = 'normal';
    try {
      const classifyPrompt = `Classify this customer email's urgency. Reply with exactly one word: low, normal, high, or urgent.\n\nSubject: ${msg.subject}\nBody: ${(msg.body || '').slice(0, 500)}`;
      const r = await aiCall('cheap_classify', classifyPrompt, { maxTokens: 10, task: 'urgency_tag' });
      const v = (r.output || '').toLowerCase().trim();
      if (['low', 'normal', 'high', 'urgent'].includes(v)) priority = v;
    } catch { /* keep default */ }

    // Create ticket
    const uid = nextTicketUid(app.db);
    const info = app.db.prepare(`
      INSERT INTO tickets (ticket_uid, customer_id, subject, priority, source, last_message_at)
      VALUES (?, ?, ?, ?, 'email', CURRENT_TIMESTAMP)
    `).run(uid, customer.id, msg.subject, priority);
    app.db.prepare(`
      INSERT INTO ticket_messages (ticket_id, sender, body) VALUES (?, 'customer', ?)
    `).run(info.lastInsertRowid, msg.body || msg.subject);
    app.db.prepare("INSERT INTO audit_log (actor, action, target, meta) VALUES ('inbox', 'ticket.create.from_email', ?, ?)")
      .run(String(info.lastInsertRowid), JSON.stringify({ messageId: msg.messageId, from: msg.fromEmail }));

    return {
      ok: true,
      ticket_id: info.lastInsertRowid,
      ticket_uid: uid,
      customer_id: customer.id,
      customer_name: customer.name,
      priority,
    };
  });
}
