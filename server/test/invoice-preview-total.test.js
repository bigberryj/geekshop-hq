/**
 * Regression test for invoice line-item preview totals — T-79EB14 (2026-06-30).
 *
 * Bug: when an invoice line item is added from the Accounting → Products &
 * Services catalog (an "hour service"), the editor's preview Total showed
 * only the line price — missing the 5% GST + 7% PST (BC) that the saved
 * invoice would carry. The client editor used to compute tax itself and
 * forgot the global tax model, so $100 line + 5%+7% BC tax showed as
 * $100 total instead of $112. The Accounting invoice editor was fixed by
 * adding a server-side `POST /api/invoices/preview` endpoint that re-uses
 * the same compute-totals code path the create/update handlers do.
 *
 * This test pins the contract so:
 *   - The preview endpoint exists and returns the same totals the create
 *     handler would persist.
 *   - The global tax model (`gst_pst_bc` by default) is applied to any
 *     taxable line that doesn't carry its own `tax_rate_id` — which is
 *     exactly the "hour service" scenario.
 *
 * Running this test now is the actual evidence the bug is gone: 100 + 5 + 7
 * = 112, regardless of whether the line was added by typing or picked from
 * the catalog, with or without an explicit tax_rate_id.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-inv-preview-'));
  const testDbPath = join(tmpDir, 'test.db');
  app = await buildServer({ logger: false, dbPath: testDbPath, skipPoller: true, skipSmtp: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseURL = `http://127.0.0.1:${app.server.address().port}`;
  const db = app.db;
  const c = db.prepare(`INSERT INTO customers (name, company, email) VALUES (?, ?, ?)`)
    .run('Service Co', 'Service Inc', 'ap@svc.test');
  customerId = c.lastInsertRowid;
});

afterAll(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /api/invoices/preview — line-item totals apply the configured tax model', () => {
  it('applies BC GST 5% + PST 7% to an hour-service line with NO own tax_rate_id (catalog pick)', async () => {
    // Mirrors what the Accounting invoice editor sends when the admin
    // picks "Hourly Service Test" from the catalog dropdown:
    // { description, quantity=1, unit_price_cents=10000, taxable=true, tax_rate_id=null }
    const r = await req('POST', '/api/invoices/preview', {
      line_items: [
        {
          description: 'Hourly Service Test',
          quantity: 1,
          unit_price_cents: 10000,
          taxable: true,
          tax_rate_id: null,
        },
      ],
    });
    // The bug being fixed: total was just $100 instead of $112.
    expect(r.subtotal_cents).toBe(10000);
    expect(r.tax_cents).toBe(1200);   // 5% GST + 7% PST on $100
    expect(r.total_cents).toBe(11200); // ← the key regression assertion
    // Two tax lines (per BC model) aggregated into one preview response each.
    const labels = (r.tax_lines || []).map((ln) => ln.label).sort();
    expect(labels).toEqual(['GST', 'PST']);
    expect(r.tax_model_key).toBe('gst_pst_bc');
  });

  it('matches the totals persisted by POST /api/invoices for the same line', async () => {
    // Preview and persist must agree byte-for-byte — no drift.
    const preview = await req('POST', '/api/invoices/preview', {
      line_items: [
        { description: 'One hour service', quantity: 1, unit_price_cents: 12500, taxable: true, tax_rate_id: null },
      ],
    });
    const created = await req('POST', '/api/invoices', {
      customer_id: customerId,
      line_items: [
        { description: 'One hour service', quantity: 1, unit_price_cents: 12500, taxable: true, tax_rate_id: null },
      ],
    });
    expect(created.subtotal_cents).toBe(preview.subtotal_cents);
    expect(created.tax_cents).toBe(preview.tax_cents);
    expect(created.total_cents).toBe(preview.total_cents);
    // GST 5% on $125 = $6.25 = 625¢; PST 7% on $125 = $8.75 = 875¢; total = $140 = 14000¢
    expect(created.total_cents).toBe(14000);
  });

  it('returns zero totals for an empty line_items array (no crash)', async () => {
    const r = await req('POST', '/api/invoices/preview', { line_items: [] });
    expect(r.subtotal_cents).toBe(0);
    expect(r.tax_cents).toBe(0);
    expect(r.total_cents).toBe(0);
  });

  it('rejects line_items being missing or not an array', async () => {
    const r = await fetch(baseURL + '/api/invoices/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/line_items/);
  });

  it('honours a non-taxable hour service (e.g. warranty line) — no tax in total', async () => {
    const r = await req('POST', '/api/invoices/preview', {
      line_items: [
        { description: 'Warranty hour', quantity: 1, unit_price_cents: 10000, taxable: false, tax_rate_id: null },
      ],
    });
    expect(r.subtotal_cents).toBe(10000);
    expect(r.tax_cents).toBe(0);
    expect(r.total_cents).toBe(10000);
  });

  it('per-line tax_rate_id overrides the global model when set (per-line tax path)', async () => {
    // Ensure there's at least one tax rate row to point at; pick the
    // default seeded one if present, else insert a 5% GST row.
    const id = app.db.prepare(
      `INSERT OR IGNORE INTO tax_rates (name, rate_bps, active) VALUES (?, ?, 1)`
    ).run('Test GST 5', 500).lastInsertRowid;
    const r = await req('POST', '/api/invoices/preview', {
      line_items: [
        { description: 'One hour service', quantity: 1, unit_price_cents: 10000, taxable: true, tax_rate_id: id },
      ],
    });
    // $100 × 5% = $5 → total $105. The per-line tax path does not add
    // PST on top (because the line carries its own rate, no fallback to
    // the global model first line).
    expect(r.subtotal_cents).toBe(10000);
    expect(r.tax_cents).toBe(500);
    expect(r.total_cents).toBe(10500);
  });
});
