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
