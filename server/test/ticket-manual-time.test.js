/**
 * Tests for manual time-entry add / edit / delete (T-7D74B8).
 *
 * The timer (start/pause/resume/stop) is covered in test/time-entries.test.js.
 * This file covers the manual entry path the operator uses when they want
 * to log time that wasn't tracked live:
 *
 *   - POST /api/tickets/:id/time         (create manual entry)
 *   - PATCH /api/tickets/:id/time/:eid   (edit stopped entry's note/timestamps)
 *   - DELETE /api/tickets/:id/time/:eid  (delete a stopped entry)
 *
 * Active timers (stopped_at IS NULL) are intentionally NOT editable or
 * deletable through these endpoints — the live timer state machine owns
 * them. Trying to edit/delete a running entry returns 400/409.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../index.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

let app;
let baseURL;
let tmpDir;
let ticketId;

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

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-manual-time-'));
  app = await buildServer({ logger: false, dbPath: join(tmpDir, 'test.db'), skipPoller: true, skipSmtp: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseURL = `http://127.0.0.1:${app.server.address().port}`;

  const db = app.db;
  const customer = db.prepare(`INSERT INTO customers (name, email) VALUES (?, ?)`).run('Manual Time', 'manual@x.com').lastInsertRowid;
  ticketId = db.prepare(`
    INSERT INTO tickets (ticket_uid, customer_id, subject, last_message_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `).run(`G-MANUAL-${Date.now()}`, customer, 'Manual time ticket').lastInsertRowid;
});

afterEach(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('manual time entry (T-7D74B8)', () => {
  it('creates a stopped entry with computed duration_seconds', async () => {
    const started = '2026-06-30T10:00:00.000Z';
    const stopped = '2026-06-30T11:30:00.000Z'; // 90 min
    const r = await req('POST', `/api/tickets/${ticketId}/time`, {
      started_at: started, stopped_at: stopped, note: 'on-site repair',
    });
    expect(r.status).toBe('stopped');
    expect(r.duration_seconds).toBe(90 * 60);
    expect(r.elapsed_seconds).toBe(90 * 60);
  });

  it('rejects manual entry with missing timestamps', async () => {
    await expect(req('POST', `/api/tickets/${ticketId}/time`, { started_at: 'x' }))
      .rejects.toThrow(/started_at and stopped_at required/);
    await expect(req('POST', `/api/tickets/${ticketId}/time`, { stopped_at: 'x' }))
      .rejects.toThrow(/started_at and stopped_at required/);
  });

  it('lists the manual entry alongside timer entries', async () => {
    await req('POST', `/api/tickets/${ticketId}/time`, {
      started_at: '2026-06-30T10:00:00.000Z',
      stopped_at: '2026-06-30T10:15:00.000Z',
      note: 'short call',
    });
    const rows = await req('GET', `/api/tickets/${ticketId}/time`);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe('short call');
    expect(rows[0].status).toBe('stopped');
  });

  it('edits a stopped entry\'s note and timestamps', async () => {
    const r = await req('POST', `/api/tickets/${ticketId}/time`, {
      started_at: '2026-06-30T10:00:00.000Z',
      stopped_at: '2026-06-30T10:30:00.000Z',
      note: 'rough estimate',
    });
    const updated = await req('PATCH', `/api/tickets/${ticketId}/time/${r.id}`, {
      started_at: '2026-06-30T10:00:00.000Z',
      stopped_at: '2026-06-30T11:00:00.000Z',
      note: 'actually took an hour',
    });
    expect(updated.duration_seconds).toBe(60 * 60);
    expect(updated.note).toBe('actually took an hour');
  });

  it('PATCH on an active timer returns 400 (use the start/pause/resume/stop endpoints instead)', async () => {
    const r = await req('POST', `/api/tickets/${ticketId}/time/start`, {});
    expect(r.status).toBe('running');
    await expect(req('PATCH', `/api/tickets/${ticketId}/time/${r.id}`, { note: 'should fail' }))
      .rejects.toThrow(/active timers are not editable/);
  });

  it('deletes a stopped entry', async () => {
    const r = await req('POST', `/api/tickets/${ticketId}/time`, {
      started_at: '2026-06-30T10:00:00.000Z',
      stopped_at: '2026-06-30T10:30:00.000Z',
    });
    const del = await req('DELETE', `/api/tickets/${ticketId}/time/${r.id}`);
    expect(del.ok).toBe(true);
    const rows = await req('GET', `/api/tickets/${ticketId}/time`);
    expect(rows).toHaveLength(0);
  });

  it('DELETE on an active timer returns 409 (stop it first)', async () => {
    const r = await req('POST', `/api/tickets/${ticketId}/time/start`, {});
    expect(r.status).toBe('running');
    await expect(req('DELETE', `/api/tickets/${ticketId}/time/${r.id}`))
      .rejects.toThrow(/cannot delete a running or paused timer/);
  });

  it('DELETE on an unknown entry returns 404', async () => {
    await expect(req('DELETE', `/api/tickets/${ticketId}/time/999999`))
      .rejects.toThrow(/HTTP 404/);
  });

  it('manual entries are reflected in the customer time roll-up (uninvoiced bucket)', async () => {
    await req('POST', `/api/tickets/${ticketId}/time`, {
      started_at: '2026-06-30T10:00:00.000Z',
      stopped_at: '2026-06-30T11:00:00.000Z',
    });
    const customerId = app.db.prepare('SELECT customer_id FROM tickets WHERE id = ?').get(ticketId).customer_id;
    const rows = await req('GET', `/api/customers/${customerId}/time`);
    expect(rows).toHaveLength(1);
    expect(rows[0].ticket_id).toBe(ticketId);
    expect(rows[0].status).toBe('stopped');
  });
});
