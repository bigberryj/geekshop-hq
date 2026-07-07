import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchJson, postJson } from '../lib/api.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import { Plus, X } from 'lucide-react';

export default function Customers() {
  const [customers, setCustomers] = useState([]);
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ name: '', company: '', email: '', phone: '', notes: '' });

  const load = () => fetchJson(`/customers${search ? `?search=${encodeURIComponent(search)}` : ''}`).then(setCustomers);
  useEffect(() => { load(); }, [search]);

  const create = async (e) => {
    e.preventDefault();
    await postJson('/customers', form);
    setShowNew(false);
    setForm({ name: '', company: '', email: '', phone: '', notes: '' });
    load();
  };

  const columns = [
    {
      key: 'name',
      header: 'Name',
      primary: true,
      render: (c) => (
        <Link to={`/customers/${c.id}`} className="text-brand-600 hover:underline font-medium break-words">
          {c.name}
        </Link>
      ),
    },
    { key: 'company', header: 'Company', hideOnMobile: true, render: (c) => <span className="text-slate-600">{c.company || '—'}</span> },
    { key: 'email',   header: 'Email',   hideOnMobile: true, render: (c) => <span className="text-slate-600 break-words">{c.email || '—'}</span> },
    { key: 'total_tickets', header: 'Tickets', hideOnMobile: true, align: 'right' },
    { key: 'memory_count',  header: 'Memory',  hideOnMobile: true, align: 'right' },
    {
      key: 'health_band',
      header: 'Health',
      hideOnMobile: true,
      render: (c) => <span className={`badge-${c.health_band}`}>{c.health_score}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Customers"
        actions={
          <>
            <input
              className="input flex-1 min-w-[140px] max-w-md tap-target"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search customers"
            />
            <button
              className="btn-primary tap-target"
              onClick={() => setShowNew((s) => !s)}
            >
              {showNew
                ? (<><X size={14} /> Cancel</>)
                : (<><Plus size={14} /> New</>)}
            </button>
          </>
        }
      />

      {showNew && (
        <form onSubmit={create} className="card mb-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Name</label>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </div>
          <div>
            <label className="label">Company</label>
            <input className="input" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          </div>
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <label className="label">Phone</label>
            <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Notes</label>
            <textarea className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <div className="sm:col-span-2 flex flex-wrap gap-2">
            <button className="btn-primary tap-target" type="submit">Create customer</button>
            <button className="btn-secondary tap-target" type="button" onClick={() => setShowNew(false)}>Cancel</button>
          </div>
        </form>
      )}

      <DataTable
        columns={columns}
        rows={customers}
        rowKey="id"
        empty="No customers yet — click + New to add one."
      />
    </div>
  );
}
