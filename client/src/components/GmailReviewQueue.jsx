import { useEffect, useState, useCallback, useMemo } from 'react';
import { fetchJson, postJson } from '../lib/api.js';
import { Mail, RefreshCw, Inbox as InboxIcon, Loader2, Star, X, RotateCcw, Eye } from 'lucide-react';
import ContactEnrichmentModal from './ContactEnrichmentModal.jsx';
import EmailPreviewModal from './EmailPreviewModal.jsx';

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

// Display-filter presets: separate from scan range, controls what's
// shown in the queue right now without re-fetching from Gmail.
const FILTER_PRESETS = [
  { key: 'all', label: 'All time', hours: null },
  { key: '24h', label: 'Last 24h', hours: 24 },
  { key: '7d',  label: 'Last 7d',  hours: 24 * 7 },
  { key: '30d', label: 'Last 30d', hours: 24 * 30 },
  { key: '90d', label: 'Last 90d', hours: 24 * 90 },
  { key: 'custom', label: 'Custom…', hours: null },
];

const STORAGE_KEY = 'ghq.inbox.scanPrefs.v1';
const FILTER_STORAGE_KEY = 'ghq.inbox.filterPrefs.v1';
const AGENT_HIDE_STORAGE_KEY = 'ghq.inbox.hideAgentMail.v1';

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

function loadFilterPrefs() {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* fall through */ }
  // Default: show last 30 days, so the inbox is usable on first load
  // (without it, all 556 pending emails dump into the list at once).
  return { range: '30d', customSince: '', customUntil: '' };
}

function saveFilterPrefs(p) {
  try { localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
}

function loadAgentHide() {
  try { return localStorage.getItem(AGENT_HIDE_STORAGE_KEY) === 'true'; } catch (e) { return false; }
}
function saveAgentHide(v) {
  try { localStorage.setItem(AGENT_HIDE_STORAGE_KEY, v ? 'true' : 'false'); } catch (e) { /* ignore */ }
}

function parseAgentMailboxList(value) {
  if (!value) return [];
  return String(value)
    .split(/[,\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
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
  // Enrichment modal: shown when the server's import returns a Google
  // Contacts match for the sender. Server does the lookup, client just
  // asks the admin which fields to apply.
  const [enrichmentMatch, setEnrichmentMatch] = useState(null);
  // Email preview modal: shown when the admin clicks the Preview button
  // on a row. The modal fetches /api/inbox/pending/:id/preview and
  // renders the email exactly as it'll appear on the ticket page.
  const [previewId, setPreviewId] = useState(null);
  // Bulk-dismiss: Set of selected pending row ids. Bulk-dismiss button
  // acts on all of them in one POST.
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Show dismissed rows? When on, the GET /api/inbox/pending returns
  // both pending and dismissed rows; the list shows both with a status
  // badge and a Restore button on dismissed ones.
  const [showDismissed, setShowDismissed] = useState(false);
  // Hide operational agent mail (default: johnn5wizbot@gmail.com — set
  // via /api/settings/agent_mailbox_from). The toggle is client-side
  // because the server's job is to keep the data, not to second-guess
  // the admin's view preferences.
  const [hideAgentMail, setHideAgentMail] = useState(loadAgentHide);
  const [agentMailboxes, setAgentMailboxes] = useState([]);

  const initial = loadPrefs();
  const [range, setRange] = useState(initial.range);
  const [customSince, setCustomSince] = useState(initial.customSince);
  const [customUntil, setCustomUntil] = useState(initial.customUntil);
  const [includeStarred, setIncludeStarred] = useState(initial.includeStarred);

  const initialFilter = loadFilterPrefs();
  const [filterRange, setFilterRange] = useState(initialFilter.range);
  const [filterCustomSince, setFilterCustomSince] = useState(initialFilter.customSince);
  const [filterCustomUntil, setFilterCustomUntil] = useState(initialFilter.customUntil);

  useEffect(() => { savePrefs({ range, customSince, customUntil, includeStarred }); }, [range, customSince, customUntil, includeStarred]);
  useEffect(() => { saveFilterPrefs({ range: filterRange, customSince: filterCustomSince, customUntil: filterCustomUntil }); }, [filterRange, filterCustomSince, filterCustomUntil]);
  useEffect(() => { saveAgentHide(hideAgentMail); }, [hideAgentMail]);
  // When the agent-mail filter is turned on, drop any selected ids
  // that match the agent mailbox so the bulk-dismiss button doesn't
  // accidentally dismiss hidden rows.
  useEffect(() => {
    if (!hideAgentMail || agentMailboxes.length === 0) return;
    const set = new Set(agentMailboxes);
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set();
      for (const id of prev) {
        const row = (pending || []).find((p) => p.id === id);
        if (row && row.from_email && set.has(row.from_email.toLowerCase())) {
          changed = true;
          continue; // drop agent mail from selection
        }
        next.add(id);
      }
      return changed ? next : prev;
    });
  }, [hideAgentMail, agentMailboxes, pending]);

  // Pull the moderation settings once on mount so the agent-mailbox
  // list is known client-side for the hide filter.
  useEffect(() => {
    fetchJson('/inbox/moderation-settings')
      .then((s) => setAgentMailboxes(parseAgentMailboxList(s && s.agent_mailbox_from)))
      .catch(() => { /* leave the list empty — hide toggle becomes a no-op */ });
  }, []);

  const buildFilterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (showDismissed) {
      // When showing dismissed, omit the status param and use the
      // include_dismissed flag — the server returns BOTH pending and
      // dismissed rows in one query.
      params.set('include_dismissed', 'true');
    } else {
      params.set('status', 'pending');
    }
    if (filterRange === 'all') return params.toString();
    let since, until;
    if (filterRange === 'custom') {
      if (filterCustomSince) since = new Date(filterCustomSince).toISOString();
      if (filterCustomUntil) until = new Date(filterCustomUntil).toISOString();
    } else {
      const preset = FILTER_PRESETS.find((p) => p.key === filterRange);
      if (preset && preset.hours) since = isoForHoursAgo(preset.hours);
    }
    if (since) params.set('since', since);
    if (until) params.set('until', until);
    return params.toString();
  }, [filterRange, filterCustomSince, filterCustomUntil, showDismissed]);

  const load = useCallback(async () => {
    try {
      const qs = buildFilterParams();
      const r = await fetchJson(`/inbox/pending?${qs}`);
      const items = Array.isArray(r) ? r : (r.items || r.rows || []);
      setPending(items);
      setTotal(typeof r === 'object' && r.total != null ? r.total : items.length);
    } catch (e) {
      setError(e.message);
      setPending([]);
      setTotal(0);
    }
  }, [buildFilterParams]);

  // Client-side filter: drop rows whose from_email is in the agent
  // mailbox list when "Hide agent mail" is on. We filter the in-memory
  // list (rather than asking the server) so the toggle is instant and
  // doesn't affect the server's data model.
  const visiblePending = useMemo(() => {
    if (!Array.isArray(pending)) return pending;
    if (!hideAgentMail || agentMailboxes.length === 0) return pending;
    const set = new Set(agentMailboxes);
    return pending.filter((p) => !(p.from_email && set.has(p.from_email.toLowerCase())));
  }, [pending, hideAgentMail, agentMailboxes]);

  // The total counts ALL rows (including hidden agent mail) so the
  // header doesn't lie about the queue size.
  const visibleTotal = useMemo(() => {
    if (!Array.isArray(pending)) return total;
    if (!hideAgentMail || agentMailboxes.length === 0) return total;
    return total - (pending.length - visiblePending.length);
  }, [pending, visiblePending, hideAgentMail, agentMailboxes, total]);

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

  // Backfill classification on legacy pending rows. One-shot admin
  // action. Surfaces the result as a banner so Byron can audit.
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [backfillResult, setBackfillResult] = useState(null);
  const backfill = async (threshold = 0.8) => {
    setBackfillBusy(true);
    setError('');
    try {
      const r = await postJson('/inbox/pending/backfill-classify', { threshold, status: 'pending', limit: 1000 });
      if (r.error) setError(r.error);
      else {
        setBackfillResult(r);
        await load();
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBackfillBusy(false);
    }
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
      if (r.error) {
        setError(r.error);
      } else {
        // If the server found a Google Contacts match, pop the enrichment
        // modal so the admin can pre-fill blank customer fields. Pass
        // along the customer so the modal knows the target id.
        if (r.contactMatch && r.contactMatch.ok && r.contactMatch.diff) {
          // Build a combined match object with the customer reference
          setEnrichmentMatch({ ...r.contactMatch, customer: r.customer, pendingId: id });
        }
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

  // Bulk-dismiss: send a single POST with the list of selected ids.
  // Server returns counts; we show a brief confirmation.
  const bulkDismiss = async () => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    setError('');
    try {
      const r = await postJson('/inbox/pending/bulk-dismiss', { ids: Array.from(selectedIds) });
      if (r.error) {
        setError(r.error);
      } else {
        setSelectedIds(new Set());
        await load();
        // Show scan result banner with the bulk-dismiss outcome.
        setScanResult({ window: { since: null, until: null, includeStarred: true, limit: 0 }, fetched: 0, inserted: 0, auto_dismissed: 0, skipped_existing: 0, bulk_dismissed: r.dismissed, bulk_skipped: r.skipped, errors: [] });
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBulkBusy(false);
    }
  };

  // Restore: moves a dismissed row back to pending. Used by the Restore
  // button on dismissed rows in "Show dismissed" mode.
  const restore = async (id) => {
    setBusyId(id);
    setError('');
    try {
      const r = await postJson(`/inbox/pending/${id}/restore`, {});
      if (r.error) setError(r.error);
      else await load();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusyId(null);
    }
  };

  const toggleSelect = (id) => setSelectedIds((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleSelectAll = () => {
    if (!visiblePending) return;
    const pendingOnly = visiblePending.filter((p) => p.status === 'pending');
    const allSelected = pendingOnly.length > 0 && pendingOnly.every((p) => selectedIds.has(p.id));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pendingOnly.map((p) => p.id)));
    }
  };

  return (
    <section className="card md:col-span-2 border-l-4 border-amber-400">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="font-semibold flex items-center gap-2">
          <Mail size={16} /> Gmail review queue
          {visiblePending && <span className="text-xs text-slate-500 font-normal">({visiblePending.length}{visibleTotal > visiblePending.length ? ` of ${visibleTotal}` : ''} pending{pending && visiblePending.length < pending.length ? ` (${pending.length - visiblePending.length} agent mail hidden)` : ''})</span>}
        </h3>
        <div className="flex items-center gap-2">
          {/* "Show dismissed" toggle — when on, both pending and dismissed
              rows are shown, with a status badge and Restore button. */}
          <label className="flex items-center gap-1 text-xs cursor-pointer" data-testid="show-dismissed-toggle">
            <input
              type="checkbox"
              checked={showDismissed}
              onChange={(e) => setShowDismissed(e.target.checked)}
            />
            <span className="text-slate-600">Show dismissed</span>
          </label>
          {/* "Hide agent mail" — keeps operational agent mail in the DB
              but filters it out of the human-pending view. */}
          <label className="flex items-center gap-1 text-xs cursor-pointer" data-testid="hide-agent-mail-toggle" title="Hide mail from the agent mailbox(es) configured in Settings">
            <input
              type="checkbox"
              checked={hideAgentMail}
              onChange={(e) => setHideAgentMail(e.target.checked)}
            />
            <span className="text-slate-600">Hide agent mail</span>
          </label>
          {/* Backfill-classify button: run the rules-first classifier
              on any legacy pending rows that don't have a classification
              yet. Safe to re-run; idempotent. */}
          <button
            className="btn-ghost text-xs flex items-center gap-1"
            onClick={() => backfill(0.8)}
            disabled={backfillBusy}
            data-testid="backfill-classify-btn"
            title="Score and dismiss any un-classified pending rows using the current rules (one-shot, idempotent)"
          >
            {backfillBusy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {backfillBusy ? 'Backfilling…' : 'Classify legacy'}
          </button>
          {selectedIds.size > 0 && (
            <button
              className="btn-secondary text-xs flex items-center gap-1"
              onClick={bulkDismiss}
              disabled={bulkBusy}
              data-testid="bulk-dismiss-btn"
            >
              {bulkBusy ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
              {bulkBusy ? 'Dismissing…' : `Dismiss ${selectedIds.size} selected`}
            </button>
          )}
          <button className="btn-secondary text-xs flex items-center gap-1" onClick={scan} disabled={scanning}>
            {scanning ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {scanning ? 'Scanning…' : 'Scan Gmail now'}
          </button>
        </div>
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

      {backfillResult && (
        <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 mb-2" data-testid="backfill-result">
          Backfill (threshold {backfillResult.threshold}): examined {backfillResult.examined}, classified {backfillResult.classified}, auto-dismissed {backfillResult.dismissed}.
          {backfillResult.samples && backfillResult.samples.length > 0 && backfillResult.dismissed > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer">Show {Math.min(backfillResult.samples.length, 25)} dismissed examples</summary>
              <ul className="mt-1 space-y-0.5 text-[11px]">
                {backfillResult.samples.filter((s) => s.should_dismiss).slice(0, 25).map((s) => (
                  <li key={s.id}>
                    <span className="font-mono">id {s.id}</span> · score {Number(s.score).toFixed(2)} · <span className="font-mono">{(s.from_email || '').slice(0, 40)}</span> · {(s.subject || '').slice(0, 50)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {error && <div className="rounded bg-red-50 border border-red-200 text-red-700 text-xs p-2 mb-2">{error}</div>}

      <div className="flex flex-wrap items-center gap-2 mb-3 text-xs" data-testid="display-filter">
        <span className="text-slate-500">Showing:</span>
        <div className="inline-flex rounded border border-slate-200 overflow-hidden">
          {FILTER_PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => setFilterRange(p.key)}
              className={`px-2 py-1 ${filterRange === p.key ? 'bg-slate-200 text-slate-800 font-medium' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
              data-testid={`filter-${p.key}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {filterRange === 'custom' && (
          <div className="flex items-center gap-2 ml-2">
            <label className="text-slate-500">From</label>
            <input type="datetime-local" value={filterCustomSince} onChange={(e) => setFilterCustomSince(e.target.value)}
              className="px-2 py-1 border border-slate-200 rounded text-xs" data-testid="filter-custom-since" />
            <label className="text-slate-500">To</label>
            <input type="datetime-local" value={filterCustomUntil} onChange={(e) => setFilterCustomUntil(e.target.value)}
              className="px-2 py-1 border border-slate-200 rounded text-xs" data-testid="filter-custom-until" />
          </div>
        )}
      </div>

      {visiblePending == null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : visiblePending.length === 0 ? (
        <div className="text-sm text-slate-500 flex items-center gap-2">
          <InboxIcon size={14} /> No new emails to review. Hit &quot;Scan Gmail now&quot; to fetch.
        </div>
      ) : (
        <ul className="space-y-2">
          {visiblePending.map((p) => (
            <li key={p.id} className={`border rounded p-3 ${p.status === 'dismissed' ? 'border-slate-200 bg-slate-50 opacity-80' : 'border-slate-200 bg-white'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate flex items-center gap-2">
                    {p.status === 'pending' && (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(p.id)}
                        onChange={() => toggleSelect(p.id)}
                        className="shrink-0"
                        data-testid={`row-select-${p.id}`}
                        aria-label={`Select email from ${p.from_email || p.from_name || 'unknown'}`}
                      />
                    )}
                    <span className="truncate">
                      {p.subject || '(no subject)'}
                      {p.flagged && <Star size={11} className="inline ml-1 text-amber-500 fill-amber-500" />}
                    </span>
                    {p.status === 'dismissed' && (
                      <span className="text-xs px-1.5 py-0.5 bg-slate-200 text-slate-700 rounded shrink-0" data-testid={`status-badge-${p.id}`}>
                        dismissed{p.dismissed_by === 'auto_junk' || p.dismissed_by === 'auto_ai' ? ' (auto)' : ''}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    From <span className="font-mono">{p.from_email || p.from_name || 'unknown'}</span>
                    {p.received_at && <> · {new Date(p.received_at).toLocaleString()}</>}
                  </div>
                  {p.snippet && <div className="text-sm text-slate-600 mt-1 line-clamp-2">{p.snippet}</div>}
                  {p.dismissed_reason && (
                    <div className="text-xs text-slate-500 mt-1 italic" title="auto-dismiss reason">
                      🤖 {p.dismissed_reason}
                    </div>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  {p.status === 'pending' && (
                    <button
                      className="btn-ghost text-xs flex items-center gap-1"
                      onClick={() => setPreviewId(p.id)}
                      disabled={busyId === p.id}
                      data-testid={`preview-btn-${p.id}`}
                      title="Preview this email as it would appear in the ticket"
                    >
                      <Eye size={11} /> Preview
                    </button>
                  )}
                  {p.status === 'pending' && (
                    <>
                      <button className="btn-primary text-xs" onClick={() => importOne(p.id)} disabled={busyId === p.id}>
                        Import
                      </button>
                      <button className="btn-ghost text-xs" onClick={() => dismiss(p.id)} disabled={busyId === p.id}>
                        Dismiss
                      </button>
                    </>
                  )}
                  {p.status === 'dismissed' && (
                    <button className="btn-secondary text-xs" onClick={() => restore(p.id)} disabled={busyId === p.id} data-testid={`restore-btn-${p.id}`}>
                      <RotateCcw size={11} /> Restore
                    </button>
                  )}
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

      {enrichmentMatch && (
        <ContactEnrichmentModal
          match={enrichmentMatch}
          onApply={() => setEnrichmentMatch(null)}
          onSkip={() => setEnrichmentMatch(null)}
          onClose={() => setEnrichmentMatch(null)}
        />
      )}

      {previewId && (
        <EmailPreviewModal
          pendingId={previewId}
          onClose={() => setPreviewId(null)}
        />
      )}
    </section>
  );
}
