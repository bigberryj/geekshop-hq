/**
 * Invoice CRUD + send + status transitions.
 */

import { sendEmail } from '../lib/email.js';
import { renderInvoiceText, renderInvoiceHtml } from '../lib/invoice-renderer.js';
import {
  computeInvoiceTotals,
  applyLabourRate,
  applyMinimumChargeFloor,
  DEFAULT_TAX_MODEL,
  getTaxModel,
} from '../lib/tax.js';

function nextInvoiceUid(db) {
  const year = new Date().getFullYear();
  const last = db.prepare("SELECT invoice_uid FROM invoices WHERE invoice_uid LIKE ? ORDER BY id DESC LIMIT 1").get(`INV-${year}-%`);
  const n = last ? Number(last.invoice_uid.split('-')[2]) + 1 : 1;
  return `INV-${year}-${String(n).padStart(3, '0')}`;
}

// Read a setting with a sane default — never returns null/undefined.
function readSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value ?? fallback;
}

function intCents(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export async function invoiceRoutes(app) {
  // List
  app.get('/api/invoices', async (req) => {
    const { status, customer_id } = req.query;
    let sql = `
      SELECT i.*, c.name as customer_name
      FROM invoices i JOIN customers c ON i.customer_id = c.id
      WHERE 1=1
    `;
    const args = [];
    if (status) { sql += ' AND i.status = ?'; args.push(status); }
    if (customer_id) { sql += ' AND i.customer_id = ?'; args.push(customer_id); }
    sql += ' ORDER BY i.created_at DESC LIMIT 200';
    return app.db.prepare(sql).all(...args).map((inv) => ({ ...inv, line_items: JSON.parse(inv.line_items) }));
  });

  // Create
  app.post('/api/invoices', async (req, reply) => {
    const { customer_id, line_items, tax_model, tax_cents_override, due_at, notes } = req.body || {};
    if (!customer_id || !Array.isArray(line_items) || !line_items.length) {
      return reply.code(400).send({ error: 'customer_id and line_items required' });
    }

    // Tax model: per-invoice override > default setting > code default.
    const defaultModel = readSetting(app.db, 'default_tax_model', DEFAULT_TAX_MODEL);
    const effectiveModel = tax_model || defaultModel;
    const overrideCents = intCents(tax_cents_override);

    const totals = computeInvoiceTotals({
      model: effectiveModel,
      lineItems: line_items,
      tax_cents_override: overrideCents,
    });

    const uid = nextInvoiceUid(app.db);
    const info = app.db.prepare(`
      INSERT INTO invoices (invoice_uid, customer_id, line_items, subtotal_cents, tax_cents, total_cents, due_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uid, customer_id, JSON.stringify(line_items), totals.subtotal_cents, totals.tax_cents, totals.total_cents, due_at || null, notes || null);
    return {
      id: info.lastInsertRowid,
      invoice_uid: uid,
      ...totals,
    };
  });

  // Pre-fill helper: take a customer's un-invoiced time entries and convert
  // them into invoice line items at the configured labour rate, with the
  // optional private minimum-charge floor applied to labour lines.
  //
  // Body: {
  //   customer_id,
  //   tax_model?,
  //   min_charge_apply?: boolean      (default: true if min_charge_cents > 0)
  //   min_charge_cents_override?: number (per-invoice override of the setting)
  // }
  //
  // Returns: {
  //   line_items, ...tax totals,
  //   rate_cents_per_hour,
  //   floor: { applied, configured_cents, effective_cents, original_labour_subtotal_cents, boosted_labour_subtotal_cents }
  // }
  app.post('/api/invoices/draft-from-time', async (req, reply) => {
    const { customer_id, tax_model, min_charge_apply, min_charge_cents_override } = req.body || {};
    if (!customer_id) return reply.code(400).send({ error: 'customer_id required' });

    const rate = intCents(readSetting(app.db, 'labour_rate_cents_per_hour', 10000)); // default $100/h
    const entries = app.db.prepare(`
      SELECT te.id, te.started_at, te.stopped_at, te.duration_seconds, te.note
      FROM time_entries te
      JOIN tickets t ON te.ticket_id = t.id
      WHERE t.customer_id = ? AND te.duration_seconds IS NOT NULL
        AND te.invoiced_at IS NULL
      ORDER BY te.started_at ASC
    `).all(customer_id);

    const rawLines = applyLabourRate(entries, { rate_cents_per_hour: rate });
    if (!rawLines.length) {
      return reply.code(400).send({ error: 'no uninvoiced time entries for this customer' });
    }

    // Minimum charge floor. Default: applied if a floor is configured (> 0).
    const configuredFloor = intCents(readSetting(app.db, 'minimum_charge_cents', 0)) || 0;
    const overrideFloor = intCents(min_charge_cents_override);
    const effectiveFloor = overrideFloor != null ? overrideFloor : configuredFloor;
    const applyFloor = min_charge_apply === false ? false : effectiveFloor > 0;

    const floorResult = applyMinimumChargeFloor(rawLines, applyFloor ? effectiveFloor : 0);
    const lineItems = floorResult.line_items;

    const defaultModel = readSetting(app.db, 'default_tax_model', DEFAULT_TAX_MODEL);
    const totals = computeInvoiceTotals({
      model: tax_model || defaultModel,
      lineItems,
    });
    return {
      line_items: lineItems,
      ...totals,
      rate_cents_per_hour: rate,
      floor: {
        applied: floorResult.floor_applied,
        configured_cents: configuredFloor,
        effective_cents: applyFloor ? effectiveFloor : 0,
        original_labour_subtotal_cents: floorResult.original_labour_subtotal_cents,
        boosted_labour_subtotal_cents: floorResult.boosted_labour_subtotal_cents,
      },
    };
  });

  // Preview-only variant of draft-from-time. Same shape, but never creates
  // anything. Used by the Money page modal to show "here's what your invoice
  // would look like" before the user confirms.
  app.post('/api/invoices/draft-preview', async (req, reply) => {
    // Re-use the draft handler — it already only computes, doesn't persist.
    const res = await app.inject({
      method: 'POST',
      url: '/api/invoices/draft-from-time',
      payload: req.body || {},
    });
    reply.code(res.statusCode);
    return res.json();
  });

  // Mark selected time entries as invoiced (call after a successful create).
  // Body: { time_entry_ids: number[] }
  app.post('/api/time-entries/mark-invoiced', async (req, reply) => {
    const { time_entry_ids } = req.body || {};
    if (!Array.isArray(time_entry_ids) || !time_entry_ids.length) {
      return reply.code(400).send({ error: 'time_entry_ids required' });
    }
    const placeholders = time_entry_ids.map(() => '?').join(',');
    const info = app.db.prepare(
      `UPDATE time_entries SET invoiced_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders}) AND invoiced_at IS NULL`
    ).run(...time_entry_ids);
    return { ok: true, updated: info.changes };
  });

  // Detail
  app.get('/api/invoices/:id', async (req, reply) => {
    const inv = app.db.prepare(`
      SELECT i.*, c.name as customer_name, c.email as customer_email
      FROM invoices i JOIN customers c ON i.customer_id = c.id
      WHERE i.id = ?
    `).get(req.params.id);
    if (!inv) return reply.code(404).send({ error: 'not found' });
    return { ...inv, line_items: JSON.parse(inv.line_items) };
  });

  // Printable invoice HTML. Use browser Print → Save as PDF.
  app.get('/api/invoices/:id/print', async (req, reply) => {
    const inv = app.db.prepare(`
      SELECT i.*, c.name as customer_name, c.email as customer_email
      FROM invoices i JOIN customers c ON i.customer_id = c.id
      WHERE i.id = ?
    `).get(req.params.id);
    if (!inv) return reply.code(404).type('text/html').send('<h1>Invoice not found</h1>');
    // Re-derive the tax breakdown from the persisted subtotal so the print
    // page is correct even for older invoices that predate the
    // tax_lines column being saved. We re-run the configured model so
    // changing the default tax model later still shows the right numbers.
    const persisted = JSON.parse(inv.line_items || '[]');
    const model = readSetting(app.db, 'default_tax_model', DEFAULT_TAX_MODEL);
    const totals = computeInvoiceTotals({ model, lineItems: persisted });
    return reply.type('text/html; charset=utf-8').send(renderInvoiceHtml({
      ...inv,
      line_items: persisted,
      tax_lines: totals.tax_lines,
      tax_cents: totals.tax_cents,
      total_cents: totals.total_cents,
      business_name: readSetting(app.db, 'business_name', 'GeekShop Computers'),
      business_email: readSetting(app.db, 'business_email', 'byron@geekshop.ca'),
    }));
  });

  // Send
  app.post('/api/invoices/:id/send', async (req, reply) => {
    const inv = app.db.prepare(`
      SELECT i.*, c.name as customer_name, c.email as customer_email
      FROM invoices i JOIN customers c ON i.customer_id = c.id
      WHERE i.id = ?
    `).get(req.params.id);
    if (!inv) return reply.code(404).send({ error: 'not found' });
    if (!inv.customer_email) return reply.code(400).send({ error: 'customer has no email' });
    const persisted = JSON.parse(inv.line_items || '[]');
    const model = readSetting(app.db, 'default_tax_model', DEFAULT_TAX_MODEL);
    const totals = computeInvoiceTotals({ model, lineItems: persisted });
    const invoice = { ...inv, line_items: persisted, tax_lines: totals.tax_lines, tax_cents: totals.tax_cents, total_cents: totals.total_cents };
    const body = `Hi ${inv.customer_name},\n\n${renderInvoiceText(invoice)}`;
    const result = await sendEmail({ to: inv.customer_email, subject: `Invoice ${inv.invoice_uid} from GeekShop Computers`, text: body });
    if (result.sent) {
      app.db.prepare("UPDATE invoices SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    }
    return result;
  });

  // Mark paid
  app.post('/api/invoices/:id/paid', async (req, reply) => {
    app.db.prepare("UPDATE invoices SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    return { ok: true };
  });
}
