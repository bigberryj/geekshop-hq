import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchJson, formatDuration } from '../lib/api.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';

export default function Time() {
  const [entries, setEntries] = useState([]);
  useEffect(() => { fetchJson('/time').then(setEntries); }, []);

  const total = entries.reduce((s, e) => s + (e.duration_seconds || 0), 0);
  const byCustomer = entries.reduce((acc, e) => {
    if (!acc[e.customer_name]) acc[e.customer_name] = 0;
    acc[e.customer_name] += e.duration_seconds || 0;
    return acc;
  }, {});

  const columns = [
    {
      key: 'started_at',
      header: 'When',
      primary: true,
      render: (e) => <span className="text-xs">{new Date(e.started_at).toLocaleString()}</span>,
    },
    {
      key: 'subject',
      header: 'Ticket',
      hideOnMobile: true,
      render: (e) => (
        <Link to={`/tickets/${e.ticket_id}`} className="text-brand-600 hover:underline break-words" title={`Internal: ${e.ticket_uid}`}>
          {e.subject || e.ticket_uid}
        </Link>
      ),
    },
    { key: 'customer_name', header: 'Customer', hideOnMobile: true },
    { key: 'duration_seconds', header: 'Duration', render: (e) => <span className="font-mono">{formatDuration(e.duration_seconds)}</span>, align: 'right' },
    { key: 'note', header: 'Note', hideOnMobile: true, render: (e) => <span className="text-slate-600 text-xs">{e.note || '—'}</span> },
  ];

  return (
    <div>
      <PageHeader title="Time log" />

      <div className="card mb-4">
        <div className="text-sm text-slate-500">
          Total tracked (last 30 days): <span className="font-semibold text-slate-900">{formatDuration(total)}</span>
        </div>
        <div className="text-xs text-slate-500 mt-2">By customer:</div>
        <ul className="mt-1">
          {Object.entries(byCustomer).map(([name, secs]) => (
            <li key={name} className="text-sm">
              {name}: <span className="font-mono">{formatDuration(secs)}</span>
            </li>
          ))}
        </ul>
      </div>

      <DataTable
        columns={columns}
        rows={entries}
        rowKey="id"
        empty="No time tracked yet."
      />
    </div>
  );
}
