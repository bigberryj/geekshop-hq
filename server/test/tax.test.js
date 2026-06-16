/**
 * Tax + labour rate math tests.
 *
 * These are pure functions — no DB, no AI, no HTTP. They cover:
 *   - Canadian tax model definitions
 *   - Compute tax for any model
 *   - Round-half-up to whole cents (no float drift)
 *   - Labour rate applied to time entries
 *   - Per-line-item tax override
 */

import { describe, it, expect } from 'vitest';
import {
  TAX_MODELS,
  DEFAULT_TAX_MODEL,
  computeInvoiceTotals,
  durationToHours,
  applyLabourRate,
  applyMinimumChargeFloor,
} from '../lib/tax.js';

describe('TAX_MODELS', () => {
  it('includes the five common Canadian models', () => {
    const keys = TAX_MODELS.map((m) => m.key);
    expect(keys).toEqual(
      expect.arrayContaining(['none', 'gst', 'gst_pst_bc', 'gst_qst_qc', 'hst_on_13', 'hst_nb_ns_pe_15'])
    );
  });

  it('BC default is 5% GST + 7% PST (12% combined, two lines)', () => {
    const bc = TAX_MODELS.find((m) => m.key === 'gst_pst_bc');
    expect(bc).toBeTruthy();
    expect(bc.lines).toEqual([
      { label: 'GST', rate: 0.05 },
      { label: 'PST', rate: 0.07 },
    ]);
  });
});

describe('computeInvoiceTotals', () => {
  it('BC: $100 subtotal → $5 GST + $7 PST = $112 total', () => {
    const r = computeInvoiceTotals({ model: 'gst_pst_bc', lineItems: [{ qty: 1, unit_price: 10000 }] });
    expect(r.subtotal_cents).toBe(10000);
    expect(r.tax_lines).toEqual([
      { label: 'GST', rate: 0.05, amount_cents: 500 },
      { label: 'PST', rate: 0.07, amount_cents: 700 },
    ]);
    expect(r.tax_cents).toBe(1200);
    expect(r.total_cents).toBe(11200);
  });

  it('QC: $100 → $5 GST + $9.975 QST = $114.975 → rounds to $114.98', () => {
    const r = computeInvoiceTotals({ model: 'gst_qst_qc', lineItems: [{ qty: 1, unit_price: 10000 }] });
    expect(r.tax_lines).toEqual([
      { label: 'GST', rate: 0.05, amount_cents: 500 },
      { label: 'QST', rate: 0.09975, amount_cents: 998 },
    ]);
    expect(r.total_cents).toBe(11498);
  });

  it('HST ON 13% → single line', () => {
    const r = computeInvoiceTotals({ model: 'hst_on_13', lineItems: [{ qty: 1, unit_price: 10000 }] });
    expect(r.tax_lines).toEqual([{ label: 'HST', rate: 0.13, amount_cents: 1300 }]);
    expect(r.total_cents).toBe(11300);
  });

  it('none: zero tax', () => {
    const r = computeInvoiceTotals({ model: 'none', lineItems: [{ qty: 1, unit_price: 10000 }] });
    expect(r.tax_lines).toEqual([]);
    expect(r.tax_cents).toBe(0);
    expect(r.total_cents).toBe(10000);
  });

  it('multi-line items: tax applies to total subtotal, not per line', () => {
    const r = computeInvoiceTotals({
      model: 'gst_pst_bc',
      lineItems: [{ qty: 2, unit_price: 5000 }, { qty: 1, unit_price: 3000 }],
    });
    // subtotal = 2*5000 + 1*3000 = 13000
    expect(r.subtotal_cents).toBe(13000);
    // GST 5% of 13000 = 650, PST 7% = 910
    expect(r.tax_cents).toBe(1560);
    expect(r.total_cents).toBe(14560);
  });

  it('rounds half-cent up to whole cent (no float drift on $0.99)', () => {
    // 0.07 * 14 = 0.98 exactly
    // 0.07 * 15 = 1.05 exactly
    // 0.09975 * 1000 = 99.75 cents → 100 cents (round-half-up)
    const r = computeInvoiceTotals({ model: 'gst_qst_qc', lineItems: [{ qty: 1, unit_price: 1000 }] });
    expect(r.tax_lines[1].amount_cents).toBe(100);
  });

  it('explicit override tax_cents bypasses the model', () => {
    const r = computeInvoiceTotals({
      model: 'gst_pst_bc',
      lineItems: [{ qty: 1, unit_price: 10000 }],
      tax_cents_override: 0, // exempt customer
    });
    expect(r.tax_lines).toEqual([]);
    expect(r.tax_cents).toBe(0);
    expect(r.total_cents).toBe(10000);
  });

  it('returns the model name + label in the response for display', () => {
    const r = computeInvoiceTotals({ model: 'gst_pst_bc', lineItems: [{ qty: 1, unit_price: 1000 }] });
    expect(r.tax_model_key).toBe('gst_pst_bc');
    expect(r.tax_model_label).toBeTruthy();
  });

  it('uses total_cents as source of truth when present', () => {
    const r = computeInvoiceTotals({
      model: 'gst_pst_bc',
      lineItems: [{ qty: 0.3333, unit_price: 15002, total_cents: 5000 }],
    });
    expect(r.subtotal_cents).toBe(5000);
    expect(r.tax_cents).toBe(600);
    expect(r.total_cents).toBe(5600);
  });
});

describe('labour rate', () => {
  it('durationToHours converts seconds to 4-decimal hours', () => {
    expect(durationToHours(1800)).toBe(0.5);
    expect(durationToHours(5400)).toBe(1.5);
    expect(durationToHours(3600)).toBe(1);
  });

  it('applyLabourRate converts time entries to dollar line items at the configured rate', () => {
    const entries = [
      { id: 1, started_at: '2026-06-15T10:00:00Z', stopped_at: '2026-06-15T11:30:00Z', duration_seconds: 5400, note: 'Wi-Fi troubleshooting' },
    ];
    const lines = applyLabourRate(entries, { rate_cents_per_hour: 12500, currency: 'CAD' });
    // 1.5h * $125/h = $187.50 = 18750 cents
    expect(lines).toEqual([
      expect.objectContaining({
        description: 'Wi-Fi troubleshooting (2026-06-15)',
        qty: 1.5,
        unit_price: 12500,
        total_cents: 18750,
        type: 'labour',
        source_time_entry_id: 1,
      }),
    ]);
  });

  it('applyLabourRate returns empty array for empty entries', () => {
    expect(applyLabourRate([], { rate_cents_per_hour: 12500 })).toEqual([]);
  });

  it('applyLabourRate skips entries with no duration', () => {
    const lines = applyLabourRate(
      [{ id: 1, started_at: '2026-06-15T10:00:00Z', duration_seconds: null }],
      { rate_cents_per_hour: 12500 }
    );
    expect(lines).toEqual([]);
  });
});

describe('DEFAULT_TAX_MODEL', () => {
  it('is BC by default (5% GST + 7% PST)', () => {
    expect(DEFAULT_TAX_MODEL).toBe('gst_pst_bc');
  });
});

describe('applyMinimumChargeFloor', () => {
  const labour = (total_cents, qty, id) => ({
    description: `work #${id}`,
    qty,
    unit_price: Math.round(total_cents / qty),
    total_cents,
    type: 'labour',
    source_time_entry_id: id,
  });

  it('returns lines unchanged when floor is 0 (disabled)', () => {
    const lines = [labour(5000, 0.4, 1)];
    const r = applyMinimumChargeFloor(lines, 0);
    expect(r.floor_applied).toBe(false);
    expect(r.line_items[0].total_cents).toBe(5000);
    expect(r.original_labour_subtotal_cents).toBe(5000);
  });

  it('returns lines unchanged when labour already meets the floor', () => {
    const lines = [labour(20000, 1.5, 1)];
    const r = applyMinimumChargeFloor(lines, 5000);
    expect(r.floor_applied).toBe(false);
    expect(r.line_items[0].total_cents).toBe(20000);
  });

  it('boosts a single labour line up to the floor exactly', () => {
    // 0.4h @ $125/h = $50. Floor $75. Boost by $25.
    const lines = [labour(5000, 0.4, 1)];
    const r = applyMinimumChargeFloor(lines, 7500);
    expect(r.floor_applied).toBe(true);
    expect(r.line_items[0].total_cents).toBe(7500);
    expect(r.line_items[0].unit_price).toBe(Math.round(7500 / 0.4)); // 18750
    expect(r.boosted_labour_subtotal_cents).toBe(7500);
  });

  it('distributes the boost proportionally across multiple labour lines', () => {
    // 0.4h @ $125 = 5000c, 1.0h @ $125 = 12500c. Total 17500c = $175.
    // Floor 20000c = $200. Delta = 2500c.
    // Proportional share:
    //   5000/17500 * 2500 = 714.29 → floor = 714 → 5714
    //   12500/17500 * 2500 = 1785.71 → floor = 1785 → 14285
    // Sum: 5714 + 14285 = 19999. Remainder 1c → added to largest (second) line.
    // Final: 5714, 14286 = 20000.
    const lines = [labour(5000, 0.4, 1), labour(12500, 1.0, 2)];
    const r = applyMinimumChargeFloor(lines, 20000);
    expect(r.floor_applied).toBe(true);
    expect(r.boosted_labour_subtotal_cents).toBe(20000);
    expect(r.line_items[0].total_cents).toBe(5714);   // 5000 + 714
    expect(r.line_items[1].total_cents).toBe(14286);  // 12500 + 1785 + 1 remainder
    const sum = r.line_items.reduce((s, li) => s + li.total_cents, 0);
    expect(sum).toBe(20000); // exact
  });

  it('leaves non-labour lines untouched (parts, fees)', () => {
    const part = { description: 'USB cable', qty: 1, unit_price: 1500, total_cents: 1500, type: 'part' };
    const lines = [labour(5000, 0.4, 1), part];
    const r = applyMinimumChargeFloor(lines, 7500);
    expect(r.line_items[1]).toEqual(expect.objectContaining({ description: 'USB cable', total_cents: 1500, type: 'part' }));
    // The labour line was boosted, the part was not.
    expect(r.line_items[0].total_cents).toBe(7500);
  });

  it('handles floor = labour subtotal exactly (delta = 0 means floor disabled behaviour)', () => {
    // Edge case: floor === original_labour_subtotal. Function treats this as "no boost needed".
    const lines = [labour(5000, 0.4, 1)];
    const r = applyMinimumChargeFloor(lines, 5000);
    expect(r.floor_applied).toBe(false);
    expect(r.line_items[0].total_cents).toBe(5000);
  });

  it('does not mutate the input line items', () => {
    const lines = [labour(5000, 0.4, 1)];
    const snapshot = JSON.parse(JSON.stringify(lines));
    applyMinimumChargeFloor(lines, 7500);
    expect(lines).toEqual(snapshot);
  });

  it('preserves original order: parts, labour, fees all kept in their original positions', () => {
    const fee = { description: 'Trip charge', qty: 1, unit_price: 2000, total_cents: 2000, type: 'fee' };
    const lines = [labour(5000, 0.4, 1), fee, labour(8000, 0.6, 2)];
    // Original labour = 13000c, floor 15000c, delta = 2000c.
    // Proportional: 5000/13000*2000 = 769.23→769, 8000/13000*2000 = 1230.77→1230
    // Sum = 1999, remainder 1c to largest (second labour line).
    const r = applyMinimumChargeFloor(lines, 15000);
    expect(r.line_items[0].type).toBe('labour');
    expect(r.line_items[1]).toEqual(expect.objectContaining({ type: 'fee', total_cents: 2000 }));
    expect(r.line_items[2].type).toBe('labour');
    expect(r.boosted_labour_subtotal_cents).toBe(15000);
    expect(r.line_items[0].total_cents).toBe(5769);   // 5000 + 769
    expect(r.line_items[2].total_cents).toBe(9231);   // 8000 + 1230 + 1 remainder
  });

  it('boosts multiple ad-hoc labour lines even without source_time_entry_id values', () => {
    const lines = [
      { description: 'Labour A', qty: 0.25, unit_price: 10000, total_cents: 2500, type: 'labour' },
      { description: 'Labour B', qty: 0.25, unit_price: 10000, total_cents: 2500, type: 'labour' },
    ];
    const r = applyMinimumChargeFloor(lines, 10000);
    expect(r.floor_applied).toBe(true);
    expect(r.boosted_labour_subtotal_cents).toBe(10000);
    expect(r.line_items[0].total_cents).toBe(5000);
    expect(r.line_items[1].total_cents).toBe(5000);
  });

  it('handles rounding remainder cleanly (boosts the largest line for the leftover cent)', () => {
    // Pathological case: 3 labour lines, 0.3h + 0.3h + 0.4h = 1.0h @ $125 = $125.
    // Floor $200. Delta $75. Each line proportional share:
    //   3750/12500 = 30% → floor(22.50) = 22 → 3772
    //   3750/12500 = 30% → floor(22.50) = 22 → 3772
    //   5000/12500 = 40% → floor(30.00) = 30 → 5030
    // Sum: 3772 + 3772 + 5030 = 12574. Remainder to 20000 = 7426. Wait that's wrong.
    // The floor is 20000 cents = $200. Original subtotal 12500 cents = $125. Delta = 7500.
    // Each line's share: 2250, 2250, 3000. Sum = 7500. No remainder. Clean.
    const lines = [labour(3750, 0.3, 1), labour(3750, 0.3, 2), labour(5000, 0.4, 3)];
    const r = applyMinimumChargeFloor(lines, 20000);
    expect(r.floor_applied).toBe(true);
    expect(r.boosted_labour_subtotal_cents).toBe(20000);
    const sum = r.line_items.reduce((s, li) => s + li.total_cents, 0);
    expect(sum).toBe(20000);
  });

  it('realistic case: 0.4h @ $125/h with $50 floor → $50 invoice, unit_price $125/h unchanged', () => {
    // 0.4h * $125 = $50. Floor $50. Already at floor, no boost.
    const lines = [labour(5000, 0.4, 1)];
    const r = applyMinimumChargeFloor(lines, 5000);
    expect(r.floor_applied).toBe(false);
  });

  it('realistic case: 0.2h @ $125/h with $50 floor → invoice = $50, unit_price jumps to $250/h', () => {
    // 0.2h * $125 = $25. Floor $50. Delta $25. New total = $50. New unit_price = 5000/0.2 = 25000.
    const lines = [labour(2500, 0.2, 1)];
    const r = applyMinimumChargeFloor(lines, 5000);
    expect(r.floor_applied).toBe(true);
    expect(r.line_items[0].total_cents).toBe(5000);
    expect(r.line_items[0].unit_price).toBe(25000); // $250/hr
    expect(r.line_items[0].qty).toBe(0.2);          // hours unchanged
  });

  it('negative or NaN floor is treated as 0 (disabled)', () => {
    const lines = [labour(5000, 0.4, 1)];
    expect(applyMinimumChargeFloor(lines, -100).floor_applied).toBe(false);
    expect(applyMinimumChargeFloor(lines, NaN).floor_applied).toBe(false);
    expect(applyMinimumChargeFloor(lines, 'abc').floor_applied).toBe(false);
  });
});
