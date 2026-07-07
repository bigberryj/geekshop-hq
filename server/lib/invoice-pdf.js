/**
 * Invoice PDF generation.
 *
 * Uses pdfkit (lightweight, pure JS, no native deps) so this works on the
 * bigbai machine without needing chromium or wkhtmltopdf installed.
 *
 * The PDF mirrors the HTML renderer's layout closely enough that the two
 * are interchangeable for printing or emailing.
 */

import PDFDocument from 'pdfkit';

function money(cents = 0) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function lineTotalCents(li) {
  // Prefer the pre-computed integer total when present (Accounting
  // editor + normalised legacy lines both set this). Fall back to
  // qty * unit_price across both legacy and modern key names.
  if (Number.isFinite(Number(li?.total_cents))) return Math.round(Number(li.total_cents));
  const q = Number(li?.qty ?? li?.quantity ?? 1);
  const p = Number(li?.unit_price ?? li?.unit_price_cents ?? 0);
  return Math.round(q * p);
}

function normalizedItems(inv) {
  return Array.isArray(inv.line_items) ? inv.line_items : JSON.parse(inv.line_items || '[]');
}

function taxLinesForRender(inv) {
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

/**
 * Render an invoice to a PDF Buffer.
 *
 * @param {object} inv  - invoice row (must include customer_name, line_items, totals, etc.)
 * @returns {Promise<Buffer>}
 */
export function renderInvoicePdf(inv) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const business = {
      name: inv.business_name || 'GeekShop Computers',
      email: inv.business_email || 'byron@geekshop.ca',
    };

    // --- Header: business on right, invoice meta on left ---
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(20).text('Invoice', { align: 'left' });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10).fillColor('#64748b').text(inv.invoice_uid);
    doc.moveDown(0.4);

    // business block, right-aligned by drawing on a fixed-width section
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a')
      .text(business.name, { align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor('#64748b')
      .text(business.email, { align: 'right' });
    doc.moveDown(1);

    // horizontal rule
    doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#e2e8f0').stroke();
    doc.moveDown(0.7);

    // --- Bill-to ---
    doc.font('Helvetica').fontSize(9).fillColor('#64748b').text('Bill to');
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a')
      .text(inv.customer_name || '');
    if (inv.customer_email) {
      doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(inv.customer_email);
    }
    doc.moveDown(0.7);

    // --- Line items table ---
    const items = normalizedItems(inv);
    const startX = 50;
    const cols = { desc: startX, qty: 360, unit: 410, amount: 490 };
    const rowH = 18;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#475569');
    doc.text('Description', cols.desc, doc.y);
    doc.text('Qty', cols.qty, doc.y, { width: 40, align: 'right' });
    doc.text('Unit', cols.unit, doc.y, { width: 70, align: 'right' });
    doc.text('Amount', cols.amount, doc.y, { width: 72, align: 'right' });
    doc.moveDown(0.7);
    // header rule
    const headerY = doc.y;
    doc.moveTo(startX, headerY).lineTo(562, headerY).strokeColor('#e2e8f0').stroke();
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10).fillColor('#0f172a');

    for (const li of items) {
      const y = doc.y;
      const qty = li.qty || 1;
      const desc = String(li.description || '').slice(0, 60);
      doc.text(desc, cols.desc, y, { width: 300 });
      doc.text(String(qty), cols.qty, y, { width: 40, align: 'right' });
      doc.text(money(li.unit_price), cols.unit, y, { width: 70, align: 'right' });
      doc.text(money(lineTotalCents(li)), cols.amount, y, { width: 72, align: 'right' });
      doc.moveDown(0.7);
      doc.moveTo(startX, doc.y).lineTo(562, doc.y).strokeColor('#f1f5f9').stroke();
    }

    doc.moveDown(0.7);

    // --- Totals ---
    const totals = doc.y;
    doc.font('Helvetica').fontSize(10).fillColor('#0f172a');
    doc.text('Subtotal', 380, totals, { width: 110, align: 'left' });
    doc.text(money(inv.subtotal_cents), 490, totals, { width: 72, align: 'right' });
    let cursor = totals + rowH;
    for (const ln of taxLinesForRender(inv)) {
      const label = ln.rate != null
        ? `${ln.label} (${(ln.rate * 100).toFixed(ln.rate * 100 % 1 === 0 ? 0 : 2)}%)`
        : ln.label;
      doc.text(label, 380, cursor, { width: 110 });
      doc.text(money(ln.amount_cents), 490, cursor, { width: 72, align: 'right' });
      cursor += rowH;
    }
    // total divider
    doc.moveTo(380, cursor + 2).lineTo(562, cursor + 2).strokeColor('#0f172a').lineWidth(1.2).stroke();
    doc.lineWidth(0.5);
    cursor += 8;
    doc.font('Helvetica-Bold').fontSize(12);
    doc.text('Total', 380, cursor, { width: 110 });
    doc.text(money(inv.total_cents), 490, cursor, { width: 72, align: 'right' });
    cursor += rowH + 4;

    if (inv.due_at) {
      doc.font('Helvetica').fontSize(10).fillColor('#475569');
      doc.text(`Due: ${inv.due_at}`, 380, cursor, { width: 200 });
    }

    doc.end();
  });
}
