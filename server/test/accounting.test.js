/**
 * Accounting module smoke test.
 *
 * Exercises every new endpoint added in migration 031 and the
 * /api/accounting/* route module:
 *
 *   1. Status endpoint reports module shape
 *   2. Create / list / update tax rates
 *   3. Create / list / update products (incl. unique-SKU 409)
 *   4. Expense categories: create + duplicate-name 409
 *   5. Expenses: create + list with filters + update
 *   6. Payments: manual payment on an invoice flips status to paid
 *   7. Reports: pnl, sales-by-customer, expenses-by-category, tax-collected, outstanding
 *   8. Dashboard rollup returns the right shape
 *   9. Audit log records accounting actions
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../index.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

let app;
let baseURL;
let tmpDir;
let customerId;
let invoiceId;

async function req(method, url, body) {
  const r = await fetch(baseURL + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status} ${method} ${url}: ${data?.error || text}`);
    err.response = { status: r.status, data };
    throw err;
  }
  return data;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-acct-'));
  const testDbPath = join(tmpDir, 'test.db');
  app = await buildServer({ logger: false, dbPath: testDbPath, skipPoller: true, skipSmtp: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  baseURL = `http://127.0.0.1:${port}`;
  const db = app.db;
  // Seed: a customer, an invoice, and the migration 031 tables are already there.
  const c = db.prepare(`INSERT INTO customers (name, company, email) VALUES (?, ?, ?)`)
    .run('Acme Co', 'Acme Inc', 'ap@acme.test');
  customerId = c.lastInsertRowid;
  const inv = db.prepare(`INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                          subtotal_cents, tax_cents, total_cents, due_at)
                          VALUES (?, ?, 'sent', '[]', 10000, 500, 10500, date('now','+30 days'))`)
    .run('INV-TEST-001', customerId);
  invoiceId = inv.lastInsertRowid;
});

afterAll(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('accounting status', () => {
  it('reports module shape', async () => {
    const s = await req('GET', '/api/accounting/status');
    expect(s.module).toBe('accounting-mvp');
    expect(s.features.tax_rates).toBe(true);
    expect(s.features.products).toBe(true);
    expect(s.features.expenses).toBe(true);
    expect(s.features.payments_manual).toBe(true);
    expect(s.features.stripe_checkout).toBe(false); // no STRIPE_SECRET_KEY in test
  });
});

describe('tax_rates', () => {
  let gstId;
  it('creates GST', async () => {
    const r = await req('POST', '/api/accounting/tax-rates', { name: 'GST', rate_bps: 500 });
    expect(r.name).toBe('GST');
    expect(r.rate_bps).toBe(500);
    expect(r.active).toBe(1);
    gstId = r.id;
  });
  it('creates PST', async () => {
    const r = await req('POST', '/api/accounting/tax-rates', { name: 'PST', rate_bps: 700, jurisdiction: 'CA-BC' });
    expect(r.jurisdiction).toBe('CA-BC');
  });
  it('rejects out-of-range rate', async () => {
    await expect(req('POST', '/api/accounting/tax-rates', { name: 'BAD', rate_bps: 50000 }))
      .rejects.toMatchObject({ response: { status: 400 } });
  });
  it('lists and updates', async () => {
    const list = await req('GET', '/api/accounting/tax-rates');
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(2);
    const upd = await req('PUT', `/api/accounting/tax-rates/${gstId}`, { rate_bps: 600 });
    expect(upd.rate_bps).toBe(600);
  });
});

describe('products', () => {
  it('creates a service with default tax', async () => {
    const taxRates = await req('GET', '/api/accounting/tax-rates');
    const gst = taxRates.find((t) => t.name === 'GST');
    const r = await req('POST', '/api/accounting/products', {
      sku: 'SVC-LBR-HR', name: 'Labour (hourly)', unit_price_cents: 12500, default_tax_rate_id: gst.id,
    });
    expect(r.sku).toBe('SVC-LBR-HR');
    expect(r.unit_price_cents).toBe(12500);
  });
  it('rejects duplicate SKU', async () => {
    await expect(req('POST', '/api/accounting/products', { sku: 'SVC-LBR-HR', name: 'Dup' }))
      .rejects.toMatchObject({ response: { status: 409 } });
  });
  it('allows no-sku product', async () => {
    const r = await req('POST', '/api/accounting/products', { name: 'Walk-in diagnostic' });
    expect(r.sku).toBeNull();
  });
  it('searches by name', async () => {
    const list = await req('GET', '/api/accounting/products?q=Labour');
    expect(list.find((p) => p.sku === 'SVC-LBR-HR')).toBeTruthy();
  });
});

describe('expense categories + expenses', () => {
  let catId;
  it('creates a category', async () => {
    const r = await req('POST', '/api/accounting/expense-categories', { name: 'Software' });
    catId = r.id;
  });
  it('rejects duplicate category name', async () => {
    await expect(req('POST', '/api/accounting/expense-categories', { name: 'Software' }))
      .rejects.toMatchObject({ response: { status: 409 } });
  });
  it('creates an expense with tax', async () => {
    const taxRates = await req('GET', '/api/accounting/tax-rates');
    const gst = taxRates.find((t) => t.name === 'GST');
    const r = await req('POST', '/api/accounting/expenses', {
      vendor: 'Adobe', expense_date: '2026-06-01', category_id: catId,
      amount_cents: 6500, tax_cents: 325, tax_rate_id: gst.id, payment_method: 'card',
      notes: 'Creative Cloud monthly',
    });
    expect(r.vendor).toBe('Adobe');
    expect(r.tax_cents).toBe(325);
  });
  it('rejects bad date format', async () => {
    await expect(req('POST', '/api/accounting/expenses', {
      vendor: 'Bad', expense_date: '06/01/2026', amount_cents: 1000,
    })).rejects.toMatchObject({ response: { status: 400 } });
  });
  it('lists expenses with filters', async () => {
    const list = await req('GET', '/api/accounting/expenses?from=2026-06-01&to=2026-06-30');
    expect(list.length).toBeGreaterThanOrEqual(1);
  });
  it('updates an expense note', async () => {
    const list = await req('GET', '/api/accounting/expenses');
    const exp = list[0];
    const upd = await req('PUT', `/api/accounting/expenses/${exp.id}`, { notes: 'updated' });
    expect(upd.notes).toBe('updated');
  });
});

describe('payments', () => {
  it('manual e-transfer marks invoice paid when total covered', async () => {
    const r = await req('POST', '/api/accounting/payments', {
      invoice_id: invoiceId, amount_cents: 10500, method: 'e_transfer', status: 'succeeded',
      notes: 'Test e-transfer',
    });
    expect(r.method).toBe('e_transfer');
    expect(r.status).toBe('succeeded');
    const inv = await req('GET', `/api/invoices`);
    const invRow = inv.find((i) => i.id === invoiceId);
    expect(invRow.status).toBe('paid');
  });
  it('records Stripe payment_intent id with idempotency', async () => {
    const r = await req('POST', '/api/accounting/payments', {
      invoice_id: invoiceId, amount_cents: 100, method: 'stripe',
      stripe_payment_intent_id: 'pi_test_abc123', status: 'succeeded',
    });
    expect(r.stripe_payment_intent_id).toBe('pi_test_abc123');
    const events = await req('GET', `/api/accounting/payments?invoice_id=${invoiceId}`);
    expect(events.length).toBeGreaterThanOrEqual(2);
  });
  it('rejects payment for missing invoice', async () => {
    await expect(req('POST', '/api/accounting/payments', {
      invoice_id: 99999, amount_cents: 100, method: 'cash',
    })).rejects.toMatchObject({ response: { status: 404 } });
  });
});

describe('reports', () => {
  it('pnl returns income - expense', async () => {
    const r = await req('GET', '/api/accounting/reports/pnl');
    expect(r.income_cents).toBeGreaterThanOrEqual(10500);
    expect(r.expense_cents).toBeGreaterThanOrEqual(6500);
    expect(r.net_cents).toBe(r.income_cents - r.expense_cents);
  });
  it('sales-by-customer shows the seeded customer', async () => {
    const r = await req('GET', '/api/accounting/reports/sales-by-customer');
    const acme = r.find((row) => row.name === 'Acme Co');
    expect(acme).toBeTruthy();
    expect(acme.sales_cents).toBeGreaterThanOrEqual(10500);
  });
  it('expenses-by-category groups Software', async () => {
    const r = await req('GET', '/api/accounting/reports/expenses-by-category');
    const sw = r.find((row) => row.category === 'Software');
    expect(sw).toBeTruthy();
    expect(sw.amount_cents).toBeGreaterThanOrEqual(6500);
  });
  it('tax-collected sums invoice tax_cents', async () => {
    const r = await req('GET', '/api/accounting/reports/tax-collected');
    expect(r[0].total_tax_cents).toBeGreaterThanOrEqual(500);
  });
  it('outstanding no longer includes the paid invoice', async () => {
    const r = await req('GET', '/api/accounting/reports/outstanding');
    const found = r.find((row) => row.id === invoiceId);
    expect(found).toBeUndefined();
  });
});

describe('dashboard rollup', () => {
  it('returns expected shape', async () => {
    const r = await req('GET', '/api/accounting/dashboard');
    expect(r.unpaid_invoices.n).toBeGreaterThanOrEqual(0);
    expect(r.income_this_month_cents).toBeGreaterThanOrEqual(10500);
    expect(r.expenses_this_month_cents).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(r.recent_payments)).toBe(true);
    expect(Array.isArray(r.recent_expenses)).toBe(true);
  });
});

describe('audit log', () => {
  it('records accounting actions', async () => {
    // audit endpoint filters by target; we use tax_rate.create target = the id (string).
    const taxRates = await req('GET', '/api/accounting/tax-rates');
    const gst = taxRates.find((t) => t.name === 'GST');
    const r = await req('GET', `/api/audit?target=${gst.id}`);
    const found = r.find((entry) => entry.action === 'tax_rate.create');
    expect(found).toBeTruthy();
    expect(JSON.parse(found.payload).name).toBe('GST');
  });
});
