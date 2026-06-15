import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchJson, formatMoney } from '../lib/api.js';
import TicketLabel from '../components/TicketLabel.jsx';
import GmailReviewQueue from '../components/GmailReviewQueue.jsx';
import NewTicketModal from '../components/NewTicketModal.jsx';
import { AlertCircle, Clock, DollarSign, Mail, CalendarClock, Activity, Plus } from 'lucide-react';

const SOURCES = [
  { key: '', label: 'All' },
  { key: 'email', label: 'Email' },
  { key: 'manual', label: 'Manual' },
  { key: 'booking', label: 'Booking' },
];

function latestRun(runs = []) {
  return runs.length ? runs[runs.length - 1] : null;
}

export default function Inbox() {
  const [data, setData] = useState(null);
  const [source, setSource] = useState('');
  const [showNew, setShowNew] = useState(false);
  const navigate = useNavigate();

  const loadDashboard = useCallback(() => {
    fetchJson(`/dashboard${source ? `?source=${source}` : ''}`).then(setData);
  }, [source]);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  if (!data) return <div>Loading…</div>;

  const onImported = (result) => {
    loadDashboard();
    if (result?.ticket?.id) navigate(`/tickets/${result.ticket.id}`);
  };

  const appointmentRun = latestRun(data.monitor_status?.appointments?.last_runs);
  const starredRun = latestRun(data.monitor_status?.starred_email_suggestions?.last_runs);

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-2">
        <h2 className="text-2xl font-bold">Inbox</h2>
        <button className="btn-primary flex items-center gap-1" onClick={() => setShowNew(true)}>
          <Plus size={14} /> New ticket
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <GmailReviewQueue onImported={onImported} />

        <Stat icon={AlertCircle} label="Open requests" value={data.open_tickets.length} color="text-blue-600" />
        <Stat icon={Clock} label="Today's appointments" value={data.today_appointments.length} color="text-purple-600" />
        <Stat icon={DollarSign} label="Overdue invoices" value={`${data.overdue_invoices.length} (${formatMoney(data.overdue_invoices.reduce((s, i) => s + i.total_cents, 0))})`} color="text-red-600" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className="card">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h3 className="font-semibold">Open requests</h3>
            <div className="flex flex-wrap gap-1">
              {SOURCES.map((s) => (
                <button
                  key={s.key || 'all'}
                  className={`px-2 py-1 rounded text-xs ${source === s.key ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                  onClick={() => setSource(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          {data.open_tickets.length === 0 ? <p className="text-slate-500 text-sm">All clear.</p> : (
            <ul className="space-y-2">
              {data.open_tickets.map((t) => (
                <li key={t.id}>
                  <Link to={`/tickets/${t.id}`} className="block hover:bg-slate-50 -mx-2 px-2 py-1 rounded">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{t.subject}</span>
                      <div className="flex items-center gap-1">
                        {t.source && <span className="badge-slate capitalize">{t.source}</span>}
                        <span className={`badge-${t.priority === 'urgent' ? 'red' : t.priority === 'high' ? 'yellow' : 'slate'}`}>{t.priority}</span>
                      </div>
                    </div>
                    <div className="text-xs text-slate-500"><TicketLabel ticket={t} compact /></div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h3 className="font-semibold mb-3">Today</h3>
          {data.today_appointments.length === 0 ? <p className="text-slate-500 text-sm">No appointments today.</p> : (
            <ul className="space-y-2">
              {data.today_appointments.map((a) => (
                <li key={a.id} className="text-sm">
                  <span className="font-mono mr-2">{new Date(a.starts_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  {a.customer_name || 'Walk-in'} <span className="text-slate-500">— {a.notes || '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h3 className="font-semibold mb-3">Overdue invoices</h3>
          {data.overdue_invoices.length === 0 ? <p className="text-slate-500 text-sm">All paid up.</p> : (
            <ul className="space-y-2">
              {data.overdue_invoices.map((i) => (
                <li key={i.id} className="flex items-center justify-between text-sm">
                  <span>{i.invoice_uid} · {i.customer_name}</span>
                  <span className="font-mono text-red-600">{formatMoney(i.total_cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h3 className="font-semibold mb-3">Customer health</h3>
          {data.top_customers.length === 0 ? <p className="text-slate-500 text-sm">No customers yet.</p> : (
            <ul className="space-y-2">
              {data.top_customers.map((c) => (
                <li key={c.id} className="flex items-center justify-between text-sm">
                  <Link to={`/customers/${c.id}`} className="hover:underline">{c.name}</Link>
                  <span className={`badge-${c.score > 70 ? 'green' : c.score >= 40 ? 'yellow' : 'red'}`}>{c.score}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h3 className="font-semibold mb-3 flex items-center gap-2"><CalendarClock size={16} /> Appointment monitor</h3>
          <StatusLine label="Pending slot choices" value={data.monitor_status?.appointments?.pending_count ?? 0} />
          <StatusLine label="Last run" value={appointmentRun?.ts || '—'} />
          <StatusLine label="Last status" value={appointmentRun?.status || '—'} />
          <p className="text-xs text-slate-500 mt-2">Read-only view of the hourly Gmail appointment monitor.</p>
        </section>

        <section className="card">
          <h3 className="font-semibold mb-3 flex items-center gap-2"><Mail size={16} /> Starred email suggestions</h3>
          <StatusLine label="Last run" value={starredRun?.timestamp || starredRun?.ts || '—'} />
          <StatusLine label="New suggestions" value={starredRun?.count ?? starredRun?.new_client_count ?? 0} />
          <StatusLine label="Sent report" value={String(starredRun?.sent ?? starredRun?.send_result ?? '—')} />
        </section>

        <section className="card md:col-span-2">
          <h3 className="font-semibold mb-3 flex items-center gap-2"><Activity size={16} /> Automation jobs</h3>
          <div className="text-sm text-slate-600 mb-2">{data.cron_status?.enabled_count ?? 0} enabled cron job(s)</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {(data.cron_status?.jobs || []).map((job) => (
              <div key={job.name} className="rounded border border-slate-200 p-2 text-xs">
                <div className="font-medium">{job.name}</div>
                <div className="text-slate-500">{job.last_status || 'unknown'} · next {job.next_run_at ? new Date(job.next_run_at).toLocaleString() : '—'}</div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <NewTicketModal open={showNew} onClose={() => setShowNew(false)} />
    </div>
  );
}

function Stat({ icon: Icon, label, value, color }) {
  return (
    <div className="card flex items-center gap-3">
      <Icon size={32} className={color} />
      <div>
        <div className="text-xs text-slate-500 uppercase">{label}</div>
        <div className="text-2xl font-semibold">{value}</div>
      </div>
    </div>
  );
}

function StatusLine({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm py-1 border-b border-slate-100 last:border-0">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono text-xs text-slate-700 text-right break-all">{value}</span>
    </div>
  );
}
