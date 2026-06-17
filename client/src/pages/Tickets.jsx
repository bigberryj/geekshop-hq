import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchJson } from '../lib/api.js';
import TicketLabel from '../components/TicketLabel.jsx';
import NewTicketModal from '../components/NewTicketModal.jsx';

const ALL_STATUSES = ['open', 'pending', 'resolved'];
const DEFAULT_STATUSES = ['open', 'pending'];

function readStatusesFromHash() {
  if (typeof window === 'undefined') return DEFAULT_STATUSES;
  const raw = window.location.hash || '';
  const match = raw.match(/status=([^&]+)/);
  if (!match) return DEFAULT_STATUSES;
  const parsed = match[1].split(',').map((s) => s.trim()).filter((s) => ALL_STATUSES.includes(s));
  return parsed.length > 0 ? parsed : DEFAULT_STATUSES;
}

function writeStatusesToHash(statuses) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  if (statuses.length === ALL_STATUSES.length) params.delete('status');
  else params.set('status', statuses.join(','));
  const next = params.toString();
  const newHash = next ? `#${next}` : '';
  if (newHash !== window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname + newHash);
  }
}

export default function Tickets() {
  const [tickets, setTickets] = useState([]);
  const [statuses, setStatuses] = useState(readStatusesFromHash);
  const [showNew, setShowNew] = useState(false);

  // Build the query. When all three are checked we send no `status` to
  // the server so the SQL stays simple.
  const query = (() => {
    if (statuses.length === 0 || statuses.length === ALL_STATUSES.length) return '';
    return `?status=${statuses.join(',')}`;
  })();

  const load = () => fetchJson(`/tickets${query}`).then(setTickets);
  useEffect(() => { load(); }, [query]);
  useEffect(() => { writeStatusesToHash(statuses); }, [statuses]);

  const toggleStatus = (s) => {
    setStatuses((prev) => {
      if (prev.includes(s)) {
        // Don't allow zero selections — fall back to the default so the
        // table never shows a confusing empty state for an empty filter.
        const next = prev.filter((x) => x !== s);
        return next.length === 0 ? DEFAULT_STATUSES : next;
      }
      return [...prev, s];
    });
  };

  const setOnly = (s) => setStatuses([s]);
  const showAll = () => setStatuses(ALL_STATUSES);

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-2 flex-wrap">
        <h2 className="text-2xl font-bold">Tickets</h2>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-sm" data-testid="ticket-status-filter">
            {ALL_STATUSES.map((s) => (
              <label key={s} className={`badge-${s === 'open' ? 'green' : s === 'pending' ? 'yellow' : 'slate'} cursor-pointer select-none px-2 py-1`}
                style={{ opacity: statuses.includes(s) ? 1 : 0.45 }}
                data-testid={`ticket-status-toggle-${s}`}
              >
                <input
                  type="checkbox"
                  className="mr-1 align-middle"
                  checked={statuses.includes(s)}
                  onChange={() => toggleStatus(s)}
                />
                {s}
              </label>
            ))}
            <button
              type="button"
              className="text-xs text-slate-500 hover:underline ml-1"
              onClick={showAll}
              data-testid="ticket-status-show-all"
            >
              show all
            </button>
          </div>
          <button className="btn-primary" onClick={() => setShowNew(true)}>+ New ticket</button>
        </div>
      </div>
      <div className="text-xs text-slate-500 mb-2" data-testid="ticket-filter-summary">
        {statuses.length === ALL_STATUSES.length
          ? 'Showing all tickets (open, pending, resolved).'
          : `Showing ${statuses.join(' + ')} tickets. Resolved tickets are hidden — reopen to see them here.`}
      </div>
      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">Subject</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Priority</th>
              <th className="px-3 py-2">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => (
              <tr key={t.id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2"><TicketLabel ticket={t} /></td>
                <td className="px-3 py-2"><span className={`badge-${t.status === 'open' ? 'green' : t.status === 'pending' ? 'yellow' : 'slate'}`}>{t.status}</span></td>
                <td className="px-3 py-2"><span className={`badge-${t.priority === 'urgent' ? 'red' : t.priority === 'high' ? 'yellow' : 'slate'}`}>{t.priority}</span></td>
                <td className="px-3 py-2 text-slate-500 text-xs">{t.last_message_at ? new Date(t.last_message_at).toLocaleString() : '—'}</td>
              </tr>
            ))}
            {tickets.length === 0 && <tr><td colSpan="4" className="px-3 py-4 text-center text-slate-500">No tickets match the current filter.</td></tr>}
          </tbody>
        </table>
      </div>
      <NewTicketModal open={showNew} onClose={() => { setShowNew(false); load(); }} />
    </div>
  );
}
