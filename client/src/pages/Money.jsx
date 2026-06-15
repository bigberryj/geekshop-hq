import { useEffect, useState } from 'react';
import { fetchJson, formatMoney, postJson, patchJson } from '../lib/api.js';

export default function Money() {
  const [summary, setSummary] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [timeRevenue, setTimeRevenue] = useState([]);

  const load = async () => {
    setSummary(await fetchJson('/money/summary'));
    setInvoices(await fetchJson('/invoices'));
    setTimeRevenue(await fetchJson('/money/time-revenue'));
  };
  useEffect(() => { load(); }, []);

  if (!summary) return <div>Loading…</div>;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Money</h2>

      <div className="grid grid-cols-4 gap-3 mb-6">
        <Tile label="Outstanding" value={formatMoney(summary.outstanding.total)} sub={`${summary.outstanding.count} invoice(s)`} color="text-yellow-600" />
        <Tile label="Overdue" value={formatMoney(summary.overdue.total)} sub={`${summary.overdue.count} invoice(s)`} color="text-red-600" />
        <Tile label="Paid this month" value={formatMoney(summary.paid_this_month.total)} sub={`${summary.paid_this_month.count} invoice(s)`} color="text-green-600" />
        <Tile label="Drafts" value={formatMoney(summary.draft.total)} sub={`${summary.draft.count} invoice(s)`} color="text-slate-600" />
      </div>

      <h3 className="font-semibold mb-2">Invoices</h3>
      <div className="card overflow-hidden p-0 mb-6">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">ID</th>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Total</th>
              <th className="px-3 py-2">Due</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id} className="border-t">
                <td className="px-3 py-2 font-mono text-xs">{i.invoice_uid}</td>
                <td className="px-3 py-2">{i.customer_name}</td>
                <td className="px-3 py-2"><span className={`badge-${i.status === 'paid' ? 'green' : i.status === 'overdue' ? 'red' : i.status === 'draft' ? 'slate' : 'yellow'}`}>{i.status}</span></td>
                <td className="px-3 py-2 font-mono">{formatMoney(i.total_cents)}</td>
                <td className="px-3 py-2 text-xs">{i.due_at || '—'}</td>
                <td className="px-3 py-2 text-right">
                  {i.status === 'draft' && <button className="btn-ghost text-xs" onClick={async () => { await postJson(`/invoices/${i.id}/send`, {}); load(); }}>Send</button>}
                  {i.status !== 'paid' && i.status !== 'draft' && <button className="btn-ghost text-xs" onClick={async () => { await postJson(`/invoices/${i.id}/paid`, {}); load(); }}>Mark paid</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="font-semibold mb-2">Time revenue (last 30 days, est. $100/hr)</h3>
      <div className="card">
        {timeRevenue.length === 0 ? <p className="text-slate-500 text-sm">No time tracked yet.</p> : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr><th>Customer</th><th>Hours</th><th>Tickets</th><th>Est. revenue</th></tr>
            </thead>
            <tbody>
              {timeRevenue.map((r) => (
                <tr key={r.customer_id} className="border-t">
                  <td className="py-1.5">{r.customer_name}</td>
                  <td>{r.total_hours}h</td>
                  <td>{r.ticket_count}</td>
                  <td className="font-mono">{formatMoney(r.estimated_revenue_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, color }) {
  return (
    <div className="card">
      <div className="text-xs text-slate-500 uppercase">{label}</div>
      <div className={`text-2xl font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-slate-500">{sub}</div>
    </div>
  );
}
