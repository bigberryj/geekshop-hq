/**
 * Regression tests for ticket timers.
 *
 * The UI needs a real timer state machine, not a hard-coded "Start timer"
 * button. Backend contract:
 *   - start creates one active running timer
 *   - pause freezes elapsed seconds while leaving the entry active
 *   - resume continues from the frozen elapsed value
 *   - stop finalizes total elapsed seconds
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
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-time-'));
  const testDbPath = join(tmpDir, 'test.db');
  app = await buildServer({ logger: false, dbPath: testDbPath, skipPoller: true, skipSmtp: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseURL = `http://127.0.0.1:${app.server.address().port}`;

  const db = app.db;
  const customer = db.prepare(`INSERT INTO customers (name, email) VALUES (?, ?)`).run('Timer Tester', 'timer@example.com');
  const ticket = db.prepare(`INSERT INTO tickets (ticket_uid, customer_id, subject, last_message_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`).run(
    `TIMER-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    customer.lastInsertRowid,
    'Timer ticket'
  );
  ticketId = ticket.lastInsertRowid;
});

afterEach(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('ticket time tracking', () => {
  it('starts, pauses, resumes, and stops one active timer while preserving elapsed seconds', async () => {
    const started = await req('POST', `/api/tickets/${ticketId}/time/start`, {});
    expect(started.status).toBe('running');
    expect(started.duration_seconds).toBe(0);
    expect(started.paused_at).toBeNull();

    // Make elapsed deterministic without sleeping.
    app.db.prepare(`UPDATE time_entries SET started_at = datetime('now', '-125 seconds') WHERE id = ?`).run(started.id);

    const paused = await req('POST', `/api/tickets/${ticketId}/time/pause`, {});
    expect(paused.status).toBe('paused');
    expect(paused.paused_at).toBeTruthy();
    expect(paused.duration_seconds).toBeGreaterThanOrEqual(120);
    expect(paused.duration_seconds).toBeLessThanOrEqual(130);

    const whilePaused = await req('GET', `/api/tickets/${ticketId}/time`);
    expect(whilePaused[0].status).toBe('paused');
    expect(whilePaused[0].elapsed_seconds).toBe(paused.duration_seconds);

    const resumed = await req('POST', `/api/tickets/${ticketId}/time/resume`, {});
    expect(resumed.status).toBe('running');
    expect(resumed.paused_at).toBeNull();
    expect(resumed.duration_seconds).toBe(paused.duration_seconds);

    app.db.prepare(`UPDATE time_entries SET started_at = datetime('now', '-35 seconds') WHERE id = ?`).run(started.id);

    const stopped = await req('POST', `/api/tickets/${ticketId}/time/stop`, {});
    expect(stopped.ok).toBe(true);
    expect(stopped.status).toBe('stopped');
    expect(stopped.duration_seconds).toBeGreaterThanOrEqual(paused.duration_seconds + 30);
    expect(stopped.duration_seconds).toBeLessThanOrEqual(paused.duration_seconds + 40);

    const finalRows = await req('GET', `/api/tickets/${ticketId}/time`);
    expect(finalRows[0].status).toBe('stopped');
    expect(finalRows[0].elapsed_seconds).toBe(stopped.duration_seconds);
  });

  it('does not create duplicate active timers for repeated starts on the same ticket', async () => {
    const first = await req('POST', `/api/tickets/${ticketId}/time/start`, {});
    const second = await req('POST', `/api/tickets/${ticketId}/time/start`, {});

    expect(second.id).toBe(first.id);
    expect(second.status).toBe('running');

    const rows = await req('GET', `/api/tickets/${ticketId}/time`);
    expect(rows.filter((row) => row.status === 'running')).toHaveLength(1);
  });
});
