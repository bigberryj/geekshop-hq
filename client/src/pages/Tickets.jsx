import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchJson } from '../lib/api.js';

export default function Tickets() {
  const [tickets, setTickets] = useState([]);
  const [status, setStatus] = useState('');
  useEffect(() => { fetchJson(`/tickets${status ? `?status=${status}` : ''}`).then(setTickets); }, [status]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Tickets</h2>
        <select className="input w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          <option value="open">Open</option>
          <option value="pending">Pending</option>
          <option value="resolved">Resolved</option>
        </select>
      </div>
      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">ID</th>
              <th className="px-3 py-2">Subject</th>
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Priority</th>
              <th className="px-3 py-2">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => (
              <tr key={t.id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-xs">{t.ticket_uid}</td>
                <td className="px-3 py-2"><Link to={`/tickets/${t.id}`} className="text-brand-600 hover:underline">{t.subject}</Link></td>
                <td className="px-3 py-2">{t.customer_name}</td>
                <td className="px-3 py-2"><span className={`badge-${t.status === 'open' ? 'green' : t.status === 'pending' ? 'yellow' : 'slate'}`}>{t.status}</span></td>
                <td className="px-3 py-2"><span className={`badge-${t.priority === 'urgent' ? 'red' : t.priority === 'high' ? 'yellow' : 'slate'}`}>{t.priority}</span></td>
                <td className="px-3 py-2 text-slate-500 text-xs">{t.last_message_at ? new Date(t.last_message_at).toLocaleString() : '—'}</td>
              </tr>
            ))}
            {tickets.length === 0 && <tr><td colSpan="6" className="px-3 py-4 text-center text-slate-500">No tickets</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
