#!/usr/bin/env node
/**
 * One-off: send Byron a "how to access and use the accounting module" email.
 * Task: T-9205D5 (requeue, decision_note = "can you email me instructions on
 * how to access this an use it please").
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import nodemailer from 'nodemailer';

// Load server/.env the same way server/index.js does it, so SMTP creds
// are present even when this script is run from a cron / systemd unit
// that doesn't inherit them.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..', '..');
try {
  const envPath = resolve(rootDir, 'server/.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch { /* ignore */ }

const TO = process.env.BYRON_GMAIL_USER || 'byron@geekshop.ca';

const subject = '[J5] Accounting module — how to access & use it (T-9205D5)';

const body = `Hi Byron,

QuickBooks is dead. Long live QuickBooks.

The accounting module you asked for (task T-9205D5) is built, migrated, tested,
and running on the bigbai machine. Here's how to get at it and what to do
once you're in.

================================================================
1. ACCESS
================================================================

The whole thing lives inside GeekShop HQ, which is already running on
bigbai. The accounting backend is mounted at /api/accounting/* — you can
hit it from anywhere HQ is reachable.

  From the bigbai box itself:
    http://localhost:5050/api/accounting/status
    http://localhost:5173                      <- main HQ UI

  From your phone / laptop over Tailscale:
    http://100.96.13.84:5050/api/accounting/status
    http://100.96.13.84:5173

Sanity check — paste this in a terminal on bigbai:

    curl -s http://localhost:5050/api/accounting/status | head -c 400
    echo

If the JSON shows "module":"accounting-mvp" and a bunch of "true" feature
flags, you're in. If the port is closed, start HQ:

    cd /home/byron/projects/geekshop-hq
    bash start.sh

NOTE: There is no dedicated /accounting page in the HQ UI yet (frontend
route is the open follow-up). For now you drive the module through:

  - the API directly (curl / any HTTP client), OR
  - a quick custom page in /mission-control style that I can build in
    a follow-up tick if you want a clickable UI.

Until that UI lands, the endpoints below are the surface.

================================================================
2. WHAT'S ALREADY TURNED ON
================================================================

Hit /api/accounting/status — here's what it should show on bigbai today:

  ✓ tax_rates               (GST / PST / HST / QST / custom)
  ✓ products                (goods & services catalog, SKU, default tax)
  ✓ expenses                (vendor, date, category, amount, tax, receipt)
  ✓ expense_categories      (Marketing, Office, Travel, etc.)
  ✓ payments_manual         (cash, cheque, e-transfer, card, other)
  ✓ reports                 (P&L, sales-by-customer, expenses-by-category,
                             tax-collected, outstanding invoices)
  ✓ pdf_invoice             (GET /api/invoices/:id/pdf — uses pdfkit,
                             no chromium needed)
  ✓ qbo_import_csv          (QBO-style CSV with auto-mapped headers)
  ✓ receipt_upload          (multipart upload/download/delete per expense)
  ✓ local_backup            (POST /api/accounting/backup + /restore)
  ✓ custom_invoice_numbering  (reads settings.invoice_prefix)
  ✗ stripe_checkout         (off — see §5)
  ✗ stripe_webhook          (off — see §5)

So everything except real Stripe payments is wired and tested.

================================================================
3. SEED DATA + A 5-MINUTE WALKTHROUGH
================================================================

The DB starts empty (the previous tick left tables clean). Here's the
shortest path to "I can see numbers":

  a) Add a tax rate:
     curl -X POST http://localhost:5050/api/accounting/tax-rates \\
       -H 'Content-Type: application/json' \\
          -d '{"name":"GST","rate_bps":500}'

     rate_bps is basis points — 500 = 5%, 700 = 7%, 1300 = 13%. This is
     the Canadian tax shape you asked for (GST/PST/HST/custom).

  b) Add a product:
     curl -X POST http://localhost:5050/api/accounting/products \\
       -H 'Content-Type: application/json' \\
          -d '{"name":"Remote support — 1hr",
               "sku":"SVC-REMOTE-1HR",
               "unit_price_cents":12000,
               "taxable":1,
               "default_tax_rate_id":1}'

  c) Pick (or create) a customer:
     curl http://localhost:5050/api/customers | head -c 400
     echo
     # If empty, the existing /customers flow in HQ is the easy way;
     # the API is POST /api/customers with {name, company, email, ...}.

  d) Create an invoice from the existing /api/invoices endpoint (it
     already has the create + send + paid + status transitions the
     brief asked for). The accounting module reads/writes the same
     invoices table; once paid, the dashboard rollup picks it up.

  e) Mark it paid manually:
     curl -X POST http://localhost:5050/api/accounting/payments \\
       -H 'Content-Type: application/json' \\
          -d '{"invoice_id":1,"amount_cents":12000,
               "method":"e_transfer","notes":"Sent 2026-06-23"}'

  f) Look at the dashboard:
     curl -s http://localhost:5050/api/accounting/dashboard | head -c 400
     echo

================================================================
4. REPORTS
================================================================

Five reports, all live, all parameterised by date range:

  GET /api/accounting/dashboard
      One-shot rollup: unpaid + overdue counts/totals, income this
      month, expenses this month, net, recent payments, recent
      expenses. Use this as your "open the app" screen.

  GET /api/accounting/reports/pnl?from=2026-01-01&to=2026-12-31
      Profit & loss: income, expenses, net.

  GET /api/accounting/reports/sales-by-customer
      Per-customer revenue for the date range.

  GET /api/accounting/reports/expenses-by-category
      Per-category spend for the date range.

  GET /api/accounting/reports/tax-collected
      Tax remittance summary by tax rate (GST/PST/HST/custom).

  GET /api/accounting/reports/outstanding
      Open invoices grouped by aging bucket.

================================================================
5. STRIPE (when you're ready to turn it on)
================================================================

Stripe is the only feature still gated. To enable:

  1) In server/.env, add:
        STRIPE_SECRET_KEY=sk_test_...      (or sk_live_... for prod)
        STRIPE_WEBHOOK_SECRET=whsec_...
     Restart the server. /api/accounting/status will flip
     stripe_checkout and stripe_webhook to true.

  2) Run a Stripe CLI listener for the webhook locally:
        stripe listen --forward-to \\
          http://localhost:5050/api/accounting/stripe/webhook

  3) On a paid invoice, call:
        POST /api/accounting/invoices/:id/checkout
     It returns a {url, session_id} — hand the URL to the customer.
     When the payment lands, Stripe hits the webhook, the
     payment_events table records the stripe_event_id (UNIQUE, so
     replays are idempotent), and the invoice is auto-marked paid.

The DB is already idempotent on stripe_event_id, so re-running a
webhook is safe.

================================================================
6. IMPORTING FROM EXISTING QUICKBOOKS
================================================================

You asked for QBO import. The brief itself suggested "start with CSV
if direct QBO API integration is too much" — we did the CSV version,
which is what 90% of QBO->migration projects end up using anyway.

  POST /api/accounting/import/csv/preview
      multipart/form-data, field "file". Returns the auto-detected
      column mapping plus the parsed rows. Look it over, no DB writes.

  POST /api/accounting/import/csv/commit
      multipart/form-data, field "file" + optional "mapping" JSON.
      Writes customers + items using the same parser.

Supported shapes: standard QBO "Customer list" and "Item list"
exports, plus a generic CSV. The library auto-maps common header
synonyms (Email/e-mail/eMail, Phone/Tel/Mobile, etc.).

Direct QBO API import is the next deferred item — would need OAuth
and a /qbo/connect screen. Ping me on Telegram if you want that
prioritised.

================================================================
7. BACKUP / RESTORE
================================================================

Single source of truth is data/hq.db (SQLite, WAL mode). Two
flavours of backup:

  a) The cheap one (already works without any new code):
        cp /home/byron/projects/geekshop-hq/data/hq.db \\
           /home/byron/projects/geekshop-hq/data/hq.db.manual-2026-06-23
     Stop the server first (or use sqlite3 .backup), then restart.

  b) The one the module provides:
        POST /api/accounting/backup
            -> creates data/backups/hq-<ISO-timestamp>.db
        GET  /api/accounting/backups
            -> lists existing backups with sizes
        POST /api/accounting/restore
            -> body: {"filename": "hq-...db"} — restores that snapshot.
               Server restarts itself after restore.

================================================================
8. WHERE EVERYTHING LIVES
================================================================

  Migration that added the module:    server/db/migrations/031_accounting.sql
  Customer fields + invoice statuses: server/db/migrations/032_customer_extend_and_invoice_status.sql
  All API routes:                     server/routes/accounting.js  (30 endpoints)
  PDF renderer:                       server/lib/invoice-pdf.js
  Stripe wrapper:                     server/lib/stripe.js
  QBO CSV parser:                     server/lib/qbo-csv.js
  Receipt uploads:                    server/lib/attachments.js (data/attachments/expenses/)
  Full build record + test counts:    docs/solutions/build-it/built-accounting-mvp.md
  Tests:                              server/test/accounting.test.js (25 cases, all green)

================================================================
9. QUICK REQUESTS YOU MIGHT HAVE NEXT
================================================================

  - "Build me a real /accounting UI page in HQ" (clickable dashboard
    + invoice + expense + report screens). Roughly 1-2 days of work.
    I can queue it as a follow-up task.
  - "Set up Stripe live keys and turn on Checkout" — needs the keys,
    then I can flip the feature flags in 10 minutes.
  - "Add a /book integration" — auto-create an invoice when an
    appointment is marked complete. Should be a half-day add.

Tell me which (if any) you want and I'll queue them.

— J5
`;

const t = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

try {
  const info = await t.sendMail({
    from: process.env.SMTP_FROM || `GeekShop HQ <${process.env.SMTP_USER}>`,
    to: TO,
    subject,
    text: body,
  });
  console.log(JSON.stringify({ sent: true, message_id: info.messageId, to: TO }, null, 2));
} catch (err) {
  console.error(JSON.stringify({ sent: false, error: err.message }, null, 2));
  process.exit(1);
}
