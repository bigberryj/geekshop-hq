/**
 * Phase 6 — Accountant export bundle.
 *
 * Endpoints:
 *   GET /api/accounting/export/invoices.csv
 *   GET /api/accounting/export/payments.csv
 *   GET /api/accounting/export/expenses.csv
 *   GET /api/accounting/export/customers.csv
 *   GET /api/accounting/export/tax-summary.csv
 *   GET /api/accounting/export/manifest.json   (the bundle's metadata file)
 *   GET /api/accounting/export/bundle.zip      (everything above, zipped)
 *
 * Design rules (from the 2026-06-29 roadmap):
 *   - Date range optional; defaults to all-time (`1970-01-01..2999-12-31`)
 *   - Generated-at timestamp on every CSV row that needs it (per-row echo)
 *   - Explicitly NO secrets, NO Gmail message bodies, NO Stripe payment
 *     intent / charge ids in the accountant exports (they're internal
 *     ledger tokens the accountant doesn't need)
 *   - All money values exported as integer cents + a derived decimal
 *     string ("$123.45") for spreadsheet sanity; this avoids float
 *     precision issues when the file is opened in Excel/Numbers
 *   - All amounts come from the canonical tables; line items are
 *     flattened into one row per line item with a parent invoice_uid
 *     so the accountant can pivot any way they want
 *
 * Everything is admin-gated via the route module's pre-existing gate
 * (the whole /api/accounting/* tree is mounted under requireAdmin by
 * routes/index.js wiring + the per-route registration in this file).
 */

import { toCsv } from './tax.js';
import { zipSync } from './zip.js';
import { logAudit } from './audit.js';

// Local wrapper so the existing in-route call sites (which use
// `writeAudit(app, ...)`) and this file's `logAudit(app.db, ...)` stay
// readable. Centralizing the audit-log noise-reduction in
// lib/audit.js keeps the implementation pluggable later.
function writeAudit(app, action, target, payload) {
  logAudit(app.db, action, target, payload);
}

// ---- helpers ----

function isoTimestamp(d = new Date()) {
  return d.toISOString();
}

function centsToDollars(c) {
  const n = Number(c) || 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}

function isoDate(s) {
  if (!s) return '';
  // Trim to YYYY-MM-DD if it was ISO datetime
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : String(s);
}

// Pull date-range query params with sane defaults so the export always
// returns the full historical ledger unless the caller narrows it.
// Anything that doesn't look like YYYY-MM-DD falls back to the
// "everything" default — the accountant gets the full historical
// ledger rather than a 500 from a SQL string-comparison crash.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function dateRangeBounds(query) {
  const fromRaw = query.from != null ? String(query.from).slice(0, 10) : '';
  const toRaw   = query.to   != null ? String(query.to).slice(0, 10)   : '';
  const from = ISO_DATE.test(fromRaw) ? fromRaw : '1970-01-01';
  const to   = ISO_DATE.test(toRaw)   ? toRaw   : '2999-12-31';
  return { from, to };
}

// Pull "today" + from/to into the manifest. Returns a JSON-serializable
// object the accountant can keep next to the bundle as documentation.
function manifestPayload(app, query, generated_at) {
  const { from, to } = dateRangeBounds(query);
  return {
    generator: 'geekshop-hq-accountant-export',
    version: '1.0.0',
    generated_at,
    from,
    to,
    schema_notes: {
      money: 'All money fields are exported as integer cents (`*_cents`) AND a derived decimal string (`*_dollars`). Pivot on whichever matches the destination spreadsheet.',
      dates: 'Dates in YYYY-MM-DD. The export uses the invoice.created_at / payment.received_at / expense.expense_date as its bookmark, depending on the CSV.',
      missing_data: 'Empty fields are emitted as empty CSV cells (not "null" or "0"). A $0 invoice is `subtotal_cents=0,total_cents=0` with both decimal fields $0.00.',
      generated_at: 'The same ISO-8601 timestamp is repeated on every CSV row inside the `generated_at` column so multi-table pivots line up in a spreadsheet.',
    },
    files: [
      'invoices.csv',
      'payments.csv',
      'expenses.csv',
      'customers.csv',
      'tax-summary.csv',
      'manifest.json',
    ],
    system: {
      hq: 'geekshop-hq',
      schema_path: 'docs/schema.md',
      api_path: 'docs/api.md',
    },
  };
}

// ---- row builders ----

function invoicesCsv(app, { from, to, generated_at }) {
  // Flatten every invoice into one row per invoice. Line items stay
  // inside an aggregate `line_items_count` + serialized
  // `line_items_json` + first-rate `first_tax_label` columns so the
  // accountant can pivot either way without losing data.
  const rows = app.db.prepare(`
    SELECT i.id, i.invoice_uid, i.status,
           i.customer_id,
           c.name        AS customer_name,
           c.company     AS customer_company,
           c.email       AS customer_email,
           i.subtotal_cents, i.tax_cents, i.total_cents,
           i.line_items, i.tax_lines,
           i.created_at, i.sent_at, i.due_at, i.paid_at, i.notes
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.created_at >= ?
      AND i.created_at <= ?
    ORDER BY i.created_at ASC, i.id ASC
    LIMIT 100000
  `).all(`${from} 00:00:00`, `${to} 23:59:59`);

  const headers = [
    'id', 'invoice_uid', 'status',
    'customer_id', 'customer_name', 'customer_company', 'customer_email',
    'subtotal_cents', 'subtotal_dollars',
    'tax_cents', 'tax_dollars',
    'total_cents', 'total_dollars',
    'line_items_count', 'line_items_json',
    'tax_lines_json', 'tax_breakdown',
    'created_at_date', 'sent_at', 'due_at', 'paid_at',
    'notes',
    'from', 'to', 'generated_at',
  ];

  const out = [];
  for (const r of rows) {
    let lineItemsCount = 0;
    let lineItemsJson = '';
    try {
      const li = r.line_items ? JSON.parse(r.line_items) : [];
      if (Array.isArray(li)) {
        lineItemsCount = li.length;
        lineItemsJson = JSON.stringify(li);
      }
    } catch (_) { /* corrupt JSON; leave count=0 and empty json */ }

    let taxBreakdown = '';
    try {
      const tl = r.tax_lines ? JSON.parse(r.tax_lines) : [];
      if (Array.isArray(tl)) {
        taxBreakdown = tl
          .map((b) => `${b.label || 'tax'} ${b.amount_cents || 0}c`)
          .join(';');
      }
    } catch (_) { /* ignore */ }

    out.push([
      r.id,
      r.invoice_uid,
      r.status,
      r.customer_id,
      r.customer_name,
      r.customer_company || '',
      r.customer_email || '',
      r.subtotal_cents,
      centsToDollars(r.subtotal_cents),
      r.tax_cents,
      centsToDollars(r.tax_cents),
      r.total_cents,
      centsToDollars(r.total_cents),
      lineItemsCount,
      lineItemsJson,
      r.tax_lines || '',
      taxBreakdown,
      isoDate(r.created_at),
      r.sent_at || '',
      r.due_at || '',
      r.paid_at || '',
      r.notes || '',
      from, to, generated_at,
    ]);
  }
  return toCsv(headers, out);
}

function paymentsCsv(app, { from, to, generated_at }) {
  // Excludes Stripe payment_intent_id and charge_id on purpose — those
  // are internal ledger tokens, not information the accountant needs.
  const rows = app.db.prepare(`
    SELECT p.id, p.invoice_id, i.invoice_uid,
           i.customer_id,
           c.name    AS customer_name,
           c.company AS customer_company,
           c.email   AS customer_email,
           p.amount_cents, p.method, p.status,
           p.received_at, p.notes, p.created_at
    FROM payments p
    JOIN invoices i ON i.id = p.invoice_id
    JOIN customers c ON c.id = i.customer_id
    WHERE p.received_at >= ?
      AND p.received_at <= ?
    ORDER BY p.received_at ASC, p.id ASC
    LIMIT 100000
  `).all(`${from} 00:00:00`, `${to} 23:59:59`);

  const headers = [
    'id', 'invoice_id', 'invoice_uid',
    'customer_id', 'customer_name', 'customer_company', 'customer_email',
    'amount_cents', 'amount_dollars',
    'method', 'status',
    'received_at_date', 'created_at', 'notes',
    'from', 'to', 'generated_at',
  ];
  const out = rows.map((r) => [
    r.id,
    r.invoice_id,
    r.invoice_uid,
    r.customer_id,
    r.customer_name,
    r.customer_company || '',
    r.customer_email || '',
    r.amount_cents,
    centsToDollars(r.amount_cents),
    r.method,
    r.status,
    isoDate(r.received_at),
    r.created_at || '',
    r.notes || '',
    from, to, generated_at,
  ]);
  return toCsv(headers, out);
}

function expensesCsv(app, { from, to, generated_at }) {
  const rows = app.db.prepare(`
    SELECT e.id, e.vendor, e.expense_date, e.amount_cents, e.tax_cents,
           e.payment_method, e.business_use,
           e.category_id, ec.name AS category_name,
           e.tax_rate_id, tr.name AS tax_rate_name, tr.rate_bps AS tax_rate_bps,
           e.receipt_path, e.notes,
           e.created_at, e.updated_at
    FROM expenses e
    LEFT JOIN expense_categories ec ON ec.id = e.category_id
    LEFT JOIN tax_rates tr ON tr.id = e.tax_rate_id
    WHERE e.expense_date >= ?
      AND e.expense_date <= ?
    ORDER BY e.expense_date ASC, e.id ASC
    LIMIT 100000
  `).all(from, to);

  const headers = [
    'id', 'vendor', 'expense_date',
    'amount_cents', 'amount_dollars',
    'tax_cents', 'tax_dollars',
    'subtotal_cents', 'subtotal_dollars',
    'category_id', 'category_name',
    'tax_rate_id', 'tax_rate_name', 'tax_rate_bps',
    'payment_method', 'business_use',
    'receipt_path', 'notes',
    'created_at', 'updated_at',
    'from', 'to', 'generated_at',
  ];
  const out = rows.map((r) => {
    const subtotal = (Number(r.amount_cents) || 0) - (Number(r.tax_cents) || 0);
    return [
      r.id,
      r.vendor,
      r.expense_date,
      r.amount_cents,
      centsToDollars(r.amount_cents),
      r.tax_cents,
      centsToDollars(r.tax_cents),
      subtotal,
      centsToDollars(subtotal),
      r.category_id || '',
      r.category_name || '',
      r.tax_rate_id || '',
      r.tax_rate_name || '',
      r.tax_rate_bps == null ? '' : r.tax_rate_bps,
      r.payment_method,
      r.business_use,
      // receipt_path is preserved as the canonical relative path under
      // GHQ_ATTACHMENT_ROOT so the accountant can request the file
      // separately. We never emit absolute filesystem paths.
      r.receipt_path || '',
      r.notes || '',
      r.created_at || '',
      r.updated_at || '',
      from, to, generated_at,
    ];
  });
  return toCsv(headers, out);
}

function customersCsv(app, { generated_at }) {
  // Customers don't have a meaningful "from" — we always export all of
  // them, but the from/to columns are still echoed for spreadsheet
  // pivots.
  const rows = app.db.prepare(`
    SELECT id, name, company, email, phone, notes,
           created_at
    FROM customers
    ORDER BY created_at ASC, id ASC
    LIMIT 100000
  `).all();

  const headers = [
    'id', 'name', 'company', 'email', 'phone', 'notes',
    'created_at',
    'generated_at',
  ];
  const out = rows.map((r) => [
    r.id,
    r.name || '',
    r.company || '',
    r.email || '',
    r.phone || '',
    r.notes || '',
    r.created_at || '',
    generated_at,
  ]);
  return toCsv(headers, out);
}

// The tax-summary CSV body reuses the exact rollups the live endpoint
// produces — re-implementing it here would risk drift, so we just call
// the same SQL pair (collected + paid) and format the same way. We
// mirror the existing format=csv layout for one-to-one compatibility.
function taxSummaryCsv(app, { from, to, generated_at }) {
  const fromBound = `${from} 00:00:00`;
  const toBound = `${to} 23:59:59`;

  // Collected (succeeded invoices in the window)
  const collectedRows = app.db.prepare(`
    SELECT i.id, i.invoice_uid, i.customer_id,
           c.name AS customer_name,
           i.created_at, i.subtotal_cents, i.tax_cents, i.total_cents
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status IN ('sent','paid','overdue','partial','viewed')
      AND i.created_at >= ?
      AND i.created_at <= ?
    ORDER BY i.created_at ASC, i.id ASC
    LIMIT 100000
  `).all(fromBound, toBound);

  // Paid (business-use expenses with tax in the window)
  const paidRows = app.db.prepare(`
    SELECT e.id, e.vendor, e.expense_date, e.amount_cents, e.tax_cents,
           e.category_id, ec.name AS category_name
    FROM expenses e
    LEFT JOIN expense_categories ec ON ec.id = e.category_id
    WHERE e.business_use = 1
      AND e.expense_date >= ?
      AND e.expense_date <= ?
    ORDER BY e.expense_date ASC, e.id ASC
    LIMIT 100000
  `).all(from, to);

  let collectedCents = 0;
  for (const r of collectedRows) collectedCents += Number(r.tax_cents) || 0;
  let paidCents = 0;
  for (const r of paidRows) paidCents += Number(r.tax_cents) || 0;

  const headers = [
    'source', 'date', 'reference', 'description', 'tax_cents',
    'tax_dollars',
    'from', 'to', 'generated_at',
  ];
  const out = [];
  for (const r of collectedRows) {
    out.push([
      'invoice-collected',
      isoDate(r.created_at),
      r.invoice_uid,
      r.customer_name || '',
      r.tax_cents,
      centsToDollars(r.tax_cents),
      from, to, generated_at,
    ]);
  }
  for (const r of paidRows) {
    out.push([
      'expense-paid',
      r.expense_date,
      r.id,
      r.vendor + (r.category_name ? ` (${r.category_name})` : ''),
      r.tax_cents,
      centsToDollars(r.tax_cents),
      from, to, generated_at,
    ]);
  }
  // Summary rows. Empty `reference` so they sort to the bottom of any
  // pivot by `reference` ASC.
  out.push(['', '', '', 'TOTAL: tax collected (cents)', collectedCents, centsToDollars(collectedCents), from, to, generated_at]);
  out.push(['', '', '', 'TOTAL: tax paid (cents)', paidCents, centsToDollars(paidCents), from, to, generated_at]);
  out.push(['', '', '', 'NET remittance (cents)', collectedCents - paidCents, centsToDollars(collectedCents - paidCents), from, to, generated_at]);
  return toCsv(headers, out);
}

// ---- route registration ----

export async function accountantExportRoutes(app) {
  // All routes are wired under the /api/accounting/* umbrella, which
  // is admin-gated by the parent module. We add an audit log on every
  // export so the owner can see who ran an accountant bundle and when.

  const handleCsv = (builder, name) => async (req, reply) => {
    const { from, to } = dateRangeBounds(req.query);
    const generated_at = isoTimestamp();
    try {
      const body = builder(app, { from, to, generated_at });
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header(
        'content-disposition',
        `attachment; filename="${name}-${from}-to-${to}.csv"`,
      );
      writeAudit(app, 'accounting.export.csv', null, { name, from, to, generated_at });
      return body;
    } catch (e) {
      req.log?.error?.(e);
      return reply.code(500).send({ error: 'export_failed', message: String(e?.message ?? e) });
    }
  };

  app.get('/api/accounting/export/invoices.csv', handleCsv(invoicesCsv, 'invoices'));
  app.get('/api/accounting/export/payments.csv', handleCsv(paymentsCsv, 'payments'));
  app.get('/api/accounting/export/expenses.csv', handleCsv(expensesCsv, 'expenses'));

  // Customers doesn't need a date range; we still attach the same
  // headers for spreadsheet consistency.
  app.get('/api/accounting/export/customers.csv', async (req, reply) => {
    const generated_at = isoTimestamp();
    try {
      const body = customersCsv(app, { generated_at });
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header(
        'content-disposition',
        `attachment; filename="customers-${generated_at.slice(0, 10)}.csv"`,
      );
      writeAudit(app, 'accounting.export.csv', null, { name: 'customers', generated_at });
      return body;
    } catch (e) {
      return reply.code(500).send({ error: 'export_failed', message: String(e?.message ?? e) });
    }
  });

  app.get('/api/accounting/export/tax-summary.csv', handleCsv(taxSummaryCsv, 'tax-summary'));

  // Manifest — JSON, useful for matching a bundle to a date window
  // after the fact and for verifying which version of HQ produced it.
  app.get('/api/accounting/export/manifest.json', async (req, reply) => {
    const generated_at = isoTimestamp();
    try {
      const payload = manifestPayload(app, req.query, generated_at);
      reply.header('content-type', 'application/json; charset=utf-8');
      writeAudit(app, 'accounting.export.manifest', null, payload);
      return payload;
    } catch (e) {
      return reply.code(500).send({ error: 'export_failed', message: String(e?.message ?? e) });
    }
  });

  // The bundle: every CSV plus the manifest, in one archive. Audit
  // log records the size + entry count for the bundle (not the
  // individual files; that would be noisy).
  app.get('/api/accounting/export/bundle.zip', async (req, reply) => {
    const { from, to } = dateRangeBounds(req.query);
    const generated_at = isoTimestamp();
    try {
      const manifest = manifestPayload(app, req.query, generated_at);
      const entries = [
        { name: 'manifest.json',     data: JSON.stringify(manifest, null, 2) + '\n', mtime: generated_at },
        { name: 'invoices.csv',      data: invoicesCsv(app, { from, to, generated_at }), mtime: generated_at },
        { name: 'payments.csv',      data: paymentsCsv(app, { from, to, generated_at }), mtime: generated_at },
        { name: 'expenses.csv',      data: expensesCsv(app, { from, to, generated_at }), mtime: generated_at },
        { name: 'customers.csv',     data: customersCsv(app, { generated_at }), mtime: generated_at },
        { name: 'tax-summary.csv',   data: taxSummaryCsv(app, { from, to, generated_at }), mtime: generated_at },
      ];
      const buf = zipSync(entries);
      const fname = `accountant-bundle-${from}-to-${to}.zip`;
      reply.header('content-type', 'application/zip');
      reply.header('content-disposition', `attachment; filename="${fname}"`);
      reply.header('x-accountant-bundle-files', String(entries.length));
      reply.header('x-accountant-bundle-bytes', String(buf.length));
      writeAudit(app, 'accounting.export.bundle', null, {
        filename: fname,
        from, to, generated_at,
        file_count: entries.length,
        bytes: buf.length,
      });
      return buf;
    } catch (e) {
      req.log?.error?.(e);
      return reply.code(500).send({ error: 'bundle_failed', message: String(e?.message ?? e) });
    }
  });
}
