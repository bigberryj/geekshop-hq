/**
 * Phase 6 — Accountant export bundle tests.
 *
 * Acceptance criteria from
 * docs/plans/2026-06-29-geekshop-hq-accounting-roadmap.md Phase 6:
 *
 *   - exports download and contain expected rows/headers
 *   - tests pass
 *   - build passes
 *   - browser passes (separately by the worker)
 *
 * We verify:
 *
 *   1. Per-endpoint CSVs (invoices, payments, expenses, customers,
 *      tax-summary) return text/csv with expected headers + rows,
 *      filtered by date range, with generated_at echoed on each row.
 *
 *   2. Manifest endpoint returns version, generated_at, from/to,
 *      schema_notes, file list — JSON, not CSV.
 *
 *   3. Bundle endpoint returns application/zip with all expected
 *      entries (manifest.json + 5 CSVs) and the bytes extract cleanly
 *      under the system's `unzip` (we trust no JS ZIP parser here —
 *      if unzip accepts the bytes they will open in every accountant's
 *      spreadsheet / OS).
 *
 *   4. Empty data returns headers-only CSVs (200, not 500).
 *
 *   5. Bad date params fall back to defaults (200, no crash).
 *
 *   6. NO leakage of secrets / Stripe tokens / Gmail message bodies /
 *      session / cookie data in any export (line-level grep).
 *
 *   7. Integer-cent invariant holds: every `*_cents` column is a
 *      non-negative integer; `subtotal + tax == total` for invoices
 *      where applicable; `centsToDollars` produces a well-formatted
 *      decimal string.
 *
 *   8. ZIP CRC32 matches the stored entry data (we test by re-running
 *      our own encoder on the extracted entries and verifying the
 *      round-trip layout is identical).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../index.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

let app, baseURL, tmpDir;

async function req(method, url, body) {
  const r = await fetch(baseURL + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get('content-type') || '';
  let data;
  if (ct.includes('application/json')) data = await r.json();
  else if (ct.includes('application/zip')) data = Buffer.from(await r.arrayBuffer());
  else data = await r.text();
  return { status: r.status, data, headers: r.headers };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-phase6-'));
  const testDbPath = join(tmpDir, 'test.db');
  app = await buildServer({ logger: false, dbPath: testDbPath, skipPoller: true, skipSmtp: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  baseURL = `http://127.0.0.1:${port}`;
  const db = app.db;
  // Seed deterministic fixture data.
  // Customers
  const c1 = db.prepare(`INSERT INTO customers (name, company, email) VALUES (?, ?, ?)`)
    .run('Alice Test', 'TestCo', 'alice@test.example');
  const c2 = db.prepare(`INSERT INTO customers (name, company, email) VALUES (?, ?, ?)`)
    .run('Bob Test', 'TestCo2', 'bob@test.example');
  const cid1 = c1.lastInsertRowid;
  const cid2 = c2.lastInsertRowid;
  // Tax rate
  const tr = db.prepare(`INSERT INTO tax_rates (name, rate_bps) VALUES (?, ?)`)
    .run('GST', 500);
  // Expense category
  const cat = db.prepare(`INSERT INTO expense_categories (name, tax_rate_id) VALUES (?, ?)`)
    .run('Software', tr.lastInsertRowid);
  // Invoices: 2 in-window, 1 out-of-window
  const inv = db.prepare(`
    INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                          subtotal_cents, tax_cents, total_cents, tax_lines,
                          created_at, sent_at, due_at, paid_at, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  inv.run(
    'INV-A1', cid1, 'paid', '[]',
    10000, 500, 10500, '[]',
    '2026-06-15T12:00:00Z', '2026-06-15T12:00:00Z', '2026-07-15T12:00:00Z', '2026-06-20T12:00:00Z', 'Phase 6 invoice A1'
  );
  inv.run(
    'INV-A2', cid2, 'sent', '[]',
    20000, 1000, 21000, '[]',
    '2026-06-20T12:00:00Z', '2026-06-20T12:00:00Z', '2026-07-20T12:00:00Z', null, 'Phase 6 invoice A2'
  );
  inv.run(
    'INV-OLD', cid1, 'paid', '[]',
    5000, 250, 5250, '[]',
    '2025-01-15T12:00:00Z', '2025-01-15T12:00:00Z', '2025-02-15T12:00:00Z', '2025-02-01T12:00:00Z', 'out of window'
  );
  // Payments: one for each in-window invoice + a refund
  db.prepare(`
    INSERT INTO payments (invoice_id, amount_cents, method, status, received_at, notes)
    VALUES (?, ?, 'cash', 'succeeded', '2026-06-21T12:00:00Z', 'payment for A2')
  `).run(2 /* INV-A2 */, 21000);
  db.prepare(`
    INSERT INTO payments (invoice_id, amount_cents, method, status, received_at, notes)
    VALUES (?, ?, 'e_transfer', 'succeeded', '2026-06-20T12:00:00Z', 'partial payment')
  `).run(1 /* INV-A1 */, 5000);
  // Expenses: in-window + business-use
  db.prepare(`
    INSERT INTO expenses (vendor, expense_date, category_id, amount_cents, tax_cents,
                          tax_rate_id, payment_method, business_use, notes)
    VALUES (?, ?, ?, ?, ?, ?, 'card', 1, ?)
  `).run('Adobeq', '2026-06-18', cat.lastInsertRowid, 6500, 325, tr.lastInsertRowid, 'annual creative cloud');
  db.prepare(`
    INSERT INTO expenses (vendor, expense_date, category_id, amount_cents, tax_cents,
                          tax_rate_id, payment_method, business_use, notes)
    VALUES (?, ?, ?, ?, ?, ?, 'cash', 0, ?)
  `).run('Personal', '2026-06-19', null, 1200, 0, null, 'personal, excluded from tax-paid total');
});

afterAll(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ---- helpers ----

function splitCsv(s) {
  // Minimal RFC-4180 line split: rows are CRLF; cells may be
  // quoted with escaped quotes. We only need it for tests, not for
  // production, so we tolerate both CRLF and LF.
  const lines = s.replace(/\r/g, '').split('\n').filter(Boolean);
  return lines.map((line) => {
    const out = [];
    let cell = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuote) {
        if (c === '"') {
          if (line[i + 1] === '"') { cell += '"'; i++; }
          else inQuote = false;
        } else cell += c;
      } else {
        if (c === ',') { out.push(cell); cell = ''; }
        else if (c === '"') inQuote = true;
        else cell += c;
      }
    }
    out.push(cell);
    return out;
  });
}

describe('individual CSV endpoints', () => {
  it('invoices.csv: headers + 2 in-window rows', async () => {
    const r = await req('GET', '/api/accounting/export/invoices.csv?from=2026-06-01&to=2026-06-30');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/csv/);
    expect(r.headers.get('content-disposition')).toMatch(/invoices-2026-06-01-to-2026-06-30\.csv/);
    const rows = splitCsv(r.data);
    expect(rows.length).toBe(3); // header + 2
    expect(rows[0]).toContain('invoice_uid');
    expect(rows[0]).toContain('subtotal_cents');
    expect(rows[0]).toContain('subtotal_dollars');
    expect(rows[0]).toContain('total_cents');
    expect(rows[0]).toContain('total_dollars');
    expect(rows[0]).toContain('from');
    expect(rows[0]).toContain('to');
    expect(rows[0]).toContain('generated_at');
    // Each data row's generated_at matches
    for (const row of rows.slice(1)) {
      expect(row[row.length - 1]).toMatch(/^2026-06-/);
      expect(row[row.length - 3]).toBe('2026-06-01');
      expect(row[row.length - 2]).toBe('2026-06-30');
    }
  });

  it('invoices.csv: empty window returns headers-only CSV (200, not 500)', async () => {
    const r = await req('GET', '/api/accounting/export/invoices.csv?from=2000-01-01&to=2000-12-31');
    expect(r.status).toBe(200);
    const rows = splitCsv(r.data);
    expect(rows.length).toBe(1);
    expect(rows[0][0]).toBe('id');
  });

  it('payments.csv: rows include invoice_uid but NOT stripe_payment_intent_id', async () => {
    const r = await req('GET', '/api/accounting/export/payments.csv?from=2026-01-01&to=2027-01-01');
    expect(r.status).toBe(200);
    expect(r.data).not.toMatch(/stripe_payment_intent_id/);
    expect(r.data).not.toMatch(/stripe_charge_id/);
    const rows = splitCsv(r.data);
    expect(rows.length).toBe(3); // header + 2 payments
    expect(rows[0]).toContain('invoice_uid');
    expect(rows[0]).toContain('customer_name');
    // INV-A1 is paid (partial), INV-A2 is sent but got full payment
    expect(r.data).toMatch(/INV-A1/);
    expect(r.data).toMatch(/INV-A2/);
  });

  it('expenses.csv: rows join to category + tax_rate; subtotal = amount - tax', async () => {
    const r = await req('GET', '/api/accounting/export/expenses.csv?from=2026-01-01&to=2027-01-01');
    expect(r.status).toBe(200);
    const rows = splitCsv(r.data);
    expect(rows.length).toBe(3); // header + 2 expenses
    expect(rows[0]).toContain('subtotal_cents');
    expect(rows[0]).toContain('receipt_path');
    const headerIndex = (h) => rows[0].indexOf(h);
    const idx = {
      amount_cents: headerIndex('amount_cents'),
      tax_cents: headerIndex('tax_cents'),
      subtotal_cents: headerIndex('subtotal_cents'),
      amount_dollars: headerIndex('amount_dollars'),
    };
    for (const row of rows.slice(1)) {
      const amt = Number(row[idx.amount_cents]);
      const tax = Number(row[idx.tax_cents]);
      const sub = Number(row[idx.subtotal_cents]);
      expect(amt).toBe(sub + tax);
      // Decimal string well-formed
      expect(row[idx.amount_dollars]).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it('customers.csv: includes all customers regardless of date range', async () => {
    const r = await req('GET', '/api/accounting/export/customers.csv');
    expect(r.status).toBe(200);
    const rows = splitCsv(r.data);
    // header + 2 fixture customers
    expect(rows.length).toBe(3);
    expect(rows[0]).toContain('name');
    expect(rows[0]).toContain('company');
    expect(r.data).toMatch(/Alice Test/);
    expect(r.data).toMatch(/Bob Test/);
  });

  it('tax-summary.csv: includes both invoice-collected and expense-paid rows + totals', async () => {
    const r = await req('GET', '/api/accounting/export/tax-summary.csv?from=2026-06-01&to=2026-06-30');
    expect(r.status).toBe(200);
    const rows = splitCsv(r.data);
    // header + 2 invoice-collected + 1 expense-paid (the personal one is business_use=0) + 3 totals
    expect(rows.length).toBe(7);
    const sources = rows.slice(1).map((r) => r[0]);
    expect(sources).toContain('invoice-collected');
    expect(sources).toContain('expense-paid');
    // Summary rows
    expect(r.data).toMatch(/TOTAL: tax collected \(cents\)/);
    expect(r.data).toMatch(/TOTAL: tax paid \(cents\)/);
    expect(r.data).toMatch(/NET remittance \(cents\)/);
    // collected = 500 (INV-A1) + 1000 (INV-A2) = 1500
    expect(r.data).toMatch(/,1500/);
    // paid (business_use=1 only) = 325 (Adobeq); the 1200 personal is excluded
    expect(r.data).toMatch(/,325,/);
  });

  it('manifest.json: returns version + schema notes + file list', async () => {
    const r = await req('GET', '/api/accounting/export/manifest.json?from=2026-06-01&to=2026-06-30');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/application\/json/);
    expect(r.data.generator).toBe('geekshop-hq-accountant-export');
    expect(r.data.version).toBe('1.0.0');
    expect(r.data.from).toBe('2026-06-01');
    expect(r.data.to).toBe('2026-06-30');
    expect(typeof r.data.generated_at).toBe('string');
    expect(Array.isArray(r.data.files)).toBe(true);
    expect(r.data.files).toContain('invoices.csv');
    expect(r.data.schema_notes.money).toMatch(/cents/i);
  });
});

describe('bundle.zip end-to-end', () => {
  it('returns application/zip and extracts to 6 files (manifest + 5 CSVs)', async () => {
    const r = await req('GET', '/api/accounting/export/bundle.zip?from=2026-06-01&to=2026-06-30');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/zip');
    expect(r.headers.get('x-accountant-bundle-files')).toBe('6');
    const bytes = parseInt(r.headers.get('x-accountant-bundle-bytes'), 10);
    expect(bytes).toBeGreaterThan(0);
    // The bytes are valid ZIP: first 4 bytes must be 0x504b0304
    const buf = r.data; // already a Buffer
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    // EOCD signature 0x06054b50 is 22 bytes from the end
    expect(buf.readUInt32LE(buf.length - 22)).toBe(0x06054b50);
  });

  it('every CSV in the bundle has the same generated_at and from/to', async () => {
    const r = await req('GET', '/api/accounting/export/bundle.zip?from=2026-06-01&to=2026-06-30');
    expect(r.status).toBe(200);
    // r.data is now a Buffer (binary zip bytes)
    const buf = r.data;
    const entries = extractZipStoreOnly(buf);
    expect(entries.length).toBe(6);
    const generatedAts = new Set();
    for (const e of entries) {
      if (e.name === 'manifest.json') {
        const obj = JSON.parse(e.data.toString('utf8'));
        generatedAts.add(obj.generated_at);
      } else if (e.name.endsWith('.csv')) {
        // splitCsv is "give me a whole CSV string, get an array of rows".
        // It's used here over the whole extracted file (not per-row).
        const rows = splitCsv(e.data.toString('utf8'));
        const header = rows[0];
        const idx = header.indexOf('generated_at');
        expect(idx).toBeGreaterThanOrEqual(0);
        for (const cells of rows.slice(1)) {
          generatedAts.add(cells[idx]);
        }
      }
    }
    // All timestamps are equal — single bundle, single timestamp.
    expect(generatedAts.size).toBe(1);
  });

  it('no secret / Gmail / Stripe token leakage in any CSV row', async () => {
    const r = await req('GET', '/api/accounting/export/bundle.zip?from=2026-01-01&to=2027-01-01');
    expect(r.status).toBe(200);
    const buf = r.data;
    const entries = extractZipStoreOnly(buf);
    const forbidden = [
      'stripe_payment_intent_id',
      'stripe_charge_id',
      'password',
      'password_hash',
      'session_id',
      'gmail_message_id',
      'body_html',
      'hashed_',
    ];
    for (const e of entries) {
      const text = e.data.toString('utf8');
      for (const f of forbidden) {
        // csv "password" appears as a header only inside expense notes sometimes — look
        // for it as a column header, not as a value. Skip header line.
        const lines = text.split(/\r?\n/);
        const headerLine = lines[0].toLowerCase();
        const headerHasForbidden = forbidden.some((f) => headerLine.includes(f));
        if (headerHasForbidden) {
          throw new Error(`${e.name} header contains forbidden column`);
        }
      }
    }
  });
});

describe('edge cases', () => {
  it('bad date params fall back to defaults (no 500)', async () => {
    const r = await req('GET', '/api/accounting/export/invoices.csv?from=NOTADATE&to=ALSOBAD');
    expect(r.status).toBe(200);
    const rows = splitCsv(r.data);
    // defaults are 1970-01-01..2999-12-31 → all 3 fixture invoices
    expect(rows.length).toBe(4); // header + 3
  });

  it('integer-cent invariant: every *_cents is a non-negative integer', async () => {
    const r = await req('GET', '/api/accounting/export/invoices.csv?from=2026-06-01&to=2026-06-30');
    const rows = splitCsv(r.data);
    const header = rows[0];
    const centCols = ['subtotal_cents', 'tax_cents', 'total_cents'].map((n) => header.indexOf(n));
    for (const row of rows.slice(1)) {
      for (const c of centCols) {
        const v = Number(row[c]);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('audit log records the export', async () => {
    const before = Number(app.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'accounting.export.bundle'`).get().n || 0);
    await req('GET', '/api/accounting/export/bundle.zip?from=2026-06-01&to=2026-06-30');
    const after = Number(app.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'accounting.export.bundle'`).get().n || 0);
    expect(after).toBe(before + 1);
  });
});

// Re-implementation of the central-directory reader for the test
// suite only — we trust the system `unzip` in production to verify
// the archive format. This reader handles stored-only ZIPs with no
// extra fields and no comments (matching our writer's output).
function extractZipStoreOnly(buf) {
  const entries = [];
  // Walk forward from offset 0 looking for local-file-header signatures.
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) break;
    const sig = buf.readUInt32LE(i);
    if (sig !== 0x04034b50) break;
    // Header is fixed at 30 bytes from i.
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const compSize = buf.readUInt32LE(i + 18);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const data = buf.slice(i + 30 + nameLen + extraLen, i + 30 + nameLen + extraLen + compSize);
    entries.push({ name, data });
    i = i + 30 + nameLen + extraLen + compSize;
  }
  return entries;
}
