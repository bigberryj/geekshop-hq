/**
 * Ticket email signature — route-level regression tests.
 *
 * Bug fixed 2026-06-29: clicking "Email customer" or "Reply & resolve"
 * on a ticket threw a 500 with `Too many parameter values were
 * provided`. Root cause: the audit_log INSERT prepared statement had
 * one placeholder but `.run()` was called with two args (target + JSON
 * payload). The crash happened AFTER `sendEmail` had already
 * delivered the message but BEFORE the route returned success, so
 * Byron saw an error in the UI for email sends that actually went out.
 *
 * Also fixed: plain `POST /api/tickets/:id/resolve` never appended
 * the configured signature to its auto-generated resolution email
 * even though `docs/api.md` claimed it did.
 *
 * These tests stub `sendEmail` to capture the payload (text + html)
 * that would have gone over the wire, so we can assert the
 * signature was appended on every reply path.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildServer } from '../index.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Stub sendEmail so we can capture what would have been delivered.
// We DO want to keep `appendSignature` + the route flow real — only
// the SMTP transport is replaced with a recorder.
let sent = [];
vi.mock('../lib/email.js', async () => {
  const real = await vi.importActual('../lib/email.js');
  return {
    ...real,
    sendEmail: async (msg) => {
      sent.push(msg);
      return { sent: true, message_id: `<test-${sent.length}@example>` };
    },
    verifySmtp: async () => true,
  };
});

// Note: vi.mock is hoisted, so the stub is in place before buildServer
// imports the module.

let app;
let baseURL;
let tmpDir;
let openTicketId;
let resolveWithReplyTicketId;
let plainResolveTicketId;
const SIGNATURE = 'Byron Berry\nGeekShop Computers\n250-555-0100\nbyron@geekshop.ca';

async function req(method, url, body) {
  const r = await fetch(baseURL + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: r.status, data };
}

async function postJson(url, body) {
  return (await req('POST', url, body));
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-ticketsig-'));
  app = await buildServer({
    logger: false,
    dbPath: join(tmpDir, 'test.db'),
    skipPoller: true,
    skipSmtp: true,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseURL = `http://127.0.0.1:${app.server.address().port}`;

  const db = app.db;
  db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature', ?)`).run(SIGNATURE);
  const c = db
    .prepare(`INSERT INTO customers (name, email) VALUES (?, ?)`)
    .run('Sig Test Co', 'sig@test.ca').lastInsertRowid;
  const ins = db.prepare(
    `INSERT INTO tickets (ticket_uid, customer_id, subject, status, last_message_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  );
  openTicketId = ins.run(`G-SIG-OPEN-${Date.now()}`, c, 'Email-customer click', 'open').lastInsertRowid;
  resolveWithReplyTicketId = ins.run(`G-SIG-RWR-${Date.now()}`, c, 'Reply & resolve click', 'open').lastInsertRowid;
  plainResolveTicketId = ins.run(`G-SIG-RES-${Date.now()}`, c, 'Plain resolve click', 'open').lastInsertRowid;
});

afterAll(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /api/tickets/:id/email-reply (Email customer)', () => {
  it('appends the configured signature and returns 200 (regression: 500 Too many parameter values)', async () => {
    sent = [];
    const reply = 'Hi Linda, just confirming the laptop specs are in stock.';
    const r = await postJson(`/api/tickets/${openTicketId}/email-reply`, { body: reply });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(r.data.sent).toBe(true);

    // The captured payload must include the signature in both text and html.
    expect(sent).toHaveLength(1);
    const msg = sent[0];
    expect(msg.text).toContain('--');
    expect(msg.text).toContain('Byron Berry');
    expect(msg.text).toContain('GeekShop Computers');
    expect(msg.html).toContain('Byron Berry');
    expect(msg.html).toContain('GeekShop Computers');
    // The original reply body should still be present above the signature.
    expect(msg.text).toContain(reply);
    // HTML must be safe — signature escaped, no script tags.
    expect(msg.html).not.toContain('<script>');
  });

  it('writes the audit_log row with target + payload (regression: audit 500 crash)', async () => {
    const before = app.db.prepare(
      "SELECT COUNT(*) as n FROM audit_log WHERE action = 'ticket.email_reply' AND target = ?"
    ).get(String(openTicketId)).n;
    sent = [];
    const r = await postJson(`/api/tickets/${openTicketId}/email-reply`, { body: 'second outgoing reply' });
    expect(r.status).toBe(200);
    const after = app.db.prepare(
      "SELECT COUNT(*) as n, MAX(payload) as p FROM audit_log WHERE action = 'ticket.email_reply' AND target = ?"
    ).get(String(openTicketId));
    expect(after.n).toBe(before + 1);
    expect(after.p).toBeTruthy();
    const parsed = JSON.parse(after.p);
    expect(parsed.sent).toBe(true);
    expect(parsed.sent_to).toBe('sig@test.ca');
    expect(parsed.had_signature).toBe(true);
  });

  it('does not double-append when the body already ends with the signature block', async () => {
    sent = [];
    const pre = `Hi Linda\n\n--\n${SIGNATURE}`;
    const r = await postJson(`/api/tickets/${openTicketId}/email-reply`, { body: pre });
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    const occurrences = sent[0].text.split(SIGNATURE).length - 1;
    expect(occurrences).toBe(1); // exactly once, not twice
  });

  it('sends the message even when no signature is configured', async () => {
    // Flip the signature off for this scenario
    app.db.prepare("DELETE FROM settings WHERE key = 'email_signature'").run();
    sent = [];
    const reply = 'Hi Linda, plain reply without signature.';
    const r = await postJson(`/api/tickets/${openTicketId}/email-reply`, { body: reply });
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(reply);
    expect(sent[0].html).toBeNull();
    // restore for the rest of the suite
    app.db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature', ?)`).run(SIGNATURE);
  });
});

describe('POST /api/tickets/:id/resolve-with-reply (Reply & resolve)', () => {
  it('appends the signature and returns 200 (regression: 500 Too many parameter values)', async () => {
    sent = [];
    const reply = 'All set on your end. Closing the ticket.';
    const r = await postJson(`/api/tickets/${resolveWithReplyTicketId}/resolve-with-reply`, { reply_body: reply });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(sent).toHaveLength(1);
    const msg = sent[0];
    expect(msg.text).toContain(reply);
    expect(msg.text).toContain('Byron Berry');
    expect(msg.text).toContain('GeekShop Computers');
    expect(msg.html).toContain('Byron Berry');
  });

  it('marks the ticket resolved and writes the audit row', async () => {
    sent = [];
    const r = await postJson(`/api/tickets/${resolveWithReplyTicketId}/resolve-with-reply`, { reply_body: 'already done' });
    expect(r.status).toBe(200);
    const row = app.db.prepare("SELECT status FROM tickets WHERE id = ?").get(resolveWithReplyTicketId);
    expect(row.status).toBe('resolved');
    const audit = app.db.prepare(
      "SELECT payload FROM audit_log WHERE action = 'ticket.resolve_with_reply' AND target = ? ORDER BY id DESC LIMIT 1"
    ).get(String(resolveWithReplyTicketId));
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit.payload).had_signature).toBe(true);
  });
});

describe('POST /api/tickets/:id/resolve (plain Mark resolved)', () => {
  it('appends the signature to the auto-resolution email (doc/code drift fix)', async () => {
    sent = [];
    const r = await postJson(`/api/tickets/${plainResolveTicketId}/resolve`, {});
    expect(r.status).toBe(200);
    // The email should have gone out (customer has an email), with the signature appended.
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const msg = sent[0];
    expect(msg.text).toContain('Just confirming we\'ve wrapped up your request');
    expect(msg.text).toContain('Byron Berry');
    expect(msg.text).toContain('GeekShop Computers');
    expect(msg.html).toContain('Byron Berry');
  });

  it('still resolves the ticket and writes the basic ticket.resolve audit row', async () => {
    const r = await postJson(`/api/tickets/${plainResolveTicketId}/resolve`, {});
    expect(r.status).toBe(200);
    // Already resolved by the previous test, but the route should still 200.
    expect(r.data.ok).toBe(true);
    const audit = app.db.prepare(
      "SELECT payload FROM audit_log WHERE action = 'ticket.resolve' AND target = ? ORDER BY id DESC LIMIT 1"
    ).get(String(plainResolveTicketId));
    expect(audit).toBeTruthy();
  });
});

describe('audit_log helper resilience', () => {
  it('logs warnings but does not throw when audit write fails', async () => {
    // Sanity check that lib/audit.js swallows errors — important so a
    // future schema bug does not break customer-facing routes.
    const { logAudit } = await import('../lib/audit.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badDb = {
      prepare: () => ({ run: () => { throw new Error('boom'); } }),
    };
    expect(() => logAudit(badDb, 'test.action', 1, { foo: 'bar' })).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('Rich (HTML) signature mode (T-F2D7BD requeue)', () => {
  // These tests verify the end-to-end HTML signature path:
  // Settings → email_signature_format = 'html' + email_signature_html
  // is configured → ticket reply routes append the SANITIZED rich
  // signature to the outgoing email. They run after the plain-mode
  // tests so the SIGNATURE constant in the parent beforeAll may be
  // overwritten.

  const HTML_SIG = '<b>Byron Berry</b><br><a href="https://geekshop.ca">GeekShop Computers</a>';

  let htmlTicketId;

  beforeAll(async () => {
    // Switch settings to rich mode and clear the plain signature so the
    // tests below are deterministic.
    app.db.prepare("DELETE FROM settings WHERE key IN ('email_signature', 'email_signature_html', 'email_signature_format')").run();
    app.db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    app.db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run(HTML_SIG);

    const db = app.db;
    const c = db.prepare(`SELECT id FROM customers WHERE email = 'sig@test.ca'`).get().id;
    htmlTicketId = db.prepare(
      `INSERT INTO tickets (ticket_uid, customer_id, subject, status, last_message_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(`G-SIG-HTML-${Date.now()}`, c, 'HTML signature test', 'open').lastInsertRowid;
  });

  it('email-reply appends the rich signature to text + html, with sanitizer applied', async () => {
    sent = [];
    const r = await postJson(`/api/tickets/${htmlTicketId}/email-reply`, { body: 'Hi Linda, confirm tomorrow' });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(sent).toHaveLength(1);
    const msg = sent[0];
    // Text side: the derived text form of the rich signature is in the tail
    expect(msg.text).toContain('Hi Linda, confirm tomorrow');
    expect(msg.text).toContain('--');
    expect(msg.text).toContain('Byron Berry');
    expect(msg.text).toContain('GeekShop Computers');
    // HTML side: the bold + link survive the sanitizer
    expect(msg.html).toContain('<b>Byron Berry</b>');
    expect(msg.html).toContain('href="https://geekshop.ca"');
    // Customer body is still escaped (no admin signature in the customer part)
    expect(msg.html).not.toContain('Hi Linda, confirm tomorrow<b>Byron Berry</b>');
    // The customer's plain body is wrapped in a <div style="white-space:pre-wrap">
    expect(msg.html).toContain('<div style="white-space:pre-wrap">Hi Linda, confirm tomorrow</div>');
    // The signature HTML is wrapped in a <div style="margin-top:1em..."> with a top border
    expect(msg.html).toMatch(/<div style="margin-top:1em[^"]*border-top:1px solid #e5e7eb[^"]*">/);
  });

  it('email-reply: <script> in the configured signature is scrubbed end-to-end', async () => {
    // Replace the configured signature with a malicious one and re-send
    app.db.prepare("UPDATE settings SET value = ? WHERE key = 'email_signature_html'").run('<b>Byron</b><script>alert(1)</script>');
    sent = [];
    const r = await postJson(`/api/tickets/${htmlTicketId}/email-reply`, { body: 'test' });
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].html).not.toContain('<script');
    expect(sent[0].html).not.toContain('alert(1)');
    expect(sent[0].html).toContain('<b>Byron</b>');
    // Restore
    app.db.prepare("UPDATE settings SET value = ? WHERE key = 'email_signature_html'").run(HTML_SIG);
  });

  it('email-reply: javascript: URL in the configured signature is stripped end-to-end', async () => {
    app.db.prepare("UPDATE settings SET value = ? WHERE key = 'email_signature_html'").run('<a href="javascript:alert(1)">click</a>');
    sent = [];
    const r = await postJson(`/api/tickets/${htmlTicketId}/email-reply`, { body: 'test' });
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].html).not.toContain('javascript:');
    // Restore
    app.db.prepare("UPDATE settings SET value = ? WHERE key = 'email_signature_html'").run(HTML_SIG);
  });

  it('email-reply: writes audit row with had_signature:true in rich mode', async () => {
    sent = [];
    const r = await postJson(`/api/tickets/${htmlTicketId}/email-reply`, { body: 'audit check' });
    expect(r.status).toBe(200);
    const audit = app.db.prepare(
      "SELECT payload FROM audit_log WHERE action = 'ticket.email_reply' AND target = ? ORDER BY id DESC LIMIT 1"
    ).get(String(htmlTicketId));
    expect(audit).toBeTruthy();
    const parsed = JSON.parse(audit.payload);
    expect(parsed.sent).toBe(true);
    expect(parsed.sent_to).toBe('sig@test.ca');
    expect(parsed.had_signature).toBe(true);
  });

  it('email-reply: dedupe works when body already ends with the "--\\n<raw HTML>" form', async () => {
    sent = [];
    const pre = `Hi Linda\n\n--\n${HTML_SIG}`;
    const r = await postJson(`/api/tickets/${htmlTicketId}/email-reply`, { body: pre });
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    // Dedupe is fired → html is null (we don't re-render the signature)
    expect(sent[0].html).toBeNull();
    // The text body equals the input verbatim — the signature was NOT re-appended
    expect(sent[0].text).toBe(pre);
  });

  it('resolve-with-reply appends the rich signature end-to-end', async () => {
    sent = [];
    // Fresh ticket so we don't fail the "already resolved" path
    const db = app.db;
    const c = db.prepare(`SELECT id FROM customers WHERE email = 'sig@test.ca'`).get().id;
    const tid = db.prepare(
      `INSERT INTO tickets (ticket_uid, customer_id, subject, status, last_message_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(`G-SIG-HTML-RWR-${Date.now()}`, c, 'RWR HTML', 'open').lastInsertRowid;
    const r = await postJson(`/api/tickets/${tid}/resolve-with-reply`, { reply_body: 'All set, closing.' });
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(sent).toHaveLength(1);
    const msg = sent[0];
    expect(msg.text).toContain('All set, closing.');
    expect(msg.text).toContain('Byron Berry');
    expect(msg.html).toContain('<b>Byron Berry</b>');
    expect(msg.html).toContain('href="https://geekshop.ca"');
    // Ticket is now resolved
    const row = db.prepare('SELECT status FROM tickets WHERE id = ?').get(tid);
    expect(row.status).toBe('resolved');
  });

  it('plain resolve appends the rich signature to the auto-resolution email', async () => {
    sent = [];
    const db = app.db;
    const c = db.prepare(`SELECT id FROM customers WHERE email = 'sig@test.ca'`).get().id;
    const tid = db.prepare(
      `INSERT INTO tickets (ticket_uid, customer_id, subject, status, last_message_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(`G-SIG-HTML-RES-${Date.now()}`, c, 'plain resolve HTML', 'open').lastInsertRowid;
    const r = await postJson(`/api/tickets/${tid}/resolve`, {});
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    const msg = sent[0];
    expect(msg.text).toContain('Just confirming we\'ve wrapped up your request');
    expect(msg.text).toContain('Byron Berry');
    expect(msg.html).toContain('<b>Byron Berry</b>');
  });

  it('falls back to no-signature behavior when email_signature_html is empty even with format=html', async () => {
    sent = [];
    app.db.prepare("UPDATE settings SET value = '' WHERE key = 'email_signature_html'").run();
    const db = app.db;
    const c = db.prepare(`SELECT id FROM customers WHERE email = 'sig@test.ca'`).get().id;
    const tid = db.prepare(
      `INSERT INTO tickets (ticket_uid, customer_id, subject, status, last_message_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(`G-SIG-HTML-EMPTY-${Date.now()}`, c, 'empty html sig', 'open').lastInsertRowid;
    const r = await postJson(`/api/tickets/${tid}/email-reply`, { body: 'no sig here' });
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe('no sig here');
    expect(sent[0].html).toBeNull();
    // Restore
    app.db.prepare("UPDATE settings SET value = ? WHERE key = 'email_signature_html'").run(HTML_SIG);
  });
});
