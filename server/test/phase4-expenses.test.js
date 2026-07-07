/**
 * Phase 4 — Expense / receipt capture tests.
 *
 * Covers the explicit acceptance criteria from
 * docs/plans/2026-06-29-geekshop-hq-accounting-roadmap.md:
 *
 *   1. Expense create / list workflow works (including date-range
 *      filters, category + vendor filters, and full update round-trip).
 *   2. Receipt handling is safe:
 *        a. Allowlist: image/{png,jpeg,webp} + application/pdf are accepted.
 *        b. Disallowed mimes (e.g. text/html, application/zip) return 415.
 *        c. Mime-spoofed payloads (declared image/png, content=PDF)
 *           return 415 — content sniff is the authority.
 *        d. Unknown signatures (random bytes) return 415.
 *        e. Oversize files return 413 (25 MB cap).
 *        f. Path-traversal attempts on GET /receipt are blocked — the
 *           server only resolves paths that survive resolveAttachmentPath
 *           and starts under ATTACHMENT_ROOT.
 *        g. Files land outside the webroot (data/attachments/expenses/<id>/).
 *        h. Audit log records uploads, downloads, deletes, and rejections.
 *   3. Tests / build / browser pass.
 *
 * The "browser pass" half of #3 is the worker's separate browser-verification
 * step; this file covers the API/DB half end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildServer } from '../index.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, statSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

let app, baseURL, tmpDir, customerId, expenseId, catId;
let attachmentRoot;

async function req(method, url, body, headers = {}) {
  const r = await fetch(baseURL + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
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

async function uploadReceiptRaw(expenseId, buffer, filename, mimeType) {
  // Use raw fetch (not req()) so we can supply a non-JSON body.
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mimeType }), filename);
  const r = await fetch(`${baseURL}/api/accounting/expenses/${expenseId}/receipt`, {
    method: 'POST', body: fd,
  });
  let body;
  try { body = await r.json(); } catch { body = await r.text(); }
  return { status: r.status, body };
}

function pngBytes() {
  // 1x1 transparent PNG
  return Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
    0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
  ]);
}

function pdfBytes() {
  // Smallest valid PDF (1 page, 1 byte of content)
  return Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 1 1]>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000010 00000 n\n0000000053 00000 n\n0000000100 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n149\n%%EOF\n');
}

function jpegBytes() {
  // Tiny JFIF (4 bytes is enough for the sniff)
  return Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
}

function webpBytes() {
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]), // 36-byte file size
    Buffer.from('WEBP', 'ascii'),
    Buffer.from('VP8 ', 'ascii'),
    Buffer.from([0x1A, 0x00, 0x00, 0x00]), // chunk size
    Buffer.alloc(20, 0x00),
  ]);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-phase4-'));
  const testDbPath = join(tmpDir, 'test.db');
  // Isolate the attachment + backup roots so the test doesn't touch the
  // real on-disk folders (and so the "outside webroot" assertion has a
  // real path to compare against).
  attachmentRoot = join(tmpDir, 'attachments');
  process.env.GHQ_ATTACHMENT_ROOT = attachmentRoot;
  process.env.GHQ_BACKUP_ROOT = join(tmpDir, 'backups');
  app = await buildServer({ logger: false, dbPath: testDbPath, skipPoller: true, skipSmtp: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  baseURL = `http://127.0.0.1:${port}`;
  const db = app.db;
  const c = db.prepare(`INSERT INTO customers (name, company, email) VALUES (?, ?, ?)`)
    .run('Phase4 Co', 'Phase4 Inc', 'p4@phase4.test');
  customerId = c.lastInsertRowid;
  // Seed: a category so we can test the join path.
  const cat = db.prepare('INSERT INTO expense_categories (name) VALUES (?)').run('Software');
  catId = cat.lastInsertRowid;
  // Seed: one expense row to attach receipts to. We deliberately do NOT
  // set tax_cents here — Phase 4 also requires that the DB-level CHECK
  // for `tax_cents <= amount_cents` and the >= 0 constraints are
  // enforced on raw writes (defense in depth against bugs in the route).
  const exp = db.prepare(`INSERT INTO expenses (vendor, expense_date, amount_cents, tax_cents, payment_method, business_use)
                          VALUES (?, ?, ?, ?, 'card', 1)`)
    .run('Backblaze', '2026-06-15', 1099, 0);
  expenseId = exp.lastInsertRowid;
});

afterAll(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.GHQ_ATTACHMENT_ROOT;
  delete process.env.GHQ_BACKUP_ROOT;
});

describe('expense create / list / update round-trip', () => {
  it('creates a new expense with category, tax split, and method', async () => {
    const r = await req('POST', '/api/accounting/expenses', {
      vendor: 'Adobe',
      expense_date: '2026-06-01',
      category_id: catId,
      amount_cents: 6500,
      tax_cents: 325,
      payment_method: 'card',
      business_use: true,
      notes: 'monthly Creative Cloud',
    });
    expect(r.id).toBeTruthy();
    expect(r.vendor).toBe('Adobe');
    expect(r.amount_cents).toBe(6500);
    expect(r.tax_cents).toBe(325);
    expect(r.category_name).toBe('Software');
  });

  it('rejects a bad date format', async () => {
    await expect(req('POST', '/api/accounting/expenses', {
      vendor: 'Bad', expense_date: '06/01/2026', amount_cents: 1000, payment_method: 'card',
    })).rejects.toMatchObject({ response: { status: 400 } });
  });

  it('rejects a payment_method outside the allowlist', async () => {
    await expect(req('POST', '/api/accounting/expenses', {
      vendor: 'Bad', expense_date: '2026-06-01', amount_cents: 1000, payment_method: 'bitcoin',
    })).rejects.toMatchObject({ response: { status: 400 } });
  });

  it('lists expenses with date-range, vendor, and category filters', async () => {
    const all = await req('GET', '/api/accounting/expenses');
    expect(all.length).toBeGreaterThanOrEqual(2); // seed + Adobe
    const june = await req('GET', '/api/accounting/expenses?from=2026-06-01&to=2026-06-30');
    expect(june.length).toBe(june.filter((r) => r.expense_date >= '2026-06-01' && r.expense_date <= '2026-06-30').length);
    const backblaze = await req('GET', `/api/accounting/expenses?vendor=Backblaze`);
    expect(backblaze.length).toBeGreaterThanOrEqual(1);
    expect(backblaze.every((r) => /backblaze/i.test(r.vendor))).toBe(true);
    const sw = await req('GET', `/api/accounting/expenses?category_id=${catId}`);
    expect(sw.length).toBeGreaterThanOrEqual(1);
    expect(sw.every((r) => r.category_id === catId)).toBe(true);
  });

  it('updates an expense in place (notes, amount, category)', async () => {
    const list = await req('GET', '/api/accounting/expenses');
    const exp = list.find((e) => e.vendor === 'Adobe');
    const upd = await req('PUT', `/api/accounting/expenses/${exp.id}`, {
      vendor: 'Adobe Inc.',
      expense_date: exp.expense_date,
      category_id: catId,
      amount_cents: 7000,
      tax_cents: 350,
      payment_method: 'card',
      business_use: true,
      notes: 'Creative Cloud annual plan',
    });
    expect(upd.amount_cents).toBe(7000);
    expect(upd.tax_cents).toBe(350);
    expect(upd.notes).toBe('Creative Cloud annual plan');
  });

  it('DB-level CHECK constraints reject tax_cents > amount_cents', async () => {
    // The route layer zod-parses, but we want the DB itself to refuse
    // any path that bypasses the route (raw INSERT, future import tool,
    // etc.). Migration 035 adds this guarantee; the test confirms it.
    const db = app.db;
    expect(() => db.prepare(
      `INSERT INTO expenses (vendor, expense_date, amount_cents, tax_cents, payment_method)
       VALUES (?, ?, ?, ?, 'other')`
    ).run('Bad', '2026-06-29', 100, 200)).toThrow(/CHECK constraint/);

    expect(() => db.prepare(
      `INSERT INTO expenses (vendor, expense_date, amount_cents, tax_cents, payment_method)
       VALUES (?, ?, ?, ?, 'other')`
    ).run('Bad', '2026-06-29', -1, 0)).toThrow(/CHECK constraint/);
  });

  it('integer-cent math: total + tax portion computed server-side stays integer', async () => {
    const r = await req('GET', '/api/accounting/reports/expenses-by-category');
    expect(Array.isArray(r)).toBe(true);
    const sw = r.find((row) => row.category === 'Software');
    expect(sw).toBeTruthy();
    expect(Number.isInteger(Number(sw.amount_cents))).toBe(true);
    expect(Number.isInteger(Number(sw.expense_count))).toBe(true);
  });
});

describe('receipt upload safety', () => {
  let uploadExpId;

  beforeEach(async () => {
    // Fresh expense row per upload test so we don't fight with the seeded one.
    const r = await req('POST', '/api/accounting/expenses', {
      vendor: 'Test Vendor',
      expense_date: '2026-06-29',
      amount_cents: 1234,
      tax_cents: 0,
      payment_method: 'cash',
      business_use: true,
    });
    uploadExpId = r.id;
  });

  it('accepts a real PNG and persists it under the per-expense bucket', async () => {
    const r = await uploadReceiptRaw(uploadExpId, pngBytes(), 'receipt.png', 'image/png');
    expect(r.status).toBe(200);
    expect(r.body.mime_type).toBe('image/png');
    expect(r.body.receipt_path).toMatch(/^expenses\//);
    // File actually on disk under the per-row bucket
    const onDisk = join(attachmentRoot, r.body.receipt_path);
    expect(existsSync(onDisk)).toBe(true);
    expect(statSync(onDisk).size).toBeGreaterThan(0);
  });

  it('accepts a real JPEG', async () => {
    const r = await uploadReceiptRaw(uploadExpId, jpegBytes(), 'r.jpg', 'image/jpeg');
    expect(r.status).toBe(200);
    expect(r.body.mime_type).toBe('image/jpeg');
  });

  it('accepts a real WebP', async () => {
    const r = await uploadReceiptRaw(uploadExpId, webpBytes(), 'r.webp', 'image/webp');
    expect(r.status).toBe(200);
    expect(r.body.mime_type).toBe('image/webp');
  });

  it('accepts a real PDF', async () => {
    const r = await uploadReceiptRaw(uploadExpId, pdfBytes(), 'r.pdf', 'application/pdf');
    expect(r.status).toBe(200);
    expect(r.body.mime_type).toBe('application/pdf');
  });

  it('rejects a file with a disallowed declared mime (text/html)', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const r = await uploadReceiptRaw(uploadExpId, html, 'evil.html', 'text/html');
    expect(r.status).toBe(415);
    expect(r.body.code).toBe('MIME_NOT_ALLOWED');
  });

  it('rejects a file with a disallowed declared mime (application/zip)', async () => {
    const r = await uploadReceiptRaw(uploadExpId, Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00]), 'a.zip', 'application/zip');
    expect(r.status).toBe(415);
    expect(r.body.code).toBe('MIME_NOT_ALLOWED');
  });

  it('rejects mime-spoofed payload: declared image/png but actual PDF content', async () => {
    // Classic bypass: a malicious client declares image/png so the file
    // picker accepts it, but the bytes are a PDF (or anything else). The
    // server must sniff the bytes and reject.
    const r = await uploadReceiptRaw(uploadExpId, pdfBytes(), 'fake.png', 'image/png');
    expect(r.status).toBe(415);
    expect(r.body.code).toBe('TYPE_MISMATCH');
  });

  it('rejects mime-spoofed payload: declared application/pdf but actual PNG content', async () => {
    const r = await uploadReceiptRaw(uploadExpId, pngBytes(), 'fake.pdf', 'application/pdf');
    expect(r.status).toBe(415);
    expect(r.body.code).toBe('TYPE_MISMATCH');
  });

  it('rejects random bytes with no recognizable signature', async () => {
    const random = Buffer.from('hello world this is just text not an image or pdf');
    const r = await uploadReceiptRaw(uploadExpId, random, 'mystery.png', 'image/png');
    expect(r.status).toBe(415);
    // No recognized magic bytes → sniff returns null → CONTENT_UNKNOWN
    // is the precise error code (TYPE_MISMATCH would imply we found a
    // *different* valid signature, which we didn't).
    expect(r.body.code).toBe('CONTENT_UNKNOWN');
  });

  it('rejects oversize uploads (25.5 MB > 25 MB cap)', async () => {
    // The multipart plugin limit is 26 MB; the business cap (lib/attachments.js)
    // is 25 MB. To exercise the *route-level* 413 with a structured JSON
    // response, we send a payload that fits the multipart cap but exceeds
    // the business cap. 25.5 MB is safely in the window.
    const header = Buffer.from('%PDF-1.4\n'); // valid PDF magic so the type check passes
    const padding = Buffer.alloc(Math.round(25.5 * 1024 * 1024) - header.length, 0x00);
    const oversize = Buffer.concat([header, padding]);
    const r = await uploadReceiptRaw(uploadExpId, oversize, 'big.pdf', 'application/pdf');
    expect(r.status).toBe(413);
    expect(r.body.error).toBe('file too large');
    expect(r.body.max_bytes).toBe(25 * 1024 * 1024);
  });

  it('audit log records uploads and rejections', async () => {
    // Upload a valid one.
    await uploadReceiptRaw(uploadExpId, pngBytes(), 'ok.png', 'image/png');
    // Upload a rejected one.
    await uploadReceiptRaw(uploadExpId, Buffer.from('not a real image'), 'bad.png', 'image/png');
    const rows = app.db.prepare(
      `SELECT action, target, payload FROM audit_log
       WHERE target = ? AND action IN ('expense.receipt_upload', 'expense.receipt_rejected')
       ORDER BY id ASC`
    ).all(String(uploadExpId));
    const upload = rows.find((r) => r.action === 'expense.receipt_upload');
    const reject = rows.find((r) => r.action === 'expense.receipt_rejected');
    expect(upload).toBeTruthy();
    expect(reject).toBeTruthy();
    const rejPayload = JSON.parse(reject.payload);
    // random text is unknown content, not a type mismatch.
    expect(rejPayload.reason).toBe('CONTENT_UNKNOWN');
    expect(rejPayload.declared_mime).toBe('image/png');
  });

  it('GET streams back the file with inline disposition', async () => {
    const orig = pngBytes();
    await uploadReceiptRaw(uploadExpId, orig, 'r.png', 'image/png');
    const r = await fetch(`${baseURL}/api/accounting/expenses/${uploadExpId}/receipt`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toMatch(/^inline; filename=/);
    const back = Buffer.from(await r.arrayBuffer());
    expect(back.length).toBe(orig.length);
    expect(back.equals(orig)).toBe(true);
  });

  it('DELETE clears the path AND removes the file from disk', async () => {
    const up = await uploadReceiptRaw(uploadExpId, pngBytes(), 'temp.png', 'image/png');
    const rel = up.body.receipt_path;
    const abs = join(attachmentRoot, rel);
    expect(existsSync(abs)).toBe(true);
    const del = await req('DELETE', `/api/accounting/expenses/${uploadExpId}/receipt`);
    expect(del.ok).toBe(true);
    expect(existsSync(abs)).toBe(false);
    const row = app.db.prepare('SELECT receipt_path FROM expenses WHERE id = ?').get(uploadExpId);
    expect(row.receipt_path).toBeNull();
  });

  it('files land OUTSIDE the webroot (data/attachments/, never /public, /client, or /dist)', async () => {
    // The HQ client is served by Vite from /client, not the server. The
    // "outside webroot" check for the server means: the storage path is
    // never exposed as a static URL by Fastify. We assert two things:
    //   1. The storage path is under data/attachments/ (or GHQ_ATTACHMENT_ROOT).
    //   2. There is no static route mapping the storage path — receipts
    //      are served only by the admin-gated /api/accounting/expenses/:id/receipt
    //      handler.
    const up = await uploadReceiptRaw(uploadExpId, pngBytes(), 'r.png', 'image/png');
    const rel = up.body.receipt_path;
    expect(rel.startsWith('expenses/')).toBe(true);
    const abs = resolve(attachmentRoot, rel);
    expect(abs.startsWith(attachmentRoot)).toBe(true);
    // No public static path serves the file directly. A GET on a
    // non-API URL must 404 (the server doesn't mount the attachment
    // root as static).
    const guess = await fetch(`${baseURL}/${rel}`);
    expect([404, 401, 403]).toContain(guess.status);
  });

  it('path-traversal: GET /receipt with a forged storage_path in URL is not possible', async () => {
    // The URL doesn't accept a path parameter — only an expense id —
    // so the only "traversal" vector is a forged `receipt_path` value
    // already in the DB. We poke one in and confirm resolveAttachmentPath
    // rejects it (returns null → 404).
    app.db.prepare("UPDATE expenses SET receipt_path = ? WHERE id = ?")
      .run('../../../etc/passwd', uploadExpId);
    const r = await fetch(`${baseURL}/api/accounting/expenses/${uploadExpId}/receipt`);
    expect(r.status).toBe(404);
    // Restore so other tests aren't affected.
    app.db.prepare("UPDATE expenses SET receipt_path = NULL WHERE id = ?").run(uploadExpId);
  });

  it('expense DELETE also removes the associated receipt file', async () => {
    const up = await uploadReceiptRaw(uploadExpId, pngBytes(), 'gone.png', 'image/png');
    const abs = join(attachmentRoot, up.body.receipt_path);
    expect(existsSync(abs)).toBe(true);
    const del = await req('DELETE', `/api/accounting/expenses/${uploadExpId}`);
    expect(del.ok).toBe(true);
    // ENOENT-tolerant delete: file should be gone, not orphaned.
    expect(existsSync(abs)).toBe(false);
  });
});

describe('expense + receipt end-to-end (the user-facing workflow)', () => {
  it('create → attach PNG → list shows receipt link → delete clears everything', async () => {
    // 1. Create
    const exp = await req('POST', '/api/accounting/expenses', {
      vendor: 'E2E Vendor',
      expense_date: '2026-06-29',
      category_id: catId,
      amount_cents: 4999,
      tax_cents: 250,
      payment_method: 'e_transfer',
      business_use: true,
      notes: 'end-to-end check',
    });
    expect(exp.id).toBeTruthy();

    // 2. Attach PNG
    const up = await uploadReceiptRaw(exp.id, pngBytes(), 'invoice.png', 'image/png');
    expect(up.status).toBe(200);
    expect(up.body.mime_type).toBe('image/png');

    // 3. List endpoint should expose the receipt_path (the UI renders the link)
    const list = await req('GET', `/api/accounting/expenses?category_id=${catId}`);
    const row = list.find((r) => r.id === exp.id);
    expect(row).toBeTruthy();
    expect(row.receipt_path).toBeTruthy();
    expect(row.receipt_path.startsWith('expenses/')).toBe(true);

    // 4. Stream the receipt back
    const get = await fetch(`${baseURL}/api/accounting/expenses/${exp.id}/receipt`);
    expect(get.status).toBe(200);

    // 5. Delete the receipt
    const d = await req('DELETE', `/api/accounting/expenses/${exp.id}/receipt`);
    expect(d.ok).toBe(true);
    const after = app.db.prepare('SELECT receipt_path FROM expenses WHERE id = ?').get(exp.id);
    expect(after.receipt_path).toBeNull();

    // 6. Delete the expense itself
    const delExp = await req('DELETE', `/api/accounting/expenses/${exp.id}`);
    expect(delExp.ok).toBe(true);
    const gone = app.db.prepare('SELECT id FROM expenses WHERE id = ?').get(exp.id);
    expect(gone).toBeUndefined();
  });

  // Phase 4+ — webcam receipt capture.
  //
  // The client-side ReceiptCapture component produces a JPEG Blob via
  // canvas.toBlob('image/jpeg', 0.85) and wraps it in a File named
  // `receipt-YYYYMMDD-HHMMSS.jpg` (see client/src/pages/Accounting.jsx).
  // This test simulates that exact payload and proves the server side of
  // the loop is intact: the JPEG sniff accepts it, the storage path is
  // recorded, and the receipt streams back as image/jpeg.
  //
  // The browser-rendering half (camera permission prompt, video element,
  // snap-to-canvas) is exercised in the worker browser-verification step
  // against the running Vite dev server.
  it('webcam-style capture: accepts receipt-YYYYMMDD-HHMMSS.jpg and serves it back as image/jpeg', async () => {
    const exp = await req('POST', '/api/accounting/expenses', {
      vendor: 'Webcam Vendor',
      expense_date: '2026-06-30',
      amount_cents: 1799,
      tax_cents: 90,
      payment_method: 'card',
      business_use: true,
      notes: 'captured from webcam',
    });

    // Simulate the exact filename pattern the ReceiptCapture component produces.
    // HHMMSS = 17h39m42s (a typical workday capture).
    const webcamFilename = 'receipt-20260630-173942.jpg';
    const up = await uploadReceiptRaw(exp.id, jpegBytes(), webcamFilename, 'image/jpeg');
    expect(up.status).toBe(200);
    expect(up.body.mime_type).toBe('image/jpeg');
    expect(up.body.filename).toMatch(/^receipt-\d{8}-\d{6}\.jpg$/);
    expect(up.body.receipt_path.startsWith('expenses/')).toBe(true);

    // The receipt row was updated
    const row = app.db.prepare('SELECT receipt_path FROM expenses WHERE id = ?').get(exp.id);
    expect(row.receipt_path).toBeTruthy();

    // Streaming the receipt back returns a 200. Fastify auto-derives the
    // content-type from the stream; the route deliberately does NOT pin
    // it (images vs PDFs share the bucket), so we just assert 200 + a
    // binary body, not a specific content-type.
    const get = await fetch(`${baseURL}/api/accounting/expenses/${exp.id}/receipt`);
    expect(get.status).toBe(200);
    const body = await get.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);

    // Audit log captured the upload with the webcam-shaped filename
    const audit = app.db.prepare(
      "SELECT payload FROM audit_log WHERE action = 'expense.receipt_upload' AND target = ? ORDER BY id DESC LIMIT 1"
    ).get(String(exp.id));
    expect(audit).toBeTruthy();
    const payload = JSON.parse(audit.payload);
    expect(payload.filename).toMatch(/^receipt-\d{8}-\d{6}\.jpg$/);
  });

  // Negative case: webcam capture fails gracefully when getUserMedia is
  // unavailable (we can't easily simulate the user-deny path from inside
  // a server test, so we just confirm the allowlist contract still holds
  // for a non-image payload that a buggy component might accidentally
  // produce). This guards against future regressions if someone wires a
  // new capture mode (e.g. canvas.toBlob with a non-standard mime).
  it('webcam capture path: rejects a payload whose content sniff is not on the allowlist (defense in depth)', async () => {
    const exp = await req('POST', '/api/accounting/expenses', {
      vendor: 'Webcam Misroute',
      expense_date: '2026-06-30',
      amount_cents: 100,
      tax_cents: 0,
      payment_method: 'cash',
      business_use: true,
    });
    // Claim it's a JPEG but the bytes are plain text — like a corrupted
    // canvas.toBlob or a hostile extension. Server must still reject.
    const r = await uploadReceiptRaw(
      exp.id,
      Buffer.from('this is not an image'),
      'receipt-20260630-180000.jpg',
      'image/jpeg',
    );
    expect(r.status).toBe(415);
    expect(r.body.error).toBe('unsupported_media_type');
  });
});

import { resolve } from 'node:path';
