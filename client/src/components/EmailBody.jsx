import { useMemo, useRef, useEffect } from 'react';

/**
 * EmailBody — render a ticket message's body.
 *
 * - If the message has a non-empty `body_html`, render it in a
 *   sandboxed iframe so styling, inline images (rewritten to our
 *   /api/attachments/:id/raw route), and layout come through.
 * - Otherwise fall back to the plain-text `body` column with
 *   `whitespace-pre-wrap`.
 *
 * The iframe is sandboxed: no scripts, no top-level navigation, no
 * form submission, no popups, no same-origin. The server has already
 * stripped <script>, <iframe>, <object>, <embed>, <link>, and on*
 * handlers from the HTML before it landed here, so this is the
 * second line of defense. Set `srcDoc` rather than `src` so the
 * contents are inline HTML rather than a real URL — keeps the
 * preview self-contained.
 *
 * The `srcdoc` baseline + cid: rewrite is server-side (see
 * `sanitizeEmailHtml` in lib/attachments.js), so by the time the
 * iframe loads, the HTML is already safe and `<img>` tags point at
 * our raw-bytes endpoint.
 *
 * Props:
 *   body:       string (plain text fallback)
 *   body_html:  string | null (sanitized HTML, with cid: → /raw)
 *   attachments: array of { id, filename, mime_type, size_bytes, disposition }
 */
export default function EmailBody({ body, body_html, attachments = [] }) {
  const iframeRef = useRef(null);

  // If we have body_html, build a self-contained document. The
  // <base> tag is NOT used (sandboxed iframes ignore it anyway);
  // relative image URLs are absolute because the server already
  // rewrote them to /api/attachments/.../raw.
  const html = useMemo(() => {
    if (!body_html) return null;
    return `<!doctype html>
<html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; line-height: 1.5; color: #111827; margin: 0; padding: 0; }
  img { max-width: 100%; height: auto; }
  a { color: #1d4ed8; }
  pre, code { white-space: pre-wrap; word-wrap: break-word; }
  table { max-width: 100%; }
  blockquote { border-left: 3px solid #cbd5e1; margin: 0.5em 0; padding-left: 0.75em; color: #475569; }
  hr { border: 0; border-top: 1px solid #e5e7eb; margin: 1em 0; }
</style>
</head><body>${body_html}</body></html>`;
  }, [body_html]);

  // Auto-resize the iframe to its content height so the whole
  // email is visible without a nested scrollbar.
  useEffect(() => {
    if (!iframeRef.current || !html) return;
    const resize = () => {
      try {
        const doc = iframeRef.current.contentDocument;
        if (doc && doc.body) {
          const h = doc.body.scrollHeight;
          iframeRef.current.style.height = `${Math.max(120, Math.min(h + 16, 4000))}px`;
        }
      } catch (e) {
        // cross-origin sandboxed docs may throw on access — ignore
      }
    };
    const id = setTimeout(resize, 50);
    const ro = new ResizeObserver(resize);
    try {
      const doc = iframeRef.current.contentDocument;
      if (doc && doc.body) ro.observe(doc.body);
    } catch (e) { /* no-op */ }
    return () => { clearTimeout(id); ro.disconnect(); };
  }, [html]);

  if (html) {
    return (
      <div className="text-sm">
        <iframe
          ref={iframeRef}
          title="Email body"
          sandbox="allow-same-origin"
          srcDoc={html}
          className="w-full border-0 bg-white"
          style={{ minHeight: 120 }}
        />
        {attachments && attachments.length > 0 && (
          <div className="mt-2 pt-2 border-t border-slate-200">
            <div className="text-xs text-slate-500 mb-1">Attachments</div>
            <ul className="space-y-0.5">
              {attachments.map((a) => (
                <li key={a.id} className="text-xs">
                  <a
                    href={`/api/attachments/${a.id}/raw`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-600 hover:underline"
                    data-testid={`attachment-link-${a.id}`}
                  >
                    📎 {a.filename}
                  </a>
                  <span className="text-slate-400 ml-1">
                    ({a.mime_type || '?'}, {formatBytes(a.size_bytes)})
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="text-sm whitespace-pre-wrap">{body}</div>
  );
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
