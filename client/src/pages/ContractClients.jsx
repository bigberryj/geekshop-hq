import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchJson, postJson } from '../lib/api.js';
import PageHeader from '../components/PageHeader.jsx';
import DataTable from '../components/DataTable.jsx';
import Modal from '../components/Modal.jsx';
import { Plus } from 'lucide-react';

/**
 * ContractClients — list of corporate clients with monthly contracts.
 *
 * Mirrors the Customers page shape so the muscle memory carries over:
 *   search-as-you-type, "new" modal, link to detail page on the row name.
 *
 * Source data: GET /api/contract-clients
 */
export default function ContractClients() {
  const [clients, setClients] = useState([]);
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    name: '',
    primary_contact_name: '',
    primary_contact_email: '',
    phone: '',
    billing_address: '',
    notes: '',
  });

  const load = () =>
    fetchJson(`/contract-clients${search ? `?search=${encodeURIComponent(search)}` : ''}`)
      .then(setClients)
      .catch((e) => setError(e.response?.data?.error || e.message));

  useEffect(() => { load(); }, [search]);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await postJson('/contract-clients', form);
      setShowNew(false);
      setForm({ name: '', primary_contact_name: '', primary_contact_email: '', phone: '', billing_address: '', notes: '' });
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    {
      key: 'name',
      header: 'Client',
      primary: true,
      render: (c) => (
        <Link to={`/contract-clients/${c.id}`} className="text-brand-600 hover:underline font-medium break-words">
          {c.name}
        </Link>
      ),
    },
    {
      key: 'primary_contact_name',
      header: 'Primary contact',
      hideOnMobile: true,
      render: (c) => (
        <span className="text-slate-600">
          {c.primary_contact_name || '—'}
          {c.primary_contact_email ? (
            <span className="block text-xs text-slate-400">{c.primary_contact_email}</span>
          ) : null}
        </span>
      ),
    },
    { key: 'location_count', header: 'Locations', hideOnMobile: true, align: 'right' },
    {
      key: 'open_request_count',
      header: 'Open',
      hideOnMobile: true,
      align: 'right',
      render: (c) => (
        <span className={c.open_request_count > 0 ? 'badge-yellow' : 'badge-slate'}>
          {c.open_request_count || 0}
        </span>
      ),
    },
    { key: 'asset_count', header: 'Assets', hideOnMobile: true, align: 'right' },
  ];

  return (
    <div>
      <PageHeader
        title="Contract Clients"
        subtitle="Multi-location clients with ongoing support contracts"
        actions={
          <>
            <input
              className="input flex-1 min-w-[140px] max-w-md tap-target"
              placeholder="Search clients…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search contract clients"
            />
            <button
              type="button"
              onClick={() => { setError(''); setShowNew(true); }}
              className="btn-primary tap-target inline-flex items-center gap-2"
            >
              <Plus size={16} /> New client
            </button>
          </>
        }
      />

      {error && !showNew && (
        <div className="mb-4 p-3 bg-red-50 text-red-700 rounded text-sm">{error}</div>
      )}

      <DataTable
        columns={columns}
        rows={clients}
        rowKey={(c) => c.id}
        empty={search ? 'No clients match your search.' : 'No contract clients yet. Click "New client" to add one.'}
      />

      <Modal
        open={showNew}
        onClose={() => setShowNew(false)}
        title="New contract client"
        footer={(
          <div className="flex flex-wrap items-center gap-2 justify-end">
            <button type="button" className="btn-ghost tap-target" onClick={() => setShowNew(false)}>Cancel</button>
            <button type="submit" form="new-contract-client-form" disabled={busy} className="btn-primary tap-target disabled:opacity-50">
              {busy ? 'Saving…' : 'Create'}
            </button>
          </div>
        )}
      >
        <form id="new-contract-client-form" onSubmit={create} className="space-y-3">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Company name *</span>
            <input
              className="input tap-target mt-1"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              autoFocus
            />
          </label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Primary contact name</span>
              <input
                className="input tap-target mt-1"
                value={form.primary_contact_name}
                onChange={(e) => setForm({ ...form, primary_contact_name: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Primary contact email</span>
              <input
                className="input tap-target mt-1"
                type="email"
                value={form.primary_contact_email}
                onChange={(e) => setForm({ ...form, primary_contact_email: e.target.value })}
              />
            </label>
          </div>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Phone</span>
            <input
              className="input tap-target mt-1"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Billing address</span>
            <input
              className="input tap-target mt-1"
              value={form.billing_address}
              onChange={(e) => setForm({ ...form, billing_address: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Notes</span>
            <textarea
              className="input mt-1 min-h-[80px]"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </label>
          {error && <div className="text-sm text-red-700 bg-red-50 rounded p-2">{error}</div>}
        </form>
      </Modal>
    </div>
  );
}
