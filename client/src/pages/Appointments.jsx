import { useEffect, useState } from 'react';
import { fetchJson, postJson, patchJson } from '../lib/api.js';

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

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Appointments</h2>
        <button className="btn-primary" onClick={() => setShowNew(!showNew)}>{showNew ? 'Cancel' : '+ New'}</button>
      </div>

      {showNew && (
        <form onSubmit={create} className="card mb-4 grid grid-cols-2 gap-3">
          <div><label className="label">Customer name</label><input className="input" value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} required /></div>
          <div><label className="label">Customer email</label><input className="input" type="email" value={form.customer_email} onChange={(e) => setForm({ ...form, customer_email: e.target.value })} required /></div>
          <div><label className="label">Starts at</label><input className="input" type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} required /></div>
          <div><label className="label">Ends at</label><input className="input" type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} required /></div>
          <div className="col-span-2"><label className="label">Notes</label><input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          <div className="col-span-2"><button className="btn-primary" type="submit">Create</button></div>
        </form>
      )}

      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Notes</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {appts.map((a) => (
              <tr key={a.id} className="border-t">
                <td className="px-3 py-2 text-xs">{new Date(a.starts_at).toLocaleString()}</td>
                <td className="px-3 py-2">{a.customer_name || '—'}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{a.notes || '—'}</td>
                <td className="px-3 py-2"><span className={`badge-${a.status === 'confirmed' ? 'green' : a.status === 'completed' ? 'slate' : 'yellow'}`}>{a.status}</span></td>
                <td className="px-3 py-2 text-right">
                  {a.status === 'scheduled' && <button className="btn-ghost text-xs" onClick={() => setStatus(a.id, 'confirmed')}>Confirm</button>}
                  {a.status !== 'completed' && <button className="btn-ghost text-xs" onClick={() => setStatus(a.id, 'completed')}>Complete</button>}
                </td>
              </tr>
            ))}
            {appts.length === 0 && <tr><td colSpan="5" className="px-3 py-4 text-center text-slate-500">No appointments</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
