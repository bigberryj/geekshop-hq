import { useEffect, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { fetchJson, postJson } from '../../lib/api.js';

const CATEGORIES = ['hardware', 'software', 'network', 'account', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

/**
 * PortalRequestNew — submit a new request from the portal side.
 *
 * - Pick a location (filtered to the ones this credential can see).
 * - Pick a contact (filtered by scope).
 * - Optionally attach an asset by hostname (filtered by scope).
 * - Subject + description required; category / priority optional.
 */
export default function PortalRequestNew() {
  const navigate = useNavigate();
  const { me } = useOutletContext();
  const [contacts, setContacts] = useState([]);
  const [assets, setAssets] = useState([]);
  const [form, setForm] = useState({
    location_id: me.locations?.[0]?.id || '',
    contact_id: me.contact_id || '',
    asset_id: '',
    subject: '',
    description: '',
    category: '',
    priority: 'normal',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchJson('/portal/contacts').then((c) => {
      setContacts(c);
      if (c.length && !form.contact_id) {
        const defaultContact = c.find((x) => x.is_office_manager) || c[0];
        setForm((f) => ({ ...f, contact_id: defaultContact.id }));
      }
    }).catch(() => setContacts([]));
  }, []);

  useEffect(() => {
    fetchJson('/portal/assets').then(setAssets).catch(() => setAssets([]));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { ...form };
      if (!body.asset_id) delete body.asset_id;
      if (!body.category) delete body.category;
      await postJson('/portal/requests', body);
      navigate('/portal/requests', { replace: true });
    } catch (err) {
      setError(err.response?.data?.reason || err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  // Filter contacts + assets to the selected location.
  const filteredContacts = contacts.filter((c) => !form.location_id || c.location_id === Number(form.location_id));
  const filteredAssets = assets.filter((a) => !form.location_id || a.location_id === Number(form.location_id));

  if ((me.locations || []).length === 0) {
    return (
      <div className="card text-sm text-slate-500">
        Your account isn't scoped to any locations. Ask your account manager to update your access.
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4 max-w-2xl">
      <h2 className="text-xl font-bold">Submit a request</h2>

      <label className="block">
        <span className="text-sm font-medium text-slate-700">Location *</span>
        <select
          className="input tap-target mt-1"
          value={form.location_id}
          onChange={(e) => setForm({ ...form, location_id: Number(e.target.value), contact_id: '', asset_id: '' })}
          required
        >
          {me.locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
      </label>

      <label className="block">
        <span className="text-sm font-medium text-slate-700">Submitting on behalf of *</span>
        <select
          className="input tap-target mt-1"
          value={form.contact_id}
          onChange={(e) => setForm({ ...form, contact_id: Number(e.target.value) })}
          required
        >
          <option value="">— select —</option>
          {filteredContacts.map((c) => (
            <option key={c.id} value={c.id}>{c.name}{c.is_office_manager ? ' (Office manager)' : ''}</option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-sm font-medium text-slate-700">Asset (optional)</span>
        <select
          className="input tap-target mt-1"
          value={form.asset_id}
          onChange={(e) => setForm({ ...form, asset_id: e.target.value })}
        >
          <option value="">— none —</option>
          {filteredAssets.map((a) => (
            <option key={a.id} value={a.id}>
              {[a.hostname, a.assigned_user, a.manufacturer, a.model].filter(Boolean).join(' / ')}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-sm font-medium text-slate-700">Subject *</span>
        <input
          className="input tap-target mt-1"
          value={form.subject}
          onChange={(e) => setForm({ ...form, subject: e.target.value })}
          required
          autoFocus
          placeholder="Short summary"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium text-slate-700">Description *</span>
        <textarea
          className="input mt-1 min-h-[120px]"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          required
          placeholder="What's happening, when, what you've tried, what you need."
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Category</span>
          <select className="input tap-target mt-1" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            <option value="">—</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Priority</span>
          <select className="input tap-target mt-1" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      </div>

      {error && <div className="text-sm text-red-700 bg-red-50 rounded p-2">{error}</div>}

      <div className="flex flex-wrap items-center gap-2 justify-end">
        <button type="button" className="btn-ghost tap-target" onClick={() => navigate('/portal/requests')}>Cancel</button>
        <button type="submit" disabled={busy} className="btn-primary tap-target disabled:opacity-50">
          {busy ? 'Submitting…' : 'Submit request'}
        </button>
      </div>
    </form>
  );
}
