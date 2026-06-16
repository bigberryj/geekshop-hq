/**
 * End-to-end smoke test that boots the actual server and exercises every
 * critical endpoint. Catches the kind of regression that bit us with the
 * "(older — no body fetched)" placeholder bug: an endpoint that *exists*
 * and returns 200, but returns nonsense for real data.
 *
 * What it checks (each MUST pass before any change ships):
 *   1. Server boots and /api/dashboard returns 200
 *   2. /api/customers returns 200 with at least one customer
 *   3. PUT /api/customers/:id updates a field, GET reflects the change
 *   4. PUT validation: empty name → 400, unknown field → ignored (not crash)
 *   5. /api/inbox/pending returns 200 with the documented shape
 *   6. /api/inbox/pending?since=...&until=... actually filters by date
 *   7. /api/tickets returns 200
 *   8. PUT/PATCH aliases both work on customers
 *   9. Audit log records the customer.update action
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../index.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

let app;
let baseURL;
let tmpDir;

// Tiny fetch wrapper — Node 26 has global fetch, no need for axios.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-smoke-'));
  const testDbPath = join(tmpDir, 'test.db');
  app = await buildServer({ logger: false, dbPath: testDbPath, skipPoller: true, skipSmtp: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  baseURL = `http://127.0.0.1:${port}`;
  // Seed test data so we have something to assert against.
  const db = app.db;
  db.prepare(`INSERT INTO customers (name, company, email, phone, notes) VALUES (?, ?, ?, ?, ?)`)
    .run('Smoke Test Co', 'TestCorp', 'smoke@test.ca', '555-0001', 'initial notes');
  db.prepare(`INSERT INTO customers (name, company, email, phone) VALUES (?, ?, ?, ?)`)
    .run('Second Smoke', 'SecondCorp', 'two@test.ca', '555-0002');
  db.prepare(`INSERT INTO pending_emails (message_id, from_email, from_name, subject, body, snippet, received_at, status)
              VALUES ('smoke-1@x', 'a@x.com', 'A', 'Smoke subject', 'body 1', 'snippet 1', '2026-06-10T12:00:00Z', 'pending')`).run();
  db.prepare(`INSERT INTO pending_emails (message_id, from_email, from_name, subject, body, snippet, received_at, status)
              VALUES ('smoke-2@x', 'b@x.com', 'B', 'Smoke subject 2', 'body 2', 'snippet 2', '2026-06-13T12:00:00Z', 'pending')`).run();
});

afterAll(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('smoke: server boots and core endpoints work', () => {
  it('dashboard returns 200', async () => {
    const data = await req('GET', '/api/dashboard');
    expect(data).toBeTypeOf('object');
  });

  it('customers list returns 200 with array shape', async () => {
    const data = await req('GET', '/api/customers');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it('PUT /api/customers/:id updates a field and persists', async () => {
    const list = await req('GET', '/api/customers');
    const target = list.find((c) => c.name === 'Smoke Test Co');
    expect(target).toBeDefined();
    const newPhone = '555-SMOKE-' + Date.now();
    const updated = await req('PUT', `/api/customers/${target.id}`, { phone: newPhone });
    expect(updated.phone).toBe(newPhone);
    const fresh = await req('GET', `/api/customers/${target.id}`);
    expect(fresh.phone).toBe(newPhone);
  });

  it('PUT /api/customers/:id rejects empty name with 400', async () => {
    const list = await req('GET', '/api/customers');
    const target = list.find((c) => c.name === 'Smoke Test Co');
    try {
      await req('PUT', `/api/customers/${target.id}`, { name: '' });
      expect.fail('expected 400');
    } catch (e) {
      expect(e.response.status).toBe(400);
      expect(e.response.data.error).toMatch(/name/i);
    }
  });

  it('PUT /api/customers/:id ignores unknown fields (no crash, no leak)', async () => {
    const list = await req('GET', '/api/customers');
    const target = list.find((c) => c.name === 'Smoke Test Co');
    const r = await req('PUT', `/api/customers/${target.id}`, { id: 99999, created_at: 'hacked', phone: target.phone || 'x' });
    expect(r.id).toBe(target.id);
    expect(r.created_at).toBe(target.created_at);
  });

  it('PATCH /api/customers/:id works the same as PUT', async () => {
    const list = await req('GET', '/api/customers');
    const target = list.find((c) => c.name === 'Smoke Test Co');
    const newNote = 'smoke-patch-' + Date.now();
    const r = await req('PATCH', `/api/customers/${target.id}`, { notes: newNote });
    expect(r.notes).toBe(newNote);
  });

  it('inbox/pending returns documented shape with items+total+filter', async () => {
    const data = await req('GET', '/api/inbox/pending?status=pending&limit=5');
    expect(data).toHaveProperty('items');
    expect(data).toHaveProperty('total');
    expect(data).toHaveProperty('limit');
    expect(data).toHaveProperty('offset');
    expect(data).toHaveProperty('filter');
    expect(Array.isArray(data.items)).toBe(true);
  });

  it('inbox/pending?since= filters by received_at', async () => {
    const since = '2026-06-12T00:00:00.000Z';
    const data = await req('GET', `/api/inbox/pending?status=pending&since=${encodeURIComponent(since)}`);
    expect(data.items.length).toBe(1);
    expect(data.items[0].message_id).toBe('smoke-2@x');
    expect(data.total).toBe(1);
  });

  it('inbox/pending?until= filters by received_at', async () => {
    const until = '2026-06-11T00:00:00.000Z';
    const data = await req('GET', `/api/inbox/pending?status=pending&until=${encodeURIComponent(until)}`);
    expect(data.items.length).toBe(1);
    expect(data.items[0].message_id).toBe('smoke-1@x');
  });

  it('inbox/pending?since > until returns 400', async () => {
    try {
      await req('GET', '/api/inbox/pending?status=pending&since=2026-06-15T00:00:00.000Z&until=2026-06-10T00:00:00.000Z');
      expect.fail('expected 400');
    } catch (e) {
      expect(e.response.status).toBe(400);
      expect(e.response.data.error).toMatch(/since/);
    }
  });

  it('customer.update action appears in audit_log with the changed fields', async () => {
    const list = await req('GET', '/api/customers');
    const target = list.find((c) => c.name === 'Smoke Test Co');
    const uniquePhone = '555-AUDIT-' + Date.now();
    await req('PUT', `/api/customers/${target.id}`, { phone: uniquePhone });
    const audit = app.db.prepare("SELECT * FROM audit_log WHERE action = 'customer.update' AND target = ? ORDER BY id DESC LIMIT 1").get(String(target.id));
    expect(audit).toBeDefined();
    const payload = JSON.parse(audit.payload);
    expect(payload).toHaveProperty('phone');
    expect(payload.phone).toBe(uniquePhone);
    // The audit must NOT leak protected fields like id or created_at.
    expect(payload).not.toHaveProperty('id');
    expect(payload).not.toHaveProperty('created_at');
  });

  it('tickets list returns 200', async () => {
    const data = await req('GET', '/api/tickets');
    expect(Array.isArray(data)).toBe(true);
  });
});
