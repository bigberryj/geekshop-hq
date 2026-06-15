/**
 * Public booking page — no auth, customer-facing.
 * The customer sees a simple form, fills it in, gets a confirmation.
 * Admin sees the new appointment in their dashboard.
 */

import { buildAvailableSlots } from '../lib/booking-slots.js';
import { sendEmail, buildIcs } from '../lib/email.js';

export async function bookingRoutes(app) {
  // Get the booking page config (simple: a slug + a friendly title)
  // In v1.5, slugs would map to a customizable page in settings.
  app.get('/api/booking/:slug', async (req, reply) => {
    const slug = req.params.slug;
    const upcoming = app.db.prepare(`
      SELECT starts_at, ends_at FROM appointments
      WHERE status != 'cancelled' AND ends_at >= datetime('now')
      ORDER BY starts_at ASC
      LIMIT 200
    `).all();
    const config = {
      slug,
      title: 'Book an appointment with GeekShop Computers',
      description: 'Pick a time and we\'ll send you a confirmation email with a calendar invite.',
      submit_url: `/api/booking/${slug}`,
      slot_minutes: 90,
      available_slots: buildAvailableSlots({ appointments: upcoming, maxSlots: 24 }),
    };
    return config;
  });

  // Submit a booking
  app.post('/api/booking/:slug', async (req, reply) => {
    const { name, email, starts_at, ends_at, notes } = req.body || {};
    if (!name || !email || !starts_at || !ends_at) {
      return reply.code(400).send({ error: 'name, email, starts_at, ends_at required' });
    }
    // Check no conflicting appointment in the slot
    const conflict = app.db.prepare(`
      SELECT id FROM appointments WHERE status != 'cancelled' AND starts_at < ? AND ends_at > ?
    `).get(ends_at, starts_at);
    if (conflict) return reply.code(409).send({ error: 'slot already booked' });

    const info = app.db.prepare(`
      INSERT INTO appointments (customer_name, customer_email, starts_at, ends_at, notes, booking_slug)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, email, starts_at, ends_at, notes || null, req.params.slug);

    // Best-effort confirmation email. Booking itself should still succeed if SMTP is down.
    let email_result = null;
    try {
      const ics = buildIcs({
        uid: `booking-${info.lastInsertRowid}@geekshop.ca`,
        start: starts_at,
        end: ends_at,
        summary: 'GeekShop appointment',
        description: notes || '',
      });
      email_result = await sendEmail({
        to: email,
        subject: 'GeekShop appointment request received',
        text: `Hi ${name},\n\nThanks — I received your appointment request for ${new Date(starts_at).toLocaleString()}.\n\n${notes ? `Notes: ${notes}\n\n` : ''}If anything changes, just reply to this email.\n\nThanks,\nByron\nGeekShop Computers\n`,
        ics,
      });
    } catch (e) {
      email_result = { sent: false, error: e.message };
    }

    return { id: info.lastInsertRowid, status: 'scheduled', message: 'Appointment request received. Check your email for confirmation.', email_sent: Boolean(email_result?.sent) };
  });
}
