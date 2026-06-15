/**
 * Money view — combines invoices + time entries for a unified financial view.
 */

function readSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value ?? fallback;
}

export async function moneyRoutes(app) {
  // Summary
  app.get('/api/money/summary', async () => {
    const db = app.db;
    const summary = {
      outstanding: db.prepare("SELECT COALESCE(SUM(total_cents), 0) as total, COUNT(*) as count FROM invoices WHERE status IN ('sent', 'overdue')").get(),
      overdue: db.prepare("SELECT COALESCE(SUM(total_cents), 0) as total, COUNT(*) as count FROM invoices WHERE status = 'overdue'").get(),
      paid_this_month: db.prepare("SELECT COALESCE(SUM(total_cents), 0) as total, COUNT(*) as count FROM invoices WHERE status = 'paid' AND paid_at >= datetime('now', 'start of month')").get(),
      draft: db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(total_cents), 0) as total FROM invoices WHERE status = 'draft'").get(),
    };
    summary.labour_rate_cents_per_hour = Number(readSetting(db, 'labour_rate_cents_per_hour', 10000));
    summary.default_tax_model = readSetting(db, 'default_tax_model', 'gst_pst_bc');
    return summary;
  });

  // Time revenue — uses the configured labour rate (not the $100/h default).
  // Optional ?rate_cents=N override for the admin's one-off calculation.
  app.get('/api/money/time-revenue', async (req) => {
    const configuredRate = Number(readSetting(app.db, 'labour_rate_cents_per_hour', 10000));
    const rateCents = req.query.rate_cents ? Number(req.query.rate_cents) : configuredRate;
    const db = app.db;
    const rows = db.prepare(`
      SELECT
        c.id as customer_id, c.name as customer_name,
        SUM(te.duration_seconds) as total_seconds,
        COUNT(DISTINCT te.ticket_id) as ticket_count
      FROM time_entries te
      JOIN tickets t ON te.ticket_id = t.id
      JOIN customers c ON t.customer_id = c.id
      WHERE te.duration_seconds IS NOT NULL
        AND te.started_at >= datetime('now', '-30 days')
      GROUP BY c.id
      ORDER BY total_seconds DESC
    `).all();
    return {
      rate_cents_per_hour: rateCents,
      configured_rate_cents_per_hour: configuredRate,
      rows: rows.map((r) => ({
        ...r,
        total_hours: Math.round((r.total_seconds / 3600) * 10) / 10,
        estimated_revenue_cents: Math.round((r.total_seconds / 3600) * rateCents),
      })),
    };
  });
}
