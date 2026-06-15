import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchJson, formatMoney } from '../lib/api.js';
import { AlertCircle, Clock, DollarSign } from 'lucide-react';

export default function Inbox() {
  const [data, setData] = useState(null);
  useEffect(() => { fetchJson('/dashboard').then(setData); }, []);

  if (!data) return <div>Loading…</div>;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Inbox</h2>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Stat icon={AlertCircle} label="Open tickets" value={data.open_tickets.length} color="text-blue-600" />
        <Stat icon={Clock} label="Today's appointments" value={data.today_appointments.length} color="text-purple-600" />
        <Stat icon={DollarSign} label="Overdue invoices" value={`${data.overdue_invoices.length} (${formatMoney(data.overdue_invoices.reduce((s, i) => s + i.total_cents, 0))})`} color="text-red-600" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className="card">
          <h3 className="font-semibold mb-3">Open tickets</h3>
          {data.open_tickets.length === 0 ? <p className="text-slate-500 text-sm">All clear.</p> : (
            <ul className="space-y-2">
              {data.open_tickets.map((t) => (
                <li key={t.id}>
                  <Link to={`/tickets/${t.id}`} className="block hover:bg-slate-50 -mx-2 px-2 py-1 rounded">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{t.subject}</span>
                      <span className={`badge-${t.priority === 'urgent' ? 'red' : t.priority === 'high' ? 'yellow' : 'slate'}`}>{t.priority}</span>
                    </div>
                    <div className="text-xs text-slate-500">{t.ticket_uid} · {t.customer_name}</div>
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
      </div>
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
