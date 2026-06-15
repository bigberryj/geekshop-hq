import { useEffect, useState } from 'react';
import { fetchJson, formatDuration } from '../lib/api.js';

export default function Time() {
  const [entries, setEntries] = useState([]);
  useEffect(() => { fetchJson('/time').then(setEntries); }, []);

  const total = entries.reduce((s, e) => s + (e.duration_seconds || 0), 0);
  const byCustomer = entries.reduce((acc, e) => {
    if (!acc[e.customer_name]) acc[e.customer_name] = 0;
    acc[e.customer_name] += e.duration_seconds || 0;
    return acc;
  }, {});

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Time log</h2>
      <div className="card mb-4">
        <div className="text-sm text-slate-500">Total tracked (last 30 days): <span className="font-semibold text-slate-900">{formatDuration(total)}</span></div>
        <div className="text-xs text-slate-500 mt-2">By customer:</div>
        <ul className="mt-1">
          {Object.entries(byCustomer).map(([name, secs]) => (
            <li key={name} className="text-sm">
              {name}: <span className="font-mono">{formatDuration(secs)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Ticket</th><th className="px-3 py-2">Customer</th><th className="px-3 py-2">Duration</th><th className="px-3 py-2">Note</th></tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t">
                <td className="px-3 py-2 text-xs">{new Date(e.started_at).toLocaleString()}</td>
                <td className="px-3 py-2"><Link to={`/tickets/${e.ticket_id}`} className="text-brand-600 hover:underline" title={`Internal: ${e.ticket_uid}`}>{e.subject || e.ticket_uid}</Link></td>
                <td className="px-3 py-2">{e.customer_name}</td>
                <td className="px-3 py-2 font-mono">{formatDuration(e.duration_seconds)}</td>
                <td className="px-3 py-2 text-slate-600 text-xs">{e.note || '—'}</td>
              </tr>
            ))}
            {entries.length === 0 && <tr><td colSpan="5" className="px-3 py-4 text-center text-slate-500">No time tracked</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
