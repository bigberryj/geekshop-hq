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
 * Normalize a single invoice line item into a canonical shape that
 * downstream code (computeInvoiceTotals, renderers, PDF, reports) can
 * rely on. The codebase grew two overlapping schemas:
 *
 *   Legacy (Money / draft-from-time):
 *     { description, qty, unit_price, total_cents?, type?, source_time_entry_id? }
 *
 *   Modern (Accounting invoice editor):
 *     { description, quantity, unit_price_cents, taxable?, tax_rate_id? }
 *
 * Both are accepted as input and normalised to BOTH key sets so the
 * persisted JSON reads correctly in renderers (which still use the legacy
 * keys) AND in the SQL reports (which already coalesce both).
 *
 * Inputs that are not numbers (e.g. NaN, null, undefined) become 0.
 * Other pass-through keys (type, source_time_entry_id, product_id, etc.)
 * are preserved verbatim so legacy flows keep their metadata.
 */
export function normalizeLineItem(li) {
  if (!li || typeof li !== 'object') {
    return { description: '', quantity: 0, qty: 0, unit_price_cents: 0, unit_price: 0, total_cents: 0, taxable: true, tax_rate_id: null };
  }
  const quantity = Number.isFinite(Number(li.quantity)) ? Number(li.quantity)
                  : Number.isFinite(Number(li.qty))      ? Number(li.qty)
                  : 1;
  const unit_price_cents = Number.isFinite(Number(li.unit_price_cents)) ? Number(li.unit_price_cents)
                          : Number.isFinite(Number(li.unit_price))      ? Number(li.unit_price)
                          : 0;
  let total_cents;
  if (Number.isFinite(Number(li.total_cents))) {
    total_cents = Math.round(Number(li.total_cents));
  } else {
    total_cents = Math.round(quantity * unit_price_cents);
  }
  const description = String(li.description ?? '');
  // taxable defaults to true when omitted (matches "all lines are taxable unless you uncheck the box").
  // A non-numeric / missing value also means "taxable" — the only falsy inputs are explicit `false` / `0`.
  let taxable = true;
  if (li.taxable === false || li.taxable === 0 || li.taxable === '0' || li.taxable === 'false') taxable = false;
  const tax_rate_id = li.tax_rate_id == null || li.tax_rate_id === '' ? null : Number(li.tax_rate_id);

  // Build a fresh object that:
  //  1) starts with the original keys preserved (so type, source_time_entry_id,
  //     product_id, currency, etc. all survive), and
  //  2) overwrites the canonicalised numeric / tax fields with the
  //     computed values.
  // Doing the spread first lets the explicit assignments win when both
  // names are present (e.g. description, qty, unit_price).
  const out = { ...li };
  out.description = description;
  out.quantity = quantity;
  out.qty = quantity;
  out.unit_price_cents = unit_price_cents;
  out.unit_price = unit_price_cents;
  out.total_cents = total_cents;
  out.taxable = taxable;
  out.tax_rate_id = tax_rate_id;
  return out;
}

/**
 * Normalize an array of line items. Always returns a fresh array of fresh
 * objects — never mutates the input.
 */
export function normalizeLineItems(lineItems) {
  if (!Array.isArray(lineItems)) return [];
  return lineItems.map(normalizeLineItem);
}

/**
 * Compute subtotal, per-line tax, total tax, and grand total for an invoice.
 *
 * Inputs:
 *   model:           one of TAX_MODELS keys (e.g. 'gst_pst_bc') — used when
 *                    no line item specifies its own tax_rate_id
 *   lineItems:       [{ qty | quantity, unit_price | unit_price_cents, ... }]
 *                    (prices in cents). Mixed shapes are accepted.
 *   tax_cents_override: number | undefined — bypass the model entirely
 *   taxRates:        optional Map<id, {name, rate_bps}> or array of the
 *                    same shape. When provided, line items with a
 *                    `tax_rate_id` use that rate (basis points) per-line
 *                    instead of the global model. Lines without a
 *                    `tax_rate_id` still fall back to the global model.
 *
 * Per-line tax is OFF by default — the existing behaviour is preserved when
 * the caller doesn't supply taxRates. The Accounting invoice editor
 * supplies them, so the line-by-line tax-rates model is authoritative
 * there.
 *
 * Returns:
 *   {
 *     subtotal_cents, tax_lines: [{label, rate, amount_cents}],
 *     tax_cents, total_cents,
 *     tax_model_key, tax_model_label,
 *   }
 */
export function computeInvoiceTotals({
  model = DEFAULT_TAX_MODEL,
  lineItems = [],
  tax_cents_override,
  taxRates,
} = {}) {
  // Normalize first so all downstream math sees a consistent shape.
  const normalized = normalizeLineItems(lineItems);
  // Subtotal is the sum of ALL line `total_cents` — it's the invoice grand
  // subtotal the customer sees (e.g. "$130 of services + parts"). Only
  // *taxable* lines contribute to the tax base, so tax is computed on the
  // sum of taxable line totals, not on the full subtotal. (Regression
  // pinned by T-79EB14 invoice-preview-total.test.js — a non-taxable
  // "warranty hour" line should NOT pull tax into the total.)
  const subtotal = normalized.reduce((s, li) => s + li.total_cents, 0);
  const taxableBase = normalized
    .filter((li) => li.taxable)
    .reduce((s, li) => s + li.total_cents, 0);

  const def = getTaxModel(model);

  let tax_lines;
  if (typeof tax_cents_override === 'number' && Number.isFinite(tax_cents_override)) {
    // Explicit override (e.g. 0 for tax-exempt). Single synthetic line.
    tax_lines = tax_cents_override > 0
      ? [{ label: 'Tax (manual)', rate: null, amount_cents: tax_cents_override }]
      : [];
  } else if (hasPerLineRates(normalized) && taxRates) {
    // Per-line tax: each taxable line contributes its tax_rate's amount.
    // Aggregate by rate label so a 5%-GST line + 5%-GST line shows as one
    // entry in tax_lines (clean invoice printout).
    tax_lines = computePerLineTax(normalized, taxRates, def);
  } else {
    // Use the taxable base for the global model too — non-taxable lines
    // (taxable === false) must NOT contribute to the tax calculation even
    // when no per-line rate is supplied.
    tax_lines = def.lines.map((ln) => ({
      label: ln.label,
      rate: ln.rate,
      amount_cents: roundHalfUpToCent(taxableBase * ln.rate),
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
 * Return true iff any line has a tax_rate_id (and is taxable). Used to
 * decide whether to switch to per-line tax math.
 */
function hasPerLineRates(normalized) {
  return normalized.some((li) => li.taxable && li.tax_rate_id != null);
}

/**
 * Index a taxRates collection (array or Map) by id. Returns a Map.
 */
function indexTaxRates(taxRates) {
  if (!taxRates) return new Map();
  if (taxRates instanceof Map) return taxRates;
  if (Array.isArray(taxRates)) {
    const m = new Map();
    for (const r of taxRates) {
      if (r && r.id != null) m.set(Number(r.id), r);
    }
    return m;
  }
  return new Map();
}

/**
 * Compute per-line tax and aggregate by rate label. Lines with no
 * tax_rate_id fall back to the first line of the global model. Non-taxable
 * lines (taxable === false) contribute nothing.
 *
 * Aggregation: amounts in the same `name` bucket are summed; the rate
 * echoed is the rate_bps/10000 of the rate that contributed (assumed
 * uniform — the operator edits rates as integer bps so this can't drift
 * within a single invoice).
 */
function computePerLineTax(normalized, taxRates, model) {
  const idx = indexTaxRates(taxRates);
  const fallback = model.lines[0]; // first line of the configured model
  // Map<label, {label, rate, amount_cents}>
  const buckets = new Map();

  for (const li of normalized) {
    if (!li.taxable) continue;
    const lineTotal = li.total_cents;
    if (lineTotal === 0) continue;

    let rate;
    let label;
    if (li.tax_rate_id != null && idx.has(li.tax_rate_id)) {
      const def = idx.get(li.tax_rate_id);
      rate = Number(def.rate_bps) / 10000;
      label = String(def.name || 'Tax');
    } else if (fallback) {
      rate = fallback.rate;
      label = fallback.label;
    } else {
      continue;
    }
    if (!Number.isFinite(rate) || rate === 0) continue;
    const amount = roundHalfUpToCent(lineTotal * rate);
    if (amount === 0) continue;
    const key = label.toLowerCase();
    const prev = buckets.get(key) || { label, rate, amount_cents: 0 };
    prev.amount_cents += amount;
    buckets.set(key, prev);
  }

  return [...buckets.values()];
}

/**
 * Convert seconds to a 4-decimal-hour value (used for qty in invoice lines).
 */
export function durationToHours(seconds) {
  return Math.round((seconds / 3600) * 10000) / 10000;
}

/**
 * Phase 5 — Tax summary helpers (pure functions, no DB).
 *
 * `aggregateTaxLines(lines)` accepts the heterogeneous `tax_lines`
 * arrays stored on `invoices.tax_lines` (JSON) and returns a stable
 * breakdown by `label`. Some invoices have a tax_cents_override (single
 * synthetic "Tax (manual)" line), others have model-generated multi-line
 * arrays, and legacy rows may be missing the field entirely — all should
 * roll up cleanly.
 *
 * `rollupTaxBreakdown(breakdowns)` merges N breakdowns (e.g. many
 * invoices worth of tax_lines) into a single sorted-by-amount-desc
 * `[{label, amount_cents, rate?}]` array. Used by the Phase 5 endpoint
 * to present "GST collected", "PST collected", etc., with optional
 * `rate` echoed when every contributing line agreed on the rate.
 *
 * Both helpers operate on integer cents and never touch floats — so
 * the API response, CSV export, and UI totals are guaranteed to match
 * to the cent.
 */

/**
 * @param {Array<{label: string, rate?: number|null, amount_cents: number}>|null|undefined} lines
 * @returns {Array<{label: string, amount_cents: number, rate?: number|null}>}
 */
export function aggregateTaxLines(lines) {
  if (!Array.isArray(lines)) return [];
  const out = new Map();
  for (const ln of lines) {
    if (!ln) continue;
    const label = String(ln.label || '').trim();
    const amount = Math.round(Number(ln.amount_cents) || 0);
    if (!label || amount === 0) continue;
    const key = label.toLowerCase();
    const prev = out.get(key) || { label, amount_cents: 0, rate: ln.rate ?? null };
    prev.amount_cents += amount;
    out.set(key, prev);
  }
  return [...out.values()];
}

/**
 * @param {Array<Array<{label: string, amount_cents: number, rate?: number|null}>>} breakdowns
 * @returns {Array<{label: string, amount_cents: number, rate?: number|null}>}
 */
export function rollupTaxBreakdown(breakdowns) {
  const out = new Map();
  for (const breakdown of breakdowns) {
    if (!Array.isArray(breakdown)) continue;
    for (const ln of breakdown) {
      if (!ln) continue;
      const label = String(ln.label || '').trim();
      const amount = Math.round(Number(ln.amount_cents) || 0);
      if (!label || amount === 0) continue;
      const key = label.toLowerCase();
      const prev = out.get(key) || { label, amount_cents: 0, rate: ln.rate ?? null };
      prev.amount_cents += amount;
      // If multiple sources contribute different rates (unlikely but
      // possible during a model change), prefer the most-recent
      // non-null rate. The label is the canonical visual key.
      if (ln.rate != null) prev.rate = ln.rate;
      out.set(key, prev);
    }
  }
  // Sort by amount descending — operator cares about the big bar first.
  return [...out.values()].sort((a, b) => b.amount_cents - a.amount_cents);
}

/**
 * CSV-safe value coercion. Wraps anything containing comma / quote /
 * newline in double quotes and escapes internal quotes by doubling
 * them. Mirrors RFC 4180 quoting so Excel / LibreOffice / `csv.reader`
 * consume it without surprises.
 *
 * @param {unknown} v
 * @returns {string}
 */
export function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Build a CSV string from a header row + data rows. Header names are
 * quoted via the same rules as data so an operator can dump this file
 * straight into QuickBooks / CRA / an accountant's spreadsheet.
 *
 * @param {string[]} headers
 * @param {Array<Array<unknown>>} rows
 * @returns {string}
 */
export function toCsv(headers, rows) {
  const lines = [];
  lines.push(headers.map(csvCell).join(','));
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  // RFC 4180 uses CRLF; Excel accepts it; git diffs look slightly
  // noisier but the canonical reference is CRLF, so use it.
  return lines.join('\r\n') + '\r\n';
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

/**
 * Apply a private minimum-charge floor to a set of invoice line items.
 *
 * Important: this is BYRON's private accounting fact, not the customer's.
 * The function boosts the unit_price on the existing labour lines so the
 * total equals the floor — no "minimum charge" line is ever added. The
 * customer sees a clean invoice; the admin sees the boost in the preview
 * modal with a clear label.
 *
 * Only line items with `type: 'labour'` are boosted. Non-labour lines
 * (parts, ad-hoc fees) are left alone — the floor applies to the work,
 * not the parts. If the labour subtotal is already at or above the
 * floor, the lines are returned unchanged.
 *
 * Distribution: the boost is distributed proportionally across labour
 * lines by `total_cents`, then any rounding remainder (in cents) is
 * added to the largest line so the sum equals the floor exactly. Hours
 * (`qty`) are NOT changed — only `unit_price` and `total_cents`.
 *
 * Inputs:
 *   lineItems: array of line items (mutated-clone, originals untouched)
 *   floor_cents: integer >= 0 (0 = floor disabled, returns lines unchanged)
 *
 * Returns: {
 *   line_items: new array (originals cloned, not mutated)
 *   floor_applied: boolean
 *   floor_cents: number (echoed back for display)
 *   original_labour_subtotal_cents: number
 *   boosted_labour_subtotal_cents: number
 * }
 */
export function applyMinimumChargeFloor(lineItems = [], floor_cents = 0) {
  const floor = Math.max(0, Math.floor(Number(floor_cents) || 0));
  const labour = lineItems.filter((li) => li && li.type === 'labour');
  const original_labour_subtotal_cents = labour.reduce(
    (s, li) => s + (Number(li.total_cents) || 0),
    0
  );

  // Floor disabled OR labour already meets it — return cloned lines untouched.
  if (floor === 0 || original_labour_subtotal_cents >= floor) {
    return {
      line_items: lineItems.map((li) => ({ ...li })),
      floor_applied: false,
      floor_cents: floor,
      original_labour_subtotal_cents,
      boosted_labour_subtotal_cents: original_labour_subtotal_cents,
    };
  }

  // Need to boost by `delta` cents. Distribute proportionally by total_cents.
  const delta = floor - original_labour_subtotal_cents;
  const total = original_labour_subtotal_cents;
  const boosted = labour.map((li) => {
    const base_total = Number(li.total_cents) || 0;
    const share = total > 0 ? Math.floor((base_total / total) * delta) : Math.floor(delta / labour.length);
    const new_total = base_total + share;
    // Recompute unit_price to match: new_total / qty, rounded to whole cent.
    const qty = Number(li.qty) || 0;
    const new_unit_price = qty > 0 ? Math.round(new_total / qty) : new_total;
    return { ...li, unit_price: new_unit_price, total_cents: new_total };
  });

  // Distribute the rounding remainder so boosted_labour_subtotal_cents === floor exactly.
  const boosted_sum = boosted.reduce((s, li) => s + (Number(li.total_cents) || 0), 0);
  const remainder = floor - boosted_sum;
  if (remainder !== 0 && boosted.length > 0) {
    // Put the remainder on the largest line so it's the least-visible change.
    let largestIdx = 0;
    for (let i = 1; i < boosted.length; i++) {
      if (boosted[i].total_cents > boosted[largestIdx].total_cents) largestIdx = i;
    }
    boosted[largestIdx] = {
      ...boosted[largestIdx],
      total_cents: boosted[largestIdx].total_cents + remainder,
      unit_price:
        (Number(boosted[largestIdx].qty) || 0) > 0
          ? Math.round((boosted[largestIdx].total_cents + remainder) / boosted[largestIdx].qty)
          : boosted[largestIdx].unit_price + remainder,
    };
  }

  // Recombine: keep original order — boost labour lines in place, leave others alone.
  // Use position, not source_time_entry_id, so ad-hoc labour lines without a
  // source id don't all collapse onto the same Map key.
  let boostedIdx = 0;
  const recombined = lineItems.map((li) => {
    if (li && li.type === 'labour') {
      const next = boosted[boostedIdx];
      boostedIdx += 1;
      return next ? { ...next } : { ...li };
    }
    return { ...li };
  });

  return {
    line_items: recombined,
    floor_applied: true,
    floor_cents: floor,
    original_labour_subtotal_cents,
    boosted_labour_subtotal_cents: floor,
  };
}
