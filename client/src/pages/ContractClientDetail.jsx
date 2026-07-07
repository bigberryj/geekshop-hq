import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchJson, postJson, patchJson, delJson } from '../lib/api.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import NewLocationModal from '../components/contract/NewLocationModal.jsx';
import NewContactModal from '../components/contract/NewContactModal.jsx';
import EditContactModal from '../components/contract/EditContactModal.jsx';
import NewAssetModal from '../components/contract/NewAssetModal.jsx';
import InviteUserModal from '../components/contract/InviteUserModal.jsx';
import { Plus, MapPin, Users, Package, FileText, KeyRound, Archive, Edit3, Trash2 } from 'lucide-react';

const TABS = ['overview', 'locations', 'contacts', 'inventory', 'requests', 'portal'];

function StatusPill({ status }) {
  const cls = {
    active: 'badge-green', archived: 'badge-slate', open: 'badge-yellow',
    in_progress: 'badge-yellow', resolved: 'badge-green', cancelled: 'badge-slate',
  }[status] || 'badge-slate';
  return <span className={cls}>{status}</span>;
}

// Priority color coding — mirrors Tickets.jsx so triage reads the same
// across modules. urgent/red, high/amber, normal/default slate,
// low/green-ish (slate-when-unknown). Text label is always rendered,
// so color is never the only signal.
function PriorityBadge({ priority }) {
  const p = (priority || '').toString().toLowerCase();
  if (p === 'urgent') return <span className="badge-red">Urgent</span>;
  if (p === 'high') return <span className="badge-yellow">High</span>;
  if (p === 'normal') return <span className="badge-slate">Normal</span>;
  if (p === 'low') return <span className="badge-green">Low</span>;
  return <span className="badge-slate">{priority || '—'}</span>;
}

/**
 * ContractClientDetail — tabbed admin view for one corporate client.
 *
 * Tabs:
 *   overview  — counts + recent requests
 *   locations — offices + add-location modal
 *   contacts  — all people + per-location add-contact
 *   inventory — assets filterable by location + add-asset
 *   requests  — full request list with cancel + status update
 *   portal    — credentials + invite users
 */
export default function ContractClientDetail() {
  const { id } = useParams();
  const clientId = Number(id);
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Per-tab data fetched lazily
  const [locationsDetail, setLocationsDetail] = useState([]);
  const [assets, setAssets] = useState([]);
  const [requests, setRequests] = useState([]);
  const [portalUsers, setPortalUsers] = useState([]);
  const [filterLoc, setFilterLoc] = useState('');
  // Requests-tab location filter (scoped to this client's locations).
  const [requestLocFilter, setRequestLocFilter] = useState('');

  // Modal states
  const [showLoc, setShowLoc] = useState(false);
  const [contactLoc, setContactLoc] = useState(null);
  const [editingContact, setEditingContact] = useState(null);
  const [deletingContact, setDeletingContact] = useState(null);
  const [contactBusy, setContactBusy] = useState(false);
  const [showAsset, setShowAsset] = useState(false);
  const [showInvite, setShowInvite] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError('');
    try {
      const detail = await fetchJson(`/contract-clients/${clientId}`);
      setData(detail);
      // Pre-fetch locations detail (with counts)
      const locs = await fetchJson(`/contract-clients/${clientId}/locations`);
      setLocationsDetail(locs);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); /* eslint-disable-next-line */ }, [clientId]);

  // Lazy loads
  useEffect(() => {
    if (tab === 'inventory') {
      const q = filterLoc ? `?location_id=${filterLoc}` : '';
      fetchJson(`/contract-clients/${clientId}/assets${q}`).then(setAssets).catch(() => setAssets([]));
    } else if (tab === 'requests') {
      const q = requestLocFilter ? `?location_id=${encodeURIComponent(requestLocFilter)}` : '';
      fetchJson(`/contract-clients/${clientId}/requests${q}`).then(setRequests).catch(() => setRequests([]));
    } else if (tab === 'portal') {
      fetchJson(`/contract-clients/${clientId}/portal-users`).then(setPortalUsers).catch(() => setPortalUsers([]));
    }
  }, [tab, clientId, filterLoc, requestLocFilter]);

  // Helper: reload the current requests view honoring the active filter.
  const reloadRequests = () => {
    const q = requestLocFilter ? `?location_id=${encodeURIComponent(requestLocFilter)}` : '';
    fetchJson(`/contract-clients/${clientId}/requests${q}`).then(setRequests).catch(() => setRequests([]));
  };

  const archiveClient = async () => {
    if (!window.confirm(`Archive ${data.client.name}? This hides them from the active list.`)) return;
    await postJson(`/contract-clients/${clientId}/archive`);
    loadAll();
  };

  const updateRequest = async (rid, patch) => {
    await patchJson(`/contract-clients/${clientId}/requests/${rid}`, patch);
    reloadRequests();
  };

  const cancelRequest = async (rid) => {
    const reason = window.prompt('Optional cancellation reason (cancel to skip):') || '';
    try {
      await postJson(`/contract-clients/requests/${rid}/cancel`, reason ? { reason } : {});
      reloadRequests();
    } catch (err) {
      window.alert(err.response?.data?.reason || err.response?.data?.error || err.message);
    }
  };

  const requestColumns = useMemo(() => [
    {
      key: 'request_uid',
      header: 'ID',
      primary: true,
      render: (r) => <span className="font-mono text-xs">{r.request_uid}</span>,
    },
    { key: 'subject', header: 'Subject' },
    { key: 'location_label', header: 'Location', hideOnMobile: true },
    { key: 'contact_name', header: 'Submitter', hideOnMobile: true },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <StatusPill status={r.status} />,
    },
    {
      key: 'priority',
      header: 'Priority',
      hideOnMobile: true,
      render: (r) => <PriorityBadge priority={r.priority} />,
    },
    { key: 'created_at', header: 'Created', hideOnMobile: true, render: (r) => new Date(r.created_at).toLocaleString() },
    {
      key: 'actions',
      header: '',
      hideOnMobile: true,
      align: 'right',
      render: (r) => (
        <div className="flex flex-wrap justify-end gap-1">
          {r.status === 'open' && (
            <>
              <button type="button" className="btn-ghost text-xs tap-target"
                onClick={() => updateRequest(r.id, { status: 'in_progress', assigned_to: 'admin' })}>
                Start
              </button>
              <button type="button" className="btn-ghost text-xs text-red-600 tap-target"
                onClick={() => cancelRequest(r.id)}>
                Cancel
              </button>
            </>
          )}
          {r.status === 'in_progress' && (
            <button type="button" className="btn-ghost text-xs tap-target"
              onClick={() => updateRequest(r.id, { status: 'resolved' })}>
              Resolve
            </button>
          )}
        </div>
      ),
    },
  ], [clientId]);

  if (loading && !data) {
    return <div className="text-slate-500">Loading…</div>;
  }
  if (error && !data) {
    return <div className="text-red-700 bg-red-50 p-3 rounded">{error}</div>;
  }
  if (!data) return null;
  const { client, contacts, counts, recent_requests } = data;

  return (
    <div>
      <PageHeader
        title={client.name}
        subtitle={`${counts.locations} location${counts.locations === 1 ? '' : 's'} · ${counts.contacts} contact${counts.contacts === 1 ? '' : 's'} · ${counts.assets} asset${counts.assets === 1 ? '' : 's'}`}
        backTo="/contract-clients"
        backLabel="← All clients"
        actions={
          <>
            {client.status === 'active' && (
              <button type="button" onClick={archiveClient} className="btn-ghost tap-target inline-flex items-center gap-1">
                <Archive size={14} /> Archive
              </button>
            )}
          </>
        }
      />

      {error && <div className="mb-3 p-2 bg-red-50 text-red-700 rounded text-sm">{error}</div>}

      {/* Tabs */}
      <nav className="border-b border-slate-200 mb-4 overflow-x-auto" aria-label="Contract client tabs">
        <ul className="flex gap-1 min-w-max">
          {TABS.map((t) => (
            <li key={t}>
              <button
                type="button"
                onClick={() => setTab(t)}
                className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
                  tab === t ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
                aria-current={tab === t ? 'page' : undefined}
              >
                {t === 'overview' && 'Overview'}
                {t === 'locations' && <span className="inline-flex items-center gap-1"><MapPin size={14} /> Locations ({counts.locations})</span>}
                {t === 'contacts' && <span className="inline-flex items-center gap-1"><Users size={14} /> Contacts ({counts.contacts})</span>}
                {t === 'inventory' && <span className="inline-flex items-center gap-1"><Package size={14} /> Inventory ({counts.assets})</span>}
                {t === 'requests' && <span className="inline-flex items-center gap-1"><FileText size={14} /> Requests ({counts.requests_total})</span>}
                {t === 'portal' && <span className="inline-flex items-center gap-1"><KeyRound size={14} /> Portal ({counts.portal_users})</span>}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {tab === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Locations', value: counts.locations },
              { label: 'Contacts', value: counts.contacts },
              { label: 'Open requests', value: counts.requests_open },
              { label: 'Assets', value: counts.assets },
            ].map((c) => (
              <div key={c.label} className="card">
                <div className="text-xs text-slate-500">{c.label}</div>
                <div className="text-2xl font-bold">{c.value}</div>
              </div>
            ))}
          </div>
          <div className="card">
            <div className="text-sm font-medium mb-2">Recent requests</div>
            <DataTable
              columns={requestColumns.filter((c) => c.key !== 'actions')}
              rows={recent_requests}
              rowKey={(r) => r.id}
              empty="No requests yet."
            />
            {counts.requests_total > recent_requests.length && (
              <button type="button" onClick={() => setTab('requests')} className="btn-ghost text-sm mt-2 tap-target">
                View all {counts.requests_total} →
              </button>
            )}
          </div>
          <div className="card">
            <div className="text-sm font-medium mb-2">Client details</div>
            <dl className="text-sm space-y-1">
              <div><dt className="inline text-slate-500">Status: </dt><dd className="inline"><StatusPill status={client.status} /></dd></div>
              <div><dt className="inline text-slate-500">Primary contact: </dt><dd className="inline">{client.primary_contact_name || '—'} {client.primary_contact_email && <span className="text-slate-400">({client.primary_contact_email})</span>}</dd></div>
              <div><dt className="inline text-slate-500">Phone: </dt><dd className="inline">{client.phone || '—'}</dd></div>
              <div><dt className="inline text-slate-500">Billing address: </dt><dd className="inline">{client.billing_address || '—'}</dd></div>
              {client.notes && <div><dt className="inline text-slate-500">Notes: </dt><dd className="inline whitespace-pre-wrap">{client.notes}</dd></div>}
            </dl>
          </div>
        </div>
      )}

      {tab === 'locations' && (
        <div>
          <div className="flex justify-end mb-3">
            <button type="button" onClick={() => setShowLoc(true)} className="btn-primary tap-target inline-flex items-center gap-1">
              <Plus size={14} /> Add location
            </button>
          </div>
          <DataTable
            columns={[
              { key: 'label', header: 'Label', primary: true },
              { key: 'city', header: 'City', hideOnMobile: true },
              { key: 'region', header: 'Region', hideOnMobile: true },
              { key: 'contact_count', header: 'Contacts', hideOnMobile: true, align: 'right' },
              { key: 'asset_count', header: 'Assets', hideOnMobile: true, align: 'right' },
              {
                key: 'open_request_count',
                header: 'Open reqs',
                hideOnMobile: true,
                align: 'right',
                render: (l) => <span className={l.open_request_count > 0 ? 'badge-yellow' : 'badge-slate'}>{l.open_request_count}</span>,
              },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (l) => (
                  <button type="button" className="btn-ghost text-xs tap-target"
                    onClick={() => setContactLoc(l)}>
                    + Contact
                  </button>
                ),
              },
            ]}
            rows={locationsDetail}
            rowKey={(l) => l.id}
            empty="No locations yet."
          />
          <NewLocationModal
            open={showLoc}
            onClose={() => setShowLoc(false)}
            clientId={clientId}
            onCreated={loadAll}
          />
          {contactLoc && (
            <NewContactModal
              open
              onClose={() => setContactLoc(null)}
              clientId={clientId}
              locationId={contactLoc.id}
              onCreated={loadAll}
            />
          )}
        </div>
      )}

      {tab === 'contacts' && (
        <div>
          {locationsDetail.length === 0 ? (
            <div className="card text-sm text-slate-500">Add a location first — contacts live under a location.</div>
          ) : (
            <>
              <div className="flex justify-end mb-3">
                <select
                  className="input max-w-xs tap-target"
                  value={contactLoc?.id || locationsDetail[0]?.id || ''}
                  onChange={(e) => setContactLoc({ id: Number(e.target.value) })}
                >
                  {locationsDetail.map((l) => <option key={l.id} value={l.id}>Add to: {l.label}</option>)}
                </select>
                <button type="button" className="btn-primary tap-target inline-flex items-center gap-1" onClick={() => setContactLoc({ id: locationsDetail[0]?.id })}>
                  <Plus size={14} /> Contact
                </button>
              </div>
              <DataTable
                columns={[
                  { key: 'name', header: 'Name', primary: true },
                  {
                    key: 'location_label',
                    header: 'Location',
                    render: (c) => c.location_label || <span className="text-slate-400">—</span>,
                  },
                  { key: 'role', header: 'Role', hideOnMobile: true },
                  { key: 'email', header: 'Email', hideOnMobile: true },
                  { key: 'phone', header: 'Phone', hideOnMobile: true },
                  {
                    key: 'is_office_manager',
                    header: 'Role',
                    hideOnMobile: true,
                    render: (c) => c.is_office_manager ? <span className="badge-green">Office manager</span> : <span className="badge-slate">Contact</span>,
                  },
                  {
                    key: 'actions',
                    header: '',
                    align: 'right',
                    render: (c) => (
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          title={`Edit ${c.name}`}
                          onClick={() => setEditingContact(c)}
                        >
                          <Edit3 size={12} />
                        </button>
                        <button
                          type="button"
                          className="btn-ghost text-xs text-red-700"
                          title={`Remove ${c.name}`}
                          onClick={() => setDeletingContact(c)}
                          disabled={contactBusy}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ),
                  },
                ]}
                rows={contacts}
                rowKey={(c) => c.id}
                empty="No contacts yet."
              />
              {contactLoc && (
                <NewContactModal
                  open
                  onClose={() => setContactLoc(null)}
                  clientId={clientId}
                  locationId={contactLoc.id}
                  onCreated={loadAll}
                />
              )}
              {editingContact && (
                <EditContactModal
                  open
                  contact={editingContact}
                  locations={locationsDetail}
                  onClose={() => setEditingContact(null)}
                  onSaved={loadAll}
                />
              )}
              {deletingContact && (
                <Modal
                  open
                  onClose={() => !contactBusy && setDeletingContact(null)}
                  title={`Remove ${deletingContact.name}?`}
                  footer={(
                    <div className="flex flex-wrap items-center gap-2 justify-end">
                      <button type="button" className="btn-ghost tap-target" disabled={contactBusy} onClick={() => setDeletingContact(null)}>Cancel</button>
                      <button
                        type="button"
                        className="btn-primary tap-target bg-red-600 hover:bg-red-700 disabled:opacity-50"
                        disabled={contactBusy}
                        onClick={async () => {
                          setContactBusy(true);
                          try {
                            await delJson(`/contract-clients/contacts/${deletingContact.id}`);
                            await loadAll();
                            setDeletingContact(null);
                          } catch (err) {
                            const data = err.response?.data;
                            if (data?.error === 'contact_in_use') {
                              alert(`${data.reason}.\nOpen requests: ${(data.blocking_requests || []).map((r) => r.request_uid).join(', ') || 'none'}`);
                            } else {
                              alert('Remove failed: ' + (data?.error || err.message));
                            }
                          } finally {
                            setContactBusy(false);
                          }
                        }}
                      >
                        {contactBusy ? 'Removing…' : 'Remove contact'}
                      </button>
                    </div>
                  )}
                >
                  <p className="text-sm text-slate-700">
                    This permanently removes <strong>{deletingContact.name}</strong> from the
                    {' '}
                    <strong>{locationsDetail.find((l) => l.id === deletingContact.location_id)?.label || 'contact list'}</strong>
                    {' '}office. Portal credentials that reference this contact will be left
                    intact but their contact name will clear (the FK is <code>ON DELETE SET NULL</code>).
                    {` `}Any request — open or resolved — that they submitted blocks removal
                    (history integrity), so the server will refuse with a 409 and a list of
                    blockers; cancel or reassign those requests first, then retry.
                  </p>
                </Modal>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'inventory' && (
        <div>
          <div className="flex flex-wrap gap-2 mb-3 items-center justify-end">
            <select className="input max-w-xs tap-target" value={filterLoc} onChange={(e) => setFilterLoc(e.target.value)}>
              <option value="">All locations</option>
              {locationsDetail.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
            <button type="button" disabled={locationsDetail.length === 0} onClick={() => setShowAsset(true)} className="btn-primary tap-target inline-flex items-center gap-1 disabled:opacity-50">
              <Plus size={14} /> Add asset
            </button>
          </div>
          {locationsDetail.length === 0 && (
            <div className="card text-sm text-slate-500">Add a location first.</div>
          )}
          <DataTable
            columns={[
              { key: 'hostname', header: 'Hostname', primary: true },
              { key: 'type', header: 'Type', hideOnMobile: true },
              { key: 'assigned_user', header: 'Assigned to', hideOnMobile: true },
              { key: 'manufacturer', header: 'Manufacturer', hideOnMobile: true },
              { key: 'model', header: 'Model', hideOnMobile: true },
              { key: 'os', header: 'OS', hideOnMobile: true },
              { key: 'location_label', header: 'Location', hideOnMobile: true },
              {
                key: 'status',
                header: 'Status',
                render: (a) => <StatusPill status={a.status} />,
              },
            ]}
            rows={assets}
            rowKey={(a) => a.id}
            empty={filterLoc ? 'No assets at this location.' : 'No assets yet.'}
          />
          <NewAssetModal
            open={showAsset}
            onClose={() => setShowAsset(false)}
            clientId={clientId}
            locations={locationsDetail}
            onCreated={() => { setShowAsset(false); loadAll(); }}
          />
        </div>
      )}

      {tab === 'requests' && (
        <div>
          {locationsDetail.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3 items-center justify-end">
              <label htmlFor="request-loc-filter" className="text-sm text-slate-600">
                Location:
              </label>
              <select
                id="request-loc-filter"
                className="input max-w-xs tap-target"
                value={requestLocFilter}
                onChange={(e) => setRequestLocFilter(e.target.value)}
                aria-label="Filter requests by location"
              >
                <option value="">All locations</option>
                {locationsDetail.map((l) => (
                  <option key={l.id} value={l.id}>{l.label}</option>
                ))}
              </select>
              {requestLocFilter && (
                <button
                  type="button"
                  className="btn-ghost text-xs tap-target"
                  onClick={() => setRequestLocFilter('')}
                >
                  Clear
                </button>
              )}
            </div>
          )}
          <DataTable
            columns={requestColumns}
            rows={requests}
            rowKey={(r) => r.id}
            empty={requestLocFilter ? 'No requests at this location.' : 'No requests yet. Office managers can submit through the client portal.'}
          />
        </div>
      )}

      {tab === 'portal' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button type="button" onClick={() => setShowInvite(true)} className="btn-primary tap-target inline-flex items-center gap-1">
              <Plus size={14} /> Invite user
            </button>
          </div>
          <DataTable
            columns={[
              { key: 'email', header: 'Email', primary: true },
              { key: 'display_name', header: 'Name' },
              { key: 'scope_type', header: 'Scope', render: (u) => u.scope_type === 'client_manager' ? 'Client manager' : 'Location manager' },
              {
                key: 'scoped_location_ids',
                header: 'Locations',
                hideOnMobile: true,
                render: (u) => {
                  if (u.scope_type === 'client_manager') return <span className="text-xs text-slate-500">all</span>;
                  try {
                    const arr = JSON.parse(u.scoped_location_ids || '[]');
                    if (arr.length === 0) return <span className="text-xs text-slate-400">none</span>;
                    const labels = arr.map((lid) => locationsDetail.find((l) => l.id === lid)?.label).filter(Boolean);
                    return <span className="text-xs">{labels.join(', ')}</span>;
                  } catch { return '—'; }
                },
              },
              {
                key: 'last_login_at',
                header: 'Last login',
                hideOnMobile: true,
                render: (u) => u.last_login_at ? new Date(u.last_login_at).toLocaleString() : <span className="text-xs text-slate-400">never</span>,
              },
            ]}
            rows={portalUsers}
            rowKey={(u) => u.id}
            empty="No portal users yet — invite one above."
          />
          <InviteUserModal
            open={showInvite}
            onClose={() => setShowInvite(false)}
            clientId={clientId}
            clientName={client.name}
            locations={locationsDetail}
            onCreated={() => fetchJson(`/contract-clients/${clientId}/portal-users`).then(setPortalUsers)}
          />
        </div>
      )}
    </div>
  );
}
