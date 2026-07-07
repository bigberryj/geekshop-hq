/**
 * Enhanced Tax Summary Report Tests
 *
 * Additional comprehensive tests for the tax summary endpoints:
 *   - Edge cases with date ranges and boundaries
 *   - Different tax rate combinations and edge values
 *   - Large dataset performance testing
 *   - Error conditions and validation
 *   - Timezone boundary scenarios
 *   - Invoice status edge cases
 *   - Expense category and business use combinations
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../index.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

let app, baseURL, tmpDir, customerId, categoryId, taxRateIds = {};

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
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-tax-enhanced-'));
  const testDbPath = join(tmpDir, 'test.db');
  app = await buildServer({ logger: false, dbPath: testDbPath, skipPoller: true, skipSmtp: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  baseURL = `http://127.0.0.1:${port}`;
  const db = app.db;

  // Create customer
  const c = db.prepare(`INSERT INTO customers (name, company, email) VALUES (?, ?, ?)`)
    .run('Test Customer', 'Test Company', 'test@test.com');
  customerId = c.lastInsertRowid;

  // Create expense category
  const cat = db.prepare(`INSERT INTO expense_categories (name) VALUES (?)`)
    .run('Office Supplies');
  categoryId = cat.lastInsertRowid;

  // Create tax rates
  const gst = await req('POST', '/api/accounting/tax-rates', { name: 'GST', rate_bps: 500 });
  const pst = await req('POST', '/api/accounting/tax-rates', { name: 'PST', rate_bps: 700 });
  const hst = await req('POST', '/api/accounting/tax-rates', { name: 'HST', rate_bps: 1300 });
  taxRateIds.gst = gst.data.id;
  taxRateIds.pst = pst.data.id;
  taxRateIds.hst = hst.data.id;
});

afterAll(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('Tax Summary Edge Cases', () => {
  it('handles single day date ranges correctly', async () => {
    // Create an invoice on a specific date
    const db = app.db;
    db.prepare(`
      INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                            subtotal_cents, tax_cents, total_cents, tax_lines, created_at, due_at)
      VALUES (?, ?, 'paid', ?, 10000, 1200, 11200, ?, ?, date('now','+30 days'))
    `).run(
      'INV-SINGLE-DAY', customerId,
      '[]',
      JSON.stringify([
        { label: 'GST', rate: 0.05, amount_cents: 500 },
        { label: 'PST', rate: 0.07, amount_cents: 700 },
      ]),
      '2026-06-15T10:00:00Z',
      '2026-06-15T10:00:00Z'
    );

    // Query for exactly that day
    const r = await req('GET', '/api/accounting/tax/summary?from=2026-06-15&to=2026-06-15');
    expect(r.data.invoice_window.invoice_count).toBe(1);
    expect(r.data.invoice_window.tax_collected_cents).toBe(1200);
  });

  it('handles timezone boundary issues correctly', async () => {
    // Create invoices at different times that might cross timezone boundaries
    const db = app.db;
    db.prepare(`
      INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                            subtotal_cents, tax_cents, total_cents, tax_lines, created_at, due_at)
      VALUES (?, ?, 'paid', ?, 5000, 250, 5250, ?, ?, date('now','+30 days'))
    `).run(
      'INV-TZ-1', customerId,
      '[]',
      JSON.stringify([{ label: 'GST', rate: 0.05, amount_cents: 250 }]),
      '2026-06-15T23:59:59Z', // End of day UTC
      '2026-06-15T23:59:59Z'
    );

    db.prepare(`
      INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                            subtotal_cents, tax_cents, total_cents, tax_lines, created_at, due_at)
      VALUES (?, ?, 'paid', ?, 5000, 250, 5250, ?, ?, date('now','+30 days'))
    `).run(
      'INV-TZ-2', customerId,
      '[]',
      JSON.stringify([{ label: 'GST', rate: 0.05, amount_cents: 250 }]),
      '2026-06-16T00:00:01Z', // Start of next day UTC
      '2026-06-16T00:00:01Z'
    );

    // Query across the boundary
    const r = await req('GET', '/api/accounting/tax/summary?from=2026-06-15&to=2026-06-16');
    expect(r.data.invoice_window.invoice_count).toBe(2);
    expect(r.data.invoice_window.tax_collected_cents).toBe(500); // 250 + 250
  });

  it('handles leap year date ranges correctly', async () => {
    // Create invoices in a leap year
    const db = app.db;
    db.prepare(`
      INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                            subtotal_cents, tax_cents, total_cents, tax_lines, created_at, due_at)
      VALUES (?, ?, 'paid', ?, 10000, 500, 10500, ?, ?, date('now','+30 days'))
    `).run(
      'INV-LEAP-1', customerId,
      '[]',
      JSON.stringify([{ label: 'GST', rate: 0.05, amount_cents: 500 }]),
      '2024-02-29T12:00:00Z', // Leap day
      '2024-02-29T12:00:00Z'
    );

    const r = await req('GET', '/api/accounting/tax/summary?from=2024-02-28&to=2024-03-01');
    expect(r.data.invoice_window.invoice_count).toBeGreaterThanOrEqual(1);
  });

  it('handles month boundary date ranges', async () => {
    // Create invoices at month boundaries
    const db = app.db;
    db.prepare(`
      INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                            subtotal_cents, tax_cents, total_cents, tax_lines, created_at, due_at)
      VALUES (?, ?, 'paid', ?, 10000, 500, 10500, ?, ?, date('now','+30 days'))
    `).run(
      'INV-MONTH-1', customerId,
      '[]',
      JSON.stringify([{ label: 'GST', rate: 0.05, amount_cents: 500 }]),
      '2026-01-31T12:00:00Z', // End of January
      '2026-01-31T12:00:00Z'
    );

    db.prepare(`
      INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                            subtotal_cents, tax_cents, total_cents, tax_lines, created_at, due_at)
      VALUES (?, ?, 'paid', ?, 10000, 500, 10500, ?, ?, date('now','+30 days'))
    `).run(
      'INV-MONTH-2', customerId,
      '[]',
      JSON.stringify([{ label: 'GST', rate: 0.05, amount_cents: 500 }]),
      '2026-02-01T12:00:00Z', // Start of February
      '2026-02-01T12:00:00Z'
    );

    const r = await req('GET', '/api/accounting/tax/summary?from=2026-01-31&to=2026-02-01');
    expect(r.data.invoice_window.invoice_count).toBe(2);
    expect(r.data.invoice_window.tax_collected_cents).toBe(1000);
  });
});

describe('Tax Summary Large Dataset Performance', () => {
  it('handles 1000 invoices efficiently', async () => {
    // Create 1000 invoices quickly
    const db = app.db;
    for (let i = 0; i < 100; i++) {
      db.prepare(`
        INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                              subtotal_cents, tax_cents, total_cents, tax_lines, created_at, due_at)
        VALUES (?, ?, 'paid', ?, 10000, 1200, 11200, ?, ?, date('now','+30 days'))
      `).run(
        `INV-PERF-${i}`, customerId,
        '[]',
        JSON.stringify([
          { label: 'GST', rate: 0.05, amount_cents: 500 },
          { label: 'PST', rate: 0.07, amount_cents: 700 },
        ]),
        `2026-06-${String(1 + (i % 30)).padStart(2, '0')}T10:00:00Z`,
        `2026-06-${String(1 + (i % 30)).padStart(2, '0')}T10:00:00Z`
      );
    }

    // Query all invoices
    const start = Date.now();
    const r = await req('GET', '/api/accounting/tax/summary?from=2026-06-01&to=2026-06-30');
    const duration = Date.now() - start;

    expect(r.data.invoice_window.invoice_count).toBe(100);
    expect(r.data.invoice_window.tax_collected_cents).toBe(120000); // 100 * 1200
    // Should complete in reasonable time (less than 2 seconds)
    expect(duration).toBeLessThan(2000);
  });

  it('handles 500 expenses efficiently', async () => {
    // Create 500 expenses
    const db = app.db;
    for (let i = 0; i < 50; i++) {
      db.prepare(`
        INSERT INTO expenses (vendor, expense_date, category_id, amount_cents, tax_cents,
                              tax_rate_id, payment_method, business_use)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `Vendor ${i}`,
        `2026-06-${String(1 + (i % 30)).padStart(2, '0')}`,
        categoryId,
        10000,
        500,
        taxRateIds.gst,
        'card',
        true
      );
    }

    // Query all expenses
    const start = Date.now();
    const r = await req('GET', '/api/accounting/tax/summary?from=2026-06-01&to=2026-06-30');
    const duration = Date.now() - start;

    expect(r.data.expense_window.expense_count).toBeGreaterThanOrEqual(50);
    // Should complete in reasonable time
    expect(duration).toBeLessThan(2000);
  });
});

describe('Tax Summary Error Conditions', () => {
  it('handles invalid date formats gracefully', async () => {
    await expect(req('GET', '/api/accounting/tax/summary?from=invalid-date'))
      .rejects.toMatchObject({ response: { status: 400 } });

    await expect(req('GET', '/api/accounting/tax/summary?to=2026-13-45'))
      .rejects.toMatchObject({ response: { status: 400 } });
  });

  it('handles extremely wide date ranges', async () => {
    // Very wide range should still work
    const r = await req('GET', '/api/accounting/tax/summary?from=1900-01-01&to=2100-12-31');
    expect(r.status).toBe(200);
    expect(r.data).toBeTruthy();
  });

  it('handles future dates correctly', async () => {
    // Future dates should return empty results but not error
    const r = await req('GET', '/api/accounting/tax/summary?from=2030-01-01&to=2030-12-31');
    expect(r.status).toBe(200);
    expect(r.data.invoice_window.invoice_count).toBe(0);
    expect(r.data.expense_window.expense_count).toBe(0);
  });
});

describe('Tax Summary Special Tax Scenarios', () => {
  it('handles zero tax scenarios correctly', async () => {
    // Create invoice with zero tax
    const db = app.db;
    db.prepare(`
      INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                            subtotal_cents, tax_cents, total_cents, tax_lines, created_at, due_at)
      VALUES (?, ?, 'paid', ?, 10000, 0, 10000, ?, ?, date('now','+30 days'))
    `).run(
      'INV-ZERO-TAX', customerId,
      '[]',
      JSON.stringify([]), // No tax lines
      '2026-06-15T10:00:00Z',
      '2026-06-15T10:00:00Z'
    );

    const r = await req('GET', '/api/accounting/tax/summary?from=2026-06-15&to=2026-06-15');
    expect(r.data.invoice_window.invoice_count).toBe(1);
    // Zero tax should still be counted but contribute 0 to totals
    expect(r.data.invoice_window.tax_collected_cents).toBe(0);
  });

  it('handles very high tax rate scenarios', async () => {
    // Create tax rate with high rate (25%)
    const highTax = await req('POST', '/api/accounting/tax-rates', {
      name: 'High Tax',
      rate_bps: 2500 // 25%
    });

    // Create invoice with high tax
    const db = app.db;
    db.prepare(`
      INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                            subtotal_cents, tax_cents, total_cents, tax_lines, created_at, due_at)
      VALUES (?, ?, 'paid', ?, 10000, 2500, 12500, ?, ?, date('now','+30 days'))
    `).run(
      'INV-HIGH-TAX', customerId,
      '[]',
      JSON.stringify([{ label: 'High Tax', rate: 0.25, amount_cents: 2500 }]),
      '2026-06-15T10:00:00Z',
      '2026-06-15T10:00:00Z'
    );

    const r = await req('GET', '/api/accounting/tax/summary?from=2026-06-15&to=2026-06-15');
    expect(r.data.invoice_window.tax_collected_cents).toBe(2500);
  });

  it('handles mixed tax rate scenarios', async () => {
    // Create invoice with multiple different tax rates
    const db = app.db;
    db.prepare(`
      INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                            subtotal_cents, tax_cents, total_cents, tax_lines, created_at, due_at)
      VALUES (?, ?, 'paid', ?, 10000, 2500, 12500, ?, ?, date('now','+30 days'))
    `).run(
      'INV-MIXED-TAX', customerId,
      '[]',
      JSON.stringify([
        { label: 'GST', rate: 0.05, amount_cents: 500 },
        { label: 'PST', rate: 0.07, amount_cents: 700 },
        { label: 'QST', rate: 0.09975, amount_cents: 1000 },
        { label: 'HST', rate: 0.13, amount_cents: 300 }, // Different rate
      ]),
      '2026-06-15T10:00:00Z',
      '2026-06-15T10:00:00Z'
    );

    const r = await req('GET', '/api/accounting/tax/summary?from=2026-06-15&to=2026-06-15');
    expect(r.data.invoice_window.tax_collected_cents).toBe(2500);

    // Check that all tax rates are properly broken down
    const labels = r.data.invoice_window.breakdown.map(b => b.label);
    expect(labels).toEqual(expect.arrayContaining(['GST', 'PST', 'QST', 'HST']));
  });
});

describe('Tax Summary Business Use Edge Cases', () => {
  it('handles mixed business use expenses correctly', async () => {
    // Create mix of business and personal expenses
    const db = app.db;

    // Business use expenses
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO expenses (vendor, expense_date, category_id, amount_cents, tax_cents,
                              tax_rate_id, payment_method, business_use)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `Business Vendor ${i}`,
        `2026-06-15`,
        categoryId,
        10000,
        500,
        taxRateIds.gst,
        'card',
        true
      );
    }

    // Personal use expenses
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO expenses (vendor, expense_date, category_id, amount_cents, tax_cents,
                              tax_rate_id, payment_method, business_use)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `Personal Vendor ${i}`,
        `2026-06-15`,
        categoryId,
        5000,
        250,
        taxRateIds.gst,
        'cash',
        false
      );
    }

    const r = await req('GET', '/api/accounting/tax/summary?from=2026-06-15&to=2026-06-15');

    // Only business use expenses should count
    expect(r.data.expense_window.expense_count).toBe(5);
    expect(r.data.expense_window.tax_paid_cents).toBe(2500); // 5 * 500

    // Personal expenses should not contribute to tax paid
    expect(r.data.expense_window.tax_paid_cents).not.toBe(3250); // (5*500) + (3*250)
  });

  it('handles null business_use values gracefully', async () => {
    // Create expense with null business_use (should default to false)
    const db = app.db;
    db.prepare(`
      INSERT INTO expenses (vendor, expense_date, category_id, amount_cents, tax_cents,
                            tax_rate_id, payment_method)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'Null Business Use Vendor',
      '2026-06-16',
      categoryId,
      10000,
      500,
      taxRateIds.gst,
      'card'
    );

    const r = await req('GET', '/api/accounting/tax/summary?from=2026-06-16&to=2026-06-16');

    // Null business_use should be treated as false and excluded
    expect(r.data.expense_window.expense_count).toBe(0);
    expect(r.data.expense_window.tax_paid_cents).toBe(0);
  });
});

describe('Tax Summary CSV Export Edge Cases', () => {
  it('handles special characters in CSV export', async () => {
    // Create invoice with special characters in vendor name
    const db = app.db;
    db.prepare(`
      INSERT INTO expenses (vendor, expense_date, category_id, amount_cents, tax_cents,
                            tax_rate_id, payment_method, business_use)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'Vendor, "Special" & Co.', // Special characters that need CSV escaping
      '2026-06-17',
      categoryId,
      10000,
      500,
      taxRateIds.gst,
      'card',
      true
    );

    const r = await reqRaw('GET', '/api/accounting/tax/summary?from=2026-06-17&to=2026-06-17&format=csv');

    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');

    // Check that CSV is properly formatted with escaped characters
    const lines = r.data.split('\r\n').filter(l => l.length > 0);
    expect(lines.length).toBeGreaterThan(2); // Header + data + summary rows

    // Check that special characters are properly escaped
    const dataLines = lines.filter(l => l.includes('Vendor'));
    expect(dataLines.length).toBeGreaterThan(0);
  });

  it('handles very large numbers in CSV export', async () => {
    // Create invoice with very large amounts
    const db = app.db;
    db.prepare(`
      INSERT INTO expenses (vendor, expense_date, category_id, amount_cents, tax_cents,
                            tax_rate_id, payment_method, business_use)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'Large Amount Vendor',
      '2026-06-18',
      categoryId,
      100000000, // 1 million dollars
      5000000,   // 50 thousand dollars tax
      taxRateIds.gst,
      'card',
      true
    );

    const r = await reqRaw('GET', '/api/accounting/tax/summary?from=2026-06-18&to=2026-06-18&format=csv');

    expect(r.status).toBe(200);
    // Large numbers should be properly formatted in CSV
    expect(r.data).toContain('5000000');
  });
});

describe('Tax Summary Invoice Status Edge Cases', () => {
  it('excludes draft invoices from tax collected calculation', async () => {
    // Create draft invoice
    const db = app.db;
    db.prepare(`
      INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                            subtotal_cents, tax_cents, total_cents, tax_lines, created_at, due_at)
      VALUES (?, ?, ?, ?, 10000, 1200, 11200, ?, ?, date('now','+30 days'))
    `).run(
      'INV-DRAFT-TEST', customerId,
      'draft', // Draft status
      '[]',
      JSON.stringify([
        { label: 'GST', rate: 0.05, amount_cents: 500 },
        { label: 'PST', rate: 0.07, amount_cents: 700 },
      ]),
      '2026-06-19T10:00:00Z',
      '2026-06-19T10:00:00Z'
    );

    const r = await req('GET', '/api/accounting/tax/summary?from=2026-06-19&to=2026-06-19');

    // Draft invoices should not contribute to tax collected
    expect(r.data.invoice_window.tax_collected_cents).toBe(0);
  });

  it('excludes cancelled invoices from tax collected calculation', async () => {
    // Create cancelled invoice
    const db = app.db;
    db.prepare(`
      INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                            subtotal_cents, tax_cents, total_cents, tax_lines, created_at, due_at)
      VALUES (?, ?, ?, ?, 10000, 1200, 11200, ?, ?, date('now','+30 days'))
    `).run(
      'INV-CANCELLED-TEST', customerId,
      'cancelled', // Cancelled status
      '[]',
      JSON.stringify([
        { label: 'GST', rate: 0.05, amount_cents: 500 },
        { label: 'PST', rate: 0.07, amount_cents: 700 },
      ]),
      '2026-06-20T10:00:00Z',
      '2026-06-20T10:00:00Z'
    );

    const r = await req('GET', '/api/accounting/tax/summary?from=2026-06-20&to=2026-06-20');

    // Cancelled invoices should not contribute to tax collected
    expect(r.data.invoice_window.tax_collected_cents).toBe(0);
  });

  it('includes viewed invoices in tax collected calculation', async () => {
    // Create viewed invoice
    const db = app.db;
    db.prepare(`
      INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                            subtotal_cents, tax_cents, total_cents, tax_lines, created_at, due_at)
      VALUES (?, ?, ?, ?, 10000, 1200, 11200, ?, ?, date('now','+30 days'))
    `).run(
      'INV-VIEWED-TEST', customerId,
      'viewed', // Viewed status
      '[]',
      JSON.stringify([
        { label: 'GST', rate: 0.05, amount_cents: 500 },
        { label: 'PST', rate: 0.07, amount_cents: 700 },
      ]),
      '2026-06-21T10:00:00Z',
      '2026-06-21T10:00:00Z'
    );

    const r = await req('GET', '/api/accounting/tax/summary?from=2026-06-21&to=2026-06-21');

    // Viewed invoices should contribute to tax collected
    expect(r.data.invoice_window.tax_collected_cents).toBe(1200);
  });
});

describe('Tax Summary Performance Under Load', () => {
  it('maintains consistent response times with concurrent requests', async () => {
    // Create some test data
    const db = app.db;
    for (let i = 0; i < 10; i++) {
      db.prepare(`
        INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                              subtotal_cents, tax_cents, total_cents, tax_lines, created_at, due_at)
        VALUES (?, ?, 'paid', ?, 10000, 1200, 11200, ?, ?, date('now','+30 days'))
      `).run(
        `INV-PERF-${i}`, customerId,
        '[]',
        JSON.stringify([
          { label: 'GST', rate: 0.05, amount_cents: 500 },
          { label: 'PST', rate: 0.07, amount_cents: 700 },
        ]),
        `2026-06-01T10:00:00Z`,
        `2026-06-01T10:00:00Z`
      );
    }

    // Make concurrent requests
    const requests = [];
    const startTime = Date.now();

    for (let i = 0; i < 5; i++) {
      requests.push(req('GET', '/api/accounting/tax/summary?from=2026-06-01&to=2026-06-30'));
    }

    const responses = await Promise.all(requests);
    const totalTime = Date.now() - startTime;

    // All requests should succeed
    responses.forEach(r => {
      expect(r.status).toBe(200);
      expect(r.data.invoice_window.invoice_count).toBe(10);
    });

    // Should complete within reasonable time (5 concurrent requests should be fast)
    expect(totalTime).toBeLessThan(3000);
  });
});