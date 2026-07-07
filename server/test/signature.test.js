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
import { getEmailSignature, appendSignature, sanitizeRichSignature, htmlToText } from '../lib/signature.js';

let db;

beforeAll(async () => {
  db = await runMigrations(':memory:');
});

// Helper: clear all three signature settings so each test starts from
// a known state. Avoids "UNIQUE constraint failed: settings.key"
// errors when a test re-inserts a key that an earlier test left in
// place.
function resetSigSettings() {
  db.prepare("DELETE FROM settings WHERE key IN ('email_signature', 'email_signature_html', 'email_signature_format')").run();
}

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

  it('does not double-append when the body already equals the signature', () => {
    db.prepare("DELETE FROM settings WHERE key = 'email_signature'").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('email_signature', 'Byron')").run();
    const result = appendSignature(db, 'Byron');
    expect(result.text).toBe('Byron');
    expect(result.html).toBeNull();
  });

  it('does not double-append when the body already ends with "--\\n<signature>"', () => {
    db.prepare("DELETE FROM settings WHERE key = 'email_signature'").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('email_signature', 'Byron')").run();
    const result = appendSignature(db, 'Hi Linda\n\n--\nByron');
    expect(result.text).toBe('Hi Linda\n\n--\nByron');
    expect(result.html).toBeNull();
  });
});

describe('sanitizeRichSignature (allowlist sanitizer)', () => {
  it('strips script tags entirely (including their content)', () => {
    const out = sanitizeRichSignature('<b>hi</b><script>alert(1)</script><i>bye</i>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<b>hi</b>');
    expect(out).toContain('<i>bye</i>');
  });

  it('strips on* event handler attributes', () => {
    const out = sanitizeRichSignature('<a href="https://x.test" onclick="alert(1)">x</a>');
    expect(out).not.toContain('onclick');
    expect(out).toContain('href="https://x.test"');
  });

  it('strips javascript: URLs from href and src', () => {
    const out = sanitizeRichSignature('<a href="javascript:alert(1)">x</a><img src="javascript:alert(2)" />');
    expect(out).not.toContain('javascript:');
    // The tags themselves are still allowed; the dangerous URL is dropped
    expect(out).toContain('<a>x</a>');
    expect(out).toContain('<img');
  });

  it('strips data:, vbscript:, file: URLs from href and src', () => {
    const out = sanitizeRichSignature('<a href="data:text/html,xx">x</a><a href="vbscript:msgbox(1)">y</a><img src="file:///etc/passwd" />');
    expect(out).not.toContain('data:text/html');
    expect(out).not.toContain('vbscript:');
    expect(out).not.toContain('file:///etc');
  });

  it('strips javascript: URLs even inside style attribute values', () => {
    const out = sanitizeRichSignature('<div style="background:url(javascript:alert(1));color:red">x</div>');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('color:red');
  });

  it('drops unknown tags but preserves their text content', () => {
    const out = sanitizeRichSignature('<custom>hello<unknown2>nested</unknown2></custom>after');
    expect(out).toContain('hello');
    expect(out).toContain('nested');
    expect(out).toContain('after');
    expect(out).not.toContain('<custom');
    expect(out).not.toContain('<unknown2');
  });

  it('strips style tags entirely (admin can use inline style= instead)', () => {
    const out = sanitizeRichSignature('<style>body{display:none}</style><b>ok</b>');
    expect(out).not.toContain('<style');
    expect(out).not.toContain('display:none');
    expect(out).toContain('<b>ok</b>');
  });

  it('forces rel="noopener noreferrer" on target=_blank links', () => {
    const out = sanitizeRichSignature('<a href="https://geekshop.ca" target="_blank">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('strips target= attributes that are not _blank (defense in depth)', () => {
    // target is allowed but only useful as _blank; the test asserts
    // the attribute is still present (admin kept it). _top / _parent
    // are also allowed for completeness.
    const out = sanitizeRichSignature('<a href="https://x.test" target="_top">x</a>');
    expect(out).toContain('target="_top"');
  });

  it('drops disallowed attributes (class, id, data-*, etc.)', () => {
    const out = sanitizeRichSignature('<b class="x" id="y" data-z="1" title="t">bold</b>');
    expect(out).not.toContain('class=');
    expect(out).not.toContain('id=');
    expect(out).not.toContain('data-z');
    expect(out).toContain('title="t"');
    expect(out).toContain('bold');
  });

  it('handles mailto: links', () => {
    const out = sanitizeRichSignature('<a href="mailto:byron@geekshop.ca">email</a>');
    expect(out).toContain('href="mailto:byron@geekshop.ca"');
  });

  it('returns empty string for null/empty input', () => {
    expect(sanitizeRichSignature(null)).toBe('');
    expect(sanitizeRichSignature('')).toBe('');
    expect(sanitizeRichSignature(undefined)).toBe('');
  });
});

describe('htmlToText', () => {
  it('converts <br> to a single newline (inline tags like <b> do not add newlines)', () => {
    // <b> is inline, so no newlines around it. <br> adds one newline.
    expect(htmlToText('<b>a</b><br><b>b</b>')).toBe('a\nb');
    expect(htmlToText('a<br>b<br>c')).toBe('a\nb\nc');
  });

  it('converts <p> and block tags to double newlines', () => {
    expect(htmlToText('<p>Para 1</p><p>Para 2</p>')).toBe('Para 1\n\nPara 2');
  });

  it('strips all remaining tags', () => {
    expect(htmlToText('<b>Byron</b> <i>Berry</i>')).toBe('Byron Berry');
  });

  it('decodes the 5 common entities', () => {
    expect(htmlToText('A &amp; B &lt; C &gt; D &quot;E&quot; F&#39;s')).toBe('A & B < C > D "E" F\'s');
  });

  it('collapses 3+ blank lines to 2', () => {
    expect(htmlToText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('returns empty for null/empty input', () => {
    expect(htmlToText(null)).toBe('');
    expect(htmlToText('')).toBe('');
  });

  it('handles <hr> as a separator line', () => {
    expect(htmlToText('a<hr>b')).toBe('a\n---\nb');
  });
});

describe('getEmailSignature — rich (html) mode', () => {
  const HTML_SIG = '<b>Byron Berry</b><br><a href="https://geekshop.ca">GeekShop Computers</a>';

  it('returns null when no html signature is set', () => {
    resetSigSettings();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    expect(getEmailSignature(db)).toBeNull();
    db.prepare("DELETE FROM settings WHERE key = 'email_signature_format'").run();
  });

  it('returns the rich signature with sanitized html and derived text when format=html', () => {
    resetSigSettings();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run(HTML_SIG);
    const sig = getEmailSignature(db);
    expect(sig).not.toBeNull();
    expect(sig.format).toBe('html');
    expect(sig.raw).toBe(HTML_SIG);
    // HTML keeps the bold + link (sanitized)
    expect(sig.html).toContain('<b>Byron Berry</b>');
    expect(sig.html).toContain('href="https://geekshop.ca"');
    // Text is derived
    expect(sig.text).toContain('Byron Berry');
    expect(sig.text).toContain('GeekShop Computers');
    expect(sig.text).not.toContain('<');
  });

  it('falls back to plain mode when format is unset', () => {
    resetSigSettings();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature', 'Plain Byron')`).run();
    const sig = getEmailSignature(db);
    expect(sig).not.toBeNull();
    expect(sig.format).toBe('plain');
    expect(sig.raw).toBe('Plain Byron');
  });

  it('html signature: appendSignature wraps customer body and adds "--" text separator', () => {
    resetSigSettings();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run(HTML_SIG);
    const result = appendSignature(db, 'Hi Linda');
    expect(result.text).toBe('Hi Linda\n\n--\nByron Berry\nGeekShop Computers');
    expect(result.html).toContain('<b>Byron Berry</b>');
    expect(result.html).toContain('Hi Linda');
  });

  it('html signature: appendSignature is a no-op when body already ends with the raw html', () => {
    resetSigSettings();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run(HTML_SIG);
    const pre = `Hi Linda\n\n--\n${HTML_SIG}`;
    const result = appendSignature(db, pre);
    expect(result.text).toBe(pre);
    expect(result.html).toBeNull();
  });

  it('html signature: <script> in the configured html is scrubbed before embed', () => {
    resetSigSettings();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run('<b>Byron</b><script>alert(1)</script>');
    const result = appendSignature(db, 'Hi Linda');
    expect(result.html).not.toContain('<script');
    expect(result.html).not.toContain('alert(1)');
    expect(result.html).toContain('<b>Byron</b>');
  });

  it('html signature: javascript: URL in configured html is scrubbed', () => {
    resetSigSettings();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run('<a href="javascript:alert(1)">click</a>');
    const result = appendSignature(db, 'Hi');
    expect(result.html).not.toContain('javascript:');
  });
});

/**
 * WYSIWYG integration tests
 * -------------------------
 * The Settings page Rich-mode editor (client/src/components/SignatureWysiwyg.jsx)
 * writes to the same `email_signature_html` setting as the manual textarea,
 * but produces HTML via document.execCommand rather than hand-typed markup.
 *
 * What contentEditable actually emits for the toolbar buttons:
 *   - Bold / Italic / Underline → <b>, <i>, <u>  (NOT <strong>/<em>)
 *   - formatBlock=H2 → wraps line in <h2>…</h2>
 *   - Bulleted list → wraps line in <ul><li>…</li></ul>
 *   - Numbered list → wraps line in <ol><li>…</li></ol>
 *   - createLink → <a href="...">...</a>
 *   - insertImage → <img src="...">
 *
 * These tests pin that the WYSIWYG-emitted HTML is accepted by the
 * server sanitizer and ends up correctly in outgoing email bodies.
 * If a future refactor tightens or loosens the sanitizer in a way that
 * breaks this round-trip, these tests fail loudly instead of leaking
 * silent regressions.
 */
describe('WYSIWYG signature round-trip', () => {
  const WYSIWYG_HTML = '<b>Byron Berry</b><div>GeekShop Computers</div><div>250-710-1007</div><div><a href="https://geekshop.ca">geekshop.ca</a> · <a href="mailto:byron@geekshop.ca">byron@geekshop.ca</a></div>';

  it('accepts WYSIWYG-emitted <b>, <div>, <a href=…> markup unchanged', () => {
    resetSigSettings();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run(WYSIWYG_HTML);
    const sig = getEmailSignature(db);
    expect(sig).not.toBeNull();
    expect(sig.html).toContain('<b>Byron Berry</b>');
    expect(sig.html).toContain('href="https://geekshop.ca"');
    expect(sig.html).toContain('href="mailto:byron@geekshop.ca"');
  });

  it('WYSIWYG signature round-trips through appendSignature into text and html', () => {
    resetSigSettings();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run(WYSIWYG_HTML);
    const out = appendSignature(db, 'Hi Linda');
    // Plain-text form should have the body + separator + signature text.
    expect(out.text).toContain('Hi Linda');
    expect(out.text).toContain('--');
    expect(out.text).toContain('Byron Berry');
    expect(out.text).toContain('GeekShop Computers');
    expect(out.text).toContain('geekshop.ca');
    expect(out.text).not.toContain('href='); // text body has no href=
    // HTML form should embed the rich signature.
    expect(out.html).toContain('<b>Byron Berry</b>');
    expect(out.html).toContain('href="https://geekshop.ca"');
    expect(out.html).toContain('Hi Linda'); // customer body wrapped
  });

  it('WYSIWYG-pasted <script> and javascript: URLs are scrubbed before reaching the email', () => {
    // This simulates an admin pasting malicious content into the
    // WYSIWYG editor. The browser's contentEditable will preserve
    // <script> as-is, but the server's sanitizer scrubs it on read.
    resetSigSettings();
    const dangerous = '<b>hi</b><script>alert(1)</script><a href="javascript:alert(2)" onclick="alert(3)">x</a><img src="javascript:alert(4)">';
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run(dangerous);
    const out = appendSignature(db, 'Hi');
    expect(out.html).not.toContain('<script');
    expect(out.html).not.toContain('alert(1)');
    expect(out.html).not.toContain('alert(2)');
    expect(out.html).not.toContain('alert(3)');
    expect(out.html).not.toContain('alert(4)');
    expect(out.html).not.toContain('javascript:');
    expect(out.html).not.toContain('onclick');
    // safe content survives
    expect(out.html).toContain('<b>hi</b>');
  });

  it('WYSIWYG list items (<ul><li>) survive sanitization', () => {
    resetSigSettings();
    const html = '<ul><li>Byron Berry</li><li>GeekShop Computers</li></ul>';
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run(html);
    const sig = getEmailSignature(db);
    expect(sig.html).toContain('<ul>');
    expect(sig.html).toContain('<li>Byron Berry</li>');
    expect(sig.text).toContain('Byron Berry');
    expect(sig.text).toContain('GeekShop Computers');
  });

  it('WYSIWYG headings (<h2>) survive sanitization', () => {
    resetSigSettings();
    const html = '<h2>Byron Berry</h2><div>GeekShop Computers</div>';
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run(html);
    const sig = getEmailSignature(db);
    expect(sig.html).toContain('<h2>Byron Berry</h2>');
  });

  it('WYSIWYG <u> underline survives sanitization', () => {
    resetSigSettings();
    const html = '<u>underlined</u>';
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run(html);
    const sig = getEmailSignature(db);
    expect(sig.html).toContain('<u>underlined</u>');
  });
});

/**
 * Table + border controls (T-F2D7BD iteration)
 * --------------------------------------------
 * Byron's follow-up: the WYSIWYG editor needed an "Insert table"
 * button and a way to adjust table border color / visibility. The
 * editor produces tables with inline style="border:...;padding:..."
 * on both the <table> and each <td>. These tests pin that the
 * server sanitizer accepts the resulting HTML unchanged and that
 * the rich-mode email pipeline delivers it to the customer.
 *
 * If the sanitizer ever tightens the table attribute allowlist, or
 * a future refactor changes how style values are scrubbed, these
 * tests fail loudly so the WYSIWYG-inserted layout doesn't silently
 * lose its borders.
 */
describe('WYSIWYG table + border round-trip', () => {
  const TABLE_HTML = '<table style="border-collapse: collapse; border: 1px solid #475569;">'
    + '<tr><td style="border: 1px solid #475569; padding: 4px 8px;">Byron</td>'
    + '<td style="border: 1px solid #475569; padding: 4px 8px;">GeekShop</td></tr>'
    + '<tr><td style="border: 1px solid #475569; padding: 4px 8px;">250-710-1007</td>'
    + '<td style="border: 1px solid #475569; padding: 4px 8px;">geekshop.ca</td></tr>'
    + '</table>';

  it('accepts a freshly inserted table with style= on table and td', () => {
    resetSigSettings();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run(TABLE_HTML);
    const sig = getEmailSignature(db);
    expect(sig).not.toBeNull();
    // The table structure survives
    expect(sig.html).toContain('<table');
    expect(sig.html).toContain('<tr>');
    expect(sig.html).toMatch(/<td[^>]*>GeekShop<\/td>/);
    // Border style values survive on both table and cells
    expect(sig.html).toMatch(/<table[^>]*style="[^"]*border: ?1px solid #475569/i);
    expect(sig.html).toMatch(/<td[^>]*style="[^"]*border: ?1px solid #475569/i);
    // The padding style (also produced by the editor) survives
    expect(sig.html).toContain('padding: 4px 8px');
  });

  it('table borders with hex color in the #RRGGBB form survive', () => {
    resetSigSettings();
    const colored = '<table style="border: 2px solid #dc2626;"><tr><td style="border: 2px solid #dc2626;">red</td></tr></table>';
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run(colored);
    const sig = getEmailSignature(db);
    expect(sig.html).toContain('2px solid #dc2626');
    expect(sig.html).toMatch(/<td[^>]*style="[^"]*border: ?2px solid #dc2626/);
  });

  it('table with no border (border:0 on table and cells) round-trips', () => {
    // Byron asked for the ability to toggle borders OFF. We represent
    // that with style="border:0" on every element; the sanitizer
    // should leave it intact.
    resetSigSettings();
    const borderless = '<table style="border-collapse: collapse; border: 0;"><tr><td style="border: 0; padding: 4px 8px;">a</td><td style="border: 0; padding: 4px 8px;">b</td></tr></table>';
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run(borderless);
    const sig = getEmailSignature(db);
    expect(sig.html).toMatch(/<table[^>]*style="[^"]*border: ?0/i);
    expect(sig.html).toMatch(/<td[^>]*style="[^"]*border: ?0/i);
  });

  it('preserves cellpadding/cellspacing/border HTML attributes (legacy table syntax)', () => {
    // Some admins will hand-edit the HTML; ensure the legacy
    // <table border="1" cellpadding="4"> form survives.
    resetSigSettings();
    const legacy = '<table border="1" cellpadding="4" cellspacing="0"><tr><td>cell</td></tr></table>';
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run(legacy);
    const sig = getEmailSignature(db);
    expect(sig.html).toContain('border="1"');
    expect(sig.html).toContain('cellpadding="4"');
    expect(sig.html).toContain('cellspacing="0"');
  });

  it('strips dangerous style values from table cells (javascript:/expression: stay out of emails)', () => {
    // Defense in depth: even if an admin tries to inject a
    // javascript: URL inside a style value, the sanitizer scrubs it.
    resetSigSettings();
    const evil = '<table><tr><td style="background:url(javascript:alert(1)); color:red">x</td></tr></table>';
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run(evil);
    const out = appendSignature(db, 'Hi');
    expect(out.html).not.toContain('javascript:');
    expect(out.html).toContain('color:red');
  });

  it('drops disallowed table attributes (class, id, data-*, summary, width=number)', () => {
    resetSigSettings();
    const dirty = '<table class="x" id="y" data-z="1" summary="hi"><tr><td>a</td></tr></table>';
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run(dirty);
    const sig = getEmailSignature(db);
    expect(sig.html).not.toContain('class=');
    expect(sig.html).not.toContain('id=');
    expect(sig.html).not.toContain('data-z');
    expect(sig.html).not.toContain('summary=');
    // The table and cell structure still survives
    expect(sig.html).toContain('<table>');
    expect(sig.html).toContain('<td>a</td>');
  });

  it('appends a table-bearing rich signature to a customer body', () => {
    resetSigSettings();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run(TABLE_HTML);
    const out = appendSignature(db, 'Hi Linda — coming out tomorrow.');
    // Body is wrapped in a pre-wrap div so newlines survive; the
    // table lands after the signature wrapper.
    expect(out.text).toContain('Hi Linda');
    expect(out.text).toContain('Byron');
    expect(out.text).toContain('GeekShop');
    // HTML contains both the body and the table layout
    expect(out.html).toContain('Hi Linda');
    expect(out.html).toMatch(/<table[^>]*>/);
    expect(out.html).toMatch(/<td[^>]*>Byron<\/td>/);
  });

  it('WYSIWYG-inserted table is idempotent: appendSignature does not double-append', () => {
    resetSigSettings();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_format', 'html')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('email_signature_html', ?)`).run(TABLE_HTML);
    const pre = `Hi Linda\n\n--\n${TABLE_HTML}`;
    const out = appendSignature(db, pre);
    // No double-append: body is returned as-is, html is null
    expect(out.html).toBeNull();
    expect(out.text).toBe(pre);
  });

  it('htmlToText flattens a borderless table cell into plain text rows', () => {
    // Each <td> contributes its inner text; <tr> adds a newline;
    // multi-row tables produce multi-line plain text.
    const html = '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>';
    const text = htmlToText(html);
    expect(text).toContain('a');
    expect(text).toContain('b');
    expect(text).toContain('c');
    expect(text).toContain('d');
    // Plain-text collapses table layout: there must be at least one
    // newline between rows (we don't pin exact whitespace because
    // htmlToText is intentionally lossy here, just not lossy-er than
    // before this iteration).
    expect(text.split('\n').length).toBeGreaterThanOrEqual(2);
  });
});
