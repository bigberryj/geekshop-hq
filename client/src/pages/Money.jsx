import { useEffect, useState } from 'react';
import { fetchJson, formatMoney, postJson } from '../lib/api.js';

export default function Money() {
  const [summary, setSummary] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [timeRevenue, setTimeRevenue] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [draftError, setDraftError] = useState('');

  const load = async () => {
    const [s, inv, tr, cust] = await Promise.all([
      fetchJson('/money/summary'),
      fetchJson('/invoices'),
      fetchJson('/money/time-revenue'),
      fetchJson('/customers'),
    ]);
    setSummary(s);
    setInvoices(inv);
    setTimeRevenue(tr);
    setCustomers(cust);
  };
  useEffect(() => { load(); }, []);

  const draftFromTime = async (customerId) => {
    setBusy(true);
    setDraftError('');
    try {
      const draft = await postJson('/invoices/draft-from-time', { customer_id: customerId });
      // Auto-create the invoice
      const created = await postJson('/invoices', {
        customer_id: customerId,
        line_items: draft.line_items,
        tax_model: draft.tax_model_key,
      });
      // Mark the time entries as invoiced so they don't show again
      const timeEntryIds = draft.line_items
        .map((li) => li.source_time_entry_id)
        .filter(Boolean);
      if (timeEntryIds.length) {
        await postJson('/time-entries/mark-invoiced', { time_entry_ids: timeEntryIds });
      }
      load();
      // Open the new invoice's print view in a new tab
      window.open(`/api/invoices/${created.id}/print`, '_blank');
    } catch (e) {
      setDraftError(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!summary) return <div>Loading…</div>;
  const rate = summary.labour_rate_cents_per_hour ?? 10000;
  const ratePerHour = (rate / 100).toFixed(2);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Money</h2>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Tile label="Outstanding" value={formatMoney(summary.outstanding.total)} sub={`${summary.outstanding.count} invoice(s)`} color="text-yellow-600" />
        <Tile label="Overdue" value={formatMoney(summary.overdue.total)} sub={`${summary.overdue.count} invoice(s)`} color="text-red-600" />
        <Tile label="Paid this month" value={formatMoney(summary.paid_this_month.total)} sub={`${summary.paid_this_month.count} invoice(s)`} color="text-green-600" />
        <Tile label="Drafts" value={formatMoney(summary.draft.total)} sub={`${summary.draft.count} invoice(s)`} color="text-slate-600" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <section className="card">
          <h3 className="font-semibold mb-2">Billing settings</h3>
          <div className="text-sm">
            <div><span className="text-slate-500">Default tax model:</span> <span className="font-mono">{summary.default_tax_model || 'gst_pst_bc'}</span></div>
            <div><span className="text-slate-500">Labour rate:</span> ${ratePerHour}/hr</div>
            <p className="text-xs text-slate-500 mt-2">Change in <a className="text-brand-600 hover:underline" href="/settings">Settings → Billing & tax</a>.</p>
          </div>
        </section>
        <section className="card">
          <h3 className="font-semibold mb-2">Draft invoice from time</h3>
          <p className="text-xs text-slate-500 mb-2">Pulls a customer's un-invoiced time entries, multiplies by your labour rate, applies the default tax model, and opens the printable invoice.</p>
          {draftError && <div className="text-xs text-red-600 mb-2">{draftError}</div>}
          <div className="flex flex-wrap gap-2">
            {customers.map((c) => (
              <button
                key={c.id}
                className="btn-secondary text-xs"
                onClick={() => draftFromTime(c.id)}
                disabled={busy}
              >
                {busy ? 'Working…' : c.name}
              </button>
            ))}
          </div>
        </section>
      </div>

      <h3 className="font-semibold mb-2">Invoices</h3>
      <div className="card overflow-hidden p-0 mb-6">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">ID</th>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Subtotal</th>
              <th className="px-3 py-2">Tax</th>
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
                <td className="px-3 py-2 font-mono">{formatMoney(i.subtotal_cents)}</td>
                <td className="px-3 py-2 font-mono text-slate-600">{formatMoney(i.tax_cents)}</td>
                <td className="px-3 py-2 font-mono font-semibold">{formatMoney(i.total_cents)}</td>
                <td className="px-3 py-2 text-xs">{i.due_at || '—'}</td>
                <td className="px-3 py-2 text-right">
                  <a className="btn-ghost text-xs" href={`/api/invoices/${i.id}/print`} target="_blank" rel="noreferrer">Print/PDF</a>
                  {i.status === 'draft' && <button className="btn-ghost text-xs" onClick={async () => { await postJson(`/invoices/${i.id}/send`, {}); load(); }}>Send</button>}
                  {i.status !== 'paid' && i.status !== 'draft' && <button className="btn-ghost text-xs" onClick={async () => { await postJson(`/invoices/${i.id}/paid`, {}); load(); }}>Mark paid</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="font-semibold mb-2">Time revenue (last 30 days)</h3>
      <p className="text-xs text-slate-500 mb-2">At ${ratePerHour}/hr (your configured rate).</p>
      <div className="card">
        {!timeRevenue || timeRevenue.rows.length === 0 ? <p className="text-slate-500 text-sm">No time tracked yet.</p> : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr><th>Customer</th><th>Hours</th><th>Tickets</th><th>Est. revenue</th></tr>
            </thead>
            <tbody>
              {timeRevenue.rows.map((r) => (
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
