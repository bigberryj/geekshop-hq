import { useEffect, useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { fetchJson, postJson } from '../../lib/api.js';
import DataTable from '../../components/DataTable.jsx';
import Modal from '../../components/Modal.jsx';

/**
 * PortalRequests — list of requests visible to the office manager.
 *
 * Each row has a "Cancel" action when the request is still cancellable
 * (per canCancel rules in the server). New request form is a separate
 * route (/portal/requests/new) so the same route can be bookmarked.
 */
export default function PortalRequests() {
  const { me } = useOutletContext();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');

  const load = () => {
    setLoading(true);
    fetchJson('/portal/requests').then(setRequests).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const cancelRequest = async (rid) => {
    if (!window.confirm('Cancel this request?')) return;
    setBusyId(rid);
    try {
      await postJson(`/portal/requests/${rid}/cancel`);
      load();
    } catch (err) {
      window.alert(err.response?.data?.reason || err.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const openDetail = async (rid) => {
    setBusyId(rid);
    try {
      const d = await fetchJson(`/portal/requests/${rid}`);
      setDetail(d);
    } finally {
      setBusyId(null);
    }
  };

  const filtered = statusFilter ? requests.filter((r) => r.status === statusFilter) : requests;
  const visibleLocs = new Set(me.locations?.map((l) => l.id) || []);
  const isCancellable = (r) => (r.status === 'open' || r.status === 'in_progress') && (visibleLocs.has(r.location_id));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-bold mr-auto">Requests</h2>
        <select className="input max-w-xs tap-target" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="resolved">Resolved</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <Link to="/portal/requests/new" className="btn-primary tap-target">+ New request</Link>
      </div>

      {loading ? <div className="text-slate-500">Loading…</div> : (
        <DataTable
          columns={[
            { key: 'request_uid', header: 'ID', primary: true, render: (r) => <span className="font-mono text-xs">{r.request_uid}</span> },
            { key: 'subject', header: 'Subject' },
            { key: 'location_label', header: 'Location', hideOnMobile: true },
            { key: 'asset_hostname', header: 'Asset', hideOnMobile: true, render: (r) => r.asset_hostname || '—' },
            {
              key: 'status',
              header: 'Status',
              render: (r) => <span className={`badge-${r.status === 'open' || r.status === 'in_progress' ? 'yellow' : r.status === 'resolved' ? 'green' : 'slate'}`}>{r.status}</span>,
            },
            { key: 'created_at', header: 'Submitted', hideOnMobile: true, render: (r) => new Date(r.created_at).toLocaleString() },
            {
              key: 'actions',
              header: '',
              hideOnMobile: true,
              align: 'right',
              render: (r) => (
                <div className="flex flex-wrap justify-end gap-1">
                  <button type="button" className="btn-ghost text-xs tap-target" onClick={() => openDetail(r.id)}>View</button>
                  {isCancellable(r) && (
                    <button
                      type="button"
                      className="btn-ghost text-xs text-red-600 tap-target disabled:opacity-50"
                      onClick={() => cancelRequest(r.id)}
                      disabled={busyId === r.id}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              ),
            },
          ]}
          rows={filtered}
          rowKey={(r) => r.id}
          empty="No requests yet."
        />
      )}

      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail ? `${detail.request_uid} — ${detail.subject}` : ''}
        footer={
          <div className="flex justify-end">
            <button type="button" className="btn-ghost tap-target" onClick={() => setDetail(null)}>Close</button>
          </div>
        }
      >
        {detail && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-2">
              <span className={`badge-${detail.status === 'resolved' ? 'green' : detail.status === 'cancelled' ? 'slate' : 'yellow'}`}>{detail.status}</span>
              <span className="badge-slate">{detail.priority}</span>
              {detail.category && <span className="badge-slate">{detail.category}</span>}
            </div>
            <dl className="space-y-1">
              <div><dt className="inline text-slate-500">Location: </dt><dd className="inline">{detail.location_label}</dd></div>
              <div><dt className="inline text-slate-500">Submitted by: </dt><dd className="inline">{detail.contact_name || '—'}</dd></div>
              {detail.asset_hostname && <div><dt className="inline text-slate-500">Asset: </dt><dd className="inline">{detail.asset_hostname}</dd></div>}
              <div><dt className="inline text-slate-500">Submitted: </dt><dd className="inline">{new Date(detail.created_at).toLocaleString()}</dd></div>
              {detail.cancelled_at && <div><dt className="inline text-slate-500">Cancelled: </dt><dd className="inline">{new Date(detail.cancelled_at).toLocaleString()}</dd></div>}
              {detail.resolved_at && <div><dt className="inline text-slate-500">Resolved: </dt><dd className="inline">{new Date(detail.resolved_at).toLocaleString()}</dd></div>}
            </dl>
            <div>
              <div className="text-slate-500 mb-1">Description</div>
              <div className="whitespace-pre-wrap bg-slate-50 p-2 rounded text-sm">{detail.description}</div>
            </div>
            {detail.events?.length > 0 && (
              <div>
                <div className="text-slate-500 mb-1">History</div>
                <ul className="border-l-2 border-slate-200 pl-3 space-y-1 text-xs">
                  {detail.events.map((ev) => (
                    <li key={ev.id}>
                      <span className="font-mono text-slate-400">{new Date(ev.created_at).toLocaleString()}</span>
                      {' · '}<strong>{ev.event_type}</strong>
                      {ev.from_status && ev.to_status && ` (${ev.from_status} → ${ev.to_status})`}
                      {ev.note && <span className="text-slate-500"> — {ev.note}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
