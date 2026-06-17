import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../index.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

let app;
let baseURL;
let tmpDir;
let openTicketId;
let pendingTicketId;
let resolvedTicketId;

async function req(method, url) {
  const r = await fetch(baseURL + url, { method });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text}`);
  return data;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-tickets-'));
  app = await buildServer({ logger: false, dbPath: join(tmpDir, 'test.db'), skipPoller: true, skipSmtp: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseURL = `http://127.0.0.1:${app.server.address().port}`;

  const db = app.db;
  const c = db.prepare(`INSERT INTO customers (name, email) VALUES (?, ?)`).run('Filter Test', 'filter@x.com').lastInsertRowid;
  const ins = db.prepare(`INSERT INTO tickets (ticket_uid, customer_id, subject, status, last_message_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`);
  openTicketId = ins.run(`G-OPEN-${Date.now()}`, c, 'Open ticket', 'open').lastInsertRowid;
  pendingTicketId = ins.run(`G-PEND-${Date.now()}`, c, 'Pending ticket', 'pending').lastInsertRowid;
  resolvedTicketId = ins.run(`G-RES-${Date.now()}`, c, 'Resolved ticket', 'resolved').lastInsertRowid;
});

afterAll(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/tickets multi-status filter', () => {
  it('returns all tickets when no status is given', async () => {
    const rows = await req('GET', '/api/tickets');
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(openTicketId);
    expect(ids).toContain(pendingTicketId);
    expect(ids).toContain(resolvedTicketId);
  });

  it('filters to one status with ?status=open', async () => {
    const rows = await req('GET', '/api/tickets?status=open');
    expect(rows.every((r) => r.status === 'open')).toBe(true);
    expect(rows.some((r) => r.id === resolvedTicketId)).toBe(false);
  });

  it('filters to multiple statuses with ?status=open,pending and hides resolved', async () => {
    const rows = await req('GET', '/api/tickets?status=open,pending');
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(openTicketId);
    expect(ids).toContain(pendingTicketId);
    expect(ids).not.toContain(resolvedTicketId);
  });

  it('returns nothing for a nonsense status (treated as the one value)', async () => {
    const rows = await req('GET', '/api/tickets?status=archived');
    expect(rows).toEqual([]);
  });
});
