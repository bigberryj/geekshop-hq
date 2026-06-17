/**
 * Outbound email signature
 * ------------------------
 *
 * Pulls the admin's signature from `settings.email_signature` and
 * returns:
 *   - a plain-text version (used as the email's `text` field)
 *   - a minimal HTML version (used as the email's `html` field, with
 *     `whitespace: pre-wrap` so the signature line breaks survive)
 *
 * The signature is plain text only — we deliberately don't allow
 * admin-authored HTML in the signature. This keeps the email
 * injection surface small (the customer's reply text + signature
 * flow through Gmail, and a malicious customer's reply could in
 * theory try to break out of the signature block). The signature
 * gets HTML-escaped, with newlines converted to <br>.
 *
 * If the signature is empty, returns `null` so callers can skip
 * the append step entirely.
 */

import { escapeHtml } from './text.js';

export function getEmailSignature(db) {
  if (!db) return null;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'email_signature'").get();
  if (!row || !row.value) return null;
  const sig = String(row.value).trim();
  if (!sig) return null;
  return {
    raw: sig,
    text: sig,
    html: `<div style="margin-top:1em;padding-top:0.75em;border-top:1px solid #e5e7eb;color:#475569;font-size:0.9em;white-space:pre-wrap">${escapeHtml(sig)}</div>`,
  };
}

/**
 * Append the signature to a body. Returns `{ text, html }` suitable
 * for `sendEmail`. If the signature is null, returns the original
 * body unchanged.
 */
export function appendSignature(db, body) {
  const sig = getEmailSignature(db);
  if (!sig) return { text: body, html: null };
  const trimmed = (body || '').replace(/\s+$/, '');
  return {
    text: `${trimmed}\n\n--\n${sig.text}`,
    html: `<div style="white-space:pre-wrap">${escapeHtml(trimmed)}</div>\n${sig.html}`,
  };
}
