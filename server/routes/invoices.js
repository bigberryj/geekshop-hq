/**
 * Invoice CRUD + send + status transitions.
 */

import { sendEmail } from '../lib/email.js';

function nextInvoiceUid(db) {
  const year = new Date().getFullYear();
  const last = db.prepare("SELECT invoice_uid FROM invoices WHERE invoice_uid LIKE ? ORDER BY id DESC LIMIT 1").get(`INV-${year}-%`);
  const n = last ? Number(last.invoice_uid.split('-')[2]) + 1 : 1;
  return `INV-${year}-${String(n).padStart(3, '0')}`;
}

export async function invoiceRoutes(app) {
  // List
  app.get('/api/invoices', async (req) => {
    const { status, customer_id } = req.query;
    let sql = `
      SELECT i.*, c.name as customer_name
      FROM invoices i JOIN customers c ON i.customer_id = c.id
      WHERE 1=1
    `;
    const args = [];
    if (status) { sql += ' AND i.status = ?'; args.push(status); }
    if (customer_id) { sql += ' AND i.customer_id = ?'; args.push(customer_id); }
    sql += ' ORDER BY i.created_at DESC LIMIT 200';
    return app.db.prepare(sql).all(...args).map((inv) => ({ ...inv, line_items: JSON.parse(inv.line_items) }));
  });

  // Create
  app.post('/api/invoices', async (req, reply) => {
    const { customer_id, line_items, tax_cents, due_at, notes } = req.body || {};
    if (!customer_id || !Array.isArray(line_items) || !line_items.length) {
      return reply.code(400).send({ error: 'customer_id and line_items required' });
    }
    const subtotal = line_items.reduce((s, li) => s + (li.qty || 1) * (li.unit_price || 0), 0);
    const tax = tax_cents ?? Math.round(subtotal * 0.05);
    const total = subtotal + tax;
    const uid = nextInvoiceUid(app.db);
    const info = app.db.prepare(`
      INSERT INTO invoices (invoice_uid, customer_id, line_items, subtotal_cents, tax_cents, total_cents, due_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uid, customer_id, JSON.stringify(line_items), subtotal, tax, total, due_at || null, notes || null);
    return { id: info.lastInsertRowid, invoice_uid: uid, subtotal_cents: subtotal, tax_cents: tax, total_cents: total };
  });

  // Detail
  app.get('/api/invoices/:id', async (req, reply) => {
    const inv = app.db.prepare(`
      SELECT i.*, c.name as customer_name, c.email as customer_email
      FROM invoices i JOIN customers c ON i.customer_id = c.id
      WHERE i.id = ?
    `).get(req.params.id);
    if (!inv) return reply.code(404).send({ error: 'not found' });
    return { ...inv, line_items: JSON.parse(inv.line_items) };
  });

  // Send
  app.post('/api/invoices/:id/send', async (req, reply) => {
    const inv = app.db.prepare(`
      SELECT i.*, c.name as customer_name, c.email as customer_email
      FROM invoices i JOIN customers c ON i.customer_id = c.id
      WHERE i.id = ?
    `).get(req.params.id);
    if (!inv) return reply.code(404).send({ error: 'not found' });
    if (!inv.customer_email) return reply.code(400).send({ error: 'customer has no email' });
    const lineItems = JSON.parse(inv.line_items);
    const lines = lineItems.map((li) => `  ${li.description} — qty ${li.qty || 1} × $${(li.unit_price / 100).toFixed(2)} = $${((li.qty || 1) * li.unit_price / 100).toFixed(2)}`).join('\n');
    const body = `Hi ${inv.customer_name},\n\nInvoice ${inv.invoice_uid} from GeekShop Computers:\n\n${lines}\n\nSubtotal: $${(inv.subtotal_cents / 100).toFixed(2)}\nTax: $${(inv.tax_cents / 100).toFixed(2)}\nTotal: $${(inv.total_cents / 100).toFixed(2)}\n${inv.due_at ? `\nDue: ${inv.due_at}` : ''}\n\nThanks for your business.\n`;
    const result = await sendEmail({ to: inv.customer_email, subject: `Invoice ${inv.invoice_uid} from GeekShop Computers`, text: body });
    if (result.sent) {
      app.db.prepare("UPDATE invoices SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    }
    return result;
  });

  // Mark paid
  app.post('/api/invoices/:id/paid', async (req, reply) => {
    app.db.prepare("UPDATE invoices SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    return { ok: true };
  });
}
