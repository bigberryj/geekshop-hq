/**
 * Public booking page — no auth, customer-facing.
 * The customer sees a simple form, fills it in, gets a confirmation.
 * Admin sees the new appointment in their dashboard.
 */

export async function bookingRoutes(app) {
  // Get the booking page config (simple: a slug + a friendly title)
  // In v1.5, slugs would map to a customizable page in settings.
  app.get('/api/booking/:slug', async (req, reply) => {
    const slug = req.params.slug;
    const config = {
      slug,
      title: 'Book an appointment with GeekShop Computers',
      description: 'Pick a time and we\'ll send you a confirmation email with a calendar invite.',
      submit_url: `/api/booking/${slug}`,
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
    return { id: info.lastInsertRowid, status: 'scheduled', message: 'Appointment booked. Check your email for confirmation.' };
  });
}
