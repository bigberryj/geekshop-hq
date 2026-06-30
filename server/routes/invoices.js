/**
 * Invoice CRUD + send + status transitions.
 */

import { sendEmail } from '../lib/email.js';
import { renderInvoiceText, renderInvoiceHtml } from '../lib/invoice-renderer.js';
import { renderInvoicePdf } from '../lib/invoice-pdf.js';
import {
  computeInvoiceTotals,
  applyLabourRate,
  applyMinimumChargeFloor,
  normalizeLineItems,
  DEFAULT_TAX_MODEL,
  getTaxModel,
} from '../lib/tax.js';

function nextInvoiceUid(db) {
  const year = new Date().getFullYear();
  // Optional custom prefix override (e.g. "BYR" → "BYR-2026-001").
  // Falls back to "INV" so existing rows continue to render correctly.
  const customPrefix = readSetting(db, 'invoice_number_prefix', null);
  const prefix = (customPrefix && /^[A-Za-z0-9_-]{1,12}$/.test(customPrefix)) ? customPrefix : 'INV';
  const like = `${prefix}-${year}-%`;
  const last = db.prepare(`SELECT invoice_uid FROM invoices WHERE invoice_uid LIKE ? ORDER BY id DESC LIMIT 1`).get(like);
  if (!last) return `${prefix}-${year}-001`;
  const parts = String(last.invoice_uid).split('-');
  const tail = Number(parts[parts.length - 1]);
  const n = Number.isFinite(tail) ? tail + 1 : 1;
  return `${prefix}-${year}-${String(n).padStart(3, '0')}`;
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

/**
 * Load all active tax_rates from the accounting schema so per-line tax
 * can be resolved. Returns an array of {id, name, rate_bps} for the
 * computeInvoiceTotals helper.
 */
function loadTaxRates(db) {
  try {
    return db.prepare(`SELECT id, name, rate_bps, is_compound FROM tax_rates WHERE active = 1`).all();
  } catch {
    // tax_rates table may not exist on very old installs; the per-line
    // path then falls back to the global model (safe default).
    return [];
  }
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

  // Preview totals — pure compute, never persists anything. Used by the
  // Accounting invoice editor's live totals panel so the preview matches
  // what the server will save byte-for-byte (no drift between UI and DB).
  //
  // Body:
  //   { line_items: [...], tax_model?: string }
  //
  // Returns the same `totals` shape as the create/update handlers:
  //   { subtotal_cents, tax_lines, tax_cents, total_cents,
  //     tax_model_key, tax_model_label }
  //
  // Lines without their own tax_rate_id fall back to the configured
  // global tax model (default 'gst_pst_bc' → GST 5% + PST 7%), which is
  // what creates a single taxable line with no tax_rate and a price —
  // without this endpoint the editor preview would show $0 tax even
  // though the saved invoice had the right tax.
  app.post('/api/invoices/preview', async (req, reply) => {
    const { line_items, tax_model } = req.body || {};
    if (!Array.isArray(line_items)) {
      return reply.code(400).send({ error: 'line_items must be an array' });
    }
    const defaultModel = readSetting(app.db, 'default_tax_model', DEFAULT_TAX_MODEL);
    const effectiveModel = tax_model || defaultModel;
    const normalized = normalizeLineItems(line_items);
    const taxRates = loadTaxRates(app.db);
    const totals = computeInvoiceTotals({
      model: effectiveModel,
      lineItems: normalized,
      taxRates,
    });
    return totals;
  });

  // Create
  app.post('/api/invoices', async (req, reply) => {
    const { customer_id, line_items, tax_model, tax_cents_override, due_at, notes, status } = req.body || {};
    if (!customer_id || !Array.isArray(line_items) || !line_items.length) {
      return reply.code(400).send({ error: 'customer_id and line_items required' });
    }

    // Tax model: per-invoice override > default setting > code default.
    const defaultModel = readSetting(app.db, 'default_tax_model', DEFAULT_TAX_MODEL);
    const effectiveModel = tax_model || defaultModel;
    const overrideCents = intCents(tax_cents_override);

    // Normalize every line into both legacy and modern key sets, then
    // compute totals with per-line tax support when the Accounting
    // editor provided `taxable` + `tax_rate_id` on any line.
    const normalized = normalizeLineItems(line_items);
    const taxRates = loadTaxRates(app.db);
    const totals = computeInvoiceTotals({
      model: effectiveModel,
      lineItems: normalized,
      tax_cents_override: overrideCents,
      taxRates,
    });

    const uid = nextInvoiceUid(app.db);
    const initialStatus = status || 'draft';
    const info = app.db.prepare(`
      INSERT INTO invoices (invoice_uid, customer_id, line_items, subtotal_cents, tax_cents, total_cents, tax_lines, status, due_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uid,
      customer_id,
      JSON.stringify(normalized),
      totals.subtotal_cents,
      totals.tax_cents,
      totals.total_cents,
      JSON.stringify(totals.tax_lines),
      initialStatus,
      due_at || null,
      notes || null,
    );
    return {
      id: info.lastInsertRowid,
      invoice_uid: uid,
      status: initialStatus,
      ...totals,
    };
  });

  // Update — used by the Accounting invoice editor ("Edit" button).
  // Body shape matches POST. We recompute totals on every save because
  // the line items may have changed, and we re-persist tax_lines so the
  // print/PDF renderers don't have to re-derive them.
  app.put('/api/invoices/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const existing = app.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    if (existing.status === 'cancelled') {
      return reply.code(409).send({ error: 'cannot edit a cancelled invoice' });
    }

    const { customer_id, line_items, tax_model, tax_cents_override, due_at, notes, status } = req.body || {};
    if (!customer_id || !Array.isArray(line_items) || !line_items.length) {
      return reply.code(400).send({ error: 'customer_id and line_items required' });
    }

    const defaultModel = readSetting(app.db, 'default_tax_model', DEFAULT_TAX_MODEL);
    const effectiveModel = tax_model || defaultModel;
    const overrideCents = intCents(tax_cents_override);

    const normalized = normalizeLineItems(line_items);
    const taxRates = loadTaxRates(app.db);
    const totals = computeInvoiceTotals({
      model: effectiveModel,
      lineItems: normalized,
      tax_cents_override: overrideCents,
      taxRates,
    });

    const nextStatus = status || existing.status;
    app.db.prepare(`
      UPDATE invoices
      SET customer_id = ?, line_items = ?, subtotal_cents = ?, tax_cents = ?, total_cents = ?,
          tax_lines = ?, status = ?, due_at = ?, notes = ?
      WHERE id = ?
    `).run(
      customer_id,
      JSON.stringify(normalized),
      totals.subtotal_cents,
      totals.tax_cents,
      totals.total_cents,
      JSON.stringify(totals.tax_lines),
      nextStatus,
      due_at || null,
      notes || null,
      id,
    );
    // Audit it so the trail is clear.
    app.db.prepare(
      "INSERT INTO audit_log (actor, action, target, payload) VALUES ('admin', 'invoice.update', ?, ?)"
    ).run(String(id), JSON.stringify({
      subtotal_cents: totals.subtotal_cents,
      tax_cents: totals.tax_cents,
      total_cents: totals.total_cents,
    }));
    return app.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
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
    // Re-derive the tax breakdown from the persisted line items so the
    // print page is correct even for older invoices that predate the
    // tax_lines column being saved. We re-run the configured model so
    // changing the default tax model later still shows the right numbers.
    // We also re-run per-line tax using the live tax_rates so an
    // Accounting-created invoice with tax_rate_id lines still shows the
    // correct per-line breakdown.
    const persisted = JSON.parse(inv.line_items || '[]');
    const normalized = normalizeLineItems(persisted);
    const model = readSetting(app.db, 'default_tax_model', DEFAULT_TAX_MODEL);
    const taxRates = loadTaxRates(app.db);
    const totals = computeInvoiceTotals({ model, lineItems: normalized, taxRates });
    return reply.type('text/html; charset=utf-8').send(renderInvoiceHtml({
      ...inv,
      line_items: normalized,
      tax_lines: totals.tax_lines,
      tax_cents: totals.tax_cents,
      total_cents: totals.total_cents,
      business_name: readSetting(app.db, 'business_name', 'GeekShop Computers'),
      business_email: readSetting(app.db, 'business_email', 'byron@geekshop.ca'),
    }));
  });

  // PDF version of the invoice (pdfkit — no chromium dependency).
  app.get('/api/invoices/:id/pdf', async (req, reply) => {
    const inv = app.db.prepare(`
      SELECT i.*, c.name as customer_name, c.email as customer_email,
             c.billing_address, c.shipping_address, c.tax_number
      FROM invoices i JOIN customers c ON i.customer_id = c.id
      WHERE i.id = ?
    `).get(req.params.id);
    if (!inv) return reply.code(404).send({ error: 'not found' });
    const persisted = JSON.parse(inv.line_items || '[]');
    const normalized = normalizeLineItems(persisted);
    const model = readSetting(app.db, 'default_tax_model', DEFAULT_TAX_MODEL);
    const taxRates = loadTaxRates(app.db);
    const totals = computeInvoiceTotals({ model, lineItems: normalized, taxRates });
    let buf;
    try {
      buf = await renderInvoicePdf({
        ...inv,
        line_items: persisted,
        tax_lines: totals.tax_lines,
        tax_cents: totals.tax_cents,
        total_cents: totals.total_cents,
        business_name: readSetting(app.db, 'business_name', 'GeekShop Computers'),
        business_email: readSetting(app.db, 'business_email', 'byron@geekshop.ca'),
      });
    } catch (err) {
      app.log.error({ err }, 'PDF render failed');
      return reply.code(500).send({ error: 'pdf_render_failed', message: err.message });
    }
    reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${inv.invoice_uid}.pdf"`)
      .send(buf);
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
    const normalized = normalizeLineItems(persisted);
    const model = readSetting(app.db, 'default_tax_model', DEFAULT_TAX_MODEL);
    const taxRates = loadTaxRates(app.db);
    const totals = computeInvoiceTotals({ model, lineItems: normalized, taxRates });
    const invoice = { ...inv, line_items: normalized, tax_lines: totals.tax_lines, tax_cents: totals.tax_cents, total_cents: totals.total_cents };
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

  // Generic status transition (draft | sent | viewed | overdue | paid | cancelled).
  // Viewed is set by a customer-side link; cancelled is admin-only.
  app.post('/api/invoices/:id/status', async (req, reply) => {
    const ALLOWED = ['draft', 'sent', 'viewed', 'overdue', 'paid', 'cancelled'];
    const next = String(req.body?.status || '');
    if (!ALLOWED.includes(next)) {
      return reply.code(400).send({ error: `status must be one of ${ALLOWED.join(', ')}` });
    }
    const inv = app.db.prepare('SELECT id, status FROM invoices WHERE id = ?').get(req.params.id);
    if (!inv) return reply.code(404).send({ error: 'not found' });
    // Audit the transition so we have a clean trail of who changed what.
    app.db.prepare(
      "INSERT INTO audit_log (actor, action, target, payload) VALUES ('admin', 'invoice.status', ?, ?)"
    ).run(String(inv.id), JSON.stringify({ from: inv.status, to: next }));
    // Side effects: paid → stamp paid_at; cancelled → leave paid_at alone.
    if (next === 'paid') {
      app.db.prepare("UPDATE invoices SET status = ?, paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP) WHERE id = ?")
        .run(next, req.params.id);
    } else {
      app.db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(next, req.params.id);
    }
    return app.db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  });
}
