/**
 * Phase 5 — Tax summary reports tests.
 *
 * Covers:
 *   - The pure-function helpers in lib/tax.js (aggregateTaxLines,
 *     rollupTaxBreakdown, csvCell, toCsv) at the math level.
 *   - GET /api/accounting/tax/summary at the Fastify level: windowed
 *     sum of invoices.tax_cents, sum of expenses.tax_cents (business
 *     use only), net remittance math, breakdown rollup across rate
 *     labels, integer-cent invariants, status exclusions (drafts +
 *     cancellations do not count), CSV variant produces RFC-4180
 *     text with summary rows + the right header.
 *   - GET /api/accounting/tax/pdf-ready returns a printable payload
 *     (per-invoice detail, per-rate breakdown on the expense side).
 *   - Empty windows return zeros — never an empty payload that
 *     breaks the UI.
 *
 * Pure-function tests run first; the Fastify tests build a transient
 * server in a tmp dir (no shared state with the live HQ DB).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../index.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  aggregateTaxLines,
  rollupTaxBreakdown,
  csvCell,
  toCsv,
} from '../lib/tax.js';

describe('aggregateTaxLines (pure)', () => {
  it('groups lines by label (case-insensitive)', () => {
    const out = aggregateTaxLines([
      { label: 'GST', rate: 0.05, amount_cents: 500 },
      { label: 'gst', rate: 0.05, amount_cents: 250 },
      { label: 'PST', rate: 0.07, amount_cents: 700 },
    ]);
    expect(out.find((b) => b.label === 'GST').amount_cents).toBe(750);
    expect(out.find((b) => b.label === 'PST').amount_cents).toBe(700);
  });

  it('drops zero and unlabelled lines', () => {
    const out = aggregateTaxLines([
      { label: '', rate: 0.05, amount_cents: 100 },
      { label: 'GST', rate: 0.05, amount_cents: 0 },
      null,
      undefined,
    ]);
    expect(out).toEqual([]);
  });

  it('returns [] for nullish input', () => {
    expect(aggregateTaxLines(null)).toEqual([]);
    expect(aggregateTaxLines(undefined)).toEqual([]);
    expect(aggregateTaxLines('not an array')).toEqual([]);
  });

  it('rounds non-integer amount_cents to nearest cent', () => {
    // 0.09975 * 1000 = 99.75 → rounds half-up to 100
    const out = aggregateTaxLines([
      { label: 'QST', rate: 0.09975, amount_cents: 99.75 },
      { label: 'QST', rate: 0.09975, amount_cents: 99.75 },
    ]);
    expect(out[0].amount_cents).toBe(200); // 100 + 100 (99.75 rounds up)
  });
});

describe('rollupTaxBreakdown (pure)', () => {
  it('merges multiple invoice breakdowns into a single sort-by-amount-desc list', () => {
    const out = rollupTaxBreakdown([
      [{ label: 'GST', rate: 0.05, amount_cents: 500 }],
      [{ label: 'GST', rate: 0.05, amount_cents: 250 }, { label: 'PST', rate: 0.07, amount_cents: 700 }],
      [{ label: 'HST', rate: 0.13, amount_cents: 1300 }],
    ]);
    expect(out[0].label).toBe('HST');
    expect(out[0].amount_cents).toBe(1300);
    const pst = out.find((b) => b.label === 'PST');
    expect(pst.amount_cents).toBe(700);
    const gst = out.find((b) => b.label === 'GST');
    expect(gst.amount_cents).toBe(750);
  });

  it('returns [] when nothing contributes', () => {
    expect(rollupTaxBreakdown([])).toEqual([]);
    expect(rollupTaxBreakdown([[], null, undefined])).toEqual([]);
  });

  it('preserves the rate when every contributing line agrees on one', () => {
    const out = rollupTaxBreakdown([
      [{ label: 'GST', rate: 0.05, amount_cents: 500 }],
      [{ label: 'GST', rate: 0.05, amount_cents: 500 }],
    ]);
    expect(out[0].rate).toBe(0.05);
  });
});

describe('csvCell + toCsv (RFC-4180)', () => {
  it('leaves boring cells untouched', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(123)).toBe('123');
    expect(csvCell(null)).toBe('');
  });

  it('quotes cells containing commas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
  });

  it('quotes and doubles embedded double quotes', () => {
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
  });

  it('quotes cells containing newlines', () => {
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('toCsv joins with CRLF and adds a header row', () => {
    const csv = toCsv(['Label', 'Amount'], [
      ['GST', 500],
      ['PST', 700],
    ]);
    expect(csv).toBe('Label,Amount\r\nGST,500\r\nPST,700\r\n');
  });

  it('toCsv escapes cells that need quoting', () => {
    const csv = toCsv(['Customer', 'Notes'], [
      ['Acme, Inc.', 'loves us'],
      ['B "Bob"', 'ok'],
    ]);
    expect(csv).toBe(
      'Customer,Notes\r\n' +
      '"Acme, Inc.",loves us\r\n' +
      '"B ""Bob""",ok\r\n',
    );
  });
});

// =====================================================================
// Fastify integration tests.
// =====================================================================

let app, baseURL, tmpDir, customerId, invoice1Id, invoice2Id;

async function req(method, url, body) {
  const r = await fetch(baseURL + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await r.json() : await r.text();
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status} ${method} ${url}: ${typeof data === 'string' ? data : data?.error}`);
    err.response = { status: r.status, data };
    throw err;
  }
  return { status: r.status, data, headers: r.headers };
}

async function reqRaw(method, url) {
  const r = await fetch(baseURL + url, { method });
  return {
    status: r.status,
    data: await r.text(),
    headers: r.headers,
  };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-tax5-'));
  const testDbPath = join(tmpDir, 'test.db');
  app = await buildServer({ logger: false, dbPath: testDbPath, skipPoller: true, skipSmtp: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  baseURL = `http://127.0.0.1:${port}`;
  const db = app.db;
  const c = db.prepare(`INSERT INTO customers (name, company, email) VALUES (?, ?, ?)`)
    .run('Acme Co', 'Acme Inc', 'ap@acme.test');
  customerId = c.lastInsertRowid;

  // Two invoices with different tax_lines shapes — verify the
  // breakdown rolls them up cleanly. Invoice 1 = BC GST + PST,
  // Invoice 2 = manual override "Tax (manual)" line.
  const inv1 = db.prepare(`
    INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                          subtotal_cents, tax_cents, total_cents, tax_lines, created_at, due_at)
    VALUES (?, ?, 'paid', ?, 10000, 1200, 11200, ?, ?, date('now','+30 days'))
  `).run(
    'INV-TAX5-001', customerId,
    '[]',
    JSON.stringify([
      { label: 'GST', rate: 0.05, amount_cents: 500 },
      { label: 'PST', rate: 0.07, amount_cents: 700 },
    ]),
    '2026-06-15T10:00:00Z',
  );
  invoice1Id = inv1.lastInsertRowid;

  const inv2 = db.prepare(`
    INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                          subtotal_cents, tax_cents, total_cents, tax_lines, created_at, due_at)
    VALUES (?, ?, 'sent', ?, 20000, 1500, 21500, ?, ?, date('now','+30 days'))
  `).run(
    'INV-TAX5-002', customerId,
    '[]',
    JSON.stringify([
      { label: 'Tax (manual)', rate: null, amount_cents: 1500 },
    ]),
    '2026-06-20T10:00:00Z',
  );
  invoice2Id = inv2.lastInsertRowid;

  // Three expenses across two rates + one personal (business_use = 0)
  // to verify that personal expenses are correctly excluded from the
  // tax-paid total even when their tax_cents > 0. The tax_rate_id is
  // required to exercise the rate-join in the breakdown; the test
  // creates the rate explicitly because the seed only populates
  // settings — not tax_rates (intentional; rates are owner-managed).
  const created = await req('POST', '/api/accounting/tax-rates', { name: 'GST', rate_bps: 500 });
  const gst = created.data;
  // Use seed-style direct inserts via the API to leverage validation:
  await req('POST', '/api/accounting/expenses', {
    vendor: 'Server Co',
    expense_date: '2026-06-10',
    amount_cents: 1100,
    tax_cents: 100,
    tax_rate_id: gst.id,
    payment_method: 'card',
    business_use: true,
  });
  await req('POST', '/api/accounting/expenses', {
    vendor: 'Office Supplies',
    expense_date: '2026-06-12',
    amount_cents: 2200,
    tax_cents: 200,
    tax_rate_id: gst.id,
    payment_method: 'cash',
    business_use: true,
  });
  await req('POST', '/api/accounting/expenses', {
    vendor: 'Personal (excluded)',
    expense_date: '2026-06-18',
    amount_cents: 5500,
    tax_cents: 500,
    tax_rate_id: gst.id,
    payment_method: 'card',
    business_use: false, // ← must NOT contribute to tax_paid
  });

  // A draft invoice + a cancelled invoice — both must be excluded
  // from the tax-collected total.
  db.prepare(`
    INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                          subtotal_cents, tax_cents, total_cents, tax_lines, created_at, due_at)
    VALUES (?, ?, 'draft', ?, 1000, 100, 1100, ?, ?, date('now','+30 days'))
  `).run(
    'INV-TAX5-DRAFT', customerId,
    '[]',
    JSON.stringify([{ label: 'GST', rate: 0.05, amount_cents: 100 }]),
    '2026-06-22T10:00:00Z',
  );
  db.prepare(`
    INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                          subtotal_cents, tax_cents, total_cents, tax_lines, created_at, due_at)
    VALUES (?, ?, 'cancelled', ?, 1000, 100, 1100, ?, ?, date('now','+30 days'))
  `).run(
    'INV-TAX5-CANX', customerId,
    '[]',
    JSON.stringify([{ label: 'GST', rate: 0.05, amount_cents: 100 }]),
    '2026-06-23T10:00:00Z',
  );
});

afterAll(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/accounting/tax/summary', () => {
  it('returns the all-time rollup when no dates set', async () => {
    const r = await req('GET', '/api/accounting/tax/summary');
    expect(r.status).toBe(200);
    // All-time window: our two invoices contribute.
    expect(r.data.invoice_window.invoice_count).toBe(2);
    expect(r.data.invoice_window.tax_collected_cents).toBe(2700); // 1200 + 1500
    // 2 business-use expenses contribute 100 + 200 = 300. The personal
    // expense is excluded by the WHERE business_use=1 clause, so the
    // response sees only the 2 qualifying rows.
    expect(r.data.expense_window.expense_count).toBe(2);
    expect(r.data.expense_window.tax_paid_cents).toBe(300);
    expect(r.data.net_remittance_cents).toBe(2400); // 2700 − 300
  });

  it('excludes draft + cancelled invoices from tax collected', async () => {
    // Our draft + cancelled invoices had tax_cents = 100 each. If
    // the status filter had been wrong, the total tax_collected
    // would have been 2700 + 200 = 2900. Verify the actual number is
    // the right one.
    const r = await req('GET', '/api/accounting/tax/summary');
    expect(r.data.invoice_window.tax_collected_cents).toBe(2700);
  });

  it('excludes business_use = 0 expenses from tax paid', async () => {
    // The personal expense had tax_cents = 500 and is filtered out at
    // the WHERE business_use=1 clause. If the filter were broken the
    // tax_paid_cents would be 800 (100 + 200 + 500). Verify the
    // actual number is the correct one.
    const r = await req('GET', '/api/accounting/tax/summary');
    expect(r.data.expense_window.tax_paid_cents).toBe(300);
    // The row count also excludes the personal expense.
    expect(r.data.expense_window.expense_count).toBe(2);
  });

  it('window filter restricts both sides (from/to bounds)', async () => {
    // Window covers only invoice 2 (June 20). Invoice 1 (June 15)
    // is excluded. Expense dates also use the window (10th and 12th
    // included; 18th excluded if window ends at 18th not inclusive).
    const r = await req('GET', '/api/accounting/tax/summary?from=2026-06-19&to=2026-06-21');
    expect(r.data.invoice_window.invoice_count).toBe(1);
    expect(r.data.invoice_window.tax_collected_cents).toBe(1500);
    // No expenses in this narrow window — 18th excluded.
    expect(r.data.expense_window.expense_count).toBe(0);
    expect(r.data.expense_window.tax_paid_cents).toBe(0);
    expect(r.data.net_remittance_cents).toBe(1500);
  });

  it('integer-cent arithmetic: every summary total is a plain integer', async () => {
    const r = await req('GET', '/api/accounting/tax/summary');
    for (const v of [
      r.data.invoice_window.subtotal_cents,
      r.data.invoice_window.tax_collected_cents,
      r.data.invoice_window.grand_total_cents,
      r.data.expense_window.total_cents,
      r.data.expense_window.tax_paid_cents,
      r.data.net_remittance_cents,
    ]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('breakdowns sum to the totals (collected + paid)', async () => {
    const r = await req('GET', '/api/accounting/tax/summary');
    const collectedSum = r.data.invoice_window.breakdown
      .reduce((s, b) => s + b.amount_cents, 0);
    expect(collectedSum).toBe(r.data.invoice_window.tax_collected_cents);
    const paidSum = r.data.expense_window.breakdown
      .reduce((s, b) => s + b.amount_cents, 0);
    expect(paidSum).toBe(r.data.expense_window.tax_paid_cents);
  });

  it('detail_rows has the same rows as both breakdowns', async () => {
    const r = await req('GET', '/api/accounting/tax/summary');
    const fromInvoice = r.data.detail_rows.filter((d) => d.source === 'invoice');
    const fromExpense = r.data.detail_rows.filter((d) => d.source === 'expense');
    expect(fromInvoice.length).toBe(r.data.invoice_window.breakdown.length);
    expect(fromExpense.length).toBe(r.data.expense_window.breakdown.length);
  });

  it('rolls up multiple invoices of the same GST label across the breakdown', async () => {
    // After excluding the draft + cancelled rows, only the "paid" +
    // "sent" rows contribute: 1200 + 1500 = 2700. The breakdown
    // should have one GST row at 500 and one PST row at 700, plus
    // one "Tax (manual)" row at 1500. Verify all three labels.
    const r = await req('GET', '/api/accounting/tax/summary');
    const labels = r.data.invoice_window.breakdown.map((b) => b.label);
    expect(labels).toEqual(expect.arrayContaining(['GST', 'PST', 'Tax (manual)']));
  });

  it('CSV format produces RFC-4180 text with summary rows', async () => {
    const r = await reqRaw('GET', '/api/accounting/tax/summary?format=csv');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.headers.get('content-disposition')).toContain('attachment');
    expect(r.headers.get('content-disposition')).toContain('tax-summary-');
    // First line is the header.
    const lines = r.data.split('\r\n').filter((l) => l.length > 0);
    expect(lines[0]).toBe('Source,Label,Rate,Amount (cents),Count,From,To,Generated at,Net remittance (cents)');
    // The last three rows are the summary TOTALs.
    expect(lines[lines.length - 3]).toContain('TOTAL: tax collected (cents)');
    expect(lines[lines.length - 2]).toContain('TOTAL: tax paid (cents)');
    expect(lines[lines.length - 1]).toContain('NET remittance (cents)');
  });

  it('CSV value totals equal the JSON summary totals (no drift between formats)', async () => {
    const json = await req('GET', '/api/accounting/tax/summary');
    const csv = await reqRaw('GET', '/api/accounting/tax/summary?format=csv');
    const lines = csv.data.split('\r\n').filter((l) => l.length > 0);
    const totals = lines.filter((l) => l.startsWith(',TOTAL: tax collected') || l.startsWith(',TOTAL: tax paid') || l.startsWith(',NET remittance'));
    expect(totals.length).toBe(3);
    // The "TOTAL: tax collected" row's 4th column is the cents. Verifies
    // that the CSV exported the same number the JSON returns.
    const collectedRow = totals.find((l) => l.startsWith(',TOTAL: tax collected'));
    const cells = collectedRow.split(',');
    expect(Number(cells[3])).toBe(json.data.invoice_window.tax_collected_cents);
  });

  it('empty window returns zeros, not nulls', async () => {
    const r = await req('GET', '/api/accounting/tax/summary?from=1999-01-01&to=1999-12-31');
    expect(r.status).toBe(200);
    expect(r.data.invoice_window.invoice_count).toBe(0);
    expect(r.data.invoice_window.tax_collected_cents).toBe(0);
    expect(r.data.expense_window.expense_count).toBe(0);
    expect(r.data.expense_window.tax_paid_cents).toBe(0);
    expect(r.data.net_remittance_cents).toBe(0);
    // Breakdown arrays are empty but not null.
    expect(Array.isArray(r.data.invoice_window.breakdown)).toBe(true);
    expect(Array.isArray(r.data.expense_window.breakdown)).toBe(true);
    expect(r.data.invoice_window.breakdown).toEqual([]);
    expect(r.data.expense_window.breakdown).toEqual([]);
  });
});

describe('GET /api/accounting/tax/pdf-ready', () => {
  it('returns the printable payload structure (title, breakdown, net)', async () => {
    const r = await req('GET', '/api/accounting/tax/pdf-ready');
    expect(r.status).toBe(200);
    expect(r.data.title).toBe('Tax Remittance Summary');
    expect(r.data.collected).toBeTruthy();
    expect(r.data.paid).toBeTruthy();
    expect(Array.isArray(r.data.collected.breakdown)).toBe(true);
    expect(Array.isArray(r.data.paid.breakdown)).toBe(true);
    expect(r.data.collected.invoices).toBeTruthy();
    expect(Number.isInteger(r.data.net_remittance_cents)).toBe(true);
    expect(r.data.generated_at).toBeTruthy();
  });

  it('windowed request limits the printable invoice list to the from/to range', async () => {
    const r = await req('GET', '/api/accounting/tax/pdf-ready?from=2026-06-19&to=2026-06-21');
    expect(r.data.collected.invoice_count).toBe(1);
    expect(r.data.collected.invoices.length).toBe(1);
    expect(r.data.collected.invoices[0].invoice_uid).toBe('INV-TAX5-002');
  });

  it('expense breakdown includes per-expense details (vendor / receipt flag)', async () => {
    const r = await req('GET', '/api/accounting/tax/pdf-ready');
    expect(r.data.paid.breakdown.length).toBeGreaterThanOrEqual(1);
    const gst = r.data.paid.breakdown.find((b) => b.label === 'GST');
    expect(gst).toBeTruthy();
    expect(gst.expenses.length).toBeGreaterThanOrEqual(2);
    expect(typeof gst.expenses[0].has_receipt).toBe('boolean');
  });
});
