/**
 * Outbound email signature
 * ------------------------
 * Unit tests for the plain-text signature module:
 *   - empty signature returns null
 *   - signature with text returns escaped HTML + plain text
 *   - appendSignature returns {text, html} suitable for sendEmail
 *   - appendSignature with empty signature is a no-op
 *   - newlines in the signature are preserved (white-space:pre-wrap)
 *   - HTML in the signature is escaped (no injection)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { getEmailSignature, appendSignature } from '../lib/signature.js';

let db;

beforeAll(async () => {
  db = await runMigrations(':memory:');
});

describe('getEmailSignature', () => {
  it('returns null when no signature is set', () => {
    const sig = getEmailSignature(db);
    expect(sig).toBeNull();
  });

  it('returns null when signature is whitespace-only', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('email_signature', '   \n  ')").run();
    expect(getEmailSignature(db)).toBeNull();
    db.prepare("DELETE FROM settings WHERE key = 'email_signature'").run();
  });

  it('returns the trimmed signature with both text and html forms', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('email_signature', 'Byron Berry\nGeekShop Computers')").run();
    const sig = getEmailSignature(db);
    expect(sig).not.toBeNull();
    expect(sig.raw).toBe('Byron Berry\nGeekShop Computers');
    expect(sig.text).toBe('Byron Berry\nGeekShop Computers');
    expect(sig.html).toContain('Byron Berry');
    expect(sig.html).toContain('GeekShop Computers');
    expect(sig.html).toContain('white-space:pre-wrap');
    // Newlines should NOT be literal "\n" in the HTML — they should
    // survive via white-space:pre-wrap. Verify by absence of <br> tags
    // (we use the CSS approach instead).
    expect(sig.html).not.toContain('<br>');
  });

  it('escapes HTML special characters in the signature', () => {
    db.prepare("DELETE FROM settings WHERE key = 'email_signature'").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('email_signature', '<script>alert(1)</script> & \"quotes\"')").run();
    const sig = getEmailSignature(db);
    expect(sig.html).toContain('&lt;script&gt;');
    expect(sig.html).toContain('&amp;');
    expect(sig.html).toContain('&quot;');
    expect(sig.html).not.toContain('<script>');
  });
});

describe('appendSignature', () => {
  it('returns the body unchanged when no signature is set', () => {
    db.prepare("DELETE FROM settings WHERE key = 'email_signature'").run();
    const result = appendSignature(db, 'Hello there');
    expect(result.text).toBe('Hello there');
    expect(result.html).toBeNull();
  });

  it('appends a "--" separator and the signature in plain text mode', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('email_signature', 'Byron')").run();
    const result = appendSignature(db, 'Hi Linda');
    expect(result.text).toBe('Hi Linda\n\n--\nByron');
    expect(result.html).toContain('Hi Linda');
    expect(result.html).toContain('Byron');
  });

  it('trims trailing whitespace from the body before appending', () => {
    db.prepare("DELETE FROM settings WHERE key = 'email_signature'").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('email_signature', 'Byron')").run();
    const result = appendSignature(db, 'Hi Linda   \n\n  ');
    expect(result.text).toBe('Hi Linda\n\n--\nByron');
  });

  it('handles a null/empty body', () => {
    db.prepare("DELETE FROM settings WHERE key = 'email_signature'").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('email_signature', 'Byron')").run();
    const result = appendSignature(db, null);
    expect(result.text).toBe('\n\n--\nByron');
  });
});
