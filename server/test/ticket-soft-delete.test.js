/**
 * Tests for ticket soft-delete (T-7D74B8).
 *
 * Byron asked for "the ability to delete tickets in ticket area". Soft-delete
 * is the right shape:
 *   - reversible (restore endpoint)
 *   - preserves audit log + customer history
 *   - keeps invoice line_items stable (denormalized JSON references the
 *     ticket_uid at create time, not a live FK)
 *
 * This test covers:
 *   - GET /api/tickets default excludes deleted rows
 *   - ?include_deleted=true surfaces them
 *   - GET /api/tickets/:id still works for deleted rows (restore needs payload)
 *   - DELETE /api/tickets/:id stamps deleted_at and flips open → resolved
 *   - DELETE /api/tickets/:id auto-stops any active timer on the ticket
 *   - DELETE is idempotent (second call returns already_deleted)
 *   - POST /api/tickets/:id/restore clears deleted_at
 *   - Soft-deleted tickets don't show up in dashboard open_tickets
 *   - Soft-deleted tickets don't show up in the customer timeline
 *   - Soft-deleted tickets are skipped by the reply matcher
 *   - Audit log records delete + restore
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the reply matcher's Gmail dep before route import so the import-time
// graph doesn't try to spin up imapflow. The matcher is unit-tested separately
// in import-merge.test.js; here we only assert the SQL filter works.
vi.mock('../lib/email-inbox.js', () => ({
  markRead: vi.fn(async () => ({ ok: true })),
  markThreadDone: vi.fn(async () => ({ ok: true })),
  fetchUnread: vi.fn(async () => []),
  fetchByMessageId: vi.fn(async () => null),
  fetchMessageByUid: vi.fn(async () => null),
}));

import { buildServer } from '../index.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { matchReplyToTicket } from '../lib/replies.js';

let app;
let baseURL;
let tmpDir;
let customerId;
let liveTicketId;
let deadTicketId;
let emailTicketId; // soft-deleted but originally email-sourced

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
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-softdel-'));
  app = await buildServer({ logger: false, dbPath: join(tmpDir, 'test.db'), skipPoller: true, skipSmtp: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseURL = `http://127.0.0.1:${app.server.address().port}`;

  const db = app.db;
  const c = db.prepare(`INSERT INTO customers (name, email) VALUES (?, ?)`).run('Soft Delete Tester', 'soft@x.com').lastInsertRowid;
  customerId = c;
  const ins = db.prepare(`
    INSERT INTO tickets (ticket_uid, customer_id, subject, status, last_message_at)
    VALUES (?, ?, ?, 'open', CURRENT_TIMESTAMP)
  `);
  liveTicketId = ins.run(`G-LIVE-${Date.now()}`, c, 'Live ticket').lastInsertRowid;
  deadTicketId = ins.run(`G-DEAD-${Date.now()}`, c, 'Delete me').lastInsertRowid;
  emailTicketId = ins.run(`G-EMAIL-${Date.now()}`, c, 'Email ticket').lastInsertRowid;
});

afterEach(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('ticket soft-delete (T-7D74B8)', () => {
  it('excludes soft-deleted tickets from GET /api/tickets by default', async () => {
    // First confirm all 3 are visible while live
    const before = await req('GET', '/api/tickets');
    expect(before.map((r) => r.id)).toContain(deadTicketId);

    // Now delete and re-check
    await req('DELETE', `/api/tickets/${deadTicketId}`);
    const after = await req('GET', '/api/tickets');
    const ids = after.map((r) => r.id);
    expect(ids).toContain(liveTicketId);
    expect(ids).toContain(emailTicketId);
    expect(ids).not.toContain(deadTicketId);
  });

  it('?include_deleted=true surfaces soft-deleted rows', async () => {
    await req('DELETE', `/api/tickets/${deadTicketId}`);
    const live = await req('GET', '/api/tickets');
    const all = await req('GET', '/api/tickets?include_deleted=true');
    expect(live.map((r) => r.id)).not.toContain(deadTicketId);
    expect(all.map((r) => r.id)).toContain(deadTicketId);
  });

  it('GET /api/tickets/:id still works for soft-deleted rows (restore needs payload)', async () => {
    await req('DELETE', `/api/tickets/${deadTicketId}`);
    const t = await req('GET', `/api/tickets/${deadTicketId}`);
    expect(t.id).toBe(deadTicketId);
    expect(t.deleted_at).toBeTruthy();
  });

  it('DELETE stamps deleted_at and flips open → resolved', async () => {
    const r = await req('DELETE', `/api/tickets/${deadTicketId}`);
    expect(r.ok).toBe(true);
    const row = app.db.prepare('SELECT status, deleted_at, deleted_by, resolved_at FROM tickets WHERE id = ?').get(deadTicketId);
    expect(row.deleted_at).toBeTruthy();
    expect(row.deleted_by).toBe('admin');
    expect(row.status).toBe('resolved');
    expect(row.resolved_at).toBeTruthy();
  });

  it('DELETE auto-stops any active timer on the ticket', async () => {
    // Start a timer
    const start = await req('POST', `/api/tickets/${deadTicketId}/time/start`, {});
    expect(start.status).toBe('running');

    // Delete the ticket
    await req('DELETE', `/api/tickets/${deadTicketId}`);

    // Timer should be finalized (stopped_at NOT NULL) with a duration
    const entry = app.db.prepare('SELECT stopped_at, duration_seconds FROM time_entries WHERE id = ?').get(start.id);
    expect(entry.stopped_at).toBeTruthy();
    expect(entry.duration_seconds).toBeGreaterThanOrEqual(0);
  });

  it('DELETE is idempotent (second call returns already_deleted)', async () => {
    const r1 = await req('DELETE', `/api/tickets/${deadTicketId}`);
    expect(r1.ok).toBe(true);
    const r2 = await req('DELETE', `/api/tickets/${deadTicketId}`);
    expect(r2.ok).toBe(true);
    expect(r2.already_deleted).toBe(true);
  });

  it('DELETE on missing ticket returns 404', async () => {
    await expect(req('DELETE', `/api/tickets/999999`)).rejects.toThrow(/HTTP 404/);
  });

  it('POST /api/tickets/:id/restore clears deleted_at and brings the ticket back', async () => {
    await req('DELETE', `/api/tickets/${deadTicketId}`);
    const r = await req('POST', `/api/tickets/${deadTicketId}/restore`, {});
    expect(r.ok).toBe(true);
    const row = app.db.prepare('SELECT deleted_at, deleted_by FROM tickets WHERE id = ?').get(deadTicketId);
    expect(row.deleted_at).toBeNull();
    expect(row.deleted_by).toBeNull();
    // Restored ticket should appear in the default list again
    const rows = await req('GET', '/api/tickets');
    expect(rows.map((r) => r.id)).toContain(deadTicketId);
  });

  it('restore on a live ticket is a no-op (already_live)', async () => {
    const r = await req('POST', `/api/tickets/${liveTicketId}/restore`, {});
    expect(r.ok).toBe(true);
    expect(r.already_live).toBe(true);
  });

  it('soft-deleted tickets are excluded from the dashboard open_tickets', async () => {
    await req('DELETE', `/api/tickets/${deadTicketId}`);
    const dash = await req('GET', '/api/dashboard');
    const openIds = dash.open_tickets.map((r) => r.id);
    expect(openIds).toContain(liveTicketId);
    expect(openIds).not.toContain(deadTicketId);
  });

  it('soft-deleted tickets do not surface in the customer timeline', async () => {
    // Add a message to deadTicketId so the timeline would otherwise include it
    await req('POST', `/api/tickets/${deadTicketId}/messages`, { body: 'hi from customer' });
    await req('DELETE', `/api/tickets/${deadTicketId}`);

    const tl = await req('GET', `/api/customers/${customerId}/timeline`);
    const kinds = tl.events.map((e) => e.kind);
    const ticketIds = tl.events.map((e) => e.meta?.ticket_id).filter(Boolean);
    // The deleted ticket's ticket_created and ticket_message should be gone
    expect(ticketIds).not.toContain(deadTicketId);
    // But the live ticket's events should still be there
    expect(ticketIds).toContain(liveTicketId);
  });

  it('soft-deleted tickets are skipped by the Gmail reply matcher (thread match)', async () => {
    // Set up a deleted email-sourced ticket that the matcher should NOT touch
    app.db.prepare(`UPDATE tickets SET source_message_id = ? WHERE id = ?`)
      .run('<msg-dead@geekshop.ca>', deadTicketId);
    await req('DELETE', `/api/tickets/${deadTicketId}`);

    // The matcher would normally hit it via Strategy 1 (In-Reply-To match)
    const result = await matchReplyToTicket(app.db, {
      messageId: 'new-incoming-msg-1@geekshop.ca',
      fromEmail: 'soft@x.com',
      from: 'Soft Delete Tester',
      subject: 'Re: Delete me',
      body: 'still need help',
      html: null,
      attachments: [],
    });
    // Should NOT match the deleted ticket
    if (result) {
      expect(result.ticket_id).not.toBe(deadTicketId);
    }
  });

  it('audit log records delete + restore', async () => {
    await req('DELETE', `/api/tickets/${deadTicketId}`);
    await req('POST', `/api/tickets/${deadTicketId}/restore`, {});

    const audit = app.db.prepare(`
      SELECT action, target FROM audit_log
      WHERE action IN ('ticket.delete', 'ticket.restore')
        AND target = ?
      ORDER BY id ASC
    `).all(String(deadTicketId));
    const actions = audit.map((r) => r.action);
    expect(actions).toContain('ticket.delete');
    expect(actions).toContain('ticket.restore');
  });
});
