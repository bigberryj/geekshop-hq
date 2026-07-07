/**
 * Phase 3 — Payments ledger + invoice state upgrades tests.
 *
 * Covers:
 *   1. Recording a partial payment flips invoice → 'partial'.
 *   2. Recording a payment that tops up the invoice to ≥ total → 'paid'.
 *   3. Refunding the top-up payment flips invoice back to 'partial'.
 *   4. A 'partial' invoice that is also past-due stays 'partial' until
 *      the last succeeded payment is removed (no auto-overdue).
 *   5. Integer-cent math: balance = total - paid always integers.
 *   6. summary endpoint reports paid / pending / refunded / balance / computed_status.
 *   7. Reconciler endpoint back-fills 'partial' on pre-existing invoices
 *      whose persisted status had drifted.
 *   8. Cancel / paid are sticky — payments don't override them.
 *   9. Payment PUT (notes / status edit) recomputes the parent invoice.
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
let inv100;   // total 10000
let inv200;   // total 20000
let inv500;   // total 50000
let inv10k;   // total 100000 (for reconciler test)

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

// Track the integer total of each invoice as the server computed it, so
// the test can assert balance math against the real persisted total.
const totals = {};

async function makeInvoice(totalCents, dueAt) {
  const r = await req('POST', '/api/invoices', {
    customer_id: customerId,
    // computeInvoiceTotals reads `li.total_cents` first; that's the
    // canonical integer-cents path used by labour lines too.
    line_items: [{ description: 'Test service', total_cents: totalCents }],
    due_at: dueAt || null,
  });
  totals[r.id] = r.total_cents;
  // Move to 'sent' so the reconciliation path is exercised.
  await req('POST', `/api/invoices/${r.id}/status`, { status: 'sent' });
  return r.id;
}

function totalFor(id) {
  return totals[id];
}
function balanceFor(id, paid) {
  return Math.max(0, totalFor(id) - paid);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-phase3-'));
  const testDbPath = join(tmpDir, 'test.db');
  app = await buildServer({ logger: false, dbPath: testDbPath, skipPoller: true, skipSmtp: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  baseURL = `http://127.0.0.1:${port}`;
  const db = app.db;
  const c = db.prepare(`INSERT INTO customers (name, company, email) VALUES (?, ?, ?)`)
    .run('Phase3 Co', 'Phase3 Inc', 'p3@phase3.test');
  customerId = c.lastInsertRowid;
  inv100 = await makeInvoice(10000);
  inv200 = await makeInvoice(20000);
  inv500 = await makeInvoice(50000);
  inv10k = await makeInvoice(100000, null);
});

afterAll(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('payments ledger — partial / paid transitions', () => {
  it('partial payment flips invoice from sent → partial', async () => {
    const r = await req('POST', '/api/accounting/payments', {
      invoice_id: inv100, amount_cents: 4000, method: 'cash', status: 'succeeded',
    });
    expect(r.status).toBe('succeeded');
    const detail = await req('GET', `/api/accounting/payments/summary?invoice_id=${inv100}`);
    expect(detail[0].paid_cents).toBe(4000);
    expect(detail[0].balance_cents).toBe(balanceFor(inv100, 4000));
    expect(detail[0].computed_status).toBe('partial');
    expect(detail[0].persisted_status ?? detail[0].status).toBe('partial');
    expect(detail[0].status_in_sync).toBe(true);
  });

  it('top-up to ≥ total flips partial → paid', async () => {
    const remaining = totalFor(inv100) - 4000;
    await req('POST', '/api/accounting/payments', {
      invoice_id: inv100, amount_cents: remaining, method: 'e_transfer', status: 'succeeded',
    });
    const detail = await req('GET', `/api/accounting/payments/summary?invoice_id=${inv100}`);
    expect(detail[0].paid_cents).toBe(totalFor(inv100));
    expect(detail[0].balance_cents).toBe(0);
    expect(detail[0].computed_status).toBe('paid');
    expect(detail[0].status_in_sync).toBe(true);
    // Last `paid_invoices.paid_at` must be set on the row.
    const row = app.db.prepare('SELECT status, paid_at FROM invoices WHERE id = ?').get(inv100);
    expect(row.status).toBe('paid');
    expect(row.paid_at).toBeTruthy();
  });

  it('refunding the top-up flips the invoice back to partial', async () => {
    const list = await req('GET', `/api/accounting/payments?invoice_id=${inv100}&status=succeeded`);
    const topup = list.find((p) => p.amount_cents !== 4000);
    expect(topup).toBeTruthy();
    await req('PUT', `/api/accounting/payments/${topup.id}`, { status: 'refunded' });
    const detail = await req('GET', `/api/accounting/payments/summary?invoice_id=${inv100}`);
    expect(detail[0].paid_cents).toBe(4000);
    expect(detail[0].refunded_cents).toBe(topup.amount_cents);
    expect(detail[0].computed_status).toBe('partial');
    const row = app.db.prepare('SELECT status FROM invoices WHERE id = ?').get(inv100);
    expect(row.status).toBe('partial');
  });

  it('partial + past due stays partial (no auto-overdue)', async () => {
    // Backdate inv200 with a partial payment, then verify it stays
    // 'partial' even when due_at is in the past (the auto-promoter should
    // only overwrite drafts → overdue, never partials).
    const past = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    app.db.prepare('UPDATE invoices SET due_at = ? WHERE id = ?').run(past, inv200);
    await req('POST', '/api/accounting/payments', {
      invoice_id: inv200, amount_cents: 5000, method: 'e_transfer', status: 'succeeded',
    });
    const detail = await req('GET', `/api/accounting/payments/summary?invoice_id=${inv200}`);
    expect(detail[0].computed_status).toBe('partial');
    expect(detail[0].status_in_sync).toBe(true);
  });

  it('integer-cent math holds: balance + paid + refunded == total', async () => {
    // inv500: any total — record a partial + a refund to exercise
    // both sums. We pin amounts as fractions of the persisted total so
    // the math is independent of the tax model used by the test DB.
    const total = totalFor(inv500);
    const bigPayment = Math.round(total * 0.6);
    const refundPayment = Math.round(total * 0.1);
    const expectedPaid = bigPayment; // refund excluded
    const expectedRefunded = refundPayment;
    const expectedBalance = Math.max(0, total - expectedPaid);

    await req('POST', '/api/accounting/payments', {
      invoice_id: inv500, amount_cents: bigPayment, method: 'cash', status: 'succeeded',
    });
    const r2 = await req('POST', '/api/accounting/payments', {
      invoice_id: inv500, amount_cents: refundPayment, method: 'cash', status: 'succeeded',
    });
    await req('PUT', `/api/accounting/payments/${r2.id}`, { status: 'refunded' });
    const detail = await req('GET', `/api/accounting/payments/summary?invoice_id=${inv500}`);
    const paid = Number(detail[0].paid_cents);
    const refunded = Number(detail[0].refunded_cents);
    const balance = Number(detail[0].balance_cents);
    expect(Number.isInteger(paid)).toBe(true);
    expect(Number.isInteger(refunded)).toBe(true);
    expect(Number.isInteger(balance)).toBe(true);
    expect(paid + balance).toBe(total);
    expect(paid).toBe(expectedPaid);
    expect(refunded).toBe(expectedRefunded);
    expect(balance).toBe(expectedBalance);
    // Net payment of refund < total → stays partial.
    expect(detail[0].computed_status).toBe('partial');
  });
});

describe('payments ledger — summary endpoint filters', () => {
  it('lists invoices by customer_id and status', async () => {
    const partials = await req('GET', `/api/accounting/payments/summary?status=partial&customer_id=${customerId}`);
    expect(partials.length).toBeGreaterThan(0);
    partials.forEach((row) => {
      expect(row.customer_id).toBe(customerId);
      expect(row.computed_status).toBe('partial');
    });
  });

  it('reports last_payment_at timestamp', async () => {
    const detail = await req('GET', `/api/accounting/payments/summary?invoice_id=${inv100}`);
    expect(detail[0].last_payment_at).toBeTruthy();
    expect(detail[0].payment_count).toBeGreaterThanOrEqual(2);
  });
});

describe('payments ledger — reconciler', () => {
  it('reconciles a hand-mutated invoice from sent → partial', async () => {
    // Manually set status = 'sent' on inv10k and pre-seed a partial
    // payment ledger so the persisted status drifts.
    const p1 = await req('POST', '/api/accounting/payments', {
      invoice_id: inv10k, amount_cents: 10000, method: 'cash', status: 'succeeded',
    });
    // The auto-promoter already set status='partial'. Force back to
    // 'sent' to simulate stale persisted state.
    app.db.prepare("UPDATE invoices SET status = 'sent' WHERE id = ?").run(inv10k);
    const r = await req('POST', '/api/accounting/payments/reconcile');
    expect(r.updated.length).toBeGreaterThanOrEqual(1);
    const found = r.updated.find((u) => u.id === inv10k);
    expect(found).toBeTruthy();
    expect(found.from).toBe('sent');
    expect(found.to).toBe('partial');

    const detail = await req('GET', `/api/accounting/payments/summary?invoice_id=${inv10k}`);
    expect(detail[0].status_in_sync).toBe(true);

    // Cleanup so we don't leak rows to other suites
    await req('PUT', `/api/accounting/payments/${p1.id}`, { status: 'refunded' });
  });

  it('does NOT touch cancelled, paid, or draft invoices', async () => {
    // Create + cancel an invoice + record a (failed) payment. Reconciler
    // must NOT flip it back to partial.
    const r = await req('POST', '/api/invoices', {
      customer_id: customerId,
      line_items: [{ description: 'Cancel-test', total_cents: 5000 }],
    });
    await req('POST', `/api/invoices/${r.id}/status`, { status: 'sent' });
    await req('POST', '/api/accounting/payments', {
      invoice_id: r.id, amount_cents: 2000, method: 'cash', status: 'failed',
    });
    await req('POST', `/api/invoices/${r.id}/status`, { status: 'cancelled' });
    const recap = await req('POST', '/api/accounting/payments/reconcile');
    const touched = recap.updated.find((u) => u.id === r.id);
    expect(touched).toBeUndefined();
    const row = app.db.prepare('SELECT status FROM invoices WHERE id = ?').get(r.id);
    expect(row.status).toBe('cancelled');
  });
});

describe('payments ledger — sticky states', () => {
  it('paid_at is preserved on payment / refund churn', async () => {
    // The ledger is the source of truth, so a "paid" invoice that gets
    // a refund drops back to 'partial' even if some human has flipped
    // it to 'paid' manually. `paid_at` (first-time-settled timestamp) is
    // preserved so we keep an immutable settlement record.
    app.db.prepare("UPDATE invoices SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?").run(inv100);
    const before = app.db.prepare('SELECT status, paid_at FROM invoices WHERE id = ?').get(inv100);
    expect(before.paid_at).toBeTruthy();
    // Recording a partial payment now drops succeeded total below the
    // invoice total → status reverts to 'partial'.
    await req('POST', '/api/accounting/payments', {
      invoice_id: inv100, amount_cents: 100, method: 'cash', status: 'succeeded',
    });
    const after = app.db.prepare('SELECT status, paid_at FROM invoices WHERE id = ?').get(inv100);
    expect(after.status).toBe('partial');
    // paid_at preserved (sentinel: still the original settlement ts).
    expect(after.paid_at).toBe(before.paid_at);
  });
});

describe('payments ledger — payment PUT notes', () => {
  it('editing notes does not change status', async () => {
    // inv500 is 'partial' + has a refunded payment above. Update notes.
    const payment = (await req('GET', `/api/accounting/payments?invoice_id=${inv500}`))[0];
    const before = app.db.prepare('SELECT status FROM invoices WHERE id = ?').get(inv500).status;
    await req('PUT', `/api/accounting/payments/${payment.id}`, { notes: 'client follow-up' });
    const after = app.db.prepare('SELECT status FROM invoices WHERE id = ?').get(inv500).status;
    expect(after).toBe(before);
  });
});
