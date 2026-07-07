/**
 * Phase 1 — Revenue leakage dashboard.
 *
 * Verifies `/api/accounting/leakage` for the five widgets:
 *   1. Uninvoiced time entries (valued at the configured labour rate)
 *   2. Resolved tickets with uninvoiced time
 *   3. Stale draft invoices (older than `stale_draft_days`)
 *   4. Overdue sent invoices
 *   5. Customers with billable activity but no recent invoice
 *
 * Each widget is tested against a freshly-seeded dataset so the assertions
 * are deterministic and don't depend on whatever was already in the DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../index.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

let app;
let baseURL;
let tmpDir;
let aliceId;
let bobId;
let incyId;
let acmeTicketId;
let resolvedTicketId;
let draftInvoiceId;
let sentOverdueInvoiceId;

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
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-leak-'));
  const testDbPath = join(tmpDir, 'test.db');
  app = await buildServer({ logger: false, dbPath: testDbPath, skipPoller: true, skipSmtp: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  baseURL = `http://127.0.0.1:${port}`;
  const db = app.db;

  // Pin labour rate to a known value so the cents math is exact.
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('labour_rate_cents_per_hour', '10000')`).run();

  // Seed: two customers (and a third "Incidental" customer only used for
  // the stale_draft_invoices test so its invoices don't pollute Alice's
  // "most recent invoice" date.)
  aliceId = db.prepare(`INSERT INTO customers (name, email) VALUES (?, ?)`).run('Alice', 'alice@example.test').lastInsertRowid;
  bobId = db.prepare(`INSERT INTO customers (name, email) VALUES (?, ?)`).run('Bob', 'bob@example.test').lastInsertRowid;
  const incyId = db.prepare(`INSERT INTO customers (name, email) VALUES (?, ?)`).run('Incidental', 'incidental@example.test').lastInsertRowid;

  // Two tickets for Alice: one open with billable time, one resolved with billable time.
  acmeTicketId = db.prepare(`INSERT INTO tickets (ticket_uid, customer_id, subject, status) VALUES (?, ?, ?, 'open')`)
    .run('G-LEAK-001', aliceId, 'Acme laptop wont boot').lastInsertRowid;
  resolvedTicketId = db.prepare(`INSERT INTO tickets (ticket_uid, customer_id, subject, status) VALUES (?, ?, ?, 'resolved')`)
    .run('G-LEAK-002', aliceId, 'Old printer setup').lastInsertRowid;

  // Bob's ticket: completely no invoices yet — should appear in dormant_customers.
  const bobTicketId = db.prepare(`INSERT INTO tickets (ticket_uid, customer_id, subject, status) VALUES (?, ?, ?, 'open')`)
    .run('G-LEAK-003', bobId, 'Bob needs help').lastInsertRowid;
  db.prepare(`INSERT INTO time_entries (ticket_id, started_at, stopped_at, duration_seconds, note)
              VALUES (?, '2026-06-01T10:00:00Z', '2026-06-01T11:00:00Z', 3600, 'Bob dial-in')`)
    .run(bobTicketId);

  // Time entries:
  //  - Open ticket: 1.5 hours of stopped work = $150 at $100/h → 15000 cents
  db.prepare(`INSERT INTO time_entries (ticket_id, started_at, stopped_at, duration_seconds, note, invoiced_at)
              VALUES (?, '2026-06-15T10:00:00Z', '2026-06-15T11:30:00Z', 5400, 'Triage', NULL)`)
    .run(acmeTicketId);
  //  - Resolved ticket: 0.5 hours = $50 = 5000 cents
  db.prepare(`INSERT INTO time_entries (ticket_id, started_at, stopped_at, duration_seconds, note, invoiced_at)
              VALUES (?, '2026-06-10T09:00:00Z', '2026-06-10T09:30:00Z', 1800, 'Printer setup', NULL)`)
    .run(resolvedTicketId);
  //  - Already invoiced — should NOT appear in uninvoiced list
  db.prepare(`INSERT INTO time_entries (ticket_id, started_at, stopped_at, duration_seconds, note, invoiced_at)
              VALUES (?, '2026-06-12T09:00:00Z', '2026-06-12T10:00:00Z', 3600, 'Old work', '2026-06-13T00:00:00Z')`)
    .run(acmeTicketId);
  //  - Time entry referenced in an invoice's line_items JSON (defensive check).
  //    Capture the id BEFORE inserting more rows so last_insert_rowid is reliable.
  //    Note: the JSON-ref invoice that uses this id is inserted by a dedicated
  //    test below so it doesn't pollute Alice/Bob's "last invoice" ages.
  db.prepare(`INSERT INTO time_entries (ticket_id, started_at, stopped_at, duration_seconds, note, invoiced_at)
              VALUES (?, '2026-06-14T09:00:00Z', '2026-06-14T10:00:00Z', 3600, 'Defensive JSON ref', NULL)`)
    .run(acmeTicketId);
  const defensiveEntryId = db.prepare(`SELECT id FROM time_entries WHERE note = ?`).get('Defensive JSON ref').id;

  // Stale draft invoice: 30 days old (assigned to Alice — she only has
  // paid invoices 90 days old, so this draft is her most-recent
  // invoice at any cutoff. That's intentional: it gives Alice a more
  // recent "last_invoice" stamp than her 90-day-old paid invoice, so
  // she's NOT in the default 30-day dormant list. The focused
  // dormant_customers test uses Bob + her 90d paid invoice to drive
  // the assertion.)
  draftInvoiceId = db.prepare(`INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                              subtotal_cents, tax_cents, total_cents, created_at)
                              VALUES (?, ?, 'draft', '[]', 10000, 0, 10000, datetime('now', '-30 days'))`)
    .run('INV-DRAFT-1', aliceId).lastInsertRowid;
  // Fresh draft — assigned to Incidental so it doesn't show up on
  // Alice's account. Should NOT be on the stale list with default
  // 14-day cutoff.
  db.prepare(`INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                              subtotal_cents, tax_cents, total_cents, created_at)
                              VALUES (?, ?, 'draft', '[]', 5000, 0, 5000, datetime('now', '-2 days'))`)
    .run('INV-DRAFT-2', incyId);

  // Overdue sent invoice: due 5 days ago, created_at pinned 45d ago so
  // it doesn't pretend to be Alice's "most recent" invoice either.
  sentOverdueInvoiceId = db.prepare(`INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                                  subtotal_cents, tax_cents, total_cents, due_at, created_at)
                                  VALUES (?, ?, 'sent', '[]', 10000, 0, 10000,
                                          datetime('now', '-5 days'), datetime('now', '-45 days'))`)
    .run('INV-OVER-1', aliceId).lastInsertRowid;
  // Sent invoice NOT overdue (due in future) — created 45d ago
  db.prepare(`INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                              subtotal_cents, tax_cents, total_cents, due_at, created_at)
                              VALUES (?, ?, 'sent', '[]', 10000, 0, 10000,
                                      datetime('now', '+10 days'), datetime('now', '-45 days'))`)
    .run('INV-NEW-1', aliceId);
  // For the dormant customer test:
  //  - Alice's last paid invoice is 90 days ago → her last invoice is "old"
  //  - Bob's last paid invoice is 45 days ago → also old
  db.prepare(`INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                              subtotal_cents, tax_cents, total_cents, created_at, paid_at)
                              VALUES (?, ?, 'paid', '[]', 10000, 0, 10000, datetime('now', '-90 days'), datetime('now', '-90 days'))`)
    .run('INV-PAID-OLD-1', aliceId);
  db.prepare(`INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                              subtotal_cents, tax_cents, total_cents, created_at, paid_at)
                              VALUES (?, ?, 'paid', '[]', 10000, 0, 10000, datetime('now', '-45 days'), datetime('now', '-45 days'))`)
    .run('INV-PAID-OLD-2', bobId);

  // The defensive JSON-ref invoice is added in its own dedicated test below so it
  // doesn't pollute Alice/Bob's "last invoice" ages for the dormant_customer tests.
  // We stash the id in a TEMP table so the focused test can reuse it without
  // re-deriving via `last_insert_rowid()`.
  db.prepare(`CREATE TEMP TABLE leak_seed (k TEXT PRIMARY KEY, v INTEGER)`).run();
  db.prepare(`INSERT INTO leak_seed VALUES ('defensive_entry_id', ?)`).run(defensiveEntryId);
});

afterAll(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/accounting/leakage', () => {
  it('returns the five widget buckets + generated_at + params', async () => {
    const r = await req('GET', '/api/accounting/leakage');
    expect(r.generated_at).toBeTruthy();
    expect(r.params).toMatchObject({
      stale_draft_days: 14,
      stale_invoice_days: 30,
      labour_rate_cents_per_hour: 10000,
    });
    // Buckets
    expect(r.uninvoiced_time).toBeTruthy();
    expect(r.resolved_tickets_with_uninvoiced_time).toBeTruthy();
    expect(r.stale_draft_invoices).toBeTruthy();
    expect(r.overdue_sent_invoices).toBeTruthy();
    expect(r.dormant_customers).toBeTruthy();
  });

  it('uninvoiced_time: values at the configured labour rate', async () => {
    const r = await req('GET', '/api/accounting/leakage');
    // Should include Acme triage (5400s = 1.5h × 10000c = 15000c)
    // Should include old printer setup (1800s = 5000c)
    // Should NOT include already-invoiced (invoiced_at set)
    // (Defensive JSON ref appears here because no JSON-ref invoice exists
    //  yet — it's added in the dedicated exclusion test below.)
    const notes = r.uninvoiced_time.entries.map((e) => e.note);
    expect(notes).toContain('Triage');
    expect(notes).toContain('Printer setup');
    expect(notes).not.toContain('Old work');

    const triage = r.uninvoiced_time.entries.find((e) => e.note === 'Triage');
    expect(triage.value_cents).toBe(15000);
    expect(triage.running).toBe(false);
    expect(triage.ticket_uid).toBe('G-LEAK-001');
    expect(triage.customer_name).toBe('Alice');
    expect(r.uninvoiced_time.total_cents).toBe(40000); // 15000 (Triage) + 5000 (Printer) + 10000 (Defensive JSON ref, no JSON ref invoice yet) + 10000 (Bob dial-in)

    // by_ticket groups
    expect(r.uninvoiced_time.by_ticket.length).toBeGreaterThanOrEqual(2);
    const acmeGroup = r.uninvoiced_time.by_ticket.find((g) => g.ticket_uid === 'G-LEAK-001');
    expect(acmeGroup.value_cents).toBe(25000); // Triage (15000) + Defensive JSON ref (10000)
    expect(acmeGroup.entries).toBe(2);
  });

  it('uninvoiced_time: skips entries referenced in invoice line_items JSON', async () => {
    // Defensive path: the time_entry's invoiced_at flag is unset, but a
    // non-cancelled invoice points at its id via source_time_entry_id in
    // its line_items JSON. The query must filter it out. Tested in a
    // dedicated test so we can attach the JSON ref to a fresh invoice
    // without polluting the dormant_customer assertion in beforeAll.
    const db = app.db;
    const defId = db.prepare(`SELECT v FROM leak_seed WHERE k = 'defensive_entry_id'`).get().v;
    db.prepare(`INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                subtotal_cents, tax_cents, total_cents)
                VALUES (?, ?, 'paid', ?, 10000, 0, 10000)`)
                .run('INV-JSON-REF-1', aliceId, JSON.stringify([{ description: 'Defensive ref', source_time_entry_id: defId }]));
    const r = await req('GET', '/api/accounting/leakage');
    const notes = r.uninvoiced_time.entries.map((e) => e.note);
    expect(notes).not.toContain('Defensive JSON ref');
    // Clean up so other tests aren't surprised.
    db.prepare(`DELETE FROM invoices WHERE invoice_uid = 'INV-JSON-REF-1'`).run();
  });

  it('uninvoiced_time: skips entries referenced in CANCELLED invoice line_items (cancellation invalidates the reference)', async () => {
    // Counter-test: if the only invoice that references the entry has
    // status='cancelled', the entry SHOULD reappear as uninvoiced (we
    // don't want a cancellation to mask recoverable billable time).
    const db = app.db;
    const defId = db.prepare(`SELECT v FROM leak_seed WHERE k = 'defensive_entry_id'`).get().v;
    db.prepare(`INSERT INTO invoices (invoice_uid, customer_id, status, line_items,
                subtotal_cents, tax_cents, total_cents)
                VALUES (?, ?, 'cancelled', ?, 10000, 0, 10000)`)
                .run('INV-JSON-REF-CXL', aliceId, JSON.stringify([{ description: 'Cancelled ref', source_time_entry_id: defId }]));
    const r = await req('GET', '/api/accounting/leakage');
    const notes = r.uninvoiced_time.entries.map((e) => e.note);
    expect(notes).toContain('Defensive JSON ref');
    db.prepare(`DELETE FROM invoices WHERE invoice_uid = 'INV-JSON-REF-CXL'`).run();
  });

  it('uninvoiced_time: skips running timer entries from the cents total', async () => {
    const db = app.db;
    db.prepare(`INSERT INTO tickets (ticket_uid, customer_id, subject, status)
                VALUES ('G-RUN-1', ?, 'Running timer test', 'open')`).run(aliceId);
    const tId = db.prepare(`SELECT last_insert_rowid() AS id`).get().id;
    db.prepare(`INSERT INTO time_entries (ticket_id, started_at, stopped_at, paused_at, duration_seconds, note)
                VALUES (?, '2026-06-29T10:00:00Z', NULL, NULL, 0, 'Timer still running')`)
      .run(tId);
    const r = await req('GET', '/api/accounting/leakage');
    const running = r.uninvoiced_time.entries.find((e) => e.note === 'Timer still running');
    expect(running.running).toBe(true);
    expect(running.value_cents).toBe(0);

    // Clean up so other tests aren't surprised.
    db.prepare(`DELETE FROM time_entries WHERE ticket_id = ?`).run(tId);
    db.prepare(`DELETE FROM tickets WHERE id = ?`).run(tId);
  });

  it('resolved_tickets_with_uninvoiced_time: contains only resolved tickets', async () => {
    const r = await req('GET', '/api/accounting/leakage');
    const groups = r.resolved_tickets_with_uninvoiced_time.groups;
    // Should include the printer setup ticket (resolved)
    expect(groups.find((g) => g.ticket_uid === 'G-LEAK-002')).toBeTruthy();
    // Should NOT include the open Acme ticket
    expect(groups.find((g) => g.ticket_uid === 'G-LEAK-001')).toBeFalsy();
    expect(groups.every((g) => g.ticket_status === 'resolved')).toBe(true);
    // Counts + totals
    expect(r.resolved_tickets_with_uninvoiced_time.count).toBe(groups.length);
    expect(r.resolved_tickets_with_uninvoiced_time.total_cents).toBeGreaterThanOrEqual(5000);
  });

  it('stale_draft_invoices: respects stale_draft_days', async () => {
    const defaultR = await req('GET', '/api/accounting/leakage');
    // Default 14-day cutoff: only INV-DRAFT-1 (30d old) qualifies.
    const uids = defaultR.stale_draft_invoices.invoices.map((i) => i.invoice_uid);
    expect(uids).toContain('INV-DRAFT-1');
    expect(uids).not.toContain('INV-DRAFT-2');
    expect(defaultR.stale_draft_invoices.count).toBe(uids.length);
    expect(defaultR.stale_draft_invoices.total_cents).toBe(10000);

    // With a 60-day cutoff, INV-DRAFT-1 (30d) should also disappear.
    const laxR = await req('GET', '/api/accounting/leakage?stale_draft_days=60');
    expect(laxR.stale_draft_invoices.invoices.map((i) => i.invoice_uid)).not.toContain('INV-DRAFT-1');

    // With a 1-day cutoff, both drafts should appear.
    const strictR = await req('GET', '/api/accounting/leakage?stale_draft_days=1');
    const strictUids = strictR.stale_draft_invoices.invoices.map((i) => i.invoice_uid);
    expect(strictUids).toContain('INV-DRAFT-1');
    expect(strictUids).toContain('INV-DRAFT-2');
  });

  it('overdue_sent_invoices: only past-due sent/overdue rows, with days_overdue', async () => {
    const r = await req('GET', '/api/accounting/leakage');
    const uids = r.overdue_sent_invoices.invoices.map((i) => i.invoice_uid);
    expect(uids).toContain('INV-OVER-1');
    expect(uids).not.toContain('INV-NEW-1'); // due in future
    expect(uids).not.toContain('INV-PAID-OLD-2'); // already paid

    const overdueRow = r.overdue_sent_invoices.invoices.find((i) => i.invoice_uid === 'INV-OVER-1');
    expect(overdueRow.days_overdue).toBeGreaterThanOrEqual(5);
    expect(overdueRow.total_cents).toBe(10000);
    expect(r.overdue_sent_invoices.total_cents).toBeGreaterThanOrEqual(10000);
  });

  it('dormant_customers: customers with billable activity but no recent invoice', async () => {
    const r = await req('GET', '/api/accounting/leakage');
    const customers = r.dormant_customers.customers;
    // Bob has open ticket + uninvoiced time; his last paid invoice is 45
    // days old → dormant at the default 30-day window.
    const ids = customers.map((c) => c.customer_id).sort();
    expect(ids).toContain(bobId);
    expect(ids).not.toContain(incyId); // Incidental has no billable activity

    const bob = customers.find((c) => c.customer_id === bobId);
    expect(bob.open_tickets).toBeGreaterThanOrEqual(1);
    expect(bob.uninvoiced_entries).toBeGreaterThanOrEqual(1);
    expect(bob.uninvoiced_seconds).toBeGreaterThan(0);
    expect(bob.last_invoice_at).toBeTruthy();
  });

  it('dormant_customers: respects stale_invoice_days window', async () => {
    // With a 100-day window, neither Bob (45d) nor Alice (90d via the
    // draft at -30d) should be dormant.
    const laxR = await req('GET', '/api/accounting/leakage?stale_invoice_days=100');
    const laxIds = laxR.dormant_customers.customers.map((c) => c.customer_id);
    expect(laxIds).not.toContain(aliceId);
    expect(laxIds).not.toContain(bobId);

    // With a 60-day window: Alice's last invoice (30d draft) is recent
    // → not dormant. Bob's (45d) is also recent → not dormant. Wait,
    // 30 < 60 → recent. 45 < 60 → recent. So neither.
    const midR = await req('GET', '/api/accounting/leakage?stale_invoice_days=60');
    const midIds = midR.dormant_customers.customers.map((c) => c.customer_id);
    expect(midIds).not.toContain(aliceId);
    expect(midIds).not.toContain(bobId);

    // With a 35-day window: Alice's last (30d draft) is recent → not
    // dormant. Bob's (45d) is older than 35d → dormant.
    const bobOnly = await req('GET', '/api/accounting/leakage?stale_invoice_days=35');
    const bobOnlyIds = bobOnly.dormant_customers.customers.map((c) => c.customer_id);
    expect(bobOnlyIds).not.toContain(aliceId);
    expect(bobOnlyIds).toContain(bobId);
  });

  it('stale_draft_days + stale_invoice_days: clamps bogus values to safe range', async () => {
    // 99999 → clamped to 365 (upper bound).
    // `0` for either param falls back to its default (14 / 30) because of
    // the `||`-default in the route — 0 is intentionally not a valid
    // threshold because it's never what an operator wants.
    const r = await req('GET', '/api/accounting/leakage?stale_draft_days=99999&stale_invoice_days=0');
    expect(r.params.stale_draft_days).toBe(365); // max
    expect(r.params.stale_invoice_days).toBe(30); // fell back to default via `||`
  });

  it('params report labour rate used for valuation', async () => {
    const r = await req('GET', '/api/accounting/leakage');
    expect(r.params.labour_rate_cents_per_hour).toBe(10000);
  });

  it('shape + types of every entry are sane', async () => {
    const r = await req('GET', '/api/accounting/leakage');
    expect(Array.isArray(r.uninvoiced_time.entries)).toBe(true);
    expect(Array.isArray(r.uninvoiced_time.by_ticket)).toBe(true);
    expect(Array.isArray(r.resolved_tickets_with_uninvoiced_time.groups)).toBe(true);
    expect(Array.isArray(r.stale_draft_invoices.invoices)).toBe(true);
    expect(Array.isArray(r.overdue_sent_invoices.invoices)).toBe(true);
    expect(Array.isArray(r.dormant_customers.customers)).toBe(true);

    for (const c of r.dormant_customers.customers) {
      expect(typeof c.customer_id).toBe('number');
      expect(typeof c.customer_name).toBe('string');
    }
    for (const inv of r.stale_draft_invoices.invoices) {
      expect(typeof inv.id).toBe('number');
      expect(inv.status).toBe('draft');
    }
  });
});
