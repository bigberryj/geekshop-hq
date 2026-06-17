import { useEffect, useState, useRef } from 'react';
import { X, Loader2, Paperclip, ExternalLink } from 'lucide-react';
import { fetchJson } from '../lib/api.js';
import EmailBody from './EmailBody.jsx';

/**
 * EmailPreviewModal
 *
 * Shown when the admin clicks the Preview button on an inbox row.
 * Fetches /api/inbox/pending/:id/preview and renders the sanitized
 * HTML body (or a plain-text fallback) inside a sandboxed iframe,
 * exactly the same way the ticket page will after import.
 *
 * The modal also lists the email's attachments (filename + size +
 * link) and a "View source" toggle so the admin can inspect the
 * raw HTML if something looks off.
 *
 * Props:
 *   pendingId:  number
 *   onClose:    () => void
 */
export default function EmailPreviewModal({ pendingId, onClose }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [showSource, setShowSource] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    fetchJson(`/inbox/pending/${pendingId}/preview`)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((e) => { if (!cancelled) setError(e.response?.data?.error || e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [pendingId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      data-testid="email-preview-modal"
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <div className="min-w-0 flex-1 pr-2">
            <h3 className="font-semibold truncate" data-testid="preview-subject">
              {loading ? 'Loading…' : (preview?.subject || '(no subject)')}
            </h3>
            {preview && (
              <div className="text-xs text-slate-500 mt-0.5 truncate">
                {preview.from_name || preview.from_email} · {preview.from_email} · {preview.date ? new Date(preview.date).toLocaleString() : ''}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {preview && (
              <button
                className="btn-ghost text-xs flex items-center gap-1"
                onClick={() => setShowSource((v) => !v)}
                data-testid="preview-toggle-source"
              >
                <ExternalLink size={12} /> {showSource ? 'View rendered' : 'View source'}
              </button>
            )}
            <button className="btn-ghost p-1" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-2">{error}</div>}
          {loading && (
            <div className="text-sm text-slate-500 flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Fetching from Gmail and sanitizing…
            </div>
          )}
          {preview && showSource && (
            <pre className="text-[11px] font-mono bg-slate-50 border border-slate-200 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all" data-testid="preview-source">
              {preview.body_html || `(no HTML body — text fallback below)\n\n${preview.body_text}`}
            </pre>
          )}
          {preview && !showSource && (
            <>
              <EmailBody
                body={preview.body_text}
                body_html={preview.body_html}
                attachments={preview.attachments || []}
              />
              {preview.attachments && preview.attachments.length > 0 && (
                <div className="mt-3 pt-3 border-t border-slate-200">
                  <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
                    <Paperclip size={12} /> {preview.attachments.length} attachment{preview.attachments.length === 1 ? '' : 's'}
                  </div>
                  <ul className="space-y-0.5">
                    {preview.attachments.map((a) => (
                      <li key={a.id} className="text-xs">
                        <a
                          href={`/api/inbox/pending/${preview.id}/attachments/${a.id}/raw`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand-600 hover:underline"
                          data-testid={`preview-attachment-${a.id}`}
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
