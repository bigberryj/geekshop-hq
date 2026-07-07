import { useEffect, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { fetchJson } from '../../lib/api.js';
import DataTable from '../../components/DataTable.jsx';

/**
 * PortalDashboard — friendly overview for office managers.
 *
 * Shows the visible locations, recent request counts, and a quick
 * "submit new request" CTA. Big-surface friendly.
 */
export default function PortalDashboard() {
  const outlet = useOutletContext() || {};
  const { me } = outlet;
  const [requests, setRequests] = useState([]);
  const [assetsCount, setAssetsCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetchJson('/portal/requests'),
      fetchJson('/portal/assets'),
    ]).then(([reqs, assets]) => {
      setRequests(reqs);
      setAssetsCount(assets.length);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-slate-500">Loading…</div>;
  if (!me) return <div className="text-slate-500">Redirecting to login…</div>;
  const safeRequests = Array.isArray(requests) ? requests : [];
  const open = safeRequests.filter((r) => r.status === 'open' || r.status === 'in_progress');
  const recent = safeRequests.slice(0, 8);

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="text-sm text-slate-500">Welcome back</div>
        <div className="text-2xl font-bold">{me.display_name || me.email}</div>
        <div className="text-xs text-slate-500 mt-1">{me.client?.name}</div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card">
          <div className="text-xs text-slate-500">Locations</div>
          <div className="text-2xl font-bold">{me.locations?.length || 0}</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">Open requests</div>
          <div className="text-2xl font-bold">{open.length}</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">Total requests</div>
          <div className="text-2xl font-bold">{safeRequests.length}</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">Devices visible</div>
          <div className="text-2xl font-bold">{assetsCount}</div>
        </div>
      </div>

      <div className="card">
        <div className="flex flex-wrap items-center gap-2 justify-between mb-3">
          <div className="text-sm font-medium">Recent requests</div>
          <Link to="/portal/requests/new" className="btn-primary text-sm tap-target">+ New request</Link>
        </div>
        <DataTable
          columns={[
            { key: 'request_uid', header: 'ID', primary: true, render: (r) => <span className="font-mono text-xs">{r.request_uid}</span> },
            { key: 'subject', header: 'Subject' },
            { key: 'location_label', header: 'Location', hideOnMobile: true },
            {
              key: 'status',
              header: 'Status',
              render: (r) => <span className={`badge-${r.status === 'open' || r.status === 'in_progress' ? 'yellow' : r.status === 'resolved' ? 'green' : 'slate'}`}>{r.status}</span>,
            },
            { key: 'created_at', header: 'Created', hideOnMobile: true, render: (r) => new Date(r.created_at).toLocaleString() },
          ]}
          rows={recent}
          rowKey={(r) => r.id}
          empty="No requests yet. Use the button above to submit your first one."
        />
      </div>

      {me.locations?.length > 0 && (
        <div className="card">
          <div className="text-sm font-medium mb-2">Your locations</div>
          <ul className="space-y-1 text-sm">
            {me.locations.map((l) => (
              <li key={l.id} className="flex items-center justify-between border-b last:border-0 py-2">
                <span className="font-medium">{l.label}</span>
                <span className="text-xs text-slate-500">{[l.city, l.region].filter(Boolean).join(', ') || '—'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
