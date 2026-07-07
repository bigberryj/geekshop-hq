import { useEffect, useState } from 'react';
import { formatMoney } from '../lib/api.js';

/**
 * Printable tax remittance view (Phase 5).
 *
 * Reads the payload produced by `GET /api/accounting/tax/pdf-ready`
 * (stashed by the parent tab via sessionStorage) and renders a
 * browser-friendly remittance sheet. Opens in a new tab so the
 * user can `Ctrl+P` / `Cmd+P` to print or save as PDF.
 *
 * If the payload is missing (user opened this URL directly), the
 * component shows a one-liner pointing them back to the Accounting
 * tab. We don't try to fetch from this URL directly — the parent
 * already has the from/to window in its URL bar; replaying it from
 * the new tab would re-query the DB.
 */
export default function TaxSummaryPrintable() {
  const [payload, setPayload] = useState(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('taxSummary.printable');
      if (raw) setPayload(JSON.parse(raw));
    } catch (_) { /* fall through to the "go back" empty state */ }
  }, []);

  // Auto-trigger the print dialog when the data arrives. This is the
  // user-friendly behaviour but not strictly required — they can
  // always click "Print" in the toolbar.
  useEffect(() => {
    if (payload) {
      // Defer past the first paint so styles settle.
      const id = setTimeout(() => { try { window.print(); } catch (_) {} }, 250);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [payload]);

  if (!payload) {
    return (
      <div style={{ fontFamily: 'system-ui', padding: 32 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600 }}>Tax remittance print view</h1>
        <p>
          This page reads a tax-summary payload from sessionStorage. If you arrived
          here directly, go back to <strong>Accounting → Tax Summary</strong>,
          pick a date window, then click <em>Printable view</em>.
        </p>
        <p>
          <a href="/accounting">/accounting</a>
        </p>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'system-ui', padding: 32, maxWidth: 820, margin: '0 auto', color: '#111' }}>
      <style>{`
        @media print {
          body { background: #fff !important; }
          .no-print { display: none !important; }
          table { page-break-inside: avoid; }
        }
        .tsh h1 { font-size: 22px; margin: 0 0 4px; }
        .tsh .meta { color: #555; font-size: 12px; margin-bottom: 16px; }
        .tsh table { width: 100%; border-collapse: collapse; margin: 8px 0 18px; font-size: 13px; }
        .tsh th, .tsh td { padding: 6px 8px; border-bottom: 1px solid #ddd; text-align: left; }
        .tsh th { background: #f3f4f6; font-weight: 600; }
        .tsh td.num, .tsh th.num { text-align: right; font-variant-numeric: tabular-nums; }
        .tsh .net { font-size: 18px; font-weight: 700; padding: 10px 12px; border: 2px solid #111; margin-top: 8px; }
        .tsh .net.neg { color: #b91c1c; }
        .tsh .net.pos { color: #15803d; }
      `}</style>
      <div className="tsh">
        <div className="no-print" style={{ marginBottom: 12 }}>
          <button onClick={() => window.print()} style={{ padding: '6px 12px' }}>Print this page</button>
          <a href="/accounting" style={{ marginLeft: 12 }}>← Back to Accounting</a>
        </div>
        <h1>{payload.title || 'Tax Remittance Summary'}</h1>
        <div className="meta">
          Window: <strong>{payload.from}</strong> to <strong>{payload.to}</strong>
          {' · '}Generated: {new Date(payload.generated_at).toLocaleString()}
          {' · '}Currency: {payload.subtotal_label || 'CAD'}
        </div>

        <h2 style={{ fontSize: 15, marginTop: 18 }}>Tax collected on invoices</h2>
        <div style={{ color: '#444', fontSize: 12, marginBottom: 6 }}>
          {payload.collected.invoice_count} invoice(s) contributing.
          Subtotal + tax must equal the invoice grand-total reported on each invoice PDF.
        </div>
        <table>
          <thead>
            <tr>
              <th>Tax label</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {(payload.collected.breakdown || []).map((b, i) => (
              <tr key={`c-${i}`}>
                <td>{b.label}</td>
                <td className="num">{formatMoney(b.amount_cents)}</td>
              </tr>
            ))}
            <tr>
              <td style={{ fontWeight: 700 }}>Total collected</td>
              <td className="num" style={{ fontWeight: 700 }}>{formatMoney(payload.collected.total_cents)}</td>
            </tr>
          </tbody>
        </table>

        <h2 style={{ fontSize: 15, marginTop: 18 }}>Tax paid on expenses</h2>
        <div style={{ color: '#444', fontSize: 12, marginBottom: 6 }}>
          {payload.paid.expense_count} expense(s) contributing. Personal expenses
          (business_use = 0) are excluded.
        </div>
        <table>
          <thead>
            <tr>
              <th>Tax label</th>
              <th className="num">Expenses</th>
              <th className="num">Tax paid</th>
            </tr>
          </thead>
          <tbody>
            {(payload.paid.breakdown || []).map((b, i) => (
              <tr key={`p-${i}`}>
                <td>{b.label}</td>
                <td className="num">{b.expenses.length}</td>
                <td className="num">{formatMoney(b.amount_cents)}</td>
              </tr>
            ))}
            <tr>
              <td style={{ fontWeight: 700 }}>Total paid</td>
              <td className="num"></td>
              <td className="num" style={{ fontWeight: 700 }}>{formatMoney(payload.paid.total_cents)}</td>
            </tr>
          </tbody>
        </table>

        <div className={`net ${payload.net_remittance_cents > 0 ? 'pos' : payload.net_remittance_cents < 0 ? 'neg' : ''}`}>
          Net remittance (Collected − Paid):&nbsp;
          {formatMoney(payload.net_remittance_cents)}
          <div style={{ fontSize: 12, fontWeight: 400, marginTop: 4 }}>
            {payload.net_remittance_cents > 0 && 'Positive: this is what you owe the CRA for the period.'}
            {payload.net_remittance_cents < 0 && 'Negative: input tax credit (ITC) — you can claim a refund / carry the credit forward.'}
            {payload.net_remittance_cents === 0 && 'Even period — no remittance required.'}
          </div>
        </div>

        <h2 style={{ fontSize: 15, marginTop: 28 }}>Contributing invoices</h2>
        <table>
          <thead>
            <tr>
              <th>Invoice #</th>
              <th>Customer</th>
              <th>Created</th>
              <th className="num">Tax</th>
            </tr>
          </thead>
          <tbody>
            {(payload.collected.invoices || []).map((inv, i) => (
              <tr key={i}>
                <td style={{ fontFamily: 'monospace' }}>{inv.invoice_uid}</td>
                <td>{inv.customer_name}</td>
                <td style={{ fontSize: 11 }}>{(inv.created_at || '').slice(0, 10)}</td>
                <td className="num">{formatMoney(inv.tax_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
