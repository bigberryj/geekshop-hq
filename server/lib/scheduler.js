/**
 * Background scheduler — runs every 5 minutes.
 *
 * Jobs:
 *   1. EOD summary at 18:00 local time
 *   2. Appointment reminder 24h before
 *   3. Follow-up nudges for tickets idle 7+ days
 *   4. Invoice overdue reminder (7/14/30 days)
 *   5. Recurring-pattern detection (daily at 02:00)
 */

import { aiCall } from './ai.js';
import { sendEmail } from './email.js';

let interval = null;
let lastEodDate = null;
let lastPatternDate = null;

export function startScheduler(app) {
  if (interval) return;
  interval = setInterval(() => tick(app), 5 * 60 * 1000);  // 5 min
  app.log.info('scheduler started (5min tick)');
  // Run once on boot
  setTimeout(() => tick(app), 5000);
}

export function stopScheduler() {
  if (interval) clearInterval(interval);
  interval = null;
}

async function tick(app) {
  const now = new Date();
  const hh = now.getHours();
  const mm = now.getMinutes();
  const today = now.toISOString().slice(0, 10);

  try {
    // 1. EOD summary at 18:00
    if (hh === 18 && mm < 5 && lastEodDate !== today) {
      lastEodDate = today;
      await sendEodSummary(app);
    }

    // 2. Appointment reminders 24h ahead — run every tick between 8am-9am
    if (hh === 8 && mm < 5) {
      await sendAppointmentReminders(app);
    }

    // 3. Follow-up nudges for tickets idle 7+ days — daily at 9am
    if (hh === 9 && mm < 5) {
      await sendFollowUpNudges(app);
    }

    // 4. Invoice overdue — daily at 10am
    if (hh === 10 && mm < 5) {
      await sendInvoiceOverdueReminders(app);
    }

    // 5. Recurring pattern detection — daily at 02:00
    if (hh === 2 && mm < 5 && lastPatternDate !== today) {
      lastPatternDate = today;
      await detectRecurringPatterns(app);
    }
  } catch (err) {
    app.log.error({ err: err.message }, 'scheduler tick error');
  }
}

async function sendEodSummary(app) {
  const db = app.db;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const tomorrow = new Date(todayStart); tomorrow.setDate(tomorrow.getDate() + 1);

  const stats = {
    tickets_open: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'open'").get().c,
    tickets_resolved_today: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'resolved' AND resolved_at >= ?").get(todayStart.toISOString()).c,
    tickets_over_48h: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status != 'resolved' AND last_message_at < datetime('now', '-2 days')").get().c,
    invoices_overdue: db.prepare("SELECT COUNT(*) as c FROM invoices WHERE status = 'overdue'").get().c,
    appts_tomorrow: db.prepare("SELECT COUNT(*) as c FROM appointments WHERE starts_at >= ? AND starts_at < ?").get(tomorrow.toISOString(), new Date(tomorrow.getTime() + 86400000).toISOString()).c,
  };

  const body = await aiCall('high_reasoning',
    `Compose a 5-6 line end-of-day email for a solo business owner. Stats: ${JSON.stringify(stats)}. Be specific and actionable.`,
    { system: 'You write concise, friendly end-of-day business summaries.' }
  );

  const adminEmail = process.env.ADMIN_EMAIL || 'byron@geekshop.ca';
  await sendEmail({ to: adminEmail, subject: 'Your GeekShop HQ end-of-day summary', text: body });
  app.log.info('EOD summary sent');
}

async function sendAppointmentReminders(app) {
  const db = app.db;
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const tStart = tomorrow.toISOString().slice(0, 10);
  const appts = db.prepare(`
    SELECT a.*, c.name as customer_name, c.email as customer_email
    FROM appointments a LEFT JOIN customers c ON a.customer_id = c.id
    WHERE a.starts_at LIKE ? AND a.status = 'scheduled'
  `).all(`${tStart}%`);
  for (const a of appts) {
    const email = a.customer_email || a.customer_name;
    if (!email) continue;
    await sendEmail({
      to: email,
      subject: 'Reminder: appointment tomorrow',
      text: `Hi ${a.customer_name || 'there'}, this is a reminder of your appointment scheduled for ${a.starts_at}.${a.notes ? '\n\nNotes: ' + a.notes : ''}`,
    });
  }
  if (appts.length) app.log.info(`Sent ${appts.length} appointment reminders`);
}

async function sendFollowUpNudges(app) {
  const db = app.db;
  const stale = db.prepare(`
    SELECT t.id, t.ticket_uid, t.subject, c.name as customer_name
    FROM tickets t JOIN customers c ON t.customer_id = c.id
    WHERE t.status != 'resolved' AND t.last_message_at < datetime('now', '-7 days')
  `).all();
  // We don't email these — surface them in the Inbox via the dashboard query.
  // This function is a hook for v1.5 where we'd email a digest.
  if (stale.length) app.log.info(`${stale.length} tickets idle 7+ days (surfaced in Inbox)`);
  // Stash the count so the dashboard query can read it
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('follow_up_count', ?)").run(String(stale.length));
}

async function sendInvoiceOverdueReminders(app) {
  const db = app.db;
  const now = new Date();
  const due = db.prepare(`
    SELECT i.*, c.name as customer_name, c.email as customer_email
    FROM invoices i JOIN customers c ON i.customer_id = c.id
    WHERE i.status = 'sent' AND i.due_at < ?
  `).all(now.toISOString());
  for (const inv of due) {
    db.prepare("UPDATE invoices SET status = 'overdue' WHERE id = ?").run(inv.id);
    if (inv.customer_email) {
      await sendEmail({
        to: inv.customer_email,
        subject: `Invoice ${inv.invoice_uid} is now overdue`,
        text: `Hi ${inv.customer_name}, invoice ${inv.invoice_uid} for $${(inv.total_cents / 100).toFixed(2)} was due ${inv.due_at}. Please let us know if you have any questions.`,
      });
    }
  }
  if (due.length) app.log.info(`Marked ${due.length} invoices overdue + sent reminders`);
}

async function detectRecurringPatterns(app) {
  const db = app.db;
  // Look for customers with 3+ tickets in the last 6 months and compute median gap
  const customers = db.prepare(`
    SELECT customer_id, COUNT(*) as c, MIN(created_at) as first, MAX(created_at) as last
    FROM tickets
    WHERE created_at > datetime('now', '-6 months')
    GROUP BY customer_id
    HAVING c >= 3
  `).all();
  let newPatterns = 0;
  for (const c of customers) {
    const gaps = db.prepare(`
      SELECT julianday(created_at) - julianday(LAG(created_at) OVER (ORDER BY created_at)) as gap
      FROM tickets WHERE customer_id = ?
    `).all(c.customer_id).map((r) => r.gap).filter((g) => g > 0);
    if (gaps.length < 2) continue;
    gaps.sort((a, b) => a - b);
    const medianGap = Math.round(gaps[Math.floor(gaps.length / 2)]);
    if (medianGap < 14 || medianGap > 365) continue;  // ignore < 2 weeks or > 1 year
    const existing = db.prepare('SELECT id FROM recurring_patterns WHERE customer_id = ? AND pattern_type = ?').get(c.customer_id, 'ticket');
    if (existing) continue;
    db.prepare(`
      INSERT INTO recurring_patterns (customer_id, pattern_type, frequency_days, last_occurrence, next_occurrence)
      VALUES (?, 'ticket', ?, ?, datetime(?, '+' || ? || ' days'))
    `).run(c.customer_id, medianGap, c.last, c.last, medianGap);
    newPatterns++;
  }
  if (newPatterns) app.log.info(`Detected ${newPatterns} new recurring patterns`);
}
