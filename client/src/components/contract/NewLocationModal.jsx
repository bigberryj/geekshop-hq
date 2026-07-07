import { useState } from 'react';
import Modal from '../Modal.jsx';
import { fetchJson, postJson } from '../../lib/api.js';

/**
 * NewLocationModal — add an office/branch to a contract client.
 *
 * Lightweight: only label is required. Address/city/region are optional
 * since MSPs often start with just "Vancouver HQ" and fill in the rest later.
 */
export default function NewLocationModal({ open, onClose, clientId, onCreated }) {
  const [form, setForm] = useState({
    label: '',
    address: '',
    city: '',
    region: '',
    postal_code: '',
    timezone: '',
    notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await postJson(`/contract-clients/${clientId}/locations`, form);
      onCreated?.(created);
      setForm({ label: '', address: '', city: '', region: '', postal_code: '', timezone: '', notes: '' });
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add location"
      footer={(
        <div className="flex flex-wrap items-center gap-2 justify-end">
          <button type="button" className="btn-ghost tap-target" onClick={onClose}>Cancel</button>
          <button type="submit" form="new-location-form" disabled={busy} className="btn-primary tap-target disabled:opacity-50">
            {busy ? 'Saving…' : 'Add location'}
          </button>
        </div>
      )}
    >
      <form id="new-location-form" onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Label *</span>
          <input
            className="input tap-target mt-1"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            placeholder="e.g. Vancouver HQ"
            required
            autoFocus
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Address</span>
          <input className="input tap-target mt-1" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </label>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">City</span>
            <input className="input tap-target mt-1" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Region</span>
            <input className="input tap-target mt-1" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Postal code</span>
            <input className="input tap-target mt-1" value={form.postal_code} onChange={(e) => setForm({ ...form, postal_code: e.target.value })} />
          </label>
        </div>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Timezone (IANA)</span>
          <input
            className="input tap-target mt-1"
            value={form.timezone}
            onChange={(e) => setForm({ ...form, timezone: e.target.value })}
            placeholder="America/Vancouver"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Notes</span>
          <textarea className="input mt-1 min-h-[60px]" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </label>
        {error && <div className="text-sm text-red-700 bg-red-50 rounded p-2">{error}</div>}
      </form>
    </Modal>
  );
}
