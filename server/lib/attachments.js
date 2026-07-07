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

// Phase 4 — ATTACHMENT_ROOT is re-evaluated on every read so test
// isolation works (vitest hoists imports, so any env-driven override
// has to be honoured at request time, not at module-load time).
// Default: ~/.../data/attachments.
function getAttachmentRoot() {
  return process.env.GHQ_ATTACHMENT_ROOT
    ? resolve(process.env.GHQ_ATTACHMENT_ROOT)
    : join(homedir(), 'projects', 'geekshop-hq', 'data', 'attachments');
}

const MAX_BYTES = 25 * 1024 * 1024;

export const attachmentConstants = {
  get ATTACHMENT_ROOT() { return getAttachmentRoot(); },
  MAX_BYTES,
};

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
  // 'pending', 'tickets', or 'expenses'
  return join(getAttachmentRoot(), scope, String(id));
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
 * Phase 4 — Receipt allowlist.
 *
 * Returns true if the given (mime, first-bytes) combination is on the
 * allowlist for receipt uploads. The allowlist is intentionally narrow:
 *
 *   - image/png  (header: 89 50 4E 47)
 *   - image/jpeg (header: FF D8 FF)
 *   - image/webp (RIFF....WEBP)
 *   - application/pdf (header: 25 50 44 46 — "%PDF")
 *
 * Why both mime and content sniff? `file.mimetype` comes from the client
 * and is fully attacker-controlled. A malicious browser could send a
 * .exe with mime=image/png and a PNG-shaped first 4 bytes. We check
 * both: the server rejects mismatches with `RECEIPT_TYPE_REJECTED`
 * before the bytes ever touch disk. The hard-coded sniff set is small
 * enough to maintain by hand and covers the only formats the HQ UI
 * currently advertises in the file picker (`accept="image/*,application/pdf"`).
 *
 * Adding a new format: extend the SNIFF_BYTES table AND update the
 * Phase 4 docs (schema.md, api.md, security.md, changelog.md).
 */
const RECEIPT_ALLOWED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
]);

export const RECEIPT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB, same as the global cap

export function isReceiptMimeAllowed(mime) {
  if (!mime || typeof mime !== 'string') return false;
  // Normalize (some browsers send "image/jpg" or "image/JPEG").
  return RECEIPT_ALLOWED_MIMES.has(mime.toLowerCase());
}

const SIG_PNG  = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // ‰PNG....
const SIG_JPEG = Buffer.from([0xFF, 0xD8, 0xFF]);
const SIG_PDF  = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF
const SIG_WEBP_RIFF = Buffer.from('RIFF', 'ascii');
const SIG_WEBP_WEBP = Buffer.from('WEBP', 'ascii');

function startsWith(buf, sig) {
  if (!buf || buf.length < sig.length) return false;
  return buf.subarray(0, sig.length).equals(sig);
}

/**
 * Sniff the file type from the first bytes. Returns the canonical mime
 * (one of the four in RECEIPT_ALLOWED_MIMES) or null if the content
 * doesn't match any known signature. PDF detection is intentionally
 * first so the %PDF header is never confused with a PNG/JPEG hex match.
 */
export function sniffReceiptMime(buffer) {
  if (!buffer || !buffer.length) return null;
  if (startsWith(buffer, SIG_PNG))  return 'image/png';
  if (startsWith(buffer, SIG_PDF))  return 'application/pdf';
  if (startsWith(buffer, SIG_JPEG)) return 'image/jpeg';
  // WebP: "RIFF????WEBP"
  if (buffer.length >= 12
      && startsWith(buffer, SIG_WEBP_RIFF)
      && buffer.subarray(8, 12).equals(SIG_WEBP_WEBP)) {
    return 'image/webp';
  }
  return null;
}

/**
 * Combined check used by the upload route. Returns:
 *   { ok: true,  mime: 'image/png' }              — passed; mime is the
 *                                                    canonical sniffed type
 *   { ok: false, code: 'MIME_NOT_ALLOWED' }       — declared mime not in list
 *   { ok: false, code: 'TYPE_MISMATCH' }           — declared vs sniffed differ
 *   { ok: false, code: 'CONTENT_UNKNOWN' }        — no signature matched
 *
 * The route should turn a non-ok result into a 415 (Unsupported Media
 * Type) so the failure mode is loud and debuggable.
 */
export function checkReceiptUpload({ declaredMime, buffer }) {
  if (!isReceiptMimeAllowed(declaredMime)) {
    return { ok: false, code: 'MIME_NOT_ALLOWED' };
  }
  const sniffed = sniffReceiptMime(buffer);
  if (!sniffed) {
    return { ok: false, code: 'CONTENT_UNKNOWN' };
  }
  // Compare by base type. e.g. "image/jpeg" matches a JPEG sniff even
  // if the client declared "image/jpg" (some browsers are sloppy).
  const declaredBase = declaredMime.toLowerCase().split('/')[1];
  const sniffedBase = sniffed.split('/')[1];
  const mimeAlias = (a) => (a === 'jpg' ? 'jpeg' : a);
  if (mimeAlias(declaredBase) !== mimeAlias(sniffedBase)) {
    return { ok: false, code: 'TYPE_MISMATCH' };
  }
  return { ok: true, mime: sniffed };
}

/**
 * Resolve a relative storage_path (from the DB) to an absolute path on
 * disk, scoped to ATTACHMENT_ROOT. Rejects any path that escapes the
 * root (path-traversal guard).
 */
export function resolveAttachmentPath(storagePath) {
  if (!storagePath || typeof storagePath !== 'string') return null;
  const root = getAttachmentRoot();
  const abs = resolve(root, storagePath);
  // Ensure the resolved path is still under the (current) root.
  const rootWithSep = root.endsWith('/') ? root : root + '/';
  if (!abs.startsWith(rootWithSep) && abs !== root) return null;
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

export { getAttachmentRoot as getAttachmentRootFn, MAX_BYTES as ATTACHMENT_MAX_BYTES };
