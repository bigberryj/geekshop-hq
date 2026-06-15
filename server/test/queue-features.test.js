/**
 * Queue feature tests added after the v0.1.0 queue cleanup request.
 */

import { describe, it, expect } from 'vitest';
import { buildAvailableSlots } from '../lib/booking-slots.js';
import { renderInvoiceText, renderInvoiceHtml } from '../lib/invoice-renderer.js';
import { summarizeCronJobs } from '../lib/cron-status.js';

describe('booking slots', () => {
  it('offers 1.5h weekday slots and excludes conflicts', () => {
    const start = new Date('2026-06-15T00:00:00-07:00'); // Monday
    const slots = buildAvailableSlots({
      now: start,
      days: 1,
      workdayStartHour: 10,
      workdayEndHour: 18,
      slotMinutes: 90,
      appointments: [
        { starts_at: '2026-06-15T11:30:00-07:00', ends_at: '2026-06-15T13:00:00-07:00' },
      ],
    });

    expect(slots.map((s) => s.label)).toEqual([
      'Mon Jun 15, 10:00 AM',
      'Mon Jun 15, 1:00 PM',
      'Mon Jun 15, 2:30 PM',
      'Mon Jun 15, 4:00 PM',
    ]);
  });

  it('skips weekends', () => {
    const slots = buildAvailableSlots({ now: new Date('2026-06-20T00:00:00-07:00'), days: 2, appointments: [] });
    expect(slots.length).toBe(0);
  });
});

describe('invoice renderer', () => {
  const invoice = {
    invoice_uid: 'INV-2026-001',
    customer_name: 'Linda Marsh',
    customer_email: 'linda@example.com',
    line_items: [{ description: 'Network diagnostic', qty: 1, unit_price: 12500 }],
    subtotal_cents: 12500,
    tax_cents: 625,
    total_cents: 13125,
    due_at: '2026-06-30',
  };

  it('renders plain text invoice without HTML', () => {
    const text = renderInvoiceText(invoice);
    expect(text).toContain('Invoice INV-2026-001');
    expect(text).toContain('Linda Marsh');
    expect(text).toContain('Total: $131.25');
    expect(text).not.toContain('<html');
  });

  it('renders printable HTML with escaped user fields', () => {
    const html = renderInvoiceHtml({ ...invoice, customer_name: '<Linda>' });
    expect(html).toContain('&lt;Linda&gt;');
    expect(html).toContain('window.print');
    expect(html).toContain('INV-2026-001');
  });
});

describe('cron status summaries', () => {
  it('summarizes enabled jobs without exposing prompt bodies', () => {
    const summary = summarizeCronJobs({ jobs: [
      { name: 'Appointments', enabled: true, last_status: 'ok', next_run_at: '2026-06-15T16:00:00-07:00', prompt: 'secret prompt' },
      { name: 'Disabled', enabled: false, last_status: 'error', prompt: 'secret prompt' },
    ] });
    expect(summary.enabled_count).toBe(1);
    expect(summary.jobs[0]).toEqual({ name: 'Appointments', enabled: true, last_status: 'ok', next_run_at: '2026-06-15T16:00:00-07:00' });
    expect(JSON.stringify(summary)).not.toContain('secret prompt');
  });
});
