import { useState, useEffect } from 'react';
import Modal from '../Modal.jsx';
import { patchJson } from '../../lib/api.js';

/**
 * EditContactModal — edit an existing contract-client contact.
 *
 * Fields editable: name, email, phone, role, is_office_manager,
 * notify_on_request, status, location_id (when the client has multiple
 * locations, a select lets admin move the contact to a different office).
 *
 * PATCH /api/contract-clients/contacts/:ctid handles the rest.
 */
export default function EditContactModal({ open, onClose, contact, locations, onSaved }) {
  const [form, setForm] = useState(() => contact || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setForm(contact || null);
    setError('');
  }, [contact]);

  if (!contact || !form) return null;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const updated = await patchJson(`/contract-clients/contacts/${contact.id}`, {
        name: form.name,
        email: form.email || null,
        phone: form.phone || null,
        role: form.role || null,
        is_office_manager: form.is_office_manager ? 1 : 0,
        notify_on_request: form.notify_on_request ? 1 : 0,
        status: form.status || 'active',
        location_id: Number(form.location_id),
      });
      onSaved?.(updated);
      onClose?.();
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
      title={`Edit ${contact.name}`}
      footer={(
        <div className="flex flex-wrap items-center gap-2 justify-end">
          <button type="button" className="btn-ghost tap-target" onClick={onClose}>Cancel</button>
          <button type="submit" form="edit-contact-form" disabled={busy} className="btn-primary tap-target disabled:opacity-50">
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}
    >
      <form id="edit-contact-form" onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Name *</span>
          <input
            className="input tap-target mt-1"
            value={form.name || ''}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            autoFocus
          />
        </label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Email</span>
            <input
              type="email"
              className="input tap-target mt-1"
              value={form.email || ''}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Phone</span>
            <input
              className="input tap-target mt-1"
              value={form.phone || ''}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Role</span>
            <input
              className="input tap-target mt-1"
              value={form.role || ''}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              placeholder="Office Manager, IT Coordinator…"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Location</span>
            <select
              className="input tap-target mt-1"
              value={form.location_id || ''}
              onChange={(e) => setForm({ ...form, location_id: Number(e.target.value) })}
            >
              {(locations || []).map((l) => (
                <option key={l.id} value={l.id}>{l.label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-center">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!form.is_office_manager}
              onChange={(e) => setForm({ ...form, is_office_manager: e.target.checked ? 1 : 0 })}
            />
            <span>Office manager</span>
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!form.notify_on_request}
              onChange={(e) => setForm({ ...form, notify_on_request: e.target.checked ? 1 : 0 })}
            />
            <span>Notify on requests</span>
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Status</span>
            <select
              className="input tap-target mt-1"
              value={form.status || 'active'}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </label>
        </div>
        {error && <div className="text-sm text-red-700 bg-red-50 rounded p-2">{error}</div>}
      </form>
    </Modal>
  );
}
