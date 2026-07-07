import { useEffect, useState } from 'react';
import { fetchJson, postJson, patchJson } from '../lib/api.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import { Plus, X } from 'lucide-react';

function statusBadge(status) {
  return `badge-${status === 'confirmed' ? 'green' : status === 'completed' ? 'slate' : 'yellow'}`;
}

export default function Appointments() {
  const [appts, setAppts] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ customer_id: '', customer_name: '', customer_email: '', starts_at: '', ends_at: '', notes: '' });

  const load = () => fetchJson('/appointments').then(setAppts);
  useEffect(() => { load(); }, []);

  const create = async (e) => {
    e.preventDefault();
    await postJson('/appointments', form);
    setShowNew(false);
    setForm({ customer_id: '', customer_name: '', customer_email: '', starts_at: '', ends_at: '', notes: '' });
    load();
  };

  const setStatus = async (id, status) => {
    await patchJson(`/appointments/${id}`, { status });
    load();
  };

  const columns = [
    {
      key: 'starts_at',
      header: 'When',
      primary: true,
      render: (a) => <span className="text-xs">{new Date(a.starts_at).toLocaleString()}</span>,
    },
    { key: 'customer_name', header: 'Customer', hideOnMobile: true, render: (a) => a.customer_name || '—' },
    { key: 'notes', header: 'Notes', hideOnMobile: true, render: (a) => <span className="text-slate-500 text-xs break-words">{a.notes || '—'}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (a) => <span className={statusBadge(a.status)}>{a.status}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (a) => (
        <div className="flex flex-wrap justify-end gap-1">
          {a.status === 'scheduled' && (
            <button className="btn-ghost text-xs tap-target" onClick={() => setStatus(a.id, 'confirmed')}>Confirm</button>
          )}
          {a.status !== 'completed' && (
            <button className="btn-ghost text-xs tap-target" onClick={() => setStatus(a.id, 'completed')}>Complete</button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Appointments"
        actions={
          <button className="btn-primary tap-target" onClick={() => setShowNew((s) => !s)}>
            {showNew ? (<><X size={14} /> Cancel</>) : (<><Plus size={14} /> New</>)}
          </button>
        }
      />

      {showNew && (
        <form onSubmit={create} className="card mb-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Customer name</label>
            <input className="input" value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} required />
          </div>
          <div>
            <label className="label">Customer email</label>
            <input className="input" type="email" value={form.customer_email} onChange={(e) => setForm({ ...form, customer_email: e.target.value })} required />
          </div>
          <div>
            <label className="label">Starts at</label>
            <input className="input" type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} required />
          </div>
          <div>
            <label className="label">Ends at</label>
            <input className="input" type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} required />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Notes</label>
            <input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <div className="sm:col-span-2 flex flex-wrap gap-2">
            <button className="btn-primary tap-target" type="submit">Create appointment</button>
            <button className="btn-secondary tap-target" type="button" onClick={() => setShowNew(false)}>Cancel</button>
          </div>
        </form>
      )}

      <DataTable
        columns={columns}
        rows={appts}
        rowKey="id"
        empty="No appointments yet."
      />
    </div>
  );
}
