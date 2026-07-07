import { useState } from 'react';
import Modal from '../Modal.jsx';
import { postJson } from '../../lib/api.js';

/**
 * NewContactModal — add a person to a specific contract location.
 */
export default function NewContactModal({ open, onClose, clientId, locationId, onCreated }) {
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    role: '',
    is_office_manager: 0,
    notify_on_request: 1,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await postJson(
        `/contract-clients/${clientId}/locations/${locationId}/contacts`,
        { ...form, is_office_manager: Number(form.is_office_manager), notify_on_request: Number(form.notify_on_request) }
      );
      onCreated?.(created);
      setForm({ name: '', email: '', phone: '', role: '', is_office_manager: 0, notify_on_request: 1 });
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
      title="Add contact"
      footer={(
        <div className="flex flex-wrap items-center gap-2 justify-end">
          <button type="button" className="btn-ghost tap-target" onClick={onClose}>Cancel</button>
          <button type="submit" form="new-contact-form" disabled={busy} className="btn-primary tap-target disabled:opacity-50">
            {busy ? 'Saving…' : 'Add contact'}
          </button>
        </div>
      )}
    >
      <form id="new-contact-form" onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Name *</span>
          <input className="input tap-target mt-1" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
        </label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Email</span>
            <input type="email" className="input tap-target mt-1" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Phone</span>
            <input className="input tap-target mt-1" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </label>
        </div>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Role</span>
          <input
            className="input tap-target mt-1"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
            placeholder="Office Manager, IT Coordinator…"
          />
        </label>
        <div className="flex flex-wrap gap-4">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!form.is_office_manager}
              onChange={(e) => setForm({ ...form, is_office_manager: e.target.checked ? 1 : 0 })}
            />
            <span>Office manager (recommended for portal login)</span>
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!form.notify_on_request}
              onChange={(e) => setForm({ ...form, notify_on_request: e.target.checked ? 1 : 0 })}
            />
            <span>Email me when requests are submitted</span>
          </label>
        </div>
        {error && <div className="text-sm text-red-700 bg-red-50 rounded p-2">{error}</div>}
      </form>
    </Modal>
  );
}
