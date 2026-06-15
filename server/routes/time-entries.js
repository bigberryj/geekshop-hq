/**
 * Time tracking per ticket.
 */

export async function timeRoutes(app) {
  // List per ticket
  app.get('/api/tickets/:id/time', async (req) => {
    return app.db.prepare(`
      SELECT * FROM time_entries WHERE ticket_id = ? ORDER BY started_at DESC
    `).all(req.params.id);
  });

  // List per customer (across all their tickets)
  app.get('/api/customers/:id/time', async (req) => {
    return app.db.prepare(`
      SELECT te.*, t.ticket_uid, t.subject
      FROM time_entries te JOIN tickets t ON te.ticket_id = t.id
      WHERE t.customer_id = ? ORDER BY te.started_at DESC
    `).all(req.params.id);
  });

  // Start
  app.post('/api/tickets/:id/time/start', async (req, reply) => {
    // Stop any running timer first (single-active-timer model)
    app.db.prepare(`UPDATE time_entries SET stopped_at = CURRENT_TIMESTAMP,
      duration_seconds = (julianday(CURRENT_TIMESTAMP) - julianday(started_at)) * 86400
      WHERE stopped_at IS NULL`).run();
    const info = app.db.prepare(`
      INSERT INTO time_entries (ticket_id, started_at) VALUES (?, CURRENT_TIMESTAMP)
    `).run(req.params.id);
    return { id: info.lastInsertRowid };
  });

  // Stop
  app.post('/api/tickets/:id/time/stop', async (req, reply) => {
    const running = app.db.prepare(`
      SELECT * FROM time_entries WHERE ticket_id = ? AND stopped_at IS NULL
      ORDER BY started_at DESC LIMIT 1
    `).get(req.params.id);
    if (!running) return reply.code(404).send({ error: 'no running timer' });
    app.db.prepare(`
      UPDATE time_entries SET stopped_at = CURRENT_TIMESTAMP,
        duration_seconds = CAST((julianday(CURRENT_TIMESTAMP) - julianday(started_at)) * 86400 AS INTEGER)
      WHERE id = ?
    `).run(running.id);
    return { ok: true };
  });

  // Add manual entry
  app.post('/api/tickets/:id/time', async (req, reply) => {
    const { started_at, stopped_at, note } = req.body || {};
    if (!started_at || !stopped_at) return reply.code(400).send({ error: 'started_at and stopped_at required' });
    const duration = Math.round((new Date(stopped_at) - new Date(started_at)) / 1000);
    const info = app.db.prepare(`
      INSERT INTO time_entries (ticket_id, started_at, stopped_at, duration_seconds, note) VALUES (?, ?, ?, ?, ?)
    `).run(req.params.id, started_at, stopped_at, duration, note || null);
    return { id: info.lastInsertRowid, duration_seconds: duration };
  });

  // Time log view (all)
  app.get('/api/time', async (req) => {
    const { customer_id, since } = req.query;
    let sql = `
      SELECT te.*, t.ticket_uid, t.subject, c.name as customer_name, c.id as customer_id
      FROM time_entries te
      JOIN tickets t ON te.ticket_id = t.id
      JOIN customers c ON t.customer_id = c.id
      WHERE te.duration_seconds IS NOT NULL
    `;
    const args = [];
    if (customer_id) { sql += ' AND c.id = ?'; args.push(customer_id); }
    if (since) { sql += ' AND te.started_at >= ?'; args.push(since); }
    sql += ' ORDER BY te.started_at DESC LIMIT 200';
    return app.db.prepare(sql).all(...args);
  });
}
