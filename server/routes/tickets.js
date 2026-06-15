/**
 * Ticket CRUD + AI endpoints.
 */

import { aiCall } from '../lib/ai.js';
import { sendEmail } from '../lib/email.js';

function nextTicketUid(db) {
  const last = db.prepare("SELECT ticket_uid FROM tickets ORDER BY id DESC LIMIT 1").get();
  const n = last ? Number(last.ticket_uid.split('-')[1]) + 1 : 1;
  return `G-${String(n).padStart(6, '0')}`;
}

export async function ticketRoutes(app) {
  // List
  app.get('/api/tickets', async (req) => {
    const { status, customer_id } = req.query;
    let sql = `
      SELECT t.*, c.name as customer_name
      FROM tickets t JOIN customers c ON t.customer_id = c.id
      WHERE 1=1
    `;
    const args = [];
    if (status) { sql += ' AND t.status = ?'; args.push(status); }
    if (customer_id) { sql += ' AND t.customer_id = ?'; args.push(customer_id); }
    sql += ' ORDER BY t.last_message_at DESC, t.id DESC LIMIT 200';
    return app.db.prepare(sql).all(...args);
  });

  // Create
  app.post('/api/tickets', async (req, reply) => {
    const { customer_id, subject, body, priority } = req.body || {};
    if (!customer_id || !subject) return reply.code(400).send({ error: 'customer_id and subject required' });
    const uid = nextTicketUid(app.db);
    const info = app.db.prepare(`
      INSERT INTO tickets (ticket_uid, customer_id, subject, priority, last_message_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(uid, customer_id, subject, priority || 'normal');
    if (body) {
      app.db.prepare(`
        INSERT INTO ticket_messages (ticket_id, sender, body) VALUES (?, 'customer', ?)
      `).run(info.lastInsertRowid, body);
    }
    app.db.prepare("INSERT INTO audit_log (actor, action, target) VALUES ('admin', 'ticket.create', ?)").run(String(info.lastInsertRowid));
    return { id: info.lastInsertRowid, ticket_uid: uid };
  });

  // Detail
  app.get('/api/tickets/:id', async (req, reply) => {
    const t = app.db.prepare(`
      SELECT t.*, c.name as customer_name, c.email as customer_email, c.id as customer_id
      FROM tickets t JOIN customers c ON t.customer_id = c.id
      WHERE t.id = ?
    `).get(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    const messages = app.db.prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC').all(req.params.id);
    const memory = app.db.prepare(`
      SELECT * FROM customer_memory WHERE customer_id = ? AND confidence >= 0.6
      ORDER BY category, created_at
    `).all(t.customer_id);
    return { ...t, messages, customer_memory: memory };
  });

  // Reply
  app.post('/api/tickets/:id/messages', async (req, reply) => {
    const { body, ai_draft } = req.body || {};
    if (!body) return reply.code(400).send({ error: 'body required' });
    const t = app.db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    app.db.prepare(`
      INSERT INTO ticket_messages (ticket_id, sender, body, ai_draft) VALUES (?, 'admin', ?, ?)
    `).run(req.params.id, body, ai_draft ? 1 : 0);
    app.db.prepare('UPDATE tickets SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    return { ok: true };
  });

  // AI draft
  app.post('/api/tickets/:id/ai-draft', async (req, reply) => {
    const t = app.db.prepare(`
      SELECT t.*, c.name as customer_name, c.email as customer_email
      FROM tickets t JOIN customers c ON t.customer_id = c.id
      WHERE t.id = ?
    `).get(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    const messages = app.db.prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC').all(req.params.id);
    const memory = app.db.prepare(`
      SELECT category, key, value, confidence FROM customer_memory WHERE customer_id = ? AND confidence >= 0.6
    `).all(t.customer_id);

    const memoryBlock = memory.length
      ? memory.map((m) => `- ${m.category}: ${m.key ? m.key + ': ' : ''}${m.value}`).join('\n')
      : '(no customer memory yet)';

    const convo = messages.map((m) => `[${m.sender}] ${m.body}`).join('\n\n');
    const prompt = `Draft a short (3-5 sentence) professional reply to a support ticket.

Customer: ${t.customer_name}
Ticket subject: ${t.subject}
Customer memory (use this to sound like a real human who knows them):
${memoryBlock}

Conversation so far:
${convo || '(no messages yet)'}

Reply with just the draft text, no preamble.`;

    const result = await aiCall('high_reasoning', prompt, {
      system: 'You write warm, specific, professional support replies. Reference the customer\'s known equipment/preferences. No upsell. No "I hope this email finds you well."',
      maxTokens: 400,
    });
    return { draft: result.output, provider: result.provider };
  });

  // AI summary
  app.post('/api/tickets/:id/ai-summary', async (req, reply) => {
    const t = app.db.prepare('SELECT subject FROM tickets WHERE id = ?').get(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    const messages = app.db.prepare('SELECT sender, body FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC').all(req.params.id);
    const convo = messages.map((m) => `[${m.sender}] ${m.body}`).join('\n');
    const prompt = `Summarize this support ticket in 1-2 sentences.\n\nSubject: ${t.subject}\n\n${convo}`;
    const result = await aiCall('high_reasoning', prompt, { maxTokens: 200 });
    app.db.prepare('UPDATE tickets SET ai_summary = ?, ai_processed_at = CURRENT_TIMESTAMP WHERE id = ?').run(result.output, req.params.id);
    return { summary: result.output, provider: result.provider };
  });

  // Resolve
  app.post('/api/tickets/:id/resolve', async (req, reply) => {
    const t = app.db.prepare(`
      SELECT t.*, c.email as customer_email, c.name as customer_name
      FROM tickets t JOIN customers c ON t.customer_id = c.id
      WHERE t.id = ?
    `).get(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    app.db.prepare("UPDATE tickets SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    app.db.prepare("INSERT INTO audit_log (actor, action, target) VALUES ('admin', 'ticket.resolve', ?)").run(req.params.id);

    // Try to send resolution email (no ticket UID, no "ticket" wording — customer-facing)
    if (t.customer_email) {
      const body = `Hi ${t.customer_name},\n\nJust confirming we've wrapped up your request about "${t.subject}". Reply to this email if you need anything else.`;
      await sendEmail({ to: t.customer_email, subject: `Re: ${t.subject}`, text: body });
    }
    return { ok: true };
  });
}
