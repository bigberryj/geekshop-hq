/**
 * Regression test for GET /api/inbox/pending/:id/preview
 *
 * Three failure modes have hit this endpoint:
 *   1. Whitespace-only `body` on the row. The old check `if (!row.body
 *      && !row.snippet)` skipped the refetch because `body = " "` is
 *      truthy.
 *   2. The endpoint never persisted `body_html` on the row, so every
 *      preview re-pulled from Gmail.
 *   3. `null` body from the row that the modal's EmailBody then rendered
 *      as a blank iframe, which the user perceived as "not found".
 *
 * The fix: refetch when `body_html` is null/empty AND we have a
 * message_id; persist body_html on success; sanitize cid: links; and
 * return a wrapped <pre> fallback when only plain text is available.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildServer } from '../index.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

let app;
let baseURL;
let tmpDir;
let fixtureRowId;

async function req(method, url) {
  const r = await fetch(baseURL + url, { method });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}: ${text}`);
    err.response = { status: r.status, data };
    throw err;
  }
  return data;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ghq-preview-'));
  app = await buildServer({ logger: false, dbPath: join(tmpDir, 'test.db'), skipPoller: true, skipSmtp: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseURL = `http://127.0.0.1:${app.server.address().port}`;

  // Insert a row that mimics the real failure: has a message_id, but its
  // body is whitespace and snippet is also empty.
  const result = app.db.prepare(`
    INSERT INTO pending_emails (message_id, from_name, from_email, subject, body, snippet, received_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    'preview-test@fake',
    'Alice',
    'alice@x.com',
    'Subject with image',
    '   ',  // whitespace only
    '',     // empty snippet
    '2026-06-15T12:00:00Z'
  );
  fixtureRowId = result.lastInsertRowid;

  // Mock fetchByMessageId so the test never hits Gmail. We just need
  // the row to come back with some html and a text body so the route
  // can persist and sanitize.
  const { fetchByMessageId } = await import('../lib/email-inbox.js');
  vi.spyOn(await import('../lib/email-inbox.js'), 'fetchByMessageId').mockImplementation(async (messageId) => {
    if (messageId !== 'preview-test@fake') return null;
    return {
      messageId,
      from: 'Alice',
      fromEmail: 'alice@x.com',
      subject: 'Subject with image',
      body: 'Body text fallback for the row',
      html: '<p>Hello <img src="cid:logo@x" alt="logo" /></p>',
      attachments: [],
      date: new Date('2026-06-15T12:00:00Z'),
      flagged: false,
      snippet: 'snippet',
    };
  });
});

afterAll(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/inbox/pending/:id/preview', () => {
  it('refetches from Gmail when body is whitespace-only and persists body_html', async () => {
    const before = app.db.prepare('SELECT body, body_html FROM pending_emails WHERE id = ?').get(fixtureRowId);
    expect(before.body_html).toBeNull();

    const preview = await req('GET', `/api/inbox/pending/${fixtureRowId}/preview`);
    expect(preview.id).toBe(fixtureRowId);
    expect(preview.from_email).toBe('alice@x.com');
    expect(preview.body_text).toContain('Body text fallback');
    // The cid: link should have been rewritten to our /raw endpoint
    // (or stripped to a safe placeholder if no matching attachment).
    expect(preview.body_html).toMatch(/Hello/);
    expect(preview.body_html).not.toMatch(/<script/i);

    // And the body_html should be persisted on the row for next time.
    const after = app.db.prepare('SELECT body, body_html, body_fetched_at FROM pending_emails WHERE id = ?').get(fixtureRowId);
    expect(after.body_html).toBeTruthy();
    expect(after.body_fetched_at).toBeTruthy();
  });

  it('does not refetch when body_html is already populated', async () => {
    // Second call should hit the cached body_html without a new fetch.
    const beforeFetchedAt = app.db.prepare('SELECT body_fetched_at FROM pending_emails WHERE id = ?').get(fixtureRowId).body_fetched_at;
    const preview = await req('GET', `/api/inbox/pending/${fixtureRowId}/preview`);
    expect(preview.body_html).toBeTruthy();
    const afterFetchedAt = app.db.prepare('SELECT body_fetched_at FROM pending_emails WHERE id = ?').get(fixtureRowId).body_fetched_at;
    expect(afterFetchedAt).toBe(beforeFetchedAt);
  });

  it('returns 404 for unknown ids and 400 for non-numeric ones', async () => {
    let threw = false;
    try { await req('GET', '/api/inbox/pending/999999/preview'); } catch (e) { threw = true; expect(e.response.status).toBe(404); }
    expect(threw).toBe(true);
    threw = false;
    try { await req('GET', '/api/inbox/pending/abc/preview'); } catch (e) { threw = true; expect(e.response.status).toBe(400); }
    expect(threw).toBe(true);
  });
});
