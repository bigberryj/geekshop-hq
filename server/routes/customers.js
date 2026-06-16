/**
 * Customer CRUD + health score.
 */

export async function customerRoutes(app) {
  // List (with health score)
  app.get('/api/customers', async (req) => {
    const { search } = req.query;
    let sql = `
      SELECT c.id, c.name, c.company, c.email, c.phone, c.notes, c.created_at,
             (SELECT MAX(m.created_at) FROM ticket_messages m JOIN tickets t ON m.ticket_id = t.id WHERE t.customer_id = c.id) as last_contact,
             (SELECT COUNT(*) FROM tickets WHERE customer_id = c.id) as total_tickets,
             (SELECT COUNT(*) FROM tickets WHERE customer_id = c.id AND status = 'resolved') as resolved_tickets,
             (SELECT COUNT(*) FROM customer_memory WHERE customer_id = c.id) as memory_count,
             (SELECT COUNT(*) FROM invoices WHERE customer_id = c.id AND status IN ('sent','overdue')) as open_invoices
      FROM customers c
      WHERE 1=1
    `;
    const args = [];
    if (search) {
      sql += ' AND (c.name LIKE ? OR c.email LIKE ? OR c.company LIKE ?)';
      const s = `%${search}%`;
      args.push(s, s, s);
    }
    sql += ' ORDER BY c.name ASC LIMIT 200';

    const rows = app.db.prepare(sql).all(...args);
    // Compute health score inline
    return rows.map((c) => {
      const last = c.last_contact ? new Date(c.last_contact) : null;
      const days = last ? Math.floor((Date.now() - last.getTime()) / 86400000) : 999;
      const recency = Math.max(0, 100 - days * 3);
      const volume = Math.max(0, 100 - c.total_tickets * 4);
      const balance = Math.max(0, 100 - c.open_invoices * 30);
      const score = Math.round((recency * 0.4 + volume * 0.2 + balance * 0.4));
      const band = score > 70 ? 'green' : score >= 40 ? 'yellow' : 'red';
      return { ...c, health_score: score, health_band: band };
    });
  });

  // Create
  app.post('/api/customers', async (req, reply) => {
    const { name, company, email, phone, notes } = req.body || {};
    if (!name) return reply.code(400).send({ error: 'name required' });
    const info = app.db.prepare(`
      INSERT INTO customers (name, company, email, phone, notes) VALUES (?, ?, ?, ?, ?)
    `).run(name, company || null, email || null, phone || null, notes || null);
    return { id: info.lastInsertRowid };
  });

  // Detail
  app.get('/api/customers/:id', async (req, reply) => {
    const c = app.db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'not found' });
    const tickets = app.db.prepare('SELECT * FROM tickets WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20').all(req.params.id);
    const memory = app.db.prepare('SELECT * FROM customer_memory WHERE customer_id = ? ORDER BY category, created_at').all(req.params.id);
    const time_total = app.db.prepare(`
      SELECT COALESCE(SUM(te.duration_seconds), 0) as total_seconds
      FROM time_entries te JOIN tickets t ON te.ticket_id = t.id
      WHERE t.customer_id = ? AND te.duration_seconds IS NOT NULL
    `).get(req.params.id);
    const invoices = app.db.prepare('SELECT id, invoice_uid, status, total_cents, sent_at, due_at, paid_at FROM invoices WHERE customer_id = ? ORDER BY created_at DESC').all(req.params.id);
    return { ...c, tickets, memory, total_time_seconds: time_total.total_seconds, invoices };
  });

  // Update — partial-update endpoint. Whitelists columns so a caller can't
  // overwrite `id`, `created_at`, or any other protected field. Empty
  // string → NULL for nullable fields so the UI can clear values.
  const UPDATABLE = ['name', 'company', 'email', 'phone', 'notes'];
  const updateHandler = async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid id' });
    const existing = app.db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    const body = req.body || {};
    // Name is NOT NULL; reject clearing it.
    if (Object.prototype.hasOwnProperty.call(body, 'name') && !String(body.name).trim()) {
      return reply.code(400).send({ error: 'name cannot be empty' });
    }
    const updates = [];
    const params = [];
    for (const k of UPDATABLE) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        const v = body[k];
        updates.push(`${k} = ?`);
        params.push(v === '' ? null : v);
      }
    }
    if (updates.length === 0) return reply.code(400).send({ error: 'no fields to update' });
    params.push(id);
    app.db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    // Audit log payload uses the SAME keys that were actually updated.
    // Map the SQL fragments ("name = ?") back to the field name ("name")
    // so the audit row tells you which fields changed and to what value.
    const changedFields = {};
    for (const frag of updates) {
      const key = frag.split(' = ')[0].trim();
      changedFields[key] = body[key];
    }
    app.db.prepare("INSERT INTO audit_log (actor, action, target, payload) VALUES ('admin', 'customer.update', ?, ?)")
      .run(String(id), JSON.stringify(changedFields));
    return app.db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  };
  app.put('/api/customers/:id', updateHandler);
  app.patch('/api/customers/:id', updateHandler);
}
