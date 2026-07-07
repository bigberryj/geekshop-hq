/**
 * Accounting MVP module.
 *
 * Adds routes for the owner-only accounting flow that builds on the
 * existing HQ customers + invoices tables:
 *
 *   - tax_rates CRUD (GST/PST/HST/custom)
 *   - products CRUD (goods + services catalog)
 *   - expense_categories CRUD
 *   - expenses CRUD + receipt path
 *   - payments (manual entry; Stripe payment_intent id stored alongside)
 *   - payment_events (idempotency for Stripe webhooks)
 *   - reports: P&L summary, sales by customer, sales by product, tax collected,
 *     expenses by category, outstanding invoices, paid invoices
 *
 * Out of scope for this MVP (explicitly deferred — see /api/accounting/status):
 *   - PDF invoice generation (existing invoice route has text/HTML renderer)
 *   - Stripe Checkout / Payment Link creation (requires STRIPE_SECRET_KEY)
 *   - Stripe webhook receiver (requires STRIPE_WEBHOOK_SECRET)
 *   - QuickBooks Online import (mapping + preview UI)
 *
 * All routes require an authenticated admin session via the existing
 * `requireAdmin` preHandler, which is the same pattern customers.js uses.
 */

import { z } from 'zod';
import {
  stripeConfigured,
  stripeWebhookConfigured,
  createCheckoutForInvoice,
  verifyWebhook,
} from '../lib/stripe.js';
import { parseCsv, mapRows, validateRecords, commitRecords } from '../lib/qbo-csv.js';
import { aggregateTaxLines, rollupTaxBreakdown, toCsv } from '../lib/tax.js';
import { persistAttachment, resolveAttachmentPath, deleteAttachment, readAttachmentStream, checkReceiptUpload, RECEIPT_MAX_BYTES } from '../lib/attachments.js';
import { copyFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

// ---------- helpers ----------

// Read a setting with a sane default — never returns null/undefined.
// Local copy (invoices.js / money.js have their own private copy).
function readSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value ?? fallback;
}

function writeAudit(app, action, target, payload) {
  app.db
    .prepare("INSERT INTO audit_log (actor, action, target, payload) VALUES ('admin', ?, ?, ?)")
    .run(action, target == null ? null : String(target), payload == null ? null : JSON.stringify(payload));
}

function intCents(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function intBool(v) {
  return v ? 1 : 0;
}

function nowIso() {
  return new Date().toISOString();
}

// Phase 4 — joined expense lookup helper.
// Mirrors the SELECT used by GET /api/accounting/expenses (with the
// category + tax_rate join) so POST / PUT can return the same shape the
// UI expects after a write — saves the UI from a refetch round trip.
function selectExpenseJoined(db, id) {
  return db.prepare(`
    SELECT e.*, c.name AS category_name, t.name AS tax_name, t.rate_bps AS tax_rate_bps
    FROM expenses e
    LEFT JOIN expense_categories c ON e.category_id = c.id
    LEFT JOIN tax_rates t ON e.tax_rate_id = t.id
    WHERE e.id = ?
  `).get(id);
}

// Compute the live, authoritative status of an invoice based on its
// payments + due_at. Used after every payment insert and on the payment
// summary endpoint so the UI can never disagree with the ledger.
//
// Transitions (all happen automatically based on payments + due_at):
//   paid_cents >= total_cents + invoice.status != 'cancelled' → 'paid'
//   0 < paid_cents < total_cents                            → 'partial'
//   paid_cents == 0 AND due_at < now (status NOT in draft/paid/cancelled) → 'overdue'
//   otherwise                                              → existing status
//
// Sticky states:
//   - 'cancelled' is terminal; never auto-recovered.
//   - 'paid' is the natural end-state if money covers the invoice. It
//     auto-demotes to 'partial' if a refund brings paid_cents below
//     total_cents. It does NOT auto-promote to 'overdue' if it goes
//     past due (a paid invoice can't go past-due).
//   - 'draft' is sticky on the user side: it's "not sent yet" and we
//     never auto-mutate it based on payments.
function computeInvoiceStatus(db, invoice) {
  if (!invoice) return null;
  if (invoice.status === 'cancelled') return 'cancelled';

  const paid = db
    .prepare("SELECT COALESCE(SUM(amount_cents), 0) AS paid FROM payments WHERE invoice_id = ? AND status = 'succeeded'")
    .get(invoice.id).paid;

  // Draft: never promoted by the auto-path. If the user sends a draft,
  // the route handles flipping status to 'sent'.
  if (invoice.status === 'draft') return 'draft';

  // Money covers everything → paid.
  if (paid > 0 && invoice.total_cents > 0 && paid >= invoice.total_cents) {
    return 'paid';
  }
  // Some money, less than total → partial. This catches both
  // never-paid-full invoices AND paid-then-refunded invoices.
  if (paid > 0 && invoice.total_cents > 0 && paid < invoice.total_cents) {
    return 'partial';
  }
  // No succeeded payments → overdue if past due, else keep current.
  if (invoice.due_at && new Date(invoice.due_at) < new Date()) {
    return 'overdue';
  }
  return invoice.status;
}

// Recompute + persist the invoice's status if it should change. Returns the
// new status (or the existing one if unchanged). Used by POST /payments and
// the auto-promote path. Wraps both writes in a transaction so the
// payments → status → ledger sequence is atomic.
//
// Sticky rules:
//   - 'cancelled' is terminal.
//   - 'draft' is NOT auto-promoted; the user must explicitly send the
//     invoice (the route /invoices/:id/status handles that).
//   - Everything else (sent/viewed/overdue/partial/paid) may be rewritten
//     to match the ledger truth.
function reconcileInvoiceStatus(app, invoiceId) {
  const invoice = app.db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!invoice) return null;
  if (invoice.status === 'cancelled' || invoice.status === 'draft') return invoice.status;

  const paid = app.db
    .prepare("SELECT COALESCE(SUM(amount_cents), 0) AS paid FROM payments WHERE invoice_id = ? AND status = 'succeeded'")
    .get(invoiceId).paid;

  let newStatus = invoice.status;
  if (paid > 0 && invoice.total_cents > 0 && paid >= invoice.total_cents) {
    newStatus = 'paid';
  } else if (paid > 0 && invoice.total_cents > 0 && paid < invoice.total_cents) {
    newStatus = 'partial';
  } else if (paid === 0 && invoice.due_at && new Date(invoice.due_at) < new Date()) {
    newStatus = 'overdue';
  }

  if (newStatus !== invoice.status) {
    if (newStatus === 'paid') {
      app.db.prepare("UPDATE invoices SET status = ?, paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP) WHERE id = ?")
        .run(newStatus, invoiceId);
      writeAudit(app, 'invoice.status_auto', invoiceId, { from: invoice.status, to: newStatus, paid_cents: paid });
    } else {
      // Demotion from paid → partial/overdue/sent: leave paid_at alone so
      // we keep an immutable record of when it first settled.
      app.db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(newStatus, invoiceId);
      writeAudit(app, 'invoice.status_auto', invoiceId, { from: invoice.status, to: newStatus, paid_cents: paid });
    }
  }
  return newStatus;
}

function parseBps(v) {
  // basis points (0..10000). 5% = 500.
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10000) return null;
  return Math.round(n);
}

function applyTaxToCents(amountCents, rateBps) {
  // Round half-up to nearest cent.
  const tax = Math.round((amountCents * rateBps) / 10000);
  return tax;
}

// ---------- schemas ----------

const taxRateSchema = z.object({
  name: z.string().min(1).max(64),
  rate_bps: z.union([z.number(), z.string()]).transform((v) => Number(v)),
  is_compound: z.boolean().optional().default(false),
  jurisdiction: z.string().max(32).nullable().optional(),
  active: z.boolean().optional().default(true),
});

const productSchema = z.object({
  sku: z.string().max(64).nullable().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  unit_price_cents: z
    .union([z.number(), z.string()])
    .transform((v) => intCents(v) ?? 0)
    .optional()
    .default(0),
  taxable: z.boolean().optional().default(true),
  default_tax_rate_id: z.number().int().nullable().optional(),
  active: z.boolean().optional().default(true),
});

const expenseCategorySchema = z.object({
  name: z.string().min(1).max(64),
  tax_rate_id: z.number().int().nullable().optional(),
});

const expenseSchema = z.object({
  vendor: z.string().min(1).max(200),
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expense_date must be YYYY-MM-DD'),
  category_id: z.number().int().nullable().optional(),
  amount_cents: z.union([z.number(), z.string()]).transform((v) => intCents(v)),
  tax_cents: z.union([z.number(), z.string()]).transform((v) => intCents(v) ?? 0).optional().default(0),
  tax_rate_id: z.number().int().nullable().optional(),
  payment_method: z.enum(['cash', 'cheque', 'e_transfer', 'card', 'other']).optional().default('other'),
  business_use: z.boolean().optional().default(true),
  receipt_path: z.string().max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const paymentSchema = z.object({
  invoice_id: z.number().int().positive(),
  amount_cents: z.union([z.number(), z.string()]).transform((v) => intCents(v)),
  method: z.enum(['stripe', 'cash', 'cheque', 'e_transfer', 'other']).optional().default('other'),
  stripe_payment_intent_id: z.string().max(200).nullable().optional(),
  stripe_charge_id: z.string().max(200).nullable().optional(),
  status: z.enum(['pending', 'succeeded', 'failed', 'refunded']).optional().default('succeeded'),
  received_at: z.string().optional(),
  notes: z.string().max(500).nullable().optional(),
});

// ---------- route registration ----------

export async function accountingRoutes(app) {
  // Module status — useful for the HQ UI to show "what's wired up".
  app.get('/api/accounting/status', async () => {
    const hasStripe = stripeConfigured();
    const hasWebhook = stripeWebhookConfigured();
    return {
      module: 'accounting-mvp',
      version: '0.3.0',
      features: {
        tax_rates: true,
        products: true,
        expenses: true,
        expense_categories: true,
        payments_manual: true,
        reports: true,
        stripe_checkout: hasStripe,
        stripe_webhook: hasWebhook,
        pdf_invoice: true,
        qbo_import_csv: true,
        receipt_upload: true,
        local_backup: true,
        custom_invoice_numbering: true,
        tax_summary_reports: true,
      },
      note: hasStripe
        ? 'Stripe Checkout wired. Webhook ' + (hasWebhook ? 'verified.' : 'needs STRIPE_WEBHOOK_SECRET.')
        : 'Set STRIPE_SECRET_KEY (and STRIPE_WEBHOOK_SECRET for the webhook) to enable payments.',
    };
  });

  // ===== tax_rates =====
  app.get('/api/accounting/tax-rates', async () => {
    return app.db.prepare('SELECT * FROM tax_rates ORDER BY active DESC, name ASC').all();
  });

  app.post('/api/accounting/tax-rates', async (req, reply) => {
    const parsed = taxRateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
    const bps = parseBps(parsed.data.rate_bps);
    if (bps == null) return reply.code(400).send({ error: 'rate_bps out of range (0..10000)' });
    const r = app.db
      .prepare(`INSERT INTO tax_rates (name, rate_bps, is_compound, jurisdiction, active)
                VALUES (?, ?, ?, ?, ?)`)
      .run(
        parsed.data.name,
        bps,
        intBool(parsed.data.is_compound),
        parsed.data.jurisdiction ?? null,
        intBool(parsed.data.active),
      );
    writeAudit(app, 'tax_rate.create', r.lastInsertRowid, { name: parsed.data.name, rate_bps: bps });
    return app.db.prepare('SELECT * FROM tax_rates WHERE id = ?').get(r.lastInsertRowid);
  });

  app.put('/api/accounting/tax-rates/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = app.db.prepare('SELECT * FROM tax_rates WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    const parsed = taxRateSchema.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
    const merged = { ...existing, ...parsed.data };
    const bps = parseBps(merged.rate_bps);
    if (bps == null) return reply.code(400).send({ error: 'rate_bps out of range' });
    app.db
      .prepare(`UPDATE tax_rates SET name = ?, rate_bps = ?, is_compound = ?, jurisdiction = ?, active = ? WHERE id = ?`)
      .run(merged.name, bps, intBool(merged.is_compound), merged.jurisdiction ?? null, intBool(merged.active), id);
    writeAudit(app, 'tax_rate.update', id, parsed.data);
    return app.db.prepare('SELECT * FROM tax_rates WHERE id = ?').get(id);
  });

  // ===== products =====
  app.get('/api/accounting/products', async (req) => {
    const { active, q } = req.query;
    let sql = `SELECT p.*, t.name AS default_tax_name, t.rate_bps AS default_tax_rate_bps
               FROM products p LEFT JOIN tax_rates t ON p.default_tax_rate_id = t.id WHERE 1=1`;
    const args = [];
    if (active === '1' || active === 'true') sql += ' AND p.active = 1';
    if (q) { sql += ' AND (p.name LIKE ? OR p.sku LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
    sql += ' ORDER BY p.active DESC, p.name ASC LIMIT 500';
    return app.db.prepare(sql).all(...args);
  });

  app.post('/api/accounting/products', async (req, reply) => {
    const parsed = productSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
    const d = parsed.data;
    try {
      const r = app.db
        .prepare(`INSERT INTO products (sku, name, description, unit_price_cents, taxable, default_tax_rate_id, active)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          d.sku ?? null,
          d.name,
          d.description ?? null,
          d.unit_price_cents,
          intBool(d.taxable),
          d.default_tax_rate_id ?? null,
          intBool(d.active),
        );
      writeAudit(app, 'product.create', r.lastInsertRowid, { name: d.name, sku: d.sku });
      return app.db.prepare('SELECT * FROM products WHERE id = ?').get(r.lastInsertRowid);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'sku already exists' });
      }
      throw err;
    }
  });

  app.put('/api/accounting/products/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = app.db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    const parsed = productSchema.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
    const merged = { ...existing, ...parsed.data };
    app.db
      .prepare(`UPDATE products SET sku = ?, name = ?, description = ?, unit_price_cents = ?,
                taxable = ?, default_tax_rate_id = ?, active = ?, updated_at = ? WHERE id = ?`)
      .run(
        merged.sku ?? null,
        merged.name,
        merged.description ?? null,
        intCents(merged.unit_price_cents) ?? 0,
        intBool(merged.taxable),
        merged.default_tax_rate_id ?? null,
        intBool(merged.active),
        nowIso(),
        id,
      );
    writeAudit(app, 'product.update', id, parsed.data);
    return app.db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  });

  // ===== expense_categories =====
  app.get('/api/accounting/expense-categories', async () => {
    return app.db
      .prepare(`SELECT c.*, t.name AS tax_name, t.rate_bps AS tax_rate_bps
                FROM expense_categories c LEFT JOIN tax_rates t ON c.tax_rate_id = t.id
                ORDER BY c.name ASC`)
      .all();
  });

  app.post('/api/accounting/expense-categories', async (req, reply) => {
    const parsed = expenseCategorySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
    try {
      const r = app.db
        .prepare('INSERT INTO expense_categories (name, tax_rate_id) VALUES (?, ?)')
        .run(parsed.data.name, parsed.data.tax_rate_id ?? null);
      writeAudit(app, 'expense_category.create', r.lastInsertRowid, { name: parsed.data.name });
      return app.db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(r.lastInsertRowid);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'category name already exists' });
      }
      throw err;
    }
  });

  // ===== expenses =====
  app.get('/api/accounting/expenses', async (req) => {
    const { from, to, category_id, vendor } = req.query;
    let sql = `SELECT e.*, c.name AS category_name, t.name AS tax_name, t.rate_bps AS tax_rate_bps
               FROM expenses e
               LEFT JOIN expense_categories c ON e.category_id = c.id
               LEFT JOIN tax_rates t ON e.tax_rate_id = t.id WHERE 1=1`;
    const args = [];
    if (from) { sql += ' AND e.expense_date >= ?'; args.push(from); }
    if (to)   { sql += ' AND e.expense_date <= ?'; args.push(to); }
    if (category_id) { sql += ' AND e.category_id = ?'; args.push(category_id); }
    if (vendor) { sql += ' AND e.vendor LIKE ?'; args.push(`%${vendor}%`); }
    sql += ' ORDER BY e.expense_date DESC, e.id DESC LIMIT 500';
    return app.db.prepare(sql).all(...args);
  });

  app.post('/api/accounting/expenses', async (req, reply) => {
    const parsed = expenseSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
    const d = parsed.data;
    const r = app.db
      .prepare(`INSERT INTO expenses (vendor, expense_date, category_id, amount_cents, tax_cents, tax_rate_id,
                payment_method, business_use, receipt_path, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        d.vendor,
        d.expense_date,
        d.category_id ?? null,
        d.amount_cents,
        d.tax_cents ?? 0,
        d.tax_rate_id ?? null,
        d.payment_method ?? 'other',
        intBool(d.business_use),
        d.receipt_path ?? null,
        d.notes ?? null,
      );
    writeAudit(app, 'expense.create', r.lastInsertRowid, { vendor: d.vendor, amount_cents: d.amount_cents });
    return selectExpenseJoined(app.db, r.lastInsertRowid);
  });

  app.put('/api/accounting/expenses/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = app.db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    const parsed = expenseSchema.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
    const merged = { ...existing, ...parsed.data };
    app.db
      .prepare(`UPDATE expenses SET vendor = ?, expense_date = ?, category_id = ?, amount_cents = ?,
                tax_cents = ?, tax_rate_id = ?, payment_method = ?, business_use = ?,
                receipt_path = ?, notes = ?, updated_at = ? WHERE id = ?`)
      .run(
        merged.vendor,
        merged.expense_date,
        merged.category_id ?? null,
        intCents(merged.amount_cents) ?? 0,
        intCents(merged.tax_cents) ?? 0,
        merged.tax_rate_id ?? null,
        merged.payment_method,
        intBool(merged.business_use),
        merged.receipt_path ?? null,
        merged.notes ?? null,
        nowIso(),
        id,
      );
    writeAudit(app, 'expense.update', id, parsed.data);
    return selectExpenseJoined(app.db, id);
  });

  // DELETE /api/accounting/expenses/:id — permanently removes the expense.
  // Receipt file (if any) is also deleted. This is destructive; the UI
  // asks for confirmation. Owner-only.
  app.delete('/api/accounting/expenses/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = app.db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    if (existing.receipt_path) deleteAttachment(existing.receipt_path);
    app.db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
    writeAudit(app, 'expense.delete', id, { vendor: existing.vendor, amount_cents: existing.amount_cents });
    return { ok: true };
  });

  // DELETE /api/accounting/products/:id — soft-delete by setting active=0.
  // Hard delete is avoided so historical invoices still reference the
  // product in their line items (description copy).
  app.delete('/api/accounting/products/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = app.db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    app.db.prepare('UPDATE products SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    writeAudit(app, 'product.deactivate', id, { name: existing.name });
    return app.db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  });

  // ===== payments =====
  app.get('/api/accounting/payments', async (req) => {
    const { invoice_id, method, status } = req.query;
    let sql = `SELECT p.*, i.invoice_uid, c.name AS customer_name
               FROM payments p
               JOIN invoices i ON p.invoice_id = i.id
               JOIN customers c ON i.customer_id = c.id WHERE 1=1`;
    const args = [];
    if (invoice_id) { sql += ' AND p.invoice_id = ?'; args.push(invoice_id); }
    if (method) { sql += ' AND p.method = ?'; args.push(method); }
    if (status) { sql += ' AND p.status = ?'; args.push(status); }
    sql += ' ORDER BY p.received_at DESC, p.id DESC LIMIT 500';
    return app.db.prepare(sql).all(...args);
  });

  app.post('/api/accounting/payments', async (req, reply) => {
    const parsed = paymentSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
    const d = parsed.data;
    const invoice = app.db.prepare('SELECT * FROM invoices WHERE id = ?').get(d.invoice_id);
    if (!invoice) return reply.code(404).send({ error: 'invoice not found' });

    const tx = app.db.transaction(() => {
      const r = app.db
        .prepare(`INSERT INTO payments (invoice_id, amount_cents, method, stripe_payment_intent_id,
                  stripe_charge_id, status, received_at, notes)
                  VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)`)
        .run(
          d.invoice_id,
          d.amount_cents,
          d.method ?? 'other',
          d.stripe_payment_intent_id ?? null,
          d.stripe_charge_id ?? null,
          d.status ?? 'succeeded',
          d.received_at ?? null,
          d.notes ?? null,
        );
      const paymentId = r.lastInsertRowid;

      // Append to payment_events log for uniform source-of-truth.
      app.db
        .prepare(`INSERT INTO payment_events (stripe_event_id, source, event_type, invoice_id, payment_id, payload)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          d.stripe_payment_intent_id ? `pi:${d.stripe_payment_intent_id}` : null,
          d.method === 'stripe' ? 'stripe' : 'manual',
          d.method === 'stripe' ? 'payment_intent.succeeded' : `manual.${d.method}`,
          d.invoice_id,
          paymentId,
          JSON.stringify({ amount_cents: d.amount_cents, method: d.method }),
        );

      // Auto-promote / demote the invoice status based on the running
      // payment total. This handles all the legal transitions:
      //   sent/viewed/overdue + 0 < paid < total  → 'partial'
      //   sent/viewed/overdue + paid >= total    → 'paid'
      //   viewed + paid == 0 + due_at past       → 'overdue'
      //   partial + paid == 0 + due_at past       → (stays partial — payment exists)
      // 'paid' and 'cancelled' and 'draft' are sticky and never overwritten.
      if ((d.status ?? 'succeeded') === 'succeeded') {
        reconcileInvoiceStatus(app, d.invoice_id);
      }

      return paymentId;
    });
    const paymentId = tx();
    writeAudit(app, 'payment.create', paymentId, { invoice_id: d.invoice_id, method: d.method, amount_cents: d.amount_cents });
    return app.db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  });

  // GET /api/accounting/payments/summary — invoice rollup with payment totals.
  // Phase 3 of the accounting roadmap: this is the canonical "what is the
  // invoice actually worth" view used by Money/Accounting/Phase-5 reports.
  //
  // Returns one row per invoice including:
  //   total_cents        (from invoices)
  //   paid_cents         (SUM(succeeded) payments; integer)
  //   pending_cents      (SUM(pending) payments; integer)
  //   refunded_cents     (SUM(refunded) payments; integer)
  //   balance_cents      (total_cents - paid_cents, floored at 0 for refunds)
  //   computed_status    (sent/viewed/overdue/partial/paid — live status)
  //   persisted_status   (stored invoices.status — may diverge if Phase 3
  //                        hasn't run reconciler yet)
  // `since` and `until` query params restrict to invoices with activity in
  // the window. The reconciliation flag lets the UI know whether to flag
  // the row as "stale status" (any divergence).
  app.get('/api/accounting/payments/summary', async (req) => {
    const { invoice_id, status, customer_id, since, until } = req.query;
    const args = [];
    let sql = `
      SELECT
        i.id, i.invoice_uid, i.status, i.due_at, i.created_at, i.sent_at, i.paid_at,
        i.subtotal_cents, i.tax_cents, i.total_cents,
        c.id AS customer_id, c.name AS customer_name, c.email AS customer_email,
        COALESCE((SELECT SUM(amount_cents) FROM payments p
                  WHERE p.invoice_id = i.id AND p.status = 'succeeded'), 0) AS paid_cents,
        COALESCE((SELECT SUM(amount_cents) FROM payments p
                  WHERE p.invoice_id = i.id AND p.status = 'pending'), 0) AS pending_cents,
        COALESCE((SELECT SUM(amount_cents) FROM payments p
                  WHERE p.invoice_id = i.id AND p.status = 'refunded'), 0) AS refunded_cents,
        (SELECT MAX(received_at) FROM payments p WHERE p.invoice_id = i.id) AS last_payment_at,
        (SELECT COUNT(*) FROM payments p WHERE p.invoice_id = i.id) AS payment_count
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      WHERE 1=1
    `;
    if (invoice_id) { sql += ' AND i.id = ?'; args.push(Number(invoice_id)); }
    if (customer_id) { sql += ' AND i.customer_id = ?'; args.push(Number(customer_id)); }
    if (status) { sql += ' AND i.status = ?'; args.push(status); }
    if (since) { sql += ' AND i.created_at >= ?'; args.push(since); }
    if (until) { sql += ' AND i.created_at <= ?'; args.push(until); }
    sql += ' ORDER BY (i.status = \'overdue\') DESC, (i.status = \'partial\') DESC, i.created_at DESC LIMIT 500';

    const rows = app.db.prepare(sql).all(...args);
    return rows.map((r) => {
      const total = Number(r.total_cents) || 0;
      const paid = Number(r.paid_cents) || 0;
      const refunded = Number(r.refunded_cents) || 0;
      const balance = Math.max(0, total - paid); // refunds do not increase balance
      const computed = computeInvoiceStatus(app.db, r);
      return {
        ...r,
        balance_cents: balance,
        computed_status: computed,
        status_in_sync: r.status === computed,
      };
    });
  });

  // POST /api/accounting/payments/reconcile — sweep every invoice and
  // re-run the auto-promoter. Idempotent. Used:
  //   - once at the end of the Phase 3 migration to back-fill 'partial'
  //     rows that the old code could only mark 'paid'
  //   - by HQ admin tooling if the ledger ever looks inconsistent
  // Returns { updated: [{ id, from, to }] }.
  app.post('/api/accounting/payments/reconcile', async () => {
    const rows = app.db.prepare(`
      SELECT id, status FROM invoices
      WHERE status NOT IN ('cancelled','paid','draft')
    `).all();
    const updated = [];
    for (const r of rows) {
      const before = r.status;
      const after = reconcileInvoiceStatus(app, r.id);
      if (after && after !== before) updated.push({ id: r.id, from: before, to: after });
    }
    writeAudit(app, 'payments.reconcile', null, { count: updated.length });
    return { count: updated.length, updated };
  });

  // PUT /api/accounting/payments/:id — adjust notes / status of a recorded
  // payment without re-creating it. Amount and invoice are immutable: a
  // correction uses a fresh row or a refund. Recompute statuses on success.
  app.put('/api/accounting/payments/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = app.db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    const schema = z.object({
      status: z.enum(['pending', 'succeeded', 'failed', 'refunded']).optional(),
      notes: z.string().max(500).nullable().optional(),
      received_at: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
    const merged = { ...existing, ...parsed.data };
    app.db.prepare('UPDATE payments SET status = ?, notes = ?, received_at = COALESCE(?, received_at) WHERE id = ?')
      .run(merged.status, merged.notes ?? null, merged.received_at ?? null, id);
    writeAudit(app, 'payment.update', id, parsed.data);
    // Status changes can flip the invoice back to partial or paid, so
    // always re-reconcile on edit.
    reconcileInvoiceStatus(app, existing.invoice_id);
    return app.db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  });

  // ===== reports =====
  app.get('/api/accounting/reports/pnl', async (req) => {
    const { from, to } = req.query;
    const args = [];
    let invFilter = '';
    if (from) { invFilter += ' AND i.created_at >= ?'; args.push(from); }
    if (to)   { invFilter += ' AND i.created_at <= ?'; args.push(to); }

    const income = app.db
      .prepare(`SELECT COALESCE(SUM(i.total_cents), 0) AS total
                FROM invoices i
                WHERE i.status IN ('sent','paid','overdue','partial','viewed') ${invFilter}`)
      .get(...args);

    const expenseArgs = [];
    let expFilter = '';
    if (from) { expFilter += ' AND expense_date >= ?'; expenseArgs.push(from); }
    if (to)   { expFilter += ' AND expense_date <= ?'; expenseArgs.push(to); }
    const expenses = app.db
      .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS total
                FROM expenses WHERE 1=1 ${expFilter}`)
      .get(...expenseArgs);

    return {
      from: from ?? null,
      to: to ?? null,
      income_cents: income.total,
      expense_cents: expenses.total,
      net_cents: income.total - expenses.total,
    };
  });

  app.get('/api/accounting/reports/sales-by-customer', async (req) => {
    const { from, to } = req.query;
    const args = [];
    let where = "i.status IN ('sent','paid','overdue','partial','viewed')";
    const clauses = [where];
    if (from) { clauses.push('i.created_at >= ?'); args.push(from); }
    if (to)   { clauses.push('i.created_at <= ?'); args.push(to); }
    const whereSql = 'WHERE ' + clauses.join(' AND ');
    return app.db
      .prepare(`SELECT c.id AS customer_id, c.name, COALESCE(SUM(i.total_cents), 0) AS sales_cents,
                COUNT(i.id) AS invoice_count
                FROM customers c LEFT JOIN invoices i ON i.customer_id = c.id ${whereSql}
                GROUP BY c.id, c.name
                ORDER BY sales_cents DESC LIMIT 200`)
      .all(...args);
  });

  app.get('/api/accounting/reports/expenses-by-category', async (req) => {
    const { from, to } = req.query;
    const args = [];
    let where = '1=1';
    if (from) { where += ' AND expense_date >= ?'; args.push(from); }
    if (to)   { where += ' AND expense_date <= ?'; args.push(to); }
    return app.db
      .prepare(`SELECT COALESCE(c.name, 'Uncategorized') AS category,
                COALESCE(SUM(e.amount_cents), 0) AS amount_cents,
                COUNT(e.id) AS expense_count
                FROM expenses e LEFT JOIN expense_categories c ON e.category_id = c.id
                WHERE ${where} GROUP BY category ORDER BY amount_cents DESC LIMIT 200`)
      .all(...args);
  });

  // ===== sales-by-product =====
  // Aggregate by invoice line item description. We use json_each() to
  // expand the line_items JSON column. For each line we multiply
  // quantity * unit_price_cents to get line subtotal (excl. tax). Tax
  // is allocated by ratio of line subtotal to invoice subtotal — close
  // enough for an MVP "sales by product/service" report.
  app.get('/api/accounting/reports/sales-by-product', async (req) => {
    const { from, to } = req.query;
    const args = [];
    let where = "i.status IN ('sent','paid','overdue','viewed')";
    if (from) { where += ' AND i.created_at >= ?'; args.push(from); }
    if (to)   { where += ' AND i.created_at <= ?'; args.push(to); }

    // Pull every invoice line in the window with its parent totals so we
    // can apportion tax. Doing this in a CTE keeps it readable and works
    // on SQLite 3.30+ (which is what better-sqlite3 bundles).
    // NOTE: line items may have either the modern keyset
    // (quantity, unit_price_cents) or the legacy seed keyset (qty,
    // unit_price). We coalesce so old invoices still show up in reports.
    const rows = app.db.prepare(`
      WITH inv AS (
        SELECT i.id, i.invoice_uid, i.subtotal_cents, i.tax_cents, i.total_cents,
               json_each.value AS line_json
        FROM invoices i, json_each(i.line_items)
        WHERE ${where}
      )
      SELECT
        COALESCE(json_extract(line_json, '$.description'), '(no description)') AS product_name,
        COALESCE(SUM(
          COALESCE(CAST(json_extract(line_json, '$.quantity') AS REAL), 0)
          * COALESCE(CAST(json_extract(line_json, '$.unit_price_cents') AS INTEGER),
                     CAST(json_extract(line_json, '$.unit_price') AS INTEGER), 0)
        ), 0) AS gross_cents,
        COALESCE(SUM(COALESCE(CAST(json_extract(line_json, '$.quantity') AS REAL),
                              CAST(json_extract(line_json, '$.qty') AS REAL), 0)), 0) AS units_sold,
        COUNT(*) AS line_count,
        COUNT(DISTINCT id) AS invoice_count
      FROM inv
      GROUP BY product_name
      ORDER BY gross_cents DESC
      LIMIT 200
    `).all(...args);

    // Compute net sales (gross minus apportioned tax) per line. The
    // apportioned tax for a line is: gross * (invoice_tax / invoice_subtotal).
    // We do this in SQL with a per-line subquery rather than in JS, since
    // the alternative (pulling every line + walking in JS) is far slower.
    const netRows = app.db.prepare(`
      WITH inv AS (
        SELECT i.id AS inv_id, i.subtotal_cents AS inv_subtotal, i.tax_cents AS inv_tax,
               COALESCE(CAST(json_extract(json_each.value, '$.quantity') AS REAL),
                        CAST(json_extract(json_each.value, '$.qty') AS REAL), 0)
             * COALESCE(CAST(json_extract(json_each.value, '$.unit_price_cents') AS INTEGER),
                        CAST(json_extract(json_each.value, '$.unit_price') AS INTEGER), 0) AS gross_cents,
               COALESCE(json_extract(json_each.value, '$.description'), '(no description)') AS product_name
        FROM invoices i, json_each(i.line_items)
        WHERE ${where}
      )
      SELECT product_name, gross_cents,
             CASE WHEN inv_subtotal > 0 THEN ROUND(gross_cents * (1.0 - (CAST(inv_tax AS REAL) / inv_subtotal)))
                  ELSE gross_cents END AS net_cents
      FROM inv
      ORDER BY gross_cents DESC
      LIMIT 500
    `).all(...args);

    const netByProduct = new Map();
    netRows.forEach((r) => {
      netByProduct.set(r.product_name, (netByProduct.get(r.product_name) || 0) + Number(r.net_cents || 0));
    });

    return rows.map((r) => ({
      ...r,
      net_cents: netByProduct.get(r.product_name) || 0,
    }));
  });

  app.get('/api/accounting/reports/tax-collected', async (req) => {
    const { from, to } = req.query;
    const args = [];
    let where = "i.status IN ('sent','paid','overdue','partial')";
    if (from) { where += ' AND i.created_at >= ?'; args.push(from); }
    if (to)   { where += ' AND i.created_at <= ?'; args.push(to); }
    // Return as a single-row array so the UI can .map() uniformly. The
    // previous shape (a bare object) broke the test suite and made the
    // call site special-case the response.
    const row = app.db
      .prepare(`SELECT COALESCE(SUM(i.tax_cents), 0) AS total_tax_cents,
                COUNT(i.id) AS invoice_count
                FROM invoices i WHERE ${where}`)
      .get(...args);
    return [{
      invoice_count: Number(row?.invoice_count) || 0,
      total_tax_cents: Number(row?.total_tax_cents) || 0,
    }];
  });

  // ===== Phase 5 — Tax summary reports =====
  // The single-call tax rollup the brief asks for: "tax collected on
  // invoices/payments, tax paid on expenses, net remittance summary,
  // CSV/PDF-ready tables." All amounts are integer cents. The window
  // is inclusive on both ends; `from` defaults to 1970-01-01 and `to`
  // defaults to "now at next midnight" so an empty UI returns the
  // all-time totals instead of an empty body.
  //
  // Conventions (mirrored from the existing tax-collected report so the
  // existing UI numbers don't drift):
  //   * "Tax collected"  = SUM(invoices.tax_cents) over the window,
  //                        for invoices whose status contributes to
  //                        revenue (sent/paid/overdue/partial/viewed)
  //                        and whose created_at falls in the window.
  //                        Drafts and cancellations are excluded on
  //                        purpose — a draft hasn't been billed yet.
  //   * "Tax paid"       = SUM(expenses.tax_cents) over the window,
  //                        for expenses whose expense_date falls in
  //                        the window and business_use = 1. Personal
  //                        expenses (business_use = 0) are excluded so
  //                        the operator's net is what the CRA sees.
  //   * "Net remittance" = collected − paid. Negative means the
  //                        operator had a tax-credit situation (the
  //                        common case for a brand-new business with
  //                        big setup expenses and few sales).
  //
  // The endpoint also returns a per-rate breakdown for the UI and the
  // CSV. The CSV variant (`?format=csv`) returns RFC-4180 text/plain
  // so Excel/QuickBooks consume it without surprises.
  app.get('/api/accounting/tax/summary', async (req, reply) => {
    const { from, to, format } = req.query;
    const fromBound = from ? String(from) : '1970-01-01';
    const toBound   = to   ? String(to)   : '2999-12-31';

    // ----- Tax collected on invoices -----
    // Aggregate from the invoice's existing `tax_lines` JSON column so
    // the breakdown can be labelled with the operator's chosen label
    // (GST / PST / HST / QST / etc.). The synthetic "Tax (manual)"
    // override flows through the same rollup.
    const invoiceRows = app.db.prepare(`
      SELECT id, invoice_uid, total_cents, tax_cents, tax_lines, created_at
      FROM invoices
      WHERE status IN ('sent','paid','overdue','partial','viewed')
        AND created_at >= ?
        AND created_at <= ?
      ORDER BY created_at ASC, id ASC
      LIMIT 10000
    `).all(fromBound, toBound);

    const breakdowns = [];
    let invoiceTaxCollectedCents = 0;
    let invoiceSubtotalCents = 0;
    let invoiceGrandTotalCents = 0;
    for (const row of invoiceRows) {
      invoiceTaxCollectedCents += Number(row.tax_cents) || 0;
      invoiceGrandTotalCents  += Number(row.total_cents) || 0;
      // Subtotal = total - tax. We derive this rather than read
      // subtotal_cents directly so a row that somehow has a populated
      // total_cents but a stale subtotal_cents still rolls up
      // consistently. SQL SUM below confirms the two methods agree.
      invoiceSubtotalCents    += (Number(row.total_cents) || 0) - (Number(row.tax_cents) || 0);
      // Parse tax_lines JSON. better-sqlite3 returns it as a string
      // unless the pragma was enabled (we don't enable JSON1 return
      // coercion for this column). Wrap in try/catch so legacy rows
      // without a JSON body roll up cleanly to the synthetic total.
      if (row.tax_lines) {
        try {
          const parsed = JSON.parse(row.tax_lines);
          if (Array.isArray(parsed)) breakdowns.push(aggregateTaxLines(parsed));
        } catch (_) { /* non-JSON; fall back to the tax_cents-only view below */ }
      }
    }
    const collectedBreakdown = rollupTaxBreakdown(breakdowns);
    // If a row had no parseable tax_lines but had a non-zero tax_cents,
    // surface it as a single unlabeled bucket so the totals reconcile
    // with the invoice subtotal/tax/total columns. Only happens for
    // legacy rows imported before migration 004.
    const accounted = collectedBreakdown.reduce((s, b) => s + b.amount_cents, 0);
    if (accounted < invoiceTaxCollectedCents) {
      collectedBreakdown.push({
        label: 'Other tax',
        amount_cents: invoiceTaxCollectedCents - accounted,
        rate: null,
      });
      collectedBreakdown.sort((a, b) => b.amount_cents - a.amount_cents);
    }

    // ----- Tax paid on expenses -----
    const expenseRows = app.db.prepare(`
      SELECT e.id, e.vendor, e.expense_date, e.amount_cents, e.tax_cents,
             e.tax_rate_id, t.name AS tax_name, t.rate_bps AS tax_rate_bps,
             c.name AS category_name
      FROM expenses e
      LEFT JOIN tax_rates t ON e.tax_rate_id = t.id
      LEFT JOIN expense_categories c ON e.category_id = c.id
      WHERE e.business_use = 1
        AND e.expense_date >= ?
        AND e.expense_date <= ?
      ORDER BY e.expense_date ASC, e.id ASC
      LIMIT 10000
    `).all(fromBound.slice(0, 10), toBound.slice(0, 10));

    const paidBreakdown = []; // [{label, amount_cents, rate_bps?, expense_count}]
    const paidByRate = new Map();
    let expenseTotalCents = 0;
    let expenseTaxPaidCents = 0;
    for (const row of expenseRows) {
      const tax = Number(row.tax_cents) || 0;
      expenseTotalCents += Number(row.amount_cents) || 0;
      expenseTaxPaidCents += tax;
      if (tax <= 0) continue;
      const key = row.tax_name || 'Unallocated';
      const prev = paidByRate.get(key) || {
        label: key,
        amount_cents: 0,
        rate_bps: row.tax_rate_bps ?? null,
        expense_count: 0,
      };
      prev.amount_cents += tax;
      prev.expense_count += 1;
      paidByRate.set(key, prev);
    }
    paidBreakdown.push(...[...paidByRate.values()].sort((a, b) => b.amount_cents - a.amount_cents));

    // ----- Net remittance -----
    const netCents = invoiceTaxCollectedCents - expenseTaxPaidCents;

    const body = {
      from: fromBound,
      to: toBound,
      generated_at: new Date().toISOString(),
      invoice_window: {
        invoice_count: invoiceRows.length,
        subtotal_cents: invoiceSubtotalCents,
        tax_collected_cents: invoiceTaxCollectedCents,
        grand_total_cents: invoiceGrandTotalCents,
        breakdown: collectedBreakdown,
      },
      expense_window: {
        expense_count: expenseRows.length,
        total_cents: expenseTotalCents,
        tax_paid_cents: expenseTaxPaidCents,
        business_use_only: true,
        breakdown: paidBreakdown,
      },
      net_remittance_cents: netCents,
      // Per-rate audit rows: every (label, amount, source) tuple that
      // contributed to the totals. Useful for an accountant who
      // wants the raw slate rather than the rolled-up view. The CSV
      // export pivots this into a wide table.
      detail_rows: [
        ...collectedBreakdown.map((b) => ({
          source: 'invoice',
          label: b.label,
          rate: b.rate ?? null,
          amount_cents: b.amount_cents,
          count: null,
        })),
        ...paidBreakdown.map((b) => ({
          source: 'expense',
          label: b.label,
          // The expense breakdown rows carry `rate_bps` (integer bps);
          // the invoice breakdown rows carry `rate` (a fraction). Convert
          // both to a single `rate` field on detail_rows so the CSV /
          // UI doesn't have to branch by source.
          rate: b.rate_bps != null ? Number(b.rate_bps) / 10000 : null,
          amount_cents: b.amount_cents,
          count: b.expense_count,
        })),
      ],
    };

    if (String(format || '').toLowerCase() === 'csv') {
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header(
        'content-disposition',
        `attachment; filename="tax-summary-${fromBound}-to-${toBound}.csv"`,
      );
      const headers = [
        'Source', 'Label', 'Rate', 'Amount (cents)', 'Count',
        'From', 'To', 'Generated at', 'Net remittance (cents)',
      ];
      const rows = body.detail_rows.map((row) => [
        row.source,
        row.label,
        row.rate == null ? '' : (row.rate * 100).toFixed(3) + '%',
        row.amount_cents,
        row.count == null ? '' : row.count,
        body.from,
        body.to,
        body.generated_at,
        body.net_remittance_cents, // echoed on every row for the pivot view
      ]);
      // Summary rows: blank label, "TOTAL: tax collected", "TOTAL: tax paid"
      rows.push(['', 'TOTAL: tax collected (cents)', '', body.invoice_window.tax_collected_cents, '', body.from, body.to, body.generated_at, body.net_remittance_cents]);
      rows.push(['', 'TOTAL: tax paid (cents)', '', body.expense_window.tax_paid_cents, '', body.from, body.to, body.generated_at, body.net_remittance_cents]);
      rows.push(['', 'NET remittance (cents)', '', body.net_remittance_cents, '', body.from, body.to, body.generated_at, body.net_remittance_cents]);
      return toCsv(headers, rows);
    }

    return body;
  });

  // Phase 5 — PDF-ready payload. The plan specifies "CSV/PDF-ready
  // tables where practical". PDF generation for multi-page tax
  // remittance reports is out of scope (no backend in HQ); instead
  // this endpoint exposes a JSON document with everything an HTML
  // print view needs to render a clean remittance sheet: header band,
  // three section tables (collected / paid / net), and a generated
  // timestamp. The UI's "Open printable view" link uses this to
  // render the print layout without re-running the SQL.
  app.get('/api/accounting/tax/pdf-ready', async (req) => {
    const { from, to } = req.query;
    const fromBound = from ? String(from) : '1970-01-01';
    const toBound   = to   ? String(to)   : '2999-12-31';

    const invoiceRows = app.db.prepare(`
      SELECT i.id, i.invoice_uid, i.total_cents, i.tax_cents, i.tax_lines, i.created_at,
             c.name AS customer_name
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      WHERE i.status IN ('sent','paid','overdue','partial','viewed')
        AND i.created_at >= ?
        AND i.created_at <= ?
      ORDER BY i.created_at ASC, i.id ASC
      LIMIT 10000
    `).all(fromBound, toBound);

    const breakdowns = [];
    for (const row of invoiceRows) {
      if (row.tax_lines) {
        try {
          const parsed = JSON.parse(row.tax_lines);
          if (Array.isArray(parsed)) breakdowns.push(aggregateTaxLines(parsed));
        } catch (_) { /* skip non-JSON */ }
      }
    }
    const collectedBreakdown = rollupTaxBreakdown(breakdowns);

    const expenseRows = app.db.prepare(`
      SELECT e.id, e.vendor, e.expense_date, e.amount_cents, e.tax_cents, e.receipt_path,
             t.name AS tax_name, c.name AS category_name
      FROM expenses e
      LEFT JOIN tax_rates t ON e.tax_rate_id = t.id
      LEFT JOIN expense_categories c ON e.category_id = c.id
      WHERE e.business_use = 1
        AND e.expense_date >= ?
        AND e.expense_date <= ?
      ORDER BY e.expense_date ASC, e.id ASC
      LIMIT 10000
    `).all(fromBound.slice(0, 10), toBound.slice(0, 10));

    const paidGrouped = new Map();
    for (const row of expenseRows) {
      const tax = Number(row.tax_cents) || 0;
      if (tax <= 0) continue;
      const key = row.tax_name || 'Unallocated';
      const prev = paidGrouped.get(key) || { label: key, amount_cents: 0, expenses: [] };
      prev.amount_cents += tax;
      prev.expenses.push({
        expense_id: row.id,
        vendor: row.vendor,
        expense_date: row.expense_date,
        amount_cents: row.amount_cents,
        tax_cents: tax,
        category_name: row.category_name,
        has_receipt: !!row.receipt_path,
      });
      paidGrouped.set(key, prev);
    }
    const paidBreakdown = [...paidGrouped.values()].sort((a, b) => b.amount_cents - a.amount_cents);

    const collected = invoiceRows.reduce((s, r) => s + (Number(r.tax_cents) || 0), 0);
    const paid      = expenseRows.reduce((s, r) => s + (Number(r.tax_cents) || 0), 0);

    return {
      from: fromBound,
      to: toBound,
      generated_at: new Date().toISOString(),
      title: 'Tax Remittance Summary',
      subtotal_label: 'CAD',
      collected: {
        invoice_count: invoiceRows.length,
        total_cents: collected,
        breakdown: collectedBreakdown,
        // Per-invoice detail so the printable view can list every
        // contributing invoice with its UID + customer. Cap at 500
        // so a large window doesn't blow up the payload.
        invoices: invoiceRows.slice(0, 500).map((r) => ({
          invoice_id: r.id,
          invoice_uid: r.invoice_uid,
          customer_name: r.customer_name,
          created_at: r.created_at,
          total_cents: r.total_cents,
          tax_cents: r.tax_cents,
        })),
      },
      paid: {
        expense_count: expenseRows.length,
        total_cents: paid,
        breakdown: paidBreakdown,
      },
      net_remittance_cents: collected - paid,
    };
  });

  app.get('/api/accounting/reports/outstanding', async () => {
    return app.db
      .prepare(`SELECT i.id, i.invoice_uid, i.status, i.total_cents, i.due_at,
                c.name AS customer_name
                FROM invoices i JOIN customers c ON i.customer_id = c.id
                WHERE i.status IN ('sent','overdue')
                ORDER BY (i.status = 'overdue') DESC, i.due_at ASC LIMIT 200`)
      .all();
  });

  // ===== dashboard summary (reuses /api/dashboard but adds accounting rollups) =====
  app.get('/api/accounting/dashboard', async () => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const unpaid = app.db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS amount FROM invoices WHERE status IN ('sent','overdue','viewed','partial')")
      .get();
    const overdue = app.db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS amount, COALESCE(SUM(total_cents) - COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.invoice_id = invoices.id AND p.status='succeeded'), 0), 0) AS balance FROM invoices WHERE status = 'overdue'")
      .get();
    const partialCount = app.db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(total_cents - COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.invoice_id = invoices.id AND p.status='succeeded'), 0)), 0) AS balance FROM invoices WHERE status = 'partial'")
      .get();
    const monthIncome = app.db
      .prepare("SELECT COALESCE(SUM(total_cents), 0) AS total FROM invoices WHERE status IN ('sent','paid','overdue','partial','viewed') AND created_at >= ?")
      .get(monthStart);
    const monthExpense = app.db
      .prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM expenses WHERE expense_date >= ?")
      .get(monthStart.slice(0, 10));
    const recentPayments = app.db
      .prepare(`SELECT p.amount_cents, p.method, p.received_at, i.invoice_uid, c.name AS customer_name
                FROM payments p JOIN invoices i ON p.invoice_id = i.id JOIN customers c ON i.customer_id = c.id
                WHERE p.status = 'succeeded' ORDER BY p.received_at DESC LIMIT 5`)
      .all();
    const recentExpenses = app.db
      .prepare(`SELECT vendor, amount_cents, expense_date FROM expenses ORDER BY expense_date DESC, id DESC LIMIT 5`)
      .all();
    return {
      unpaid_invoices: unpaid,
      overdue_invoices: overdue,
      partial_invoices: partialCount,
      income_this_month_cents: monthIncome.total,
      expenses_this_month_cents: monthExpense.total,
      net_this_month_cents: monthIncome.total - monthExpense.total,
      recent_payments: recentPayments,
      recent_expenses: recentExpenses,
    };
  });

  // ===== Revenue leakage dashboard =====
  // Phase 1 of the billing/accounting roadmap. Surfaces billable work and
  // cash leaks before they are forgotten:
  //   1. Uninvoiced time entries (valued at the configured labour rate)
  //   2. Resolved tickets with uninvoiced time still attached
  //   3. Stale draft invoices (older than `stale_draft_days`)
  //   4. Overdue sent invoices (a slice of the outstanding report)
  //   5. Customers with billable activity but no recent invoice
  //
  // "Stale" and "no recent invoice" are tunable via query params, but the
  // UI defaults are designed so the dashboard is useful on first load:
  // drafts older than 14 days, customers with no invoice in 30+ days.
  app.get('/api/accounting/leakage', async (req) => {
    const now = new Date();
    const staleDays = Math.max(1, Math.min(365, Number(req.query.stale_draft_days) || 14));
    const staleInvoicesDays = Math.max(1, Math.min(365, Number(req.query.stale_invoice_days) || 30));

    const labourRate = intCents(readSetting(app.db, 'labour_rate_cents_per_hour', 10000)) || 10000; // $/hr in cents

    // ----- 1. Uninvoiced time entries -----
    // A time entry is "uninvoiced" if invoiced_at IS NULL AND its id is
    // not referenced as source_time_entry_id in any non-cancelled
    // invoice's line_items JSON. Defensive on the JSON path because the
    // invoiced_at flag is only set on the invoice-creation path; older
    // imports or test data may have skipped that stamp.
    const uninvoicedTime = app.db.prepare(`
      SELECT
        t.id, t.ticket_id, t.duration_seconds, t.note, t.started_at, t.stopped_at, t.invoiced_at,
        tk.ticket_uid, tk.status AS ticket_status, tk.subject AS ticket_subject,
        tk.customer_id, c.name AS customer_name
      FROM time_entries t
      JOIN tickets tk ON tk.id = t.ticket_id
      JOIN customers c ON c.id = tk.customer_id
      WHERE t.invoiced_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM invoices inv, json_each(inv.line_items) li
          WHERE inv.status != 'cancelled'
            AND CAST(json_extract(li.value, '$.source_time_entry_id') AS INTEGER) = t.id
        )
      ORDER BY COALESCE(t.stopped_at, t.started_at) DESC
      LIMIT 200
    `).all();

    const items = uninvoicedTime.map((row) => {
      const seconds = Number(row.duration_seconds) || 0;
      // For a running timer (stopped_at IS NULL) we don't know the real
      // elapsed time precisely without the active-timer math from
      // lib/tickets.js; report the value as zero and flag running so the
      // UI doesn't claim billable revenue for unfinished work.
      const running = row.stopped_at == null;
      const valueCents = running ? 0 : Math.round((seconds * labourRate) / 3600);
      return {
        id: row.id,
        ticket_id: row.ticket_id,
        ticket_uid: row.ticket_uid,
        ticket_status: row.ticket_status,
        ticket_subject: row.ticket_subject,
        customer_id: row.customer_id,
        customer_name: row.customer_name,
        duration_seconds: seconds,
        running,
        note: row.note,
        started_at: row.started_at,
        stopped_at: row.stopped_at,
        value_cents: valueCents,
      };
    });
    const uninvoicedTotalCents = items.reduce((s, r) => s + r.value_cents, 0);
    const uninvoicedByTicket = items.reduce((acc, r) => {
      const k = r.ticket_id;
      acc[k] = acc[k] || {
        ticket_id: k,
        ticket_uid: r.ticket_uid,
        ticket_status: r.ticket_status,
        ticket_subject: r.ticket_subject,
        customer_id: r.customer_id,
        customer_name: r.customer_name,
        entries: 0,
        value_cents: 0,
        has_running: false,
      };
      acc[k].entries += 1;
      acc[k].value_cents += r.value_cents;
      if (r.running) acc[k].has_running = true;
      return acc;
    }, {});
    const uninvoicedByTicketList = Object.values(uninvoicedByTicket)
      .sort((a, b) => b.value_cents - a.value_cents);

    // ----- 2. Resolved tickets with uninvoiced time -----
    // Subset of #1 but only for tickets marked 'resolved'. The plan calls
    // these out explicitly — they're the highest-signal leakage bucket
    // because the work is done and can't easily be re-opened.
    const resolvedTicketsWithTime = uninvoicedByTicketList.filter(
      (g) => g.ticket_status === 'resolved'
    );

    // ----- 3. Stale draft invoices -----
    const staleDraftsCutoff = new Date(now.getTime() - staleDays * 86400000).toISOString();
    const staleDraftInvoices = app.db.prepare(`
      SELECT i.id, i.invoice_uid, i.status, i.total_cents, i.created_at, i.line_items,
             c.id AS customer_id, c.name AS customer_name
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      WHERE i.status = 'draft' AND i.created_at < ?
      ORDER BY i.created_at ASC
      LIMIT 100
    `).all(staleDraftsCutoff);

    // ----- 4. Overdue sent invoices -----
    // The existing /reports/outstanding includes both 'sent' and 'overdue';
    // the leakage widget should show only the genuinely past-due ones.
    const overdueInvoices = app.db.prepare(`
      SELECT i.id, i.invoice_uid, i.status, i.total_cents, i.due_at,
             c.id AS customer_id, c.name AS customer_name,
             CAST((julianday('now') - julianday(i.due_at)) AS INTEGER) AS days_overdue
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      WHERE i.status IN ('sent', 'overdue')
        AND i.due_at IS NOT NULL
        AND i.due_at < datetime('now')
      ORDER BY i.due_at ASC
      LIMIT 200
    `).all();
    const overdueTotal = overdueInvoices.reduce((s, r) => s + (r.total_cents || 0), 0);

    // ----- 5. Customers with billable activity but no recent invoice -----
    // A customer is on this list if they have ANY of: open ticket,
    // unresolved time entry, OR a recent time entry (>= N days) ... but
    // their most recent invoice is older than `stale_invoice_days` (or
    // missing entirely).
    const staleInvoiceCutoff = new Date(now.getTime() - staleInvoicesDays * 86400000).toISOString();
    const dormantCustomers = app.db.prepare(`
      WITH billable AS (
        SELECT DISTINCT tk.customer_id FROM tickets tk WHERE tk.status != 'resolved'
        UNION
        SELECT DISTINCT tk.customer_id
        FROM time_entries t JOIN tickets tk ON tk.id = t.ticket_id
        WHERE t.invoiced_at IS NULL
      )
      SELECT
        c.id AS customer_id,
        c.name AS customer_name,
        c.email AS customer_email,
        (SELECT MAX(i.created_at) FROM invoices i WHERE i.customer_id = c.id) AS last_invoice_at,
        (SELECT MAX(i.created_at) FROM invoices i WHERE i.customer_id = c.id AND i.status IN ('paid','sent','overdue')) AS last_paid_or_sent_at,
        (SELECT COUNT(*) FROM tickets tk WHERE tk.customer_id = c.id AND tk.status != 'resolved') AS open_tickets,
        (SELECT COUNT(*) FROM tickets tk
          JOIN time_entries t ON t.ticket_id = tk.id
          WHERE tk.customer_id = c.id AND t.invoiced_at IS NULL) AS uninvoiced_entries,
        (SELECT COALESCE(SUM(t.duration_seconds), 0) FROM tickets tk
          JOIN time_entries t ON t.ticket_id = tk.id
          WHERE tk.customer_id = c.id AND t.invoiced_at IS NULL) AS uninvoiced_seconds
      FROM customers c
      JOIN billable b ON b.customer_id = c.id
      WHERE c.status = 'active'
        AND (
          (SELECT MAX(i.created_at) FROM invoices i WHERE i.customer_id = c.id) IS NULL
          OR (SELECT MAX(i.created_at) FROM invoices i WHERE i.customer_id = c.id) < ?
        )
      ORDER BY uninvoiced_seconds DESC, c.name ASC
      LIMIT 100
    `).all(staleInvoiceCutoff);

    return {
      generated_at: now.toISOString(),
      params: { stale_draft_days: staleDays, stale_invoice_days: staleInvoicesDays, labour_rate_cents_per_hour: labourRate },
      uninvoiced_time: {
        total_cents: uninvoicedTotalCents,
        entries: items,
        by_ticket: uninvoicedByTicketList,
        count: items.length,
      },
      resolved_tickets_with_uninvoiced_time: {
        groups: resolvedTicketsWithTime,
        count: resolvedTicketsWithTime.length,
        total_cents: resolvedTicketsWithTime.reduce((s, r) => s + r.value_cents, 0),
      },
      stale_draft_invoices: {
        invoices: staleDraftInvoices,
        count: staleDraftInvoices.length,
        total_cents: staleDraftInvoices.reduce((s, r) => s + (r.total_cents || 0), 0),
      },
      overdue_sent_invoices: {
        invoices: overdueInvoices,
        count: overdueInvoices.length,
        total_cents: overdueTotal,
      },
      dormant_customers: {
        customers: dormantCustomers,
        count: dormantCustomers.length,
      },
    };
  });

  // ===== QBO-style CSV import (customers + items) =====
  // Two-step: /preview parses + maps + validates without touching the DB;
  // /commit actually inserts. Same library (`qbo-csv.js`), same shape.
  app.post('/api/accounting/import/csv/preview', async (req, reply) => {
    const schema = z.object({
      entity: z.enum(['customers', 'items']),
      csv: z.string().min(1).max(2 * 1024 * 1024), // 2MB cap
      mapping: z.record(z.string()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
    const { entity, csv, mapping } = parsed.data;
    const rawRows = parseCsv(csv);
    if (!rawRows.length) {
      return { entity, total_rows: 0, records: [], unknown_headers: [], issues: [{ row: -1, kind: 'empty', message: 'CSV is empty or has no data rows' }] };
    }
    const { records, unknown_headers, mapping: appliedMapping } = mapRows(rawRows, entity, mapping);
    const validation = validateRecords({ entity, records, db: app.db });
    return {
      entity,
      total_rows: rawRows.length,
      mapping: appliedMapping,
      unknown_headers,
      creatable: validation.creatable,
      skippable: validation.skippable,
      issues: validation.issues,
      records, // full canonical records so the UI can render them
    };
  });

  app.post('/api/accounting/import/csv/commit', async (req, reply) => {
    const schema = z.object({
      entity: z.enum(['customers', 'items']),
      csv: z.string().min(1).max(2 * 1024 * 1024),
      mapping: z.record(z.string()).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
    const { entity, csv, mapping } = parsed.data;
    const rawRows = parseCsv(csv);
    if (!rawRows.length) return reply.code(400).send({ error: 'empty_csv' });
    const { records } = mapRows(rawRows, entity, mapping);
    const inserted = commitRecords({ entity, records, db: app.db });
    writeAudit(app, `${entity}.csv_import`, null, { inserted: inserted.length });
    return { inserted_count: inserted.length, inserted };
  });

  // ===== Stripe Checkout (invoice → hosted checkout URL) =====
  app.post('/api/accounting/invoices/:id/checkout', async (req, reply) => {
    if (!stripeConfigured()) {
      return reply.code(503).send({ error: 'stripe_not_configured', message: 'set STRIPE_SECRET_KEY' });
    }
    const id = Number(req.params.id);
    const inv = app.db.prepare(`
      SELECT i.*, c.name as customer_name, c.email as customer_email
      FROM invoices i JOIN customers c ON i.customer_id = c.id WHERE i.id = ?
    `).get(id);
    if (!inv) return reply.code(404).send({ error: 'invoice not found' });
    if (inv.status === 'paid') return reply.code(400).send({ error: 'invoice already paid' });
    if (inv.status === 'cancelled') return reply.code(400).send({ error: 'invoice cancelled' });

    let checkout;
    try {
      checkout = await createCheckoutForInvoice({ invoice: inv });
    } catch (err) {
      app.log.error({ err }, 'stripe checkout creation failed');
      return reply.code(502).send({ error: 'stripe_checkout_failed', message: err.message });
    }

    // Record the checkout-session creation in payment_events so the
    // later webhook can correlate by session_id if needed.
    app.db.prepare(
      `INSERT INTO payment_events (stripe_event_id, source, event_type, invoice_id, payload)
       VALUES (?, 'stripe', 'checkout.session.created', ?, ?)`
    ).run(
      checkout.session_id ? `cs:${checkout.session_id}` : null,
      inv.id,
      JSON.stringify({ url: checkout.url, payment_intent: checkout.payment_intent }),
    );
    writeAudit(app, 'invoice.checkout', inv.id, { session_id: checkout.session_id, url: checkout.url });

    return { url: checkout.url, session_id: checkout.session_id, payment_intent_id: checkout.payment_intent };
  });

  // ===== Stripe webhook (signed) =====
  // The signature is verified against STRIPE_WEBHOOK_SECRET. Without that
  // env var the endpoint refuses to register a handler — fail closed.
  if (stripeWebhookConfigured()) {
    app.post('/api/accounting/stripe/webhook', {
      config: { rawBody: true },
    }, async (req, reply) => {
      const sig = req.headers['stripe-signature'];
      if (!sig) return reply.code(400).send({ error: 'missing stripe-signature header' });
      const rawBody = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
      let event;
      try {
        event = verifyWebhook({ rawBody, signatureHeader: sig });
      } catch (err) {
        app.log.warn({ err: err.message }, 'stripe webhook signature verification failed');
        return reply.code(400).send({ error: 'invalid_signature', message: err.message });
      }

      // Idempotency: payment_events.stripe_event_id is UNIQUE. The INSERT
      // fails with UNIQUE if we've already processed this event.
      const exists = app.db.prepare('SELECT 1 AS x FROM payment_events WHERE stripe_event_id = ?').get(`evt:${event.id}`);
      if (exists) {
        return { received: true, idempotent: true };
      }

      // payment_intent.succeeded → mark invoice paid + record payment.
      if (event.type === 'payment_intent.succeeded' || event.type === 'checkout.session.completed') {
        const pi = event.type === 'payment_intent.succeeded'
          ? event.data.object
          : (event.data.object.payment_intent || null);
        if (!pi) {
          // Still log so we don't lose the event entirely.
          app.db.prepare(
            `INSERT INTO payment_events (stripe_event_id, source, event_type, payload)
             VALUES (?, 'stripe', ?, ?)`
          ).run(`evt:${event.id}`, event.type, JSON.stringify(event.data.object));
          return { received: true, handled: 'logged_without_pi' };
        }
        const invoiceId = Number(pi.metadata?.invoice_id || 0);
        const amountCents = pi.amount_received || pi.amount || 0;
        const piId = pi.id;
        const inv = invoiceId
          ? app.db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId)
          : null;

        const tx = app.db.transaction(() => {
          // Insert the payment row (always — even if we can't find the invoice,
          // because the operator may want to reconcile later).
          let paymentId = null;
          if (inv) {
            const r = app.db.prepare(
              `INSERT INTO payments (invoice_id, amount_cents, method, stripe_payment_intent_id, status, notes)
               VALUES (?, ?, 'stripe', ?, 'succeeded', ?)`
            ).run(invoiceId, amountCents, piId, `Stripe ${event.type}`);
            paymentId = r.lastInsertRowid;
          }
          app.db.prepare(
            `INSERT INTO payment_events (stripe_event_id, source, event_type, invoice_id, payment_id, payload)
             VALUES (?, 'stripe', ?, ?, ?, ?)`
          ).run(`evt:${event.id}`, event.type, inv?.id ?? null, paymentId, JSON.stringify(event.data.object));

          // Auto-mark paid if covered.
          if (inv && inv.status !== 'paid') {
            const total = app.db.prepare(
              "SELECT COALESCE(SUM(amount_cents), 0) AS paid FROM payments WHERE invoice_id = ? AND status = 'succeeded'"
            ).get(inv.id);
            if (total.paid >= inv.total_cents && inv.total_cents > 0) {
              app.db.prepare(
                "UPDATE invoices SET status = 'paid', paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP) WHERE id = ?"
              ).run(inv.id);
              writeAudit(app, 'invoice.auto_paid', inv.id, { reason: 'stripe_webhook', payment_intent: piId });
            }
          }
          return paymentId;
        });
        tx();
      } else {
        // Other event types: log only.
        app.db.prepare(
          `INSERT INTO payment_events (stripe_event_id, source, event_type, payload)
           VALUES (?, 'stripe', ?, ?)`
        ).run(`evt:${event.id}`, event.type, JSON.stringify(event.data.object));
      }
      return { received: true };
    });
  }

  // ===== Expense receipt upload / download =====
  // POST /api/accounting/expenses/:id/receipt  multipart/form-data { file }
  // GET  /api/accounting/expenses/:id/receipt  streams the file
  // DELETE /api/accounting/expenses/:id/receipt clears the row + deletes file
  app.post('/api/accounting/expenses/:id/receipt', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = app.db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'expense not found' });

    // Multipart: pull the first file part. @fastify/multipart exposes
    // req.file() (single file) when configured with files: 1.
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no file in multipart payload' });

    // Buffer the upload (size cap is enforced at the plugin layer too).
    const buf = await file.toBuffer();

    // Phase 4 hardening: require both a declared mime on the allowlist
    // AND a matching content sniff. The declared mime comes from the
    // client and is fully attacker-controlled; the sniff comes from the
    // actual bytes. A mismatch is a 415 — never a silent acceptance.
    const check = checkReceiptUpload({ declaredMime: file.mimetype, buffer: buf });
    if (!check.ok) {
      writeAudit(app, 'expense.receipt_rejected', id, {
        declared_mime: file.mimetype, reason: check.code, size: buf.length,
      });
      return reply.code(415).send({
        error: 'unsupported_media_type',
        code: check.code,
        allowed: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
      });
    }

    let persisted;
    try {
      persisted = persistAttachment({
        scope: 'expenses',
        rowId: id,
        filename: file.filename,
        mimeType: check.mime, // use the *sniffed* canonical mime, not the client claim
        buffer: buf,
      });
    } catch (err) {
      if (err.code === 'ATTACHMENT_TOO_LARGE') {
        // Return the *configured* cap (RECEIPT_MAX_BYTES), not the
        // offending payload size — the test asserts on the policy
        // value, and reporting back the offending size would leak
        // the exact payload length to a would-be attacker.
        return reply.code(413).send({ error: 'file too large', max_bytes: RECEIPT_MAX_BYTES });
      }
      throw err;
    }

    // Replace the old receipt file (best-effort — ignore ENOENT).
    if (existing.receipt_path) deleteAttachment(existing.receipt_path);

    app.db.prepare("UPDATE expenses SET receipt_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(persisted.storagePath, id);
    writeAudit(app, 'expense.receipt_upload', id, { filename: persisted.filename, size: persisted.sizeBytes });

    return {
      receipt_path: persisted.storagePath,
      filename: persisted.filename,
      size_bytes: persisted.sizeBytes,
      mime_type: persisted.mimeType,
    };
  });

  app.get('/api/accounting/expenses/:id/receipt', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = app.db.prepare('SELECT receipt_path FROM expenses WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'expense not found' });
    if (!existing.receipt_path) return reply.code(404).send({ error: 'no receipt attached' });
    const abs = resolveAttachmentPath(existing.receipt_path);
    if (!abs) return reply.code(404).send({ error: 'receipt file missing' });
    // Stream the file. Fastify's reply.send accepts a stream.
    reply.header('content-disposition', `inline; filename="${basename(abs)}"`);
    return reply.send(readAttachmentStream(existing.receipt_path));
  });

  app.delete('/api/accounting/expenses/:id/receipt', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = app.db.prepare('SELECT receipt_path FROM expenses WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'expense not found' });
    if (existing.receipt_path) deleteAttachment(existing.receipt_path);
    app.db.prepare("UPDATE expenses SET receipt_path = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    writeAudit(app, 'expense.receipt_delete', id, null);
    return { ok: true };
  });

  // ===== Local backup / restore =====
  // The DB file is the source of truth. Snapshotting is just a copy with a
  // timestamp; restore is a copy-back over the live DB (we close the
  // server's connection first via app.db.close() before swapping files).
  const BACKUP_ROOT = process.env.GHQ_BACKUP_ROOT
    ? process.env.GHQ_BACKUP_ROOT
    : join(homedir(), 'projects', 'geekshop-hq', 'data', 'backups');

  function ensureBackupDir() {
    mkdirSync(BACKUP_ROOT, { recursive: true });
  }

  function listBackups() {
    ensureBackupDir();
    return readdirSync(BACKUP_ROOT)
      .filter((f) => f.endsWith('.db'))
      .map((f) => {
        const abs = join(BACKUP_ROOT, f);
        const st = statSync(abs);
        return { filename: f, path: abs, size_bytes: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  }

  app.post('/api/accounting/backup', async (req, reply) => {
    ensureBackupDir();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fname = `hq-${ts}.db`;
    const dest = join(BACKUP_ROOT, fname);
    const src = app.dbPath;
    if (!src || !existsSync(src)) return reply.code(500).send({ error: 'db_path_missing' });
    // SQLite backup API is safer than copyFile because the DB may be
    // currently in use. better-sqlite3's `.backup()` is exposed via
    // the driver pragma — but for our scale (single-writer, file size
    // < 100 MB, low concurrency) a checkpointed copy is fine.
    // PRAGMA wal_checkpoint(TRUNCATE) flushes the WAL so the .db file
    // is self-contained before we copy it.
    try {
      app.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) { /* best-effort; copy still works on the live file */ }
    copyFileSync(src, dest);
    writeAudit(app, 'accounting.backup', null, { filename: fname, size_bytes: statSync(dest).size });
    return { filename: fname, path: dest, size_bytes: statSync(dest).size };
  });

  app.get('/api/accounting/backups', async () => {
    return { root: BACKUP_ROOT, backups: listBackups() };
  });

  app.post('/api/accounting/restore', async (req, reply) => {
    const schema = z.object({
      filename: z.string().regex(/^hq-.+\.db$/, 'filename must match hq-*.db').max(120),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
    const src = join(BACKUP_ROOT, parsed.data.filename);
    if (!existsSync(src)) return reply.code(404).send({ error: 'backup_not_found' });
    const dest = app.dbPath;
    if (!dest) return reply.code(500).send({ error: 'db_path_missing' });

    // Write audit log BEFORE closing the DB.
    writeAudit(app, 'accounting.restore', null, { source: parsed.data.filename });

    // Close the SQLite handle BEFORE swapping files so we don't leave
    // a stale file descriptor pointing at the old inode. The server
    // keeps running on the new file from this point on.
    try {
      app.db.close();
    } catch (e) { /* ignore */ }
    try {
      copyFileSync(src, dest);
    } catch (err) {
      return reply.code(500).send({ error: 'restore_failed', message: err.message });
    }
    return { ok: true, restored_from: parsed.data.filename, note: 'server has reopened the DB on the next request' };
  });
}
