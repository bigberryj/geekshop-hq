import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { fetchJson, formatMoney } from '../lib/api.js';
import { Loader2, AlertCircle, Clock, Inbox, Mail, Receipt, Wallet, Calendar, Brain, Ticket, CheckCircle2, Filter, Hash } from 'lucide-react';

/**
 * Customer 360 timeline (Phase 2 of billing/accounting roadmap).
 *
 * Renders the unified event feed from `/api/customers/:id/timeline`.
 * Handles:
 *   - loading  → spinner + "Loading timeline…"
 *   - empty    → "No activity yet" + hint to send/reply to seed events
 *   - error    → red banner with the message + retry button
 *   - filter chips (per-kind counts) → re-queries with kinds=
 *   - sort-stable render (newest first; the server enforces ordering)
 *
 * The component is intentionally dumb about each event kind: it maps
 * `kind` to an icon + colour, but the unified shape (`title`, `summary`,
 * `href`, `meta`) keeps the JSX for the row itself generic.
 */

const KIND_META = {
  ticket_created:   { icon: Ticket,       color: 'slate',  label: 'Ticket' },
  ticket_resolved:  { icon: CheckCircle2, color: 'green',  label: 'Resolved' },
  ticket_message:   { icon: Mail,         color: 'yellow', label: 'Message' },
  appointment:      { icon: Calendar,     color: 'yellow', label: 'Appointment' },
  time_entry:       { icon: Clock,        color: 'slate',  label: 'Time' },
  invoice:          { icon: Receipt,      color: 'green',  label: 'Invoice' },
  payment:          { icon: Wallet,       color: 'green',  label: 'Payment' },
  memory:           { icon: Brain,        color: 'yellow', label: 'Memory' },
};

// Filter chip order — matches the "story arc" of customer support.
const FILTER_ORDER = [
  'ticket_message', 'ticket_created', 'ticket_resolved',
  'appointment', 'time_entry',
  'invoice', 'payment', 'memory',
];

function formatAt(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function EventRow({ ev }) {
  const meta = KIND_META[ev.kind] || { icon: Inbox, color: 'slate', label: ev.kind };
  const Icon = meta.icon;
  return (
    <li className="flex gap-3 py-3 border-b border-slate-100 last:border-0" data-testid={`timeline-event-${ev.kind}`}>
      <div className="shrink-0 mt-0.5">
        <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full bg-${meta.color}-100 text-${meta.color}-700`}>
          <Icon size={14} />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-sm font-medium text-slate-900 break-words min-w-0">
            {ev.href ? (
              <Link to={ev.href} className="hover:underline">{ev.title}</Link>
            ) : (
              ev.title
            )}
          </div>
          <div className="text-xs text-slate-400 shrink-0 whitespace-nowrap" data-testid="timeline-event-at">
            {formatAt(ev.at)}
          </div>
        </div>
        {ev.summary && (
          <p className="text-sm text-slate-600 mt-0.5 break-words whitespace-pre-wrap">{ev.summary}</p>
        )}
        {/* Per-kind meta tail — intentionally minimal. Numbers in
            `formatMoney`, lowercase enums, no Stripe / Gmail IDs. */}
        <div className="text-xs text-slate-400 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          {ev.kind === 'invoice' && ev.meta?.total_cents != null && (
            <span className="font-mono">{formatMoney(ev.meta.total_cents)}</span>
          )}
          {ev.kind === 'payment' && ev.meta?.amount_cents != null && (
            <span className="font-mono">{formatMoney(ev.meta.amount_cents)} · {ev.meta.method}</span>
          )}
          {ev.kind === 'time_entry' && (
            <span>
              {Math.floor((ev.meta.duration_seconds || 0) / 60)}m
              {ev.meta.running ? ' · running' : ''}
              {ev.meta.invoiced ? ' · invoiced' : ''}
            </span>
          )}
          {ev.kind === 'ticket_message' && ev.meta?.sender && (
            <span className="capitalize">{ev.meta.sender}{ev.meta.ai_draft ? ' · AI draft' : ''}</span>
          )}
          {ev.kind === 'memory' && ev.meta?.source && (
            <span>{ev.meta.source}{ev.meta.confidence < 1 ? ` · conf ${Math.round(ev.meta.confidence * 100)}%` : ''}</span>
          )}
        </div>
      </div>
    </li>
  );
}

export default function CustomerTimeline({ customerId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // null = all kinds (server default); otherwise Set of kind strings
  const [activeFilter, setActiveFilter] = useState(null);

  const load = async (kinds) => {
    setLoading(true);
    setError('');
    try {
      const qs = kinds && kinds.size > 0 ? `?kinds=${Array.from(kinds).join(',')}` : '';
      const d = await fetchJson(`/customers/${customerId}/timeline${qs}`);
      setData(d);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!customerId) return;
    load(activeFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, activeFilter === null ? 'all' : Array.from(activeFilter).sort().join(',')]);

  // Counts reflect the FULL eligible set (`counts` is computed on the
  // un-capped event list server-side). That's deliberate — chips should
  // reflect "how much of each type exists in this filter window", not
  // "what's currently visible". Re-fetching for every chip click is what
  // we already do, so the counts are always accurate.
  const chips = useMemo(() => {
    if (!data) return [];
    return FILTER_ORDER
      .filter((k) => data.counts[k] != null && data.counts[k] > 0)
      .map((k) => ({ kind: k, count: data.counts[k], ...KIND_META[k] }));
  }, [data]);

  const toggleKind = (kind) => {
    // null means "all"; clicking any chip pins to that single kind.
    if (activeFilter && activeFilter.size === 1 && activeFilter.has(kind)) {
      // Already filtered to just this one → toggle off back to "all".
      setActiveFilter(null);
      return;
    }
    setActiveFilter(new Set([kind]));
  };

  const allActive = activeFilter === null;

  if (loading && !data) {
    return (
      <div className="card flex items-center gap-2 text-sm text-slate-500" data-testid="timeline-loading">
        <Loader2 size={16} className="animate-spin" /> Loading timeline…
      </div>
    );
  }

  if (error) {
    return (
      <div className="card border-red-200 bg-red-50 text-sm text-red-700" data-testid="timeline-error">
        <div className="flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Couldn't load timeline</div>
            <div className="text-xs mt-0.5">{error}</div>
            <button
              type="button"
              className="btn-secondary text-xs mt-2"
              onClick={() => load(activeFilter)}
              data-testid="timeline-retry"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-3" data-testid="customer-timeline">
      <div className="flex items-center gap-2 flex-wrap" role="toolbar" aria-label="Filter timeline">
        <Filter size={14} className="text-slate-400" />
        <button
          type="button"
          onClick={() => setActiveFilter(null)}
          className={`btn-secondary text-xs ${allActive ? '!bg-brand-100 !text-brand-700' : ''}`}
          data-testid="timeline-filter-all"
        >
          <Hash size={12} /> All
        </button>
        {chips.map((c) => {
          const isActive = activeFilter && activeFilter.has(c.kind);
          return (
            <button
              key={c.kind}
              type="button"
              onClick={() => toggleKind(c.kind)}
              className={`btn-secondary text-xs ${isActive ? '!bg-brand-100 !text-brand-700' : ''}`}
              data-testid={`timeline-filter-${c.kind}`}
              title={c.label}
            >
              <c.icon size={12} /> {c.label} <span className="text-slate-400">({c.count})</span>
            </button>
          );
        })}
      </div>

      {data.events.length === 0 ? (
        <div className="card text-sm text-slate-500" data-testid="timeline-empty">
          <div className="flex items-start gap-2">
            <Inbox size={16} className="mt-0.5 shrink-0 text-slate-400" />
            <div>
              <div className="font-medium text-slate-700">No activity yet</div>
              <p className="text-xs mt-1">
                {allActive
                  ? 'Send a reply, log a ticket, or invoice this customer to seed the timeline.'
                  : 'No events of that type in the current window. Try another chip or "All".'}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="card">
          <ul className="divide-y divide-slate-100">
            {data.events.map((ev) => (
              <EventRow key={ev.id} ev={ev} />
            ))}
          </ul>
          <div className="text-xs text-slate-400 mt-2">
            Showing {data.events.length} event{data.events.length === 1 ? '' : 's'}.
          </div>
        </div>
      )}
    </div>
  );
}
