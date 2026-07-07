import { useEffect, useState } from 'react';
import { fetchJson, formatMoney, postJson } from '../lib/api.js';
import InvoiceDraftModal from '../components/InvoiceDraftModal.jsx';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';

export default function Money() {
  const [summary, setSummary] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [timeRevenue, setTimeRevenue] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [settings, setSettings] = useState({});
  const [busy, setBusy] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [draftFor, setDraftFor] = useState(null); // customer object when modal is open

  const load = async () => {
    const [s, inv, tr, cust, set] = await Promise.all([
      fetchJson('/money/summary'),
      fetchJson('/invoices'),
      fetchJson('/money/time-revenue'),
      fetchJson('/customers'),
      fetchJson('/settings'),
    ]);
    setSummary(s);
    setInvoices(inv);
    setTimeRevenue(tr);
    setCustomers(cust);
    setSettings(set);
  };
  useEffect(() => { load(); }, []);

  const onCreated = (invoice) => {
    load();
    setDraftFor(null);
  };

  const draftFromTime = async (customerId) => {
    // New flow: open the draft modal. The modal calls the draft endpoint,
    // lets you toggle/override the minimum charge, and creates the invoice
    // on confirm. The old auto-create flow is gone — you wanted to see the
    // math (especially the floor) before committing.
    const cust = customers.find((c) => c.id === customerId);
    if (cust) setDraftFor(cust);
  };

  if (!summary) return <div>Loading…</div>;
  const rate = summary.labour_rate_cents_per_hour ?? 10000;
  const ratePerHour = (rate / 100).toFixed(2);

  const invoiceStatusBadge = (status) => {
    if (status === 'paid') return 'badge-green';
    if (status === 'overdue') return 'badge-red';
    if (status === 'draft') return 'badge-slate';
    return 'badge-yellow';
  };

  const invoiceColumns = [
    {
      key: 'invoice_uid',
      header: 'ID',
      primary: true,
      render: (i) => <span className="font-mono text-xs">{i.invoice_uid}</span>,
    },
    { key: 'customer_name', header: 'Customer', hideOnMobile: true },
    {
      key: 'status',
      header: 'Status',
      render: (i) => <span className={invoiceStatusBadge(i.status)}>{i.status}</span>,
    },
    { key: 'subtotal_cents', header: 'Subtotal', hideOnMobile: true, align: 'right', render: (i) => <span className="font-mono">{formatMoney(i.subtotal_cents)}</span> },
    { key: 'tax_cents',      header: 'Tax',      hideOnMobile: true, align: 'right', render: (i) => <span className="font-mono text-slate-600">{formatMoney(i.tax_cents)}</span> },
    { key: 'total_cents',    header: 'Total',    align: 'right', render: (i) => <span className="font-mono font-semibold">{formatMoney(i.total_cents)}</span> },
    { key: 'due_at',         header: 'Due',      hideOnMobile: true, render: (i) => <span className="text-xs">{i.due_at || '—'}</span> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (i) => (
        <div className="flex flex-wrap justify-end gap-1">
          <a className="btn-ghost text-xs tap-target" href={`/api/invoices/${i.id}/print`} target="_blank" rel="noreferrer">Print/PDF</a>
          {i.status === 'draft' && (
            <button
              className="btn-ghost text-xs tap-target"
              onClick={async () => { await postJson(`/invoices/${i.id}/send`, {}); load(); }}
            >
              Send
            </button>
          )}
          {i.status !== 'paid' && i.status !== 'draft' && (
            <button
              className="btn-ghost text-xs tap-target"
              onClick={async () => { await postJson(`/invoices/${i.id}/paid`, {}); load(); }}
            >
              Mark paid
            </button>
          )}
        </div>
      ),
    },
  ];

  const timeRevenueColumns = [
    { key: 'customer_name', header: 'Customer', primary: true, render: (r) => r.customer_name },
    { key: 'total_hours', header: 'Hours', align: 'right', render: (r) => <span className="font-mono">{r.total_hours}h</span> },
    { key: 'ticket_count', header: 'Tickets', align: 'right', hideOnMobile: true, render: (r) => r.ticket_count },
    { key: 'estimated_revenue_cents', header: 'Est. revenue', align: 'right', render: (r) => <span className="font-mono">{formatMoney(r.estimated_revenue_cents)}</span> },
  ];

  return (
    <div>
      <PageHeader title="Money" />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Tile label="Outstanding" value={formatMoney(summary.outstanding.total)} sub={`${summary.outstanding.count} invoice(s)`} color="text-yellow-600" />
        <Tile label="Overdue" value={formatMoney(summary.overdue.total)} sub={`${summary.overdue.count} invoice(s)`} color="text-red-600" />
        <Tile label="Paid this month" value={formatMoney(summary.paid_this_month.total)} sub={`${summary.paid_this_month.count} invoice(s)`} color="text-green-600" />
        <Tile label="Drafts" value={formatMoney(summary.draft.total)} sub={`${summary.draft.count} invoice(s)`} color="text-slate-600" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <section className="card">
          <h3 className="font-semibold mb-2">Billing settings</h3>
          <div className="text-sm space-y-1">
            <div><span className="text-slate-500">Default tax model:</span> <span className="font-mono break-all">{summary.default_tax_model || 'gst_pst_bc'}</span></div>
            <div><span className="text-slate-500">Labour rate:</span> ${ratePerHour}/hr</div>
            <p className="text-xs text-slate-500 mt-2">Change in <a className="text-brand-600 hover:underline" href="/settings">Settings → Billing & tax</a>.</p>
          </div>
        </section>
        <section className="card">
          <h3 className="font-semibold mb-2">Draft invoice from time</h3>
          <p className="text-xs text-slate-500 mb-2">
            Pulls a customer's un-invoiced time entries, multiplies by your labour rate, optionally applies
            your private minimum charge, and shows a preview before creating. The minimum charge is silently
            folded into the labour lines — the customer never sees a "minimum" line on the invoice.
          </p>
          {draftError && <div className="text-xs text-red-600 mb-2">{draftError}</div>}
          <div className="flex flex-wrap gap-2">
            {customers.map((c) => (
              <button
                key={c.id}
                className="btn-secondary text-xs tap-target"
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
      <DataTable
        columns={invoiceColumns}
        rows={invoices}
        rowKey="id"
        empty="No invoices yet."
        cardClassName="text-sm"
      />

      <h3 className="font-semibold mb-2 mt-6">Time revenue (last 30 days)</h3>
      <p className="text-xs text-slate-500 mb-2">At ${ratePerHour}/hr (your configured rate).</p>
      <DataTable
        columns={timeRevenueColumns}
        rows={timeRevenue?.rows || []}
        rowKey="customer_id"
        empty="No time tracked yet."
      />

      {draftFor && (
        <InvoiceDraftModal
          customer={draftFor}
          onClose={() => setDraftFor(null)}
          onCreated={onCreated}
          configuredFloorCents={Number(settings.minimum_charge_cents) || 0}
        />
      )}
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
