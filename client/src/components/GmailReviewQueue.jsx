import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { fetchJson, postJson } from '../lib/api.js';
import { Mail, RefreshCw, Inbox as InboxIcon, Loader2 } from 'lucide-react';

/**
 * GmailReviewQueue
 * Lists pending_emails. Admin can:
 *   - "Scan Gmail now" (POST /api/inbox/scan) to pull new messages
 *   - "Import" (POST /api/inbox/pending/:id/import) to create a real ticket + customer
 *   - "Dismiss" to mark ignored
 *
 * Customers are auto-created at import time when missing, but ONLY after
 * the admin has explicitly chosen to import. No silent auto-creates.
 */
export default function GmailReviewQueue({ onImported }) {
  const [pending, setPending] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setPending(await fetchJson('/inbox/pending?status=pending'));
    } catch (e) {
      setError(e.message);
      setPending([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const scan = async () => {
    setScanning(true);
    setError('');
    try {
      const r = await postJson('/inbox/scan', {});
      if (r.error) setError(r.error);
      else await load();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setScanning(false);
    }
  };

  const importOne = async (id) => {
    setBusyId(id);
    setError('');
    try {
      const r = await postJson(`/inbox/pending/${id}/import`, {});
      if (r.error) setError(r.error);
      else {
        await load();
        onImported?.(r);
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusyId(null);
    }
  };

  const dismiss = async (id) => {
    setBusyId(id);
    setError('');
    try {
      const r = await postJson(`/inbox/pending/${id}/dismiss`, {});
      if (r.error) setError(r.error);
      else await load();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="card md:col-span-2 border-l-4 border-amber-400">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="font-semibold flex items-center gap-2">
          <Mail size={16} /> Gmail review queue
          {pending && <span className="text-xs text-slate-500 font-normal">({pending.length} pending)</span>}
        </h3>
        <button className="btn-secondary text-xs flex items-center gap-1" onClick={scan} disabled={scanning}>
          {scanning ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {scanning ? 'Scanning…' : 'Scan Gmail now'}
        </button>
      </div>

      {error && <div className="rounded bg-red-50 border border-red-200 text-red-700 text-xs p-2 mb-2">{error}</div>}

      {pending == null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : pending.length === 0 ? (
        <div className="text-sm text-slate-500 flex items-center gap-2">
          <InboxIcon size={14} /> No new emails to review. Hit "Scan Gmail now" to fetch.
        </div>
      ) : (
        <ul className="space-y-2">
          {pending.map((p) => (
            <li key={p.id} className="border border-slate-200 rounded p-3 bg-white">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{p.subject || '(no subject)'}</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    From <span className="font-mono">{p.from_email || p.from_name || 'unknown'}</span>
                    {p.received_at && <> · {new Date(p.received_at).toLocaleString()}</>}
                  </div>
                  {p.snippet && <div className="text-sm text-slate-600 mt-1 line-clamp-2">{p.snippet}</div>}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button className="btn-primary text-xs" onClick={() => importOne(p.id)} disabled={busyId === p.id}>
                    Import
                  </button>
                  <button className="btn-ghost text-xs" onClick={() => dismiss(p.id)} disabled={busyId === p.id}>
                    Dismiss
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-slate-500 mt-3">
        Customers are auto-created at import time when missing — but only after you click <strong>Import</strong>.
        Nothing in the system changes without your say-so.
      </p>
    </section>
  );
}
