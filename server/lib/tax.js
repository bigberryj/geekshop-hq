/**
 * Tax + labour rate math.
 *
 * All amounts in CENTS (integer) — no floats. Rounding is banker's-style
 * half-up to whole cents so $100 × 9.975% = 998 cents (not 997 or 999).
 *
 * The 5% federal GST is consistent across Canada. Provincial tax varies:
 *   - BC: 7% PST (on top of GST; PST applies to the same base as GST)
 *   - QC: 9.975% QST (on top of GST; same base)
 *   - ON: 13% HST (single blended line, federal + provincial)
 *   - NB/NS/PE: 15% HST
 *   - AB/SK/MT/YT/NT/NU: no provincial sales tax (GST only or none)
 *   - Non-taxable: "none"
 *
 * Per-invoice override: if `tax_cents_override` is passed (e.g. 0 for a
 * tax-exempt customer, or a manually-calculated amount), it bypasses the
 * model. The override is recorded in `tax_lines` as a single synthetic
 * line so the invoice still shows *something* in the tax section.
 *
 * `applyLabourRate(entries, { rate_cents_per_hour })` converts time
 * entries into invoice line items. One line per entry, with the time
 * note as the description. Lets the admin "import" tracked time into
 * an invoice with one click.
 */

const roundHalfUpToCent = (cents) => Math.round(cents);

export const TAX_MODELS = [
  { key: 'none', label: 'No tax', lines: [] },
  { key: 'gst', label: 'GST 5% (federal only)', lines: [{ label: 'GST', rate: 0.05 }] },
  {
    key: 'gst_pst_bc',
    label: 'BC: GST 5% + PST 7%',
    lines: [
      { label: 'GST', rate: 0.05 },
      { label: 'PST', rate: 0.07 },
    ],
  },
  {
    key: 'gst_qst_qc',
    label: 'QC: GST 5% + QST 9.975%',
    lines: [
      { label: 'GST', rate: 0.05 },
      { label: 'QST', rate: 0.09975 },
    ],
  },
  { key: 'hst_on_13', label: 'HST 13% (Ontario)', lines: [{ label: 'HST', rate: 0.13 }] },
  { key: 'hst_nb_ns_pe_15', label: 'HST 15% (NB/NS/PE)', lines: [{ label: 'HST', rate: 0.15 }] },
];

export const DEFAULT_TAX_MODEL = 'gst_pst_bc';

export function getTaxModel(key) {
  return TAX_MODELS.find((m) => m.key === key) || TAX_MODELS[0];
}

/**
 * Compute subtotal, per-line tax, total tax, and grand total for an invoice.
 *
 * Inputs:
 *   model:           one of TAX_MODELS keys (e.g. 'gst_pst_bc')
 *   lineItems:       [{ qty, unit_price, description? }] (unit_price in cents)
 *   tax_cents_override: number | undefined — bypass the model
 *
 * Returns:
 *   {
 *     subtotal_cents, tax_lines: [{label, rate, amount_cents}],
 *     tax_cents, total_cents,
 *     tax_model_key, tax_model_label,
 *   }
 */
export function computeInvoiceTotals({ model = DEFAULT_TAX_MODEL, lineItems = [], tax_cents_override } = {}) {
  const subtotal = lineItems.reduce((s, li) => s + (Number(li.qty) || 1) * (Number(li.unit_price) || 0), 0);
  const def = getTaxModel(model);

  let tax_lines;
  if (typeof tax_cents_override === 'number' && Number.isFinite(tax_cents_override)) {
    // Explicit override (e.g. 0 for tax-exempt). Single synthetic line.
    tax_lines = tax_cents_override > 0
      ? [{ label: 'Tax (manual)', rate: null, amount_cents: tax_cents_override }]
      : [];
  } else {
    tax_lines = def.lines.map((ln) => ({
      label: ln.label,
      rate: ln.rate,
      amount_cents: roundHalfUpToCent(subtotal * ln.rate),
    }));
  }

  const tax_cents = tax_lines.reduce((s, ln) => s + ln.amount_cents, 0);
  return {
    subtotal_cents: subtotal,
    tax_lines,
    tax_cents,
    total_cents: subtotal + tax_cents,
    tax_model_key: def.key,
    tax_model_label: def.label,
  };
}

/**
 * Convert seconds to a 4-decimal-hour value (used for qty in invoice lines).
 */
export function durationToHours(seconds) {
  return Math.round((seconds / 3600) * 10000) / 10000;
}

/**
 * Convert time entries into invoice line items at a given labour rate.
 *
 * Inputs:
 *   entries: [{ id, started_at, stopped_at, duration_seconds, note }]
 *   { rate_cents_per_hour, currency? }
 *
 * Returns: [{ description, qty (hours), unit_price (cents/hour), total_cents, type: 'labour', source_time_entry_id }]
 *
 * Skips entries with no `duration_seconds` (still running).
 */
export function applyLabourRate(entries = [], { rate_cents_per_hour, currency = 'CAD' } = {}) {
  if (!rate_cents_per_hour || rate_cents_per_hour <= 0) return [];
  const lines = [];
  for (const e of entries) {
    if (!e.duration_seconds) continue;
    const hours = durationToHours(e.duration_seconds);
    if (hours <= 0) continue;
    const total_cents = Math.round(hours * rate_cents_per_hour);
    const when = e.started_at ? new Date(e.started_at).toISOString().slice(0, 10) : '';
    lines.push({
      description: e.note ? `${e.note}${when ? ` (${when})` : ''}` : `Labour${when ? ` (${when})` : ''}`,
      qty: hours,
      unit_price: rate_cents_per_hour,
      total_cents,
      type: 'labour',
      source_time_entry_id: e.id,
      currency,
    });
  }
  return lines;
}
