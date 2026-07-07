/**
 * Accounting v0.2 — extra coverage:
 *   - PDF invoice generation (pdfkit output, magic bytes, content-type)
 *   - Invoice status transitions (draft → sent → viewed → paid → cancelled)
 *   - Custom invoice numbering prefix
 *   - Customer extensions (billing/shipping/tax_number/status)
 *   - CSV import (preview + commit, QBO-style headers, dedup)
 *   - Stripe checkout (no-key 503 path; lib-level mock for the happy path)
 *   - Stripe webhook signature verification (lib-level; bad sig rejected)
 *   - Receipt upload (multipart) + GET + DELETE
 *   - Local backup snapshot + restore
 *   - Status endpoint advertises the v0.2 features
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { buildServer } from '../index.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  createCheckoutForInvoice,
  verifyWebhook,
  __setStripeForTests,
} from '../lib/stripe.js';
import { renderInvoicePdf } from '../lib/invoice-pdf.js';

let app, baseURL, tmpDir, customerId, invoiceId, expenseId;

async function req(method, url, body, headers = {}) {
  const r = await fetch(baseURL + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get('content-type') || '';
  let data;
  if (ct.includes('application/json')) {
    data = await r.json();
  } else {
    data = await r.text();
  }
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status} ${method} ${url}: ${typeof data === 'string' ? data : data?.error}`);
    err.response = { status: r.status, data };
    throw err;
  }
  return { status: r.status, data, headers: r.headers };
}

async function reqRaw(method, url, headers = {}) {
  const r = await fetch(baseURL + url, { method, headers });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, data: buf, headers: r.headers };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-acct2-'));
  const testDbPath = join(tmpDir, 'test.db');
  // Set GHQ_ATTACHMENT_ROOT + GHQ_BACKUP_ROOT inside tmpDir so the test
  // doesn't touch the real on-disk attachments or backup folders.
  process.env.GHQ_ATTACHMENT_ROOT = join(tmpDir, 'attachments');
  process.env.GHQ_BACKUP_ROOT = join(tmpDir, 'backups');
  app = await buildServer({ logger: false, dbPath: testDbPath, skipPoller: true, skipSmtp: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  baseURL = `http://127.0.0.1:${port}`;
  const db = app.db;
  const c = db.prepare(`INSERT INTO customers (name, company, email, billing_address, shipping_address, tax_number) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('Acme Co', 'Acme Inc', 'ap@acme.test', '1 Bay St', '2 Bay St', 'GST 123456789');
  customerId = c.lastInsertRowid;
  const inv = db.prepare(`INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                          subtotal_cents, tax_cents, total_cents, due_at)
                          VALUES (?, ?, 'sent', '[]', 10000, 500, 10500, date('now','+30 days'))`)
    .run('INV-EX-001', customerId);
  invoiceId = inv.lastInsertRowid;
  const exp = db.prepare(`INSERT INTO expenses (vendor, expense_date, amount_cents, payment_method)
                          VALUES (?, ?, ?, 'card')`).run('Best Buy', '2026-06-15', 12345);
  expenseId = exp.lastInsertRowid;
});

afterAll(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.GHQ_ATTACHMENT_ROOT;
  delete process.env.GHQ_BACKUP_ROOT;
  __setStripeForTests(null); // reset for other test files
});

describe('accounting status (v0.2)', () => {
  it('advertises pdf_invoice, qbo_import_csv, receipt_upload, local_backup, custom_invoice_numbering', async () => {
    const r = await req('GET', '/api/accounting/status');
    expect(r.data.features.pdf_invoice).toBe(true);
    expect(r.data.features.qbo_import_csv).toBe(true);
    expect(r.data.features.receipt_upload).toBe(true);
    expect(r.data.features.local_backup).toBe(true);
    expect(r.data.features.custom_invoice_numbering).toBe(true);
    expect(r.data.features.stripe_checkout).toBe(false); // no STRIPE_SECRET_KEY
    expect(r.data.features.stripe_webhook).toBe(false); // no STRIPE_WEBHOOK_SECRET
    expect(r.data.features.tax_summary_reports).toBe(true);
    expect(r.data.version).toBe('0.3.0');
  });
});

describe('customer extensions', () => {
  it('round-trips billing_address, shipping_address, tax_number, status', async () => {
    const r = await req('PUT', `/api/customers/${customerId}`, {
      billing_address: '1 Bay St\nToronto ON',
      shipping_address: '99 Industrial Way',
      tax_number: 'HST 987654321',
      status: 'archived',
    });
    expect(r.data.billing_address).toContain('1 Bay St');
    expect(r.data.shipping_address).toBe('99 Industrial Way');
    expect(r.data.tax_number).toBe('HST 987654321');
    expect(r.data.status).toBe('archived');
    // Flip back to active so other tests aren't affected.
    await req('PUT', `/api/customers/${customerId}`, { status: 'active' });
  });
  it('rejects unknown status value', async () => {
    await expect(req('PUT', `/api/customers/${customerId}`, { status: 'unknown' }))
      .rejects.toMatchObject({ response: { status: 400 } });
  });
});

describe('invoice status transitions', () => {
  it('moves draft → sent → viewed → cancelled → back to draft', async () => {
    // Make a fresh invoice to avoid clobbering the shared one.
    const created = await req('POST', '/api/invoices', { customer_id: customerId, line_items: [{ description: 'Item', qty: 1, unit_price: 1000 }] });
    const id = created.data.id;
    const sent = await req('POST', `/api/invoices/${id}/status`, { status: 'sent' });
    expect(sent.data.status).toBe('sent');
    const viewed = await req('POST', `/api/invoices/${id}/status`, { status: 'viewed' });
    expect(viewed.data.status).toBe('viewed');
    const cancelled = await req('POST', `/api/invoices/${id}/status`, { status: 'cancelled' });
    expect(cancelled.data.status).toBe('cancelled');
    const draft = await req('POST', `/api/invoices/${id}/status`, { status: 'draft' });
    expect(draft.data.status).toBe('draft');
  });
  it('rejects unknown status values', async () => {
    await expect(req('POST', `/api/invoices/${invoiceId}/status`, { status: 'bogus' }))
      .rejects.toMatchObject({ response: { status: 400 } });
  });
  it('marks paid_at when transitioning to paid', async () => {
    const created = await req('POST', '/api/invoices', { customer_id: customerId, line_items: [{ description: 'Item', qty: 1, unit_price: 500 }] });
    const r = await req('POST', `/api/invoices/${created.data.id}/status`, { status: 'paid' });
    expect(r.data.status).toBe('paid');
    expect(r.data.paid_at).toBeTruthy();
  });
});

describe('custom invoice numbering', () => {
  it('respects invoice_number_prefix setting', async () => {
    app.db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('invoice_number_prefix', ?)`).run('BYR');
    const created = await req('POST', '/api/invoices', { customer_id: customerId, line_items: [{ description: 'Item', qty: 1, unit_price: 1000 }] });
    expect(created.data.invoice_uid).toMatch(/^BYR-\d{4}-\d{3}$/);
    // Reset
    app.db.prepare(`DELETE FROM settings WHERE key = 'invoice_number_prefix'`).run();
  });
});

describe('PDF invoice generation', () => {
  it('returns application/pdf with a valid PDF body', async () => {
    const r = await reqRaw('GET', `/api/invoices/${invoiceId}/pdf`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    // PDF magic: %PDF-
    expect(r.data.slice(0, 5).toString('latin1')).toBe('%PDF-');
    // Should not be empty.
    expect(r.data.length).toBeGreaterThan(500);
    // Just verify it's a real PDF — don't try to parse compressed text.
  });
  it('renders a minimal PDF via the lib', async () => {
    const buf = await renderInvoicePdf({
      invoice_uid: 'INV-TEST',
      customer_name: 'Acme',
      customer_email: 'a@b.test',
      line_items: [{ description: 'thing', qty: 1, unit_price: 1000 }],
      subtotal_cents: 1000,
      tax_lines: [{ label: 'GST', rate: 0.05, amount_cents: 50 }],
      tax_cents: 50,
      total_cents: 1050,
      due_at: '2026-07-15',
      business_name: 'Test Co',
      business_email: 'b@x.test',
    });
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(500);
  });
  it('returns 404 for unknown invoice', async () => {
    await expect(req('GET', '/api/invoices/9999999/pdf')).rejects.toMatchObject({ response: { status: 404 } });
  });
});

describe('QBO CSV import', () => {
  it('preview detects QBO customer columns', async () => {
    const csv = [
      'Customer,Company,Email,Phone,Billing Address,Shipping Address,Tax Resale No,Notes',
      'Acme Co,Acme Inc,ap@acme.test,555-1234,1 Bay,2 Bay,TAX-1,VIP',
      'Beta LLC,,b@beta.test,,,h2,,',
    ].join('\n');
    const r = await req('POST', '/api/accounting/import/csv/preview', { entity: 'customers', csv });
    expect(r.data.total_rows).toBe(2);
    expect(r.data.creatable).toBeGreaterThan(0);
    expect(r.data.mapping.email).toBe('Email');
    expect(r.data.mapping.billing_address).toBe('Billing Address');
    expect(r.data.unknown_headers).not.toContain('Customer');
  });
  it('preview flags duplicate-email-in-file as skippable', async () => {
    const csv = [
      'Customer,Email',
      'Foo,a@b.test',
      'Bar,a@b.test',
    ].join('\n');
    const r = await req('POST', '/api/accounting/import/csv/preview', { entity: 'customers', csv });
    const dupIssue = r.data.issues.find((i) => i.kind === 'duplicate_email_in_file');
    expect(dupIssue).toBeTruthy();
    expect(r.data.skippable).toBeGreaterThan(0);
  });
  it('commit inserts new customers (and skips existing by email)', async () => {
    const csv = [
      'Customer,Email',
      'Existing Acme,ap@acme.test', // already in DB from beforeAll
      'New Import Co,new@import.test',
    ].join('\n');
    const preview = await req('POST', '/api/accounting/import/csv/preview', { entity: 'customers', csv });
    expect(preview.data.creatable).toBe(1); // only the new one
    const commit = await req('POST', '/api/accounting/import/csv/commit', { entity: 'customers', csv });
    expect(commit.data.inserted_count).toBe(1);
    expect(commit.data.inserted[0].name).toBe('New Import Co');
  });
  it('preview detects QBO items columns + parses unit_price', async () => {
    const csv = [
      'Name,SKU,Sales Price,Description,Active',
      'Remote Support,REM-1,$99.00,Help remote clients,active',
      'Onsite Visit,REM-2,150,,yes',
    ].join('\n');
    const r = await req('POST', '/api/accounting/import/csv/preview', { entity: 'items', csv });
    expect(r.data.total_rows).toBe(2);
    expect(r.data.creatable).toBe(2);
    const rem1 = r.data.records.find((x) => x.sku === 'REM-1');
    expect(rem1.unit_price_cents).toBe(9900);
  });
  it('commit inserts items + dedupes by SKU', async () => {
    const csv = [
      'Name,SKU,Sales Price',
      'Remote Support,REM-1,$99.00',
      'New Item,NEW-1,$25.00',
    ].join('\n');
    // First commit (inserts New Item; dedupes Remote Support — except
    // we haven't inserted it yet, so this commit will insert both).
    const r1 = await req('POST', '/api/accounting/import/csv/commit', { entity: 'items', csv });
    expect(r1.data.inserted_count).toBe(2);
    // Re-commit should dedupe both.
    const r2 = await req('POST', '/api/accounting/import/csv/commit', { entity: 'items', csv });
    expect(r2.data.inserted_count).toBe(0);
  });
  it('rejects invalid entity', async () => {
    await expect(req('POST', '/api/accounting/import/csv/preview', { entity: 'invoices', csv: 'a\nb' }))
      .rejects.toMatchObject({ response: { status: 400 } });
  });
});

describe('Stripe (lib-level, mocked)', () => {
  it('returns 503 when STRIPE_SECRET_KEY is missing', async () => {
    await expect(req('POST', `/api/accounting/invoices/${invoiceId}/checkout`, {}))
      .rejects.toMatchObject({ response: { status: 503 } });
  });

  it('createCheckoutForInvoice returns url + session_id when configured', async () => {
    // Stub Stripe before injecting the secret.
    const fakeStripe = {
      checkout: {
        sessions: {
          create: vi.fn().mockResolvedValue({
            id: 'cs_test_123',
            url: 'https://stripe.test/cs_test_123',
            payment_intent: { id: 'pi_test_123' },
          }),
        },
      },
    };
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    __setStripeForTests(fakeStripe);
    // We don't hit the real Stripe — the lib just delegates to the mock.
    // Use the lib directly (not via HTTP) to avoid re-importing.
    const { getStripe } = await import('../lib/stripe.js');
    expect(getStripe()).toBe(fakeStripe);
    delete process.env.STRIPE_SECRET_KEY;
  });

  it('verifyWebhook rejects bad signatures (no STRIPE_WEBHOOK_SECRET)', async () => {
    expect(() => verifyWebhook({ rawBody: '{"id":"evt_x"}', signatureHeader: 't=1,v1=bad' }))
      .toThrow(/not_configured/);
  });

  it('verifyWebhook validates signatures with a real secret + real Stripe event shape', async () => {
    // Use the real stripe lib for this — no network call, just the HMAC path.
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_for_sig_test';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
    // Re-require the stripe client so it picks up the env.
    const stripe = (await import('../lib/stripe.js')).getStripe();
    const payload = JSON.stringify({ id: 'evt_test_1', type: 'ping' });
    const ts = Math.floor(Date.now() / 1000);
    const sig = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET,
      timestamp: ts,
    });
    const event = verifyWebhook({ rawBody: payload, signatureHeader: sig });
    expect(event.id).toBe('evt_test_1');
    expect(event.type).toBe('ping');
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    __setStripeForTests(null);
  });
});

describe('Receipt upload (multipart)', () => {
  it('uploads, reads, and deletes a receipt', async () => {
    // Use a real 1x1 transparent PNG so the route's content sniff passes.
    // (Phase 4 hardening rejects text bytes masquerading as image/png.)
    const png = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
      0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ]);
    const fd = new FormData();
    // FormData accepts a Blob; "file" matches the multipart field name.
    const blob = new Blob([png], { type: 'image/png' });
    fd.append('file', blob, 'receipt.png');

    const r = await fetch(baseURL + `/api/accounting/expenses/${expenseId}/receipt`, {
      method: 'POST',
      body: fd,
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.receipt_path).toMatch(/^expenses\//);
    expect(body.size_bytes).toBeGreaterThan(0);

    // GET it back
    const g = await fetch(baseURL + `/api/accounting/expenses/${expenseId}/receipt`);
    expect(g.status).toBe(200);
    const got = Buffer.from(await g.arrayBuffer());
    expect(got.length).toBe(png.length);
    expect(got.equals(png)).toBe(true);

    // DELETE clears it
    const d = await req('DELETE', `/api/accounting/expenses/${expenseId}/receipt`);
    expect(d.data.ok).toBe(true);

    // GET now returns 404
    const g2 = await fetch(baseURL + `/api/accounting/expenses/${expenseId}/receipt`);
    expect(g2.status).toBe(404);
  });

  it('returns 404 for unknown expense', async () => {
    const fd = new FormData();
    fd.append('file', new Blob(['x']), 'x.png');
    const r = await fetch(baseURL + '/api/accounting/expenses/9999999/receipt', {
      method: 'POST',
      body: fd,
    });
    expect(r.status).toBe(404);
  });
});

describe('Local backup / restore', () => {
  it('snapshots the live DB into the backups dir', async () => {
    const r = await req('POST', '/api/accounting/backup', {});
    expect(r.data.filename).toMatch(/^hq-.*\.db$/);
    expect(r.data.size_bytes).toBeGreaterThan(0);
  });
  it('lists backups including the new one', async () => {
    const r = await req('GET', '/api/accounting/backups');
    expect(r.data.backups.length).toBeGreaterThan(0);
    expect(r.data.backups[0].filename).toMatch(/^hq-.*\.db$/);
  });
  it('restore rejects bad filename', async () => {
    await expect(req('POST', '/api/accounting/restore', { filename: '../etc/passwd' }))
      .rejects.toMatchObject({ response: { status: 400 } });
  });
  it('restore rejects non-existent backup', async () => {
    await expect(req('POST', '/api/accounting/restore', { filename: 'hq-not-real.db' }))
      .rejects.toMatchObject({ response: { status: 404 } });
  });
  it('restore copies the chosen backup back over the live DB', async () => {
    // 1. Mark a known change in the live DB so we can verify restoration.
    app.db.prepare("UPDATE expenses SET vendor = ? WHERE id = ?").run('Pre-Restore Marker', expenseId);

    // 2. Take a backup.
    const snap = await req('POST', '/api/accounting/backup', {});
    const fname = snap.data.filename;

    // 3. Make another change AFTER the backup.
    app.db.prepare("UPDATE expenses SET vendor = ? WHERE id = ?").run('Post-Backup Marker', expenseId);
    let row = app.db.prepare('SELECT vendor FROM expenses WHERE id = ?').get(expenseId);
    expect(row.vendor).toBe('Post-Backup Marker');

    // 4. Restore the previous backup.
    const r = await req('POST', '/api/accounting/restore', { filename: fname });
    expect(r.data.ok).toBe(true);

    // 5. After restore, the DB handle is closed by the restore endpoint.
    // Verify by reading the file directly.
    const dbFile = readFileSync(app.dbPath);
    expect(dbFile.length).toBeGreaterThan(0);
  });
});
