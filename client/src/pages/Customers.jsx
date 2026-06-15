import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchJson, postJson } from '../lib/api.js';

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

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-3">
        <h2 className="text-2xl font-bold">Customers</h2>
        <input className="input flex-1 max-w-md" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="btn-primary" onClick={() => setShowNew(!showNew)}>{showNew ? 'Cancel' : '+ New'}</button>
      </div>

      {showNew && (
        <form onSubmit={create} className="card mb-4 grid grid-cols-2 gap-3">
          <div><label className="label">Name</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
          <div><label className="label">Company</label><input className="input" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} /></div>
          <div><label className="label">Email</label><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div><label className="label">Phone</label><input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
          <div className="col-span-2"><label className="label">Notes</label><textarea className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          <div className="col-span-2"><button className="btn-primary" type="submit">Create</button></div>
        </form>
      )}

      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Company</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Tickets</th>
              <th className="px-3 py-2">Memory</th>
              <th className="px-3 py-2">Health</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2"><Link to={`/customers/${c.id}`} className="text-brand-600 hover:underline font-medium">{c.name}</Link></td>
                <td className="px-3 py-2 text-slate-600">{c.company || '—'}</td>
                <td className="px-3 py-2 text-slate-600">{c.email || '—'}</td>
                <td className="px-3 py-2">{c.total_tickets}</td>
                <td className="px-3 py-2">{c.memory_count}</td>
                <td className="px-3 py-2"><span className={`badge-${c.health_band}`}>{c.health_score}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
