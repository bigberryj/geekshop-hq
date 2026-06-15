/**
 * Dashboard / Inbox endpoint.
 * Returns everything Byron needs to see on the Inbox page in one call:
 *   - open tickets
 *   - today's appointments
 *   - overdue invoices
 *   - follow-up nudges
 *   - top struggling customers (lowest health score)
 *   - EOD summary (if after 6pm)
 */

import { readFileSync, existsSync } from 'node:fs';
import { aiCall } from '../lib/ai.js';
import { summarizeCronJobs } from '../lib/cron-status.js';
import { readJsonSafe, readJsonlTail } from '../lib/appointment-email-state.js';

const HERMES_HOME = process.env.HERMES_HOME || '/home/byron/.hermes';

function readCronStatus() {
  try {
    const path = `${HERMES_HOME}/cron/jobs.json`;
    if (!existsSync(path)) return { enabled_count: 0, jobs: [] };
    return summarizeCronJobs(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return { enabled_count: 0, jobs: [] };
  }
}

function readMonitorStatus() {
  const appointmentLog = readJsonlTail(`${HERMES_HOME}/state/appointment-email-monitor/run_log.jsonl`, 8);
  const starredLog = readJsonlTail(`${HERMES_HOME}/state/starred-client-suggestions-log.jsonl`, 8);
  const pendingSlots = readJsonSafe(`${HERMES_HOME}/state/appointment-email-monitor/pending_slots.json`, {});
  return {
    appointments: {
      last_runs: appointmentLog,
      pending_count: Array.isArray(pendingSlots) ? pendingSlots.length : Object.keys(pendingSlots || {}).length,
    },
    starred_email_suggestions: {
      last_runs: starredLog,
    },
  };
}

export async function dashboardRoutes(app) {
  app.get('/api/dashboard', async (req, reply) => {
    const db = app.db;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(todayStart); todayEnd.setDate(todayEnd.getDate() + 1);

    const { source } = req.query;

    // Open tickets
    let openTicketSql = `
      SELECT t.id, t.ticket_uid, t.subject, t.priority, t.status, t.source, t.source_message_id, t.last_message_at,
             c.name as customer_name, c.id as customer_id
      FROM tickets t JOIN customers c ON t.customer_id = c.id
      WHERE t.status != 'resolved'
    `;
    const openTicketArgs = [];
    if (source && ['email', 'manual', 'booking'].includes(source)) {
      openTicketSql += ' AND t.source = ?';
      openTicketArgs.push(source);
    }
    openTicketSql += ' ORDER BY t.priority DESC, t.last_message_at ASC LIMIT 20';
    const openTickets = db.prepare(openTicketSql).all(...openTicketArgs);

    // Today's appointments
    const todayAppts = db.prepare(`
      SELECT a.*, c.name as customer_name
      FROM appointments a LEFT JOIN customers c ON a.customer_id = c.id
      WHERE a.starts_at >= ? AND a.starts_at < ?
      ORDER BY a.starts_at ASC
    `).all(todayStart.toISOString(), todayEnd.toISOString());

    // Overdue invoices
    const overdueInvoices = db.prepare(`
      SELECT i.id, i.invoice_uid, i.total_cents, i.due_at, c.name as customer_name
      FROM invoices i JOIN customers c ON i.customer_id = c.id
      WHERE i.status IN ('sent', 'overdue') AND i.due_at < datetime('now')
      ORDER BY i.due_at ASC
      LIMIT 10
    `).all();

    // Follow-up count (set by scheduler)
    const followUpCount = Number(db.prepare("SELECT value FROM settings WHERE key = 'follow_up_count'").get()?.value || 0);

    // Customer health scores (cheap_classify tier for derivation if we add it; for now compute inline)
    const healthScores = db.prepare(`
      SELECT c.id, c.name,
             (SELECT COUNT(*) FROM tickets WHERE customer_id = c.id) as total_tickets,
             (SELECT MAX(m.created_at) FROM ticket_messages m JOIN tickets t ON m.ticket_id = t.id WHERE t.customer_id = c.id) as last_contact
      FROM customers c
      ORDER BY c.id DESC
      LIMIT 5
    `).all().map((c) => {
      // Simple inline health: 100 - days_since_contact * 3, floor 0
      const last = c.last_contact ? new Date(c.last_contact) : null;
      const days = last ? Math.floor((Date.now() - last.getTime()) / 86400000) : 999;
      return { id: c.id, name: c.name, score: Math.max(0, 100 - days * 3) };
    });

    return {
      open_tickets: openTickets,
      today_appointments: todayAppts,
      overdue_invoices: overdueInvoices,
      follow_up_count: followUpCount,
      top_customers: healthScores,
      cron_status: readCronStatus(),
      monitor_status: readMonitorStatus(),
      generated_at: new Date().toISOString(),
    };
  });
}
