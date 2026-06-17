/**
 * Attachment storage on disk.
 *
 * Layout:
 *   data/attachments/pending/<pending_id>/<sha256-prefix>-<filename>
 *   data/attachments/tickets/<ticket_id>/<sha256-prefix>-<filename>
 *
 * The DB stores `storage_path` as a path relative to `data/attachments/`
 * so the on-disk root can move (e.g. to a different volume) without a
 * migration. We resolve the absolute path at serve time.
 *
 * Files are written once, never mutated. The DB row + the on-disk file
 * have a 1:1 relationship: deleting a row deletes the file, and the
 * file is what the server hands back via the /raw route.
 *
 * Filenames get a SHA-256 hex prefix (first 8 chars) so that two
 * attachments with the same display name ("image.png") don't
 * collide on disk, and so that filenames with weird characters
 * don't break the HTTP layer.
 *
 * Size cap: 25MB per attachment. Larger MIME parts are skipped during
 * import (logged) so the queue doesn't accidentally eat 2GB of
 * "thanks for the cat photo" attachments.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, statSync, unlinkSync, existsSync, createReadStream, readFileSync } from 'node:fs';
import { join, dirname, resolve, basename, extname } from 'node:path';
import { homedir } from 'node:os';

const ATTACHMENT_ROOT = process.env.GHQ_ATTACHMENT_ROOT
  ? resolve(process.env.GHQ_ATTACHMENT_ROOT)
  : join(homedir(), 'projects', 'geekshop-hq', 'data', 'attachments');

const MAX_BYTES = 25 * 1024 * 1024;

export const attachmentConstants = { ATTACHMENT_ROOT, MAX_BYTES };

function safeFilename(name) {
  // Strip path components + control chars, keep the extension. Fall
  // back to 'attachment' if the result is empty.
  const ext = extname(name || '');
  const base = basename(name || 'attachment', ext).replace(/[^\w.\-]+/g, '_').slice(0, 80);
  return (base || 'attachment') + (ext || '').slice(0, 16);
}

function shortHash(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

function bucketFor(scope, id) {
  // 'pending' or 'tickets'
  return join(ATTACHMENT_ROOT, scope, String(id));
}

/**
 * Persist an attachment to disk. Returns the relative storage_path
 * (relative to ATTACHMENT_ROOT) — store that in the DB.
 *
 * @param {object} args
 * @param {'pending'|'tickets'} args.scope
 * @param {number} args.rowId            pending_email_id or ticket_id
 * @param {string} args.filename
 * @param {string} args.mimeType
 * @param {Buffer} args.buffer           raw bytes
 * @param {string|null} [args.contentId] cid: from the MIME headers
 * @param {string} [args.disposition]    'attachment' | 'inline'
 * @returns {{ storagePath: string, sizeBytes: number, filename: string, mimeType: string, contentId: string|null, disposition: string }}
 */
export function persistAttachment({ scope, rowId, filename, mimeType, buffer, contentId = null, disposition = 'attachment' }) {
  if (!buffer || !buffer.length) {
    throw new Error('attachment buffer is empty');
  }
  if (buffer.length > MAX_BYTES) {
    const err = new Error(`attachment too large (${buffer.length} > ${MAX_BYTES} bytes)`);
    err.code = 'ATTACHMENT_TOO_LARGE';
    err.sizeBytes = buffer.length;
    throw err;
  }
  const dir = bucketFor(scope, rowId);
  mkdirSync(dir, { recursive: true });
  const cleanName = safeFilename(filename);
  const hash = shortHash(buffer);
  const file = `${hash}-${cleanName}`;
  const fullPath = join(dir, file);
  writeFileSync(fullPath, buffer);
  const relPath = join(scope, String(rowId), file);
  return {
    storagePath: relPath,
    sizeBytes: buffer.length,
    filename: cleanName,
    mimeType: mimeType || 'application/octet-stream',
    contentId,
    disposition,
  };
}

/**
 * Resolve a relative storage_path (from the DB) to an absolute path on
 * disk, scoped to ATTACHMENT_ROOT. Rejects any path that escapes the
 * root (path-traversal guard).
 */
export function resolveAttachmentPath(storagePath) {
  if (!storagePath || typeof storagePath !== 'string') return null;
  const abs = resolve(ATTACHMENT_ROOT, storagePath);
  // Ensure the resolved path is still under ATTACHMENT_ROOT.
  const root = ATTACHMENT_ROOT.endsWith('/') ? ATTACHMENT_ROOT : ATTACHMENT_ROOT + '/';
  if (!abs.startsWith(root) && abs !== ATTACHMENT_ROOT) return null;
  if (!existsSync(abs)) return null;
  return abs;
}

export function attachmentExists(storagePath) {
  return Boolean(resolveAttachmentPath(storagePath));
}

export function attachmentSize(storagePath) {
  const abs = resolveAttachmentPath(storagePath);
  if (!abs) return 0;
  try { return statSync(abs).size; } catch { return 0; }
}

export function deleteAttachment(storagePath) {
  const abs = resolveAttachmentPath(storagePath);
  if (!abs) return;
  try { unlinkSync(abs); } catch (e) { /* file already gone — fine */ }
}

export function readAttachmentStream(storagePath) {
  const abs = resolveAttachmentPath(storagePath);
  if (!abs) return null;
  return createReadStream(abs);
}

/**
 * Read the full attachment into a Buffer. Returns null if the file
 * is missing. Used by the import path when copying an attachment
 * from the pending bucket into the ticket bucket.
 */
export function readAttachmentBuffer(storagePath) {
  const abs = resolveAttachmentPath(storagePath);
  if (!abs) return null;
  try { return readFileSync(abs); } catch { return null; }
}

/**
 * Minimal HTML sanitizer for the email preview / ticket render path.
 *
 * Strips <script>, <style>, <iframe>, <object>, <embed>, <link>, and
 * on* event attributes. This is *not* a replacement for DOMPurify —
 * it's a small, fast, deterministic scrubber for the trusted
 * admin-only paths (the inbox queue + ticket page, both local-only
 * behind Tailscale). The output is always wrapped in a sandboxed
 * iframe on the frontend as the second line of defense.
 *
 * The sanitizer also rewrites cid: image references to the
 * /attachments/:id/raw route so inline images actually render.
 *
 * @param {string} html
 * @param {(cid: string) => number|null} cidToAttachmentId  lookup function
 * @returns {string} sanitized html
 */
export function sanitizeEmailHtml(html, cidToAttachmentId) {
  if (!html || typeof html !== 'string') return '';
  let s = html;

  // 1. Drop <script>...</script> including their content.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  // 2. Drop <style>...</style> (we render the email in our own iframe
  //    with our own CSS — the inline styles will still apply per-element
  //    because we don't strip `style=` attributes).
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  // 3. Drop risky embedded elements entirely.
  s = s.replace(/<(iframe|object|embed|link|meta|base|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<(iframe|object|embed|link|meta|base|form)\b[^>]*\/?>/gi, '');

  // 4. Strip on* event handler attributes (onclick, onload, onerror, ...).
  s = s.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
  s = s.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');
  s = s.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '');

  // 5. Strip javascript: URLs from href/src.
  s = s.replace(/(\s(?:href|src)\s*=\s*")\s*javascript:[^"]*"/gi, '$1#"');
  s = s.replace(/(\s(?:href|src)\s*=\s*')\s*javascript:[^']*'/gi, "$1#'");
  s = s.replace(/(\s(?:href|src)\s*=\s*)javascript:[^\s>]+/gi, '$1#');

  // 6. Strip target=_blank with javascript: handled above; also add
  //    rel="noopener noreferrer" to external links.
  s = s.replace(/<a\b([^>]*?)>/gi, (m, attrs) => {
    if (/\bhref\s*=/i.test(attrs) && !/\brel\s*=/i.test(attrs)) {
      return `<a${attrs} rel="noopener noreferrer">`;
    }
    return m;
  });

  // 7. Rewrite cid: image references to our /attachments/:id/raw
  //    endpoint. cid: comes in two forms: "cid:abc123" and
  //    "cid:<abc123@example>" (with angle brackets).
  if (typeof cidToAttachmentId === 'function') {
    s = s.replace(/(\s(?:src|background)\s*=\s*")\s*cid:([^"]*)"/gi, (m, prefix, cid) => {
      const cleanCid = cid.replace(/^<|>$/g, '');
      const id = cidToAttachmentId(cleanCid);
      return id ? `${prefix}/api/attachments/${id}/raw"` : `${prefix}#" data-missing-cid="${cleanCid}"`;
    });
    s = s.replace(/(\s(?:src|background)\s*=\s*')\s*cid:([^']*)'/gi, (m, prefix, cid) => {
      const cleanCid = cid.replace(/^<|>$/g, '');
      const id = cidToAttachmentId(cleanCid);
      return id ? `${prefix}/api/attachments/${id}/raw'` : `${prefix}#' data-missing-cid="${cleanCid}"`;
    });
  }

  return s;
}

export { ATTACHMENT_ROOT, MAX_BYTES as ATTACHMENT_MAX_BYTES };
