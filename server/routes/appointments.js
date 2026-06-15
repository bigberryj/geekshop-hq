/**
 * Appointment CRUD with confirmation + reminder logic.
 */

import { sendEmail, buildIcs } from '../lib/email.js';

export async function appointmentRoutes(app) {
  // List
  app.get('/api/appointments', async (req) => {
    const { from, to, status } = req.query;
    let sql = `
      SELECT a.*, c.name as customer_name, c.email as customer_email
      FROM appointments a LEFT JOIN customers c ON a.customer_id = c.id
      WHERE 1=1
    `;
    const args = [];
    if (from) { sql += ' AND a.starts_at >= ?'; args.push(from); }
    if (to) { sql += ' AND a.starts_at < ?'; args.push(to); }
    if (status) { sql += ' AND a.status = ?'; args.push(status); }
    sql += ' ORDER BY a.starts_at ASC LIMIT 200';
    return app.db.prepare(sql).all(...args);
  });

  // Create
  app.post('/api/appointments', async (req, reply) => {
    const { customer_id, customer_name, customer_email, starts_at, ends_at, notes, booking_slug } = req.body || {};
    if (!starts_at || !ends_at) return reply.code(400).send({ error: 'starts_at and ends_at required' });
    const info = app.db.prepare(`
      INSERT INTO appointments (customer_id, customer_name, customer_email, starts_at, ends_at, notes, booking_slug)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(customer_id || null, customer_name || null, customer_email || null, starts_at, ends_at, notes || null, booking_slug || null);

    // Send confirmation
    if (customer_email) {
      const ics = buildIcs({ uid: `appt-${info.lastInsertRowid}@geekshop.local`, start: starts_at, end: ends_at, summary: 'GeekShop appointment', description: notes || '' });
      await sendEmail({
        to: customer_email,
        subject: 'Appointment confirmed',
        text: `Hi ${customer_name || 'there'},\n\nYour appointment is confirmed for ${starts_at}.${notes ? '\n\nNotes: ' + notes : ''}`,
        ics,
      });
    }
    return { id: info.lastInsertRowid };
  });

  // Update
  app.patch('/api/appointments/:id', async (req, reply) => {
    const { status, notes } = req.body || {};
    const updates = [];
    const args = [];
    if (status) { updates.push('status = ?'); args.push(status); }
    if (notes !== undefined) { updates.push('notes = ?'); args.push(notes); }
    if (!updates.length) return reply.code(400).send({ error: 'nothing to update' });
    args.push(req.params.id);
    app.db.prepare(`UPDATE appointments SET ${updates.join(', ')} WHERE id = ?`).run(...args);
    return { ok: true };
  });
}
