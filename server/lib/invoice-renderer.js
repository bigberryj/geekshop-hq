/**
 * Invoice text + printable HTML rendering.
 * Escapes all customer-provided fields before HTML output.
 */

function money(cents = 0) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
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

export function renderInvoiceText(inv) {
  const items = normalizedItems(inv);
  const lines = items.map((li) => {
    const qty = li.qty || 1;
    return `  ${li.description} — qty ${qty} × ${money(li.unit_price)} = ${money(qty * li.unit_price)}`;
  }).join('\n');
  return `Invoice ${inv.invoice_uid} from GeekShop Computers\n\nCustomer: ${inv.customer_name || ''}\n${inv.customer_email ? `Email: ${inv.customer_email}\n` : ''}\n${lines}\n\nSubtotal: ${money(inv.subtotal_cents)}\nTax: ${money(inv.tax_cents)}\nTotal: ${money(inv.total_cents)}\n${inv.due_at ? `Due: ${inv.due_at}\n` : ''}\nThanks,\nGeekShop Computers\n`;
}

export function renderInvoiceHtml(inv) {
  const items = normalizedItems(inv);
  const rows = items.map((li) => {
    const qty = li.qty || 1;
    return `<tr><td>${esc(li.description)}</td><td class="num">${qty}</td><td class="num">${money(li.unit_price)}</td><td class="num">${money(qty * li.unit_price)}</td></tr>`;
  }).join('');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${esc(inv.invoice_uid)} — GeekShop Computers</title>
  <style>
    body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #0f172a; margin: 40px; }
    .top { display:flex; justify-content:space-between; gap:24px; border-bottom: 2px solid #e2e8f0; padding-bottom: 20px; margin-bottom: 24px; }
    h1 { margin:0; font-size: 30px; }
    .muted { color:#64748b; font-size: 13px; }
    table { width:100%; border-collapse: collapse; margin: 24px 0; }
    th, td { border-bottom:1px solid #e2e8f0; padding:10px 8px; text-align:left; }
    th { background:#f8fafc; color:#475569; font-size:12px; text-transform:uppercase; }
    .num { text-align:right; font-variant-numeric: tabular-nums; }
    .totals { max-width: 320px; margin-left:auto; }
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
    <div><strong>GeekShop Computers</strong><br/><span class="muted">byron@geekshop.ca</span></div>
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
    <div><span>Tax</span><span>${money(inv.tax_cents)}</span></div>
    <div class="total"><span>Total</span><span>${money(inv.total_cents)}</span></div>
    ${inv.due_at ? `<div><span>Due</span><span>${esc(inv.due_at)}</span></div>` : ''}
  </section>
</body>
</html>`;
}
