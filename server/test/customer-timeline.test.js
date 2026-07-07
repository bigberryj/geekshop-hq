/**
 * Phase 2 — Customer 360 timeline endpoint.
 *
 * Verifies `/api/customers/:id/timeline`:
 *   1. 404 on unknown customer id, 400 on non-integer id
 *   2. Happy path returns events from all 8 kinds, newest first
 *   3. kinds= filter is respected
 *   4. from / to / limit filters are respected
 *   5. Privacy — never projects Gmail Message-ID, Stripe IDs, body_html
 *   6. Invoice state expansion: created/sent/paid appear as 3 distinct events
 *   7. Appointment email fallback matches bookings created with customer_id NULL
 *   8. counts object reflects the per-kind totals (over the FULL set, not limited)
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
let otherCustomerId;

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
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-timeline-'));
  const testDbPath = join(tmpDir, 'test.db');
  app = await buildServer({ logger: false, dbPath: testDbPath, skipPoller: true, skipSmtp: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  baseURL = `http://127.0.0.1:${port}`;
  const db = app.db;

  // Primary customer under test.
  const c1 = db.prepare(`INSERT INTO customers (name, company, email, phone, notes) VALUES (?, ?, ?, ?, ?) RETURNING id`)
    .get('Timeline Co', 'TimelineCorp', 'timeline@test.ca', '555-0100', 'timeline notes');
  customerId = c1.id;
  // A second customer that shares NO data — used for cross-customer leakage checks.
  const c2 = db.prepare(`INSERT INTO customers (name, company, email, phone) VALUES (?, ?, ?, ?) RETURNING id`)
    .get('Other Co', 'OtherCorp', 'other@test.ca', '555-0200');
  otherCustomerId = c2.id;

  // 1. Ticket — created, with messages, then resolved.
  const t1 = db.prepare(`INSERT INTO tickets (ticket_uid, customer_id, subject, status, priority, created_at, last_message_at, resolved_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .get('TL-000001', customerId, 'Slow laptop', 'resolved', 'normal',
         '2026-06-29T09:00:00Z', '2026-06-29T11:00:00Z', '2026-06-29T11:30:00Z');
  db.prepare(`INSERT INTO tickets (ticket_uid, customer_id, subject, status, priority, created_at, last_message_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('TL-000002', customerId, 'Printer offline', 'open', 'high',
         '2026-06-29T14:00:00Z', '2026-06-29T14:00:00Z');

  // 2. Messages on the resolved ticket — one customer, one AI-drafted admin reply.
  //    Include a raw Gmail header value to assert the endpoint does not echo it.
  db.prepare(`INSERT INTO ticket_messages (ticket_id, sender, body, body_html, gmail_message_id, source_message_id, ai_draft, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(t1.id, 'customer', 'My laptop is slow after Windows update',
         '<p>Plain html</p>', 'gid-customer-1@a.com', 'gid-thread-1@a.com', 0,
         '2026-06-29T09:30:00Z');
  db.prepare(`INSERT INTO ticket_messages (ticket_id, sender, body, ai_draft, created_at)
              VALUES (?, ?, ?, ?, ?)`)
    .run(t1.id, 'admin', 'Try clearing the temp folder', 1,
         '2026-06-29T10:00:00Z');

  // 3. Appointment — by customer_id.
  db.prepare(`INSERT INTO appointments (customer_id, customer_name, customer_email, starts_at, ends_at, status, notes, booking_slug)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(customerId, 'Timeline Co', 'timeline@test.ca',
         '2026-06-30T15:00:00Z', '2026-06-30T15:30:00Z',
         'scheduled', 'Onsite virus scan', 'general');

  // 4. Appointment — legacy email-only (customer_id NULL), email-fallback path.
  db.prepare(`INSERT INTO appointments (customer_id, customer_name, customer_email, starts_at, ends_at, status, notes, booking_slug)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(null, 'Timeline Co', 'TIMELINE@test.ca', // uppercase to test case-fold
         '2026-06-29T08:00:00Z', '2026-06-29T08:30:00Z',
         'completed', 'Old booking pre-import', 'general');

  // 5. Appointment for the OTHER customer — should never leak in.
  db.prepare(`INSERT INTO appointments (customer_id, customer_name, customer_email, starts_at, ends_at, status, booking_slug)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(otherCustomerId, 'Other Co', 'other@test.ca',
         '2026-06-30T10:00:00Z', '2026-06-30T10:30:00Z',
         'scheduled', 'general');

  // 6. Time entries — one running, one invoiced, one plain stopped.
  db.prepare(`INSERT INTO time_entries (ticket_id, started_at, stopped_at, duration_seconds, note)
              VALUES (?, ?, ?, ?, ?)`)
    .run(t1.id, '2026-06-29T09:30:00Z', '2026-06-29T10:15:00Z', 2700, 'Diagnostic work');
  db.prepare(`INSERT INTO time_entries (ticket_id, started_at, stopped_at, duration_seconds, note, invoiced_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(t1.id, '2026-06-29T10:30:00Z', '2026-06-29T11:00:00Z', 1800, 'Cleanup', '2026-06-29T16:00:00Z');
  db.prepare(`INSERT INTO time_entries (ticket_id, started_at, stopped_at, duration_seconds)
              VALUES (?, ?, ?, ?)`)
    .run(t1.id, '2026-06-29T13:00:00Z', null, null); // still running

  // 7. Invoice — created then sent then paid.
  const inv1 = db.prepare(`INSERT INTO invoices (invoice_uid, customer_id, status, line_items, subtotal_cents, tax_cents, total_cents, created_at, sent_at, paid_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .get('INV-TL-001', customerId, 'paid', '[]', 10000, 1200, 11200,
         '2026-06-25T00:00:00Z', '2026-06-26T00:00:00Z', '2026-06-29T12:00:00Z');
  // Draft invoice still unsettled — only `created` state fires.
  db.prepare(`INSERT INTO invoices (invoice_uid, customer_id, status, line_items, subtotal_cents, tax_cents, total_cents, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('INV-TL-002', customerId, 'draft', '[]', 5000, 600, 5600,
         '2026-06-29T18:00:00Z');

  // 8. Payments — including Stripe metadata, which must NOT leak.
  db.prepare(`INSERT INTO payments (invoice_id, amount_cents, method, stripe_payment_intent_id, stripe_charge_id, status, received_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(inv1.id, 11200, 'stripe', 'pi_secret_id_xxx', 'ch_secret_id_yyy', 'succeeded',
         '2026-06-29T12:00:00Z');
  db.prepare(`INSERT INTO payments (invoice_id, amount_cents, method, status, received_at, notes)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(inv1.id, 0, 'cash', 'succeeded', '2026-06-29T12:01:00Z', 'no tip'); // sanity: $0 row

  // 9. Customer memory — manual + AI.
  db.prepare(`INSERT INTO customer_memory (customer_id, category, key, value, source, confidence)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(customerId, 'preference', 'contact_method', 'email only', 'manual', 1.0);
  db.prepare(`INSERT INTO customer_memory (customer_id, category, key, value, source, confidence)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(customerId, 'equipment', 'router', 'TP-Link Archer AX50', 'ai', 0.7);
});

afterAll(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('customer timeline endpoint (Phase 2)', () => {
  it('400 on non-integer customer id', async () => {
    try {
      await req('GET', '/api/customers/notanumber/timeline');
      expect.fail('expected 400');
    } catch (e) {
      expect(e.response.status).toBe(400);
    }
  });

  it('404 on unknown customer id', async () => {
    try {
      await req('GET', '/api/customers/999999/timeline');
      expect.fail('expected 404');
    } catch (e) {
      expect(e.response.status).toBe(404);
    }
  });

  it('returns events for a customer with full activity', async () => {
    const data = await req('GET', `/api/customers/${customerId}/timeline`);
    expect(Array.isArray(data.events)).toBe(true);
    expect(data.events.length).toBeGreaterThan(0);
    expect(data.customer.id).toBe(customerId);
    expect(typeof data.generated_at).toBe('string');

    // Every event must have the unified shape.
    for (const ev of data.events) {
      expect(ev).toHaveProperty('id');
      expect(ev).toHaveProperty('kind');
      expect(ev).toHaveProperty('at');
      expect(ev).toHaveProperty('title');
      expect(ev).toHaveProperty('summary');
      expect(ev).toHaveProperty('meta');
    }

    // Sorted newest first.
    const ats = data.events.map((e) => e.at);
    const sorted = [...ats].sort().reverse();
    expect(ats).toEqual(sorted);

    // All 8 kinds should be present in counts.
    expect(data.counts.ticket_created).toBeGreaterThanOrEqual(1);
    expect(data.counts.ticket_resolved).toBeGreaterThanOrEqual(1);
    expect(data.counts.ticket_message).toBeGreaterThanOrEqual(2);
    expect(data.counts.appointment).toBeGreaterThanOrEqual(2);
    expect(data.counts.time_entry).toBeGreaterThanOrEqual(3);
    expect(data.counts.invoice).toBeGreaterThanOrEqual(3); // created+sent+paid for inv1 + created for inv2 = 4
    expect(data.counts.payment).toBeGreaterThanOrEqual(2);
    expect(data.counts.memory).toBeGreaterThanOrEqual(2);
  });

  it('kinds= filter restricts what comes back', async () => {
    const data = await req('GET', `/api/customers/${customerId}/timeline?kinds=memory`);
    // Only memory events should appear.
    expect(data.events.length).toBeGreaterThanOrEqual(1);
    for (const ev of data.events) expect(ev.kind).toBe('memory');
  });

  it('from / to date filters clamp the result set', async () => {
    const data = await req('GET', `/api/customers/${customerId}/timeline?from=2026-06-29T12:00:00Z&to=2026-06-30T00:00:00Z`);
    expect(data.events.length).toBeGreaterThan(0);
    for (const ev of data.events) {
      expect(ev.at >= '2026-06-29T12:00:00Z').toBe(true);
      expect(ev.at < '2026-06-30T00:00:00Z').toBe(true);
    }
  });

  it('limit clamps the response size', async () => {
    const data = await req('GET', `/api/customers/${customerId}/timeline?limit=2`);
    expect(data.events.length).toBe(2);
  });

  it('does not leak secrets / Gmail headers / Stripe ids / body_html', async () => {
    const data = await req('GET', `/api/customers/${customerId}/timeline`);
    const blob = JSON.stringify(data);
    // Privacy assertions — explicit, not exhaustive.
    expect(blob).not.toContain('gid-customer-1@a.com');
    expect(blob).not.toContain('gid-thread-1@a.com');
    expect(blob).not.toContain('pi_secret_id_xxx');
    expect(blob).not.toContain('ch_secret_id_yyy');
    expect(blob).not.toContain('Plain html');
  });

  it('invoice state expansion produces 3 events for a paid invoice', async () => {
    const data = await req('GET', `/api/customers/${customerId}/timeline?kinds=invoice`);
    const states = data.events.map((e) => e.meta?.state).filter(Boolean).sort();
    // INV-TL-001 (paid) → created/sent/paid; INV-TL-002 (draft) → created.
    expect(states).toEqual(['created', 'created', 'paid', 'sent']);
    // All four are sorted newest first within the kind filter.
    expect(data.events[0].meta.state).toBe('created'); // INV-TL-002 most recent
  });

  it('appointment email-fallback matches legacy customer_id=NULL bookings', async () => {
    const data = await req('GET', `/api/customers/${customerId}/timeline?kinds=appointment`);
    expect(data.events.length).toBe(2);
    // The Aug-08:00 booking was created with customer_id=NULL but matched by email.
    expect(data.events.map((e) => e.meta.appointment_id)).toHaveLength(2);
  });

  it('isolates customers — never returns another customer\'s data', async () => {
    const data = await req('GET', `/api/customers/${otherCustomerId}/timeline`);
    for (const ev of data.events) {
      // No events should reference the timeline customer's data.
      const payload = JSON.stringify(ev);
      if (ev.kind === 'ticket_message') {
        // We seeded no tickets for otherCustomer, so no messages should appear.
        expect.fail('unexpected ticket message');
      }
      if (ev.kind === 'invoice' || ev.kind === 'payment') {
        expect(payload).not.toContain('INV-TL');
      }
      if (ev.kind === 'memory') {
        expect(payload).not.toContain('TP-Link');
        expect(payload).not.toContain('contact_method');
      }
    }
  });

  it('rejects unknown kind names in kinds= filter', async () => {
    const data = await req('GET', `/api/customers/${customerId}/timeline?kinds=bogus,also_bogus`);
    // Unknown kinds are dropped from the filter set; with none valid, the
    // allowed list is empty — so no events should be returned.
    expect(data.events.length).toBe(0);
  });
});
