import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchJson, delJson, postJson } from '../lib/api.js';
import TicketLabel from '../components/TicketLabel.jsx';
import NewTicketModal from '../components/NewTicketModal.jsx';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import { Plus, Trash2, RotateCcw, Eye, EyeOff } from 'lucide-react';

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

// Badge class resolution kept inline so the DataTable render fn stays terse.
function statusBadge(status) {
  return `badge-${status === 'open' ? 'green' : status === 'pending' ? 'yellow' : 'slate'}`;
}
function priorityBadge(priority) {
  return `badge-${priority === 'urgent' ? 'red' : priority === 'high' ? 'yellow' : 'slate'}`;
}

export default function Tickets() {
  const [tickets, setTickets] = useState([]);
  const [statuses, setStatuses] = useState(readStatusesFromHash);
  const [showNew, setShowNew] = useState(false);
  // "Trash" toggle. When on, the list surfaces soft-deleted tickets and
  // every row gets a Restore button instead of a Delete button.
  const [showDeleted, setShowDeleted] = useState(false);
  const [busyId, setBusyId] = useState(null);

  // Build the query. When all three are checked we send no `status` to
  // the server so the SQL stays simple. `include_deleted=true` is sent
  // whenever the trash toggle is on.
  const query = (() => {
    const params = new URLSearchParams();
    if (statuses.length > 0 && statuses.length < ALL_STATUSES.length) {
      params.set('status', statuses.join(','));
    }
    if (showDeleted) params.set('include_deleted', 'true');
    const s = params.toString();
    return s ? `?${s}` : '';
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

  const deleteTicket = async (t) => {
    if (!window.confirm(
      `Delete ticket "${t.subject}"?\n\n` +
      `This hides it from the default view but keeps the audit log, customer history, and any time entries. ` +
      `You can restore it from the trash view.`,
    )) return;
    setBusyId(t.id);
    try {
      await delJson(`/tickets/${t.id}`);
      await load();
    } catch (e) {
      alert(`Delete failed: ${e?.response?.data?.error || e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const restoreTicket = async (t) => {
    setBusyId(t.id);
    try {
      await postJson(`/tickets/${t.id}/restore`, {});
      await load();
    } catch (e) {
      alert(`Restore failed: ${e?.response?.data?.error || e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  // DataTable columns. `primary: true` lifts the subject line to be the card
  // header on mobile. `hideOnMobile: true` collapses secondary columns out
  // of the card view but keeps them on the desktop table.
  const columns = [
    {
      key: 'subject',
      header: 'Subject',
      primary: true,
      render: (t) => (
        <div className="min-w-0">
          <Link to={`/tickets/${t.id}`} className="text-brand-600 hover:underline font-medium block truncate">
            {t.subject}
          </Link>
          <div className="text-xs text-slate-500 truncate"><TicketLabel ticket={t} compact /></div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (t) => (
        <span className="flex items-center gap-1">
          <span className={statusBadge(t.status)}>{t.status}</span>
          {t.deleted_at && <span className="badge-slate" title="Soft-deleted; hidden from default views">deleted</span>}
        </span>
      ),
    },
    {
      key: 'priority',
      header: 'Priority',
      hideOnMobile: true,
      render: (t) => <span className={priorityBadge(t.priority)}>{t.priority}</span>,
    },
    {
      key: 'last_message_at',
      header: 'Last activity',
      hideOnMobile: true,
      render: (t) => <span className="text-slate-500 text-xs">{t.last_message_at ? new Date(t.last_message_at).toLocaleString() : '—'}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      hideOnMobile: true,
      render: (t) => {
        if (t.deleted_at) {
          return (
            <button
              className="btn-ghost text-xs text-brand-600 inline-flex items-center gap-1"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); restoreTicket(t); }}
              disabled={busyId === t.id}
              data-testid={`ticket-restore-${t.id}`}
              title="Restore this ticket to the default list view"
            >
              <RotateCcw size={12} /> Restore
            </button>
          );
        }
        return (
          <button
            className="btn-ghost text-xs text-red-600 inline-flex items-center gap-1"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); deleteTicket(t); }}
            disabled={busyId === t.id}
            data-testid={`ticket-delete-${t.id}`}
            title="Soft-delete this ticket. The audit log and customer history are kept; you can restore it from the trash view."
          >
            <Trash2 size={12} /> Delete
          </button>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Tickets"
        actions={
          <>
            <div className="flex items-center gap-2 text-sm flex-wrap" data-testid="ticket-status-filter">
              {ALL_STATUSES.map((s) => (
                <label
                  key={s}
                  className={`${statusBadge(s)} cursor-pointer select-none px-2 py-1 tap-target inline-flex items-center`}
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
                className="text-xs text-slate-500 hover:underline ml-1 tap-target px-2"
                onClick={showAll}
                data-testid="ticket-status-show-all"
              >
                show all
              </button>
            </div>
            <button
              type="button"
              className="btn-secondary tap-target text-xs"
              onClick={() => setShowDeleted((v) => !v)}
              data-testid="ticket-show-deleted"
              title={showDeleted ? 'Hide soft-deleted tickets' : 'Show soft-deleted tickets (trash view)'}
            >
              {showDeleted ? <EyeOff size={14} /> : <Eye size={14} />}
              {showDeleted ? 'Hide trash' : 'Show trash'}
            </button>
            <button className="btn-primary tap-target" onClick={() => setShowNew(true)}>
              <Plus size={14} /> New ticket
            </button>
          </>
        }
      />
      <div className="text-xs text-slate-500 mb-2" data-testid="ticket-filter-summary">
        {statuses.length === ALL_STATUSES.length
          ? 'Showing all tickets (open, pending, resolved).'
          : `Showing ${statuses.join(' + ')} tickets. Resolved tickets are hidden — reopen to see them here.`}
        {showDeleted && ' Showing soft-deleted (trash view) — use Restore to bring a ticket back.'}
      </div>
      <DataTable
        columns={columns}
        rows={tickets}
        rowKey="id"
        empty={showDeleted ? 'No tickets in the trash.' : 'No tickets match the current filter.'}
      />
      <NewTicketModal open={showNew} onClose={() => { setShowNew(false); load(); }} />
    </div>
  );
}
