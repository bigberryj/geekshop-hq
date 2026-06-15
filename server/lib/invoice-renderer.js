/**
 * Invoice text + printable HTML rendering.
 * Escapes all customer-provided fields before HTML output.
 */

function money(cents = 0) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function lineTotalCents(li) {
  return Math.round((Number(li.qty) || 1) * (Number(li.unit_price) || 0));
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizedItems(inv) {
  return Array.isArray(inv.line_items) ? inv.line_items : JSON.parse(inv.line_items || '[]');
}

function taxLinesForRender(inv) {
  // Prefer the explicit tax_lines array (per-line breakdown). Fall back
  // to a single combined "Tax" line for old invoices that predate the
  // multi-line support.
  if (Array.isArray(inv.tax_lines) && inv.tax_lines.length) {
    return inv.tax_lines.map((ln) => ({
      label: ln.label,
      rate: ln.rate,
      amount_cents: ln.amount_cents,
    }));
  }
  if (inv.tax_cents && Number(inv.tax_cents) > 0) {
    return [{ label: 'Tax', rate: null, amount_cents: Number(inv.tax_cents) }];
  }
  return [];
}

export function renderInvoiceText(inv) {
  const items = normalizedItems(inv);
  const lines = items.map((li) => {
    const qty = li.qty || 1;
    return `  ${li.description} — qty ${qty} × ${money(li.unit_price)} = ${money(lineTotalCents(li))}`;
  }).join('\n');
  const taxes = taxLinesForRender(inv);
  const taxText = taxes.length
    ? taxes.map((t) => t.rate != null
        ? `  ${t.label} (${(t.rate * 100).toFixed(t.rate * 100 % 1 === 0 ? 0 : 2)}%): ${money(t.amount_cents)}`
        : `  ${t.label}: ${money(t.amount_cents)}`).join('\n')
    : '';
  return `Invoice ${inv.invoice_uid} from GeekShop Computers\n\nCustomer: ${inv.customer_name || ''}\n${inv.customer_email ? `Email: ${inv.customer_email}\n` : ''}\n${lines}\n\nSubtotal: ${money(inv.subtotal_cents)}\n${taxText ? taxText + '\n' : ''}Total: ${money(inv.total_cents)}\n${inv.due_at ? `Due: ${inv.due_at}\n` : ''}\nThanks,\nGeekShop Computers\n`;
}

export function renderInvoiceHtml(inv) {
  const items = normalizedItems(inv);
  const rows = items.map((li) => {
    const qty = li.qty || 1;
    return `<tr><td>${esc(li.description)}</td><td class="num">${qty}</td><td class="num">${money(li.unit_price)}</td><td class="num">${money(lineTotalCents(li))}</td></tr>`;
  }).join('');
  const taxes = taxLinesForRender(inv);
  const taxRows = taxes.map((t) => `<div><span>${esc(t.label)}${t.rate != null ? ` <span class="muted">(${(t.rate * 100).toFixed(t.rate * 100 % 1 === 0 ? 0 : 2)}%)</span>` : ''}</span><span>${money(t.amount_cents)}</span></div>`).join('');
  const business = { name: inv.business_name || 'GeekShop Computers', email: inv.business_email || 'byron@geekshop.ca' };
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${esc(inv.invoice_uid)} — ${esc(business.name)}</title>
  <style>
    body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #0f172a; margin: 40px; }
    .top { display:flex; justify-content:space-between; gap:24px; border-bottom: 2px solid #e2e8f0; padding-bottom: 20px; margin-bottom: 24px; }
    h1 { margin:0; font-size: 30px; }
    .muted { color:#64748b; font-size: 13px; }
    table { width:100%; border-collapse: collapse; margin: 24px 0; }
    th, td { border-bottom:1px solid #e2e8f0; padding:10px 8px; text-align:left; }
    th { background:#f8fafc; color:#475569; font-size:12px; text-transform:uppercase; }
    .num { text-align:right; font-variant-numeric: tabular-nums; }
    .totals { max-width: 360px; margin-left:auto; }
    .totals div { display:flex; justify-content:space-between; padding:6px 0; }
    .total { font-size: 20px; font-weight: 700; border-top: 2px solid #e2e8f0; margin-top: 6px; padding-top:10px !important; }
    .print { position: fixed; top: 18px; right: 18px; }
    @media print { .print { display:none; } body { margin: 0.5in; } }
  </style>
</head>
<body>
  <button class="print" onclick="window.print()">Print / Save PDF</button>
  <section class="top">
    <div><h1>Invoice</h1><div class="muted">${esc(inv.invoice_uid)}</div></div>
    <div><strong>${esc(business.name)}</strong><br/><span class="muted">${esc(business.email)}</span></div>
  </section>
  <section>
    <div class="muted">Bill to</div>
    <strong>${esc(inv.customer_name || '')}</strong><br/>
    <span class="muted">${esc(inv.customer_email || '')}</span>
  </section>
  <table>
    <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <section class="totals">
    <div><span>Subtotal</span><span>${money(inv.subtotal_cents)}</span></div>
    ${taxRows}
    <div class="total"><span>Total</span><span>${money(inv.total_cents)}</span></div>
    ${inv.due_at ? `<div><span>Due</span><span>${esc(inv.due_at)}</span></div>` : ''}
  </section>
</body>
</html>`;
}
