/**
 * Time tracking per ticket.
 */

function timerStatus(row) {
  if (row.stopped_at) return 'stopped';
  if (row.paused_at) return 'paused';
  return 'running';
}

function elapsedExpression(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `
    CASE
      WHEN ${p}stopped_at IS NOT NULL THEN COALESCE(${p}duration_seconds, 0)
      WHEN ${p}paused_at IS NOT NULL THEN COALESCE(${p}duration_seconds, 0)
      ELSE CAST(COALESCE(${p}duration_seconds, 0) + ((julianday(CURRENT_TIMESTAMP) - julianday(${p}started_at)) * 86400) AS INTEGER)
    END
  `;
}

function decorateTimer(row) {
  if (!row) return row;
  return {
    ...row,
    status: timerStatus(row),
    duration_seconds: row.duration_seconds ?? 0,
    elapsed_seconds: Number(row.elapsed_seconds ?? row.duration_seconds ?? 0),
  };
}

function activeTimer(db, ticketId) {
  const row = db.prepare(`
    SELECT *, ${elapsedExpression()} AS elapsed_seconds
    FROM time_entries
    WHERE ticket_id = ? AND stopped_at IS NULL
    ORDER BY started_at DESC LIMIT 1
  `).get(ticketId);
  return decorateTimer(row);
}

function finalizeOtherActiveTimers(db, ticketId) {
  db.prepare(`
    UPDATE time_entries
    SET stopped_at = CURRENT_TIMESTAMP,
        duration_seconds = ${elapsedExpression()}
    WHERE stopped_at IS NULL AND ticket_id != ?
  `).run(ticketId);
}

export async function timeRoutes(app) {
  // List per ticket
  app.get('/api/tickets/:id/time', async (req) => {
    return app.db.prepare(`
      SELECT *, ${elapsedExpression()} AS elapsed_seconds
      FROM time_entries WHERE ticket_id = ? ORDER BY started_at DESC
    `).all(req.params.id).map(decorateTimer);
  });

  // List per customer (across all their tickets)
  app.get('/api/customers/:id/time', async (req) => {
    return app.db.prepare(`
      SELECT te.*, t.ticket_uid, t.subject, ${elapsedExpression('te')} AS elapsed_seconds
      FROM time_entries te JOIN tickets t ON te.ticket_id = t.id
      WHERE t.customer_id = ? ORDER BY te.started_at DESC
    `).all(req.params.id).map(decorateTimer);
  });

  // Start. Idempotent per ticket: clicking Start twice returns the active row.
  app.post('/api/tickets/:id/time/start', async (req) => {
    const existing = activeTimer(app.db, req.params.id);
    if (existing) return existing;

    // Stop any active timer on another ticket first (single-active-timer model).
    finalizeOtherActiveTimers(app.db, req.params.id);

    const info = app.db.prepare(`
      INSERT INTO time_entries (ticket_id, started_at, duration_seconds) VALUES (?, CURRENT_TIMESTAMP, 0)
    `).run(req.params.id);
    return activeTimer(app.db, req.params.id) || { id: info.lastInsertRowid, status: 'running', duration_seconds: 0, elapsed_seconds: 0, paused_at: null };
  });

  // Pause active timer without finalizing it.
  app.post('/api/tickets/:id/time/pause', async (req, reply) => {
    const running = activeTimer(app.db, req.params.id);
    if (!running) return reply.code(404).send({ error: 'no running timer' });
    if (running.status === 'paused') return running;

    app.db.prepare(`
      UPDATE time_entries
      SET paused_at = CURRENT_TIMESTAMP,
          duration_seconds = ${elapsedExpression()}
      WHERE id = ?
    `).run(running.id);
    return activeTimer(app.db, req.params.id);
  });

  // Resume a paused active timer.
  app.post('/api/tickets/:id/time/resume', async (req, reply) => {
    const paused = activeTimer(app.db, req.params.id);
    if (!paused) return reply.code(404).send({ error: 'no paused timer' });
    if (paused.status === 'running') return paused;

    app.db.prepare(`
      UPDATE time_entries
      SET started_at = CURRENT_TIMESTAMP,
          paused_at = NULL
      WHERE id = ?
    `).run(paused.id);
    return activeTimer(app.db, req.params.id);
  });

  // Stop/finalize active timer whether it is running or paused.
  app.post('/api/tickets/:id/time/stop', async (req, reply) => {
    const active = activeTimer(app.db, req.params.id);
    if (!active) return reply.code(404).send({ error: 'no running timer' });
    app.db.prepare(`
      UPDATE time_entries SET stopped_at = CURRENT_TIMESTAMP,
        paused_at = NULL,
        duration_seconds = ${elapsedExpression()}
      WHERE id = ?
    `).run(active.id);
    const stopped = app.db.prepare(`
      SELECT *, ${elapsedExpression()} AS elapsed_seconds
      FROM time_entries WHERE id = ?
    `).get(active.id);
    return { ok: true, ...decorateTimer(stopped) };
  });

  // Add manual entry
  app.post('/api/tickets/:id/time', async (req, reply) => {
    const { started_at, stopped_at, note } = req.body || {};
    if (!started_at || !stopped_at) return reply.code(400).send({ error: 'started_at and stopped_at required' });
    const duration = Math.round((new Date(stopped_at) - new Date(started_at)) / 1000);
    const info = app.db.prepare(`
      INSERT INTO time_entries (ticket_id, started_at, stopped_at, duration_seconds, note) VALUES (?, ?, ?, ?, ?)
    `).run(req.params.id, started_at, stopped_at, duration, note || null);
    return { id: info.lastInsertRowid, duration_seconds: duration, elapsed_seconds: duration, status: 'stopped' };
  });

  // Time log view (all)
  app.get('/api/time', async (req) => {
    const { customer_id, since } = req.query;
    let sql = `
      SELECT te.*, t.ticket_uid, t.subject, c.name as customer_name, c.id as customer_id,
             ${elapsedExpression('te')} AS elapsed_seconds
      FROM time_entries te
      JOIN tickets t ON te.ticket_id = t.id
      JOIN customers c ON t.customer_id = c.id
      WHERE te.stopped_at IS NOT NULL
    `;
    const args = [];
    if (customer_id) { sql += ' AND c.id = ?'; args.push(customer_id); }
    if (since) { sql += ' AND te.started_at >= ?'; args.push(since); }
    sql += ' ORDER BY te.started_at DESC LIMIT 200';
    return app.db.prepare(sql).all(...args).map(decorateTimer);
  });
}
