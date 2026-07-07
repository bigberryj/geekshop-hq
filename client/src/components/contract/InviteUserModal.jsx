import { useState } from 'react';
import Modal from '../Modal.jsx';
import { postJson } from '../../lib/api.js';

/**
 * InviteUserModal — generate a magic-link invite for a contract user.
 *
 * Admin pastes the user's email + picks which location(s) they can manage.
 * Returns a one-time URL ready to copy/paste.
 *
 * The full URL is built client-side so admin can copy/share without
 * re-querying the server. In production this is also where the email
 * send would be triggered; we leave that seam documented in the
 * solution doc since Gmail sending for client users is not in v1.
 */
export default function InviteUserModal({ open, onClose, clientId, clientName, locations, onCreated }) {
  const [form, setForm] = useState({
    email: '',
    display_name: '',
    contact_id: '',
    scope_type: 'location_manager',
    scoped_location_ids: [],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await postJson(`/contract-clients/${clientId}/invites`, {
        ...form,
        scoped_location_ids: form.scope_type === 'client_manager' ? null : form.scoped_location_ids,
      });
      const url = `${window.location.origin}/portal/redeem/${res.token}`;
      setResult({ ...res, url });
      onCreated?.(res);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleLoc = (id) => {
    setForm((f) => {
      const has = f.scoped_location_ids.includes(id);
      return {
        ...f,
        scoped_location_ids: has
          ? f.scoped_location_ids.filter((x) => x !== id)
          : [...f.scoped_location_ids, id],
      };
    });
  };

  return (
    <Modal
      open={open}
      onClose={() => { setResult(null); setError(''); onClose(); }}
      title={result ? 'Invite ready' : `Invite user — ${clientName}`}
      footer={result ? (
        <div className="flex flex-wrap items-center gap-2 justify-end">
          <button type="button" className="btn-ghost tap-target" onClick={() => { setResult(null); onClose(); }}>Close</button>
          <a href={result.url} target="_blank" rel="noreferrer" className="btn-primary tap-target">Open invite link</a>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 justify-end">
          <button type="button" className="btn-ghost tap-target" onClick={onClose}>Cancel</button>
          <button type="submit" form="invite-form" disabled={busy} className="btn-primary tap-target disabled:opacity-50">
            {busy ? 'Creating…' : 'Create invite'}
          </button>
        </div>
      )}
    >
      {result ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Send this link to <strong>{result.email}</strong>. It expires in 7 days and can be redeemed once.
          </p>
          <input
            readOnly
            className="input font-mono text-xs"
            value={result.url}
            onClick={(e) => e.target.select()}
            onFocus={(e) => e.target.select()}
          />
          <button
            type="button"
            className="btn-secondary tap-target"
            onClick={() => navigator.clipboard?.writeText(result.url)}
          >
            Copy link
          </button>
          <div className="text-xs text-slate-500 border-t pt-3">
            Email delivery to <code>{result.email}</code> is the next phase (Gmail API or a transactional provider). For now share the link manually.
          </div>
        </div>
      ) : (
        <form id="invite-form" onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Email *</span>
            <input
              type="email"
              className="input tap-target mt-1"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
              autoFocus
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Display name</span>
            <input
              className="input tap-target mt-1"
              value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              placeholder="Jane Smith"
            />
          </label>
          <fieldset className="border border-slate-200 rounded p-3">
            <legend className="text-sm font-medium text-slate-700 px-2">Scope</legend>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="scope"
                  checked={form.scope_type === 'location_manager'}
                  onChange={() => setForm({ ...form, scope_type: 'location_manager' })}
                />
                <span>Location manager — pick one or more locations below</span>
              </label>
              {form.scope_type === 'location_manager' && (
                <div className="ml-6 space-y-1 max-h-40 overflow-y-auto">
                  {locations.length === 0 && (
                    <div className="text-xs text-slate-500 italic">No locations yet — add locations first.</div>
                  )}
                  {locations.map((l) => (
                    <label key={l.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={form.scoped_location_ids.includes(l.id)}
                        onChange={() => toggleLoc(l.id)}
                      />
                      <span>{l.label}</span>
                    </label>
                  ))}
                </div>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="scope"
                  checked={form.scope_type === 'client_manager'}
                  onChange={() => setForm({ ...form, scope_type: 'client_manager', scoped_location_ids: [] })}
                />
                <span>Client manager — sees all locations on {clientName}</span>
              </label>
            </div>
          </fieldset>
          {error && <div className="text-sm text-red-700 bg-red-50 rounded p-2">{error}</div>}
        </form>
      )}
    </Modal>
  );
}
