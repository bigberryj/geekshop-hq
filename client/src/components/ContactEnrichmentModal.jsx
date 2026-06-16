import { useState } from 'react';
import { putJson } from '../lib/api.js';
import { X, BookUser, Check, Loader2 } from 'lucide-react';

/**
 * ContactEnrichmentModal
 *
 * Shown after a Gmail email is imported. The server has already found
 * a matching contact in Google Contacts and proposed which fields to
 * fill in on the customer record. The user picks which fields to apply
 * (or skips entirely) — nothing is written until they confirm.
 *
 * Per Byron's preference (2026-06-15):
 *   - preview_then_apply: show preview, never auto-apply
 *   - email_first_name_keep: only fill blanks, never overwrite name
 *
 * The "skipped" list (fields that would have been overwritten) is shown
 * muted at the bottom so Byron knows the data is there if he wants it.
 */
export default function ContactEnrichmentModal({ match, onApply, onSkip, onClose }) {
  const { diff, candidate } = match;
  const proposedEntries = Object.entries(diff.proposed || {}).filter(([_, v]) => v);
  const skippedEntries = (diff.skipped || []).map((s) => ({ key: s.key, current: s.current, proposed: s.proposed }));

  // Default: every proposed field is checked. User can opt out per field.
  const [selected, setSelected] = useState(() => {
    const init = {};
    for (const [k, _] of proposedEntries) init[k] = true;
    return init;
  });
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');

  const toggle = (k) => setSelected((s) => ({ ...s, [k]: !s[k] }));

  const apply = async () => {
    if (!candidate?.resourceName) {
      setError('no candidate to apply');
      return;
    }
    const customerId = match.customer?.id;
    if (!customerId) {
      setError('no customer id from import — cannot apply');
      return;
    }
    const patch = {};
    for (const [k, v] of Object.entries(diff.proposed || {})) {
      if (selected[k] && v) patch[k] = v;
    }
    if (Object.keys(patch).length === 0) {
      // Nothing selected — treat as skip.
      onSkip?.();
      return;
    }
    setApplying(true);
    setError('');
    try {
      await putJson(`/customers/${customerId}`, patch);
      onApply?.({ customerId, patch, candidate });
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setApplying(false);
    }
  };

  if (!diff || proposedEntries.length === 0) {
    return (
      <ModalShell onClose={onClose} title="Google Contacts match" icon={<BookUser size={14} />}>
        <p className="text-sm text-slate-600">
          Found <strong>{candidate?.name || 'a contact'}</strong> in your Google Contacts, but no
          blank fields to fill in. Nothing to apply.
        </p>
        <div className="mt-3 flex justify-end">
          <button onClick={onClose} className="btn-primary text-xs" data-testid="enrichment-dismiss">
            <Check size={12} /> Got it
          </button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell
      onClose={onClose}
      title={`Found ${candidate.name} in Google Contacts`}
      icon={<BookUser size={14} />}
    >
      <p className="text-sm text-slate-600 mb-3" data-testid="enrichment-intro">
        Matched by {match.match?.primaryEmail ? `email (${match.match.primaryEmail})` : 'name'}. Apply any of these — existing data won't be overwritten.
      </p>

      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-2">{error}</div>}

      <div className="space-y-2" data-testid="enrichment-fields">
        {proposedEntries.map(([key, value]) => (
          <label key={key} className="flex items-start gap-2 p-2 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer">
            <input
              type="checkbox"
              checked={!!selected[key]}
              onChange={() => toggle(key)}
              className="mt-1"
              data-testid={`enrichment-field-${key}`}
            />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-slate-700">{fieldLabel(key)}</div>
              <div className="text-sm text-slate-900 break-words whitespace-pre-wrap">{value}</div>
              {diff.currentValues?.[key] && (
                <div className="text-xs text-slate-500 mt-0.5">
                  (current: {diff.currentValues[key] || <em>empty</em>})
                </div>
              )}
            </div>
          </label>
        ))}
      </div>

      {skippedEntries.length > 0 && (
        <details className="mt-3">
          <summary className="text-xs text-slate-500 cursor-pointer">
            {skippedEntries.length} field{skippedEntries.length > 1 ? 's' : ''} skipped (would overwrite your existing data)
          </summary>
          <ul className="mt-1 text-xs text-slate-500 space-y-1">
            {skippedEntries.map((s) => (
              <li key={s.key}>
                <strong>{fieldLabel(s.key)}</strong>: keeping "{s.current}", Google's value is "{s.proposed}"
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onSkip} className="btn-ghost text-xs" disabled={applying} data-testid="enrichment-skip">
          <X size={12} /> Skip
        </button>
        <button onClick={apply} className="btn-primary text-xs" disabled={applying} data-testid="enrichment-apply">
          {applying ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {applying ? 'Applying…' : 'Apply selected'}
        </button>
      </div>
    </ModalShell>
  );
}

function fieldLabel(key) {
  return ({
    name: 'Name',
    company: 'Company',
    phone: 'Phone',
    email: 'Email',
    notes: 'Notes',
  })[key] || key;
}

function ModalShell({ onClose, title, icon, children }) {
  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      data-testid="contact-enrichment-modal"
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-lg w-full p-4 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-sm flex items-center gap-2">{icon}{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
