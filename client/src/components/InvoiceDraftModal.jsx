import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { postJson } from '../lib/api.js';

/**
 * Modal that previews an invoice draft from a customer's un-invoiced time
 * entries, lets the admin toggle / override the private minimum-charge floor,
 * and creates the invoice on confirm.
 *
 * Props:
 *   customer: { id, name }
 *   onClose: () => void
 *   onCreated: (invoice) => void    // called with the created invoice (id, invoice_uid, etc.)
 *   configuredFloorCents: number    // the admin's saved default minimum, from /api/settings
 *
 * Behaviour:
 *   - On open, calls /api/invoices/draft-from-time once to get the unboosted draft.
 *   - Re-derives the floor in-component as the user changes the override / toggle
 *     so the preview updates live. (Server is the source of truth — we re-call
 *     the endpoint on Apply, but client-side math is just for instant feedback.)
 *   - "Create invoice" calls /api/invoices with the boosted line items, marks
 *     the time entries as invoiced, then opens the printable invoice in a new tab.
 */
export default function InvoiceDraftModal({ customer, onClose, onCreated, configuredFloorCents = 0 }) {
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // User-controlled floor state. Initialised from server's configured value.
  const [floorEnabled, setFloorEnabled] = useState(configuredFloorCents > 0);
  const [floorOverride, setFloorOverride] = useState(''); // empty = use configured
  const [busyPreview, setBusyPreview] = useState(false);

  const loadDraft = async (apply = floorEnabled, override = floorOverride) => {
    setError('');
    setBusyPreview(true);
    try {
      const payload = {
        customer_id: customer.id,
        min_charge_apply: apply,
      };
      if (override !== '' && override != null) {
        const cents = Math.round(Number(override) * 100);
        if (Number.isFinite(cents) && cents >= 0) payload.min_charge_cents_override = cents;
      }
      const d = await postJson('/invoices/draft-preview', payload);
      setDraft(d);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusyPreview(false);
    }
  };

  useEffect(() => {
    loadDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer.id]);

  // Re-preview when the user toggles or changes the override.
  useEffect(() => {
    if (!draft) return;
    const t = setTimeout(() => loadDraft(floorEnabled, floorOverride), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorEnabled, floorOverride]);

  const create = async () => {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      const payload = {
        customer_id: customer.id,
        line_items: draft.line_items,
        tax_model: draft.tax_model_key,
      };
      const created = await postJson('/invoices', payload);
      const timeEntryIds = (draft.line_items || [])
        .map((li) => li.source_time_entry_id)
        .filter(Boolean);
      if (timeEntryIds.length) {
        await postJson('/time-entries/mark-invoiced', { time_entry_ids: timeEntryIds });
      }
      onCreated?.(created);
      window.open(`/api/invoices/${created.id}/print`, '_blank');
      onClose();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!customer) return null;

  const floorCents = (() => {
    if (floorOverride !== '' && floorOverride != null) {
      const n = Number(floorOverride);
      if (Number.isFinite(n) && n >= 0) return Math.round(n * 100);
    }
    return configuredFloorCents;
  })();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-lg font-semibold">
            Draft invoice — {customer.name}
          </h3>
          <button className="btn-ghost p-1" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          {error && <div className="text-sm text-red-600 mb-3">{error}</div>}
          {!draft && !error && <div className="text-sm text-slate-500">Loading…</div>}
          {busyPreview && draft && (
            <div className="text-xs text-slate-400 mb-2">Recalculating…</div>
          )}

          {draft && (
            <>
              <div className="mb-4">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-slate-500">
                    <tr>
                      <th className="pb-1">Description</th>
                      <th className="pb-1 text-right">Qty</th>
                      <th className="pb-1 text-right">Rate</th>
                      <th className="pb-1 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.line_items.map((li, i) => (
                      <tr key={i} className="border-t">
                        <td className="py-1.5">{li.description}</td>
                        <td className="py-1.5 text-right font-mono">{li.qty}h</td>
                        <td className="py-1.5 text-right font-mono">
                          ${(li.unit_price / 100).toFixed(2)}/h
                          {li.type === 'labour' &&
                            draft.floor?.applied &&
                            li.total_cents >
                              (draft.floor.original_labour_subtotal_cents *
                                (li.total_cents / Math.max(1, draft.floor.boosted_labour_subtotal_cents)) || 0) && (
                              <span className="ml-1 text-[10px] text-amber-600" title="Rate adjusted up to meet your private minimum charge">
                                *
                              </span>
                            )}
                        </td>
                        <td className="py-1.5 text-right font-mono font-semibold">
                          ${(li.total_cents / 100).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t-2">
                    <tr>
                      <td colSpan={3} className="pt-2 text-right text-xs text-slate-500">Subtotal</td>
                      <td className="pt-2 text-right font-mono">${(draft.subtotal_cents / 100).toFixed(2)}</td>
                    </tr>
                    {draft.tax_lines.map((tl, i) => (
                      <tr key={i}>
                        <td colSpan={3} className="text-right text-xs text-slate-500">
                          {tl.label} {tl.rate != null ? `(${(tl.rate * 100).toFixed(tl.rate >= 0.1 ? 2 : 3)}%)` : ''}
                        </td>
                        <td className="text-right font-mono text-slate-600">${(tl.amount_cents / 100).toFixed(2)}</td>
                      </tr>
                    ))}
                    <tr className="border-t">
                      <td colSpan={3} className="pt-2 text-right font-semibold">Total</td>
                      <td className="pt-2 text-right font-mono font-bold text-lg">
                        ${(draft.total_cents / 100).toFixed(2)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Minimum charge controls — admin only, never sent to customer */}
              <div className="bg-slate-50 border border-slate-200 rounded p-3 mb-2">
                <div className="flex items-center justify-between mb-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={floorEnabled}
                      onChange={(e) => setFloorEnabled(e.target.checked)}
                    />
                    <span className="font-medium">Apply minimum charge</span>
                    <span className="text-xs text-slate-500">(private — never shown on invoice)</span>
                  </label>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <label className="text-xs text-slate-600">Floor amount (overrides default for this invoice):</label>
                  <input
                    type="number"
                    className="input w-24"
                    step="0.01"
                    min="0"
                    placeholder={configuredFloorCents > 0 ? `${(configuredFloorCents / 100).toFixed(2)}` : '0.00'}
                    value={floorOverride}
                    onChange={(e) => setFloorOverride(e.target.value)}
                  />
                </div>
                {draft.floor && (
                  <div className="text-xs text-slate-500 mt-2">
                    {draft.floor.applied ? (
                      <>
                        Floor applied: labour subtotal ${(draft.floor.original_labour_subtotal_cents / 100).toFixed(2)}{' '}
                        → ${(draft.floor.boosted_labour_subtotal_cents / 100).toFixed(2)}
                        (line items re-priced proportionally; invoice still shows normal labour lines)
                      </>
                    ) : floorCents > 0 ? (
                      <>
                        Floor ${(floorCents / 100).toFixed(2)} set, but not applied (labour subtotal{' '}
                        ${(draft.floor.original_labour_subtotal_cents / 100).toFixed(2)} already meets it)
                      </>
                    ) : configuredFloorCents > 0 ? (
                      <>Default floor is ${(configuredFloorCents / 100).toFixed(2)} — currently disabled for this invoice</>
                    ) : (
                      <>No minimum charge configured. Set one in Settings to enable.</>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t bg-slate-50">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={create} disabled={busy || !draft}>
            {busy ? 'Creating…' : 'Create invoice'}
          </button>
        </div>
      </div>
    </div>
  );
}
