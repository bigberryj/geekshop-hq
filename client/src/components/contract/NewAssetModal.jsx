import { useState } from 'react';
import Modal from '../Modal.jsx';
import { postJson } from '../../lib/api.js';

const TYPES = ['laptop', 'desktop', 'server', 'printer', 'network', 'other'];

/**
 * NewAssetModal — record a computer/device at a contract location.
 *
 * MVP: minimal required fields (location, type). Spec fields like serial,
 * RAM, storage are all optional because the legacy Google Sheet had
 * wildly varying completeness per row.
 */
export default function NewAssetModal({ open, onClose, clientId, locations, onCreated }) {
  const [form, setForm] = useState({
    location_id: locations[0]?.id || '',
    hostname: '',
    asset_tag: '',
    assigned_user: '',
    type: 'laptop',
    manufacturer: '',
    model: '',
    serial: '',
    os: '',
    cpu: '',
    ram_gb: '',
    storage_gb: '',
    warranty_until: '',
    last_serviced_at: '',
    status: 'active',
    notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { ...form };
      // Numeric coercion for ram/storage only when present.
      if (body.ram_gb !== '') body.ram_gb = Number(body.ram_gb); else delete body.ram_gb;
      if (body.storage_gb !== '') body.storage_gb = Number(body.storage_gb); else delete body.storage_gb;
      ['hostname','asset_tag','assigned_user','manufacturer','model','serial','os','cpu','warranty_until','last_serviced_at','notes'].forEach((k) => {
        if (body[k] === '') delete body[k];
      });
      const created = await postJson(`/contract-clients/${clientId}/assets`, body);
      onCreated?.(created);
      setForm({
        location_id: locations[0]?.id || '', hostname: '', asset_tag: '', assigned_user: '',
        type: 'laptop', manufacturer: '', model: '', serial: '', os: '', cpu: '',
        ram_gb: '', storage_gb: '', warranty_until: '', last_serviced_at: '', status: 'active', notes: '',
      });
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
      title="Add asset"
      footer={(
        <div className="flex flex-wrap items-center gap-2 justify-end">
          <button type="button" className="btn-ghost tap-target" onClick={onClose}>Cancel</button>
          <button type="submit" form="new-asset-form" disabled={busy} className="btn-primary tap-target disabled:opacity-50">
            {busy ? 'Saving…' : 'Add asset'}
          </button>
        </div>
      )}
    >
      <form id="new-asset-form" onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Location *</span>
            <select
              className="input tap-target mt-1"
              value={form.location_id}
              onChange={(e) => setForm({ ...form, location_id: Number(e.target.value) })}
              required
            >
              {locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Type *</span>
            <select
              className="input tap-target mt-1"
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
              required
            >
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Hostname</span>
            <input className="input tap-target mt-1" value={form.hostname} onChange={(e) => setForm({ ...form, hostname: e.target.value })} placeholder="ACME-LAPTOP-04" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Asset tag</span>
            <input className="input tap-target mt-1" value={form.asset_tag} onChange={(e) => setForm({ ...form, asset_tag: e.target.value })} />
          </label>
        </div>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Assigned user</span>
          <input className="input tap-target mt-1" value={form.assigned_user} onChange={(e) => setForm({ ...form, assigned_user: e.target.value })} />
        </label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Manufacturer</span>
            <input className="input tap-target mt-1" value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Model</span>
            <input className="input tap-target mt-1" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Serial</span>
            <input className="input tap-target mt-1" value={form.serial} onChange={(e) => setForm({ ...form, serial: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">OS</span>
            <input className="input tap-target mt-1" value={form.os} onChange={(e) => setForm({ ...form, os: e.target.value })} placeholder="Windows 11 / macOS 15 / Ubuntu 24" />
          </label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">CPU</span>
            <input className="input tap-target mt-1" value={form.cpu} onChange={(e) => setForm({ ...form, cpu: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">RAM (GB)</span>
            <input type="number" min="0" className="input tap-target mt-1" value={form.ram_gb} onChange={(e) => setForm({ ...form, ram_gb: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Storage (GB)</span>
            <input type="number" min="0" className="input tap-target mt-1" value={form.storage_gb} onChange={(e) => setForm({ ...form, storage_gb: e.target.value })} />
          </label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Warranty until</span>
            <input type="date" className="input tap-target mt-1" value={form.warranty_until} onChange={(e) => setForm({ ...form, warranty_until: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Last serviced</span>
            <input type="date" className="input tap-target mt-1" value={form.last_serviced_at} onChange={(e) => setForm({ ...form, last_serviced_at: e.target.value })} />
          </label>
        </div>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Notes</span>
          <textarea className="input mt-1 min-h-[60px]" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </label>
        {error && <div className="text-sm text-red-700 bg-red-50 rounded p-2">{error}</div>}
      </form>
    </Modal>
  );
}
