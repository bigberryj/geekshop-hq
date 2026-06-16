import { useEffect, useState, useCallback } from 'react';
import { fetchJson, postJson } from '../lib/api.js';
import { Mail, RefreshCw, Inbox as InboxIcon, Loader2, Star } from 'lucide-react';

/**
 * GmailReviewQueue
 * Lists pending_emails. Admin can:
 *   - "Scan Gmail now" (POST /api/inbox/scan) to pull new messages
 *     with a date range + starred-include toggle
 *   - "Import" (POST /api/inbox/pending/:id/import) to create a real ticket + customer
 *   - "Dismiss" to mark ignored
 *
 * Customers are auto-created at import time when missing, but ONLY after
 * the admin has explicitly chosen to import. No silent auto-creates.
 *
 * The scan window persists to localStorage so the user's last choice
 * (e.g. "last 7 days") is remembered next session. The default for new
 * visitors is "last 24 hours", matching the server-side default.
 */

const RANGE_PRESETS = [
  { key: '24h', label: 'Last 24h', hours: 24 },
  { key: '7d',  label: 'Last 7d',  hours: 24 * 7 },
  { key: '30d', label: 'Last 30d', hours: 24 * 30 },
  { key: '90d', label: 'Last 90d', hours: 24 * 90 },
  { key: 'all', label: 'All unread', hours: null },
  { key: 'custom', label: 'Custom…', hours: null },
];

const STORAGE_KEY = 'ghq.inbox.scanPrefs.v1';

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* fall through */ }
  return { range: '24h', customSince: '', customUntil: '', includeStarred: true };
}

function savePrefs(p) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
}

function isoForHoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export default function GmailReviewQueue({ onImported }) {
  const [pending, setPending] = useState(null);
  const [total, setTotal] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [scanResult, setScanResult] = useState(null);

  const initial = loadPrefs();
  const [range, setRange] = useState(initial.range);
  const [customSince, setCustomSince] = useState(initial.customSince);
  const [customUntil, setCustomUntil] = useState(initial.customUntil);
  const [includeStarred, setIncludeStarred] = useState(initial.includeStarred);

  useEffect(() => { savePrefs({ range, customSince, customUntil, includeStarred }); }, [range, customSince, customUntil, includeStarred]);

  const load = useCallback(async () => {
    try {
      const r = await fetchJson('/inbox/pending?status=pending');
      const items = Array.isArray(r) ? r : (r.items || r.rows || []);
      setPending(items);
      setTotal(typeof r === 'object' && r.total != null ? r.total : items.length);
    } catch (e) {
      setError(e.message);
      setPending([]);
      setTotal(0);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const buildScanBody = () => {
    const body = { include_starred: includeStarred };
    if (range === 'custom') {
      if (customSince) body.since = new Date(customSince).toISOString();
      if (customUntil) body.until = new Date(customUntil).toISOString();
    } else {
      const preset = RANGE_PRESETS.find((p) => p.key === range);
      if (preset && preset.hours) body.since = isoForHoursAgo(preset.hours);
    }
    return body;
  };

  const scan = async () => {
    setScanning(true);
    setError('');
    setScanResult(null);
    try {
      const r = await postJson('/inbox/scan', buildScanBody());
      if (r.error) {
        setError(r.error);
      } else {
        setScanResult(r);
        await load();
      }
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
          {pending && <span className="text-xs text-slate-500 font-normal">({pending.length}{total > pending.length ? ` of ${total}` : ''} pending)</span>}
        </h3>
        <button className="btn-secondary text-xs flex items-center gap-1" onClick={scan} disabled={scanning}>
          {scanning ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {scanning ? 'Scanning…' : 'Scan Gmail now'}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
        <span className="text-slate-500">Window:</span>
        <div className="inline-flex rounded border border-slate-200 overflow-hidden">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => setRange(p.key)}
              className={`px-2 py-1 ${range === p.key ? 'bg-amber-100 text-amber-800 font-medium' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
              data-testid={`range-${p.key}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {range === 'custom' && (
          <div className="flex items-center gap-2 ml-2">
            <label className="text-slate-500">From</label>
            <input type="datetime-local" value={customSince} onChange={(e) => setCustomSince(e.target.value)}
              className="px-2 py-1 border border-slate-200 rounded text-xs" data-testid="custom-since" />
            <label className="text-slate-500">To</label>
            <input type="datetime-local" value={customUntil} onChange={(e) => setCustomUntil(e.target.value)}
              className="px-2 py-1 border border-slate-200 rounded text-xs" data-testid="custom-until" />
          </div>
        )}
        <label className="inline-flex items-center gap-1 ml-2 cursor-pointer">
          <input
            type="checkbox"
            checked={includeStarred}
            onChange={(e) => setIncludeStarred(e.target.checked)}
            data-testid="include-starred"
          />
          <Star size={12} className={includeStarred ? 'text-amber-500 fill-amber-500' : 'text-slate-400'} />
          <span className="text-slate-600">Include starred</span>
        </label>
      </div>

      {scanResult && (
        <div className="text-xs text-slate-600 mb-2" data-testid="scan-result">
          Scanned {scanResult.fetched} ({scanResult.inserted} new, {scanResult.skipped_existing} already in queue)
          {scanResult.window && (
            <> · window: {scanResult.window.since?.replace('T', ' ').slice(0, 16)}{scanResult.window.until ? ` → ${scanResult.window.until.replace('T', ' ').slice(0, 16)}` : ' → now'}{scanResult.window.includeStarred ? ' · starred: yes' : ''}</>
          )}
        </div>
      )}

      {error && <div className="rounded bg-red-50 border border-red-200 text-red-700 text-xs p-2 mb-2">{error}</div>}

      {pending == null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : pending.length === 0 ? (
        <div className="text-sm text-slate-500 flex items-center gap-2">
          <InboxIcon size={14} /> No new emails to review. Hit &quot;Scan Gmail now&quot; to fetch.
        </div>
      ) : (
        <ul className="space-y-2">
          {pending.map((p) => (
            <li key={p.id} className="border border-slate-200 rounded p-3 bg-white">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">
                    {p.subject || '(no subject)'}
                    {p.flagged && <Star size={11} className="inline ml-1 text-amber-500 fill-amber-500" />}
                  </div>
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
