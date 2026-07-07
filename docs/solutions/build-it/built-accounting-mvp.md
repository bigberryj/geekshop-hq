# Accounting MVP — what shipped, what didn't, and why

> Built from HQ task T-9205D5, 2026-06-18. Solo-owner QuickBooks / Xero
> alternative, designed to run on the bigbai machine first.

## The honest version

The full task brief is a QuickBooks Online / Xero competitor: invoicing,
billing, payments, expenses, customers, products, taxes, dashboard,
reports, Stripe, webhooks, PDF, QuickBooks import. A production version of
all of that is a multi-month engineering project — and **this 12-minute
worker tick is not that**.

What I shipped in the tick: a **working MVP scaffold** for every core
domain, with real endpoints, real validation, real audit log writes, and
25 vitest cases that pass against a freshly migrated database.

What's deliberately deferred, with a clean seam for the next pass:

| Feature | Status | Why deferred | Seam left behind |
|---|---|---|---|
| Tax rates (GST/PST/HST/custom) | ✅ done | — | — |
| Product catalog (SKU, default tax, taxable) | ✅ done | — | — |
| Expense categories + expenses + filters | ✅ done | — | — |
| Manual payments (cash, cheque, e-transfer) | ✅ done | — | — |
| Stripe payment_intent recording | ✅ done (record only) | Can't accept payments without a Checkout/Link | `payments` row + `payment_events` log already accept the Stripe shape; `STRIPE_SECRET_KEY` check in status |
| Invoice auto-mark-paid when covered | ✅ done | — | — |
| Dashboard rollup | ✅ done | — | — |
| Reports (P&L, sales-by-customer, expenses-by-category, tax-collected, outstanding) | ✅ done | — | — |
| Audit log on every create/update | ✅ done | — | — |
| Invoice statuses (sent/viewed/cancelled in addition to draft/paid/overdue) | partial | Existing `invoices` table uses `draft|sent|overdue|paid` | The new payments module reads/writes those; adding `viewed|cancelled` is a single enum bump + index. Not blocking. |
| Custom invoice numbering | partial | The existing `nextInvoiceUid` makes `INV-2026-NNN` | Custom prefix would be a one-line `readSetting` override |
| PDF invoice generation | ❌ deferred | Requires PDF backend (puppeteer / chromium). The current `lib/invoice-renderer.js` emits text + HTML. | PDF would slot in as `lib/invoice-pdf.js` + a `/api/invoices/:id/pdf` route. ~half a day. |
| Stripe Checkout / Payment Links | ❌ deferred | Gated on `STRIPE_SECRET_KEY`. The status endpoint flips to `true` once the env var exists. | Add `lib/stripe.js` + `POST /api/accounting/payments/create-checkout` (returns `session.url`) + `POST /api/invoices/:id/checkout` |
| Stripe webhook receiver (signed) | ❌ deferred | Gated on `STRIPE_WEBHOOK_SECRET`. The DB is already idempotent. | `POST /api/accounting/stripe/webhook` — verify signature with `stripe.webhooks.constructEvent`, then `INSERT INTO payment_events` with the `stripe_event_id` UNIQUE key (no double-processing). The existing `POST /api/accounting/payments` would be the manual fallback. |
| QuickBooks Online import (OAuth + mapping) | ❌ deferred | QBO OAuth flow + mapping UI is its own module. | `lib/qbo-import.js` + `POST /api/accounting/import/qbo/preview` + `POST /api/accounting/import/qbo/commit` |
| QuickBooks CSV import (the v0.2 step the brief explicitly suggested) | ❌ deferred | Could be a 1-day follow-up; left for a separate tick | `POST /api/accounting/import/csv` with `multipart/form-data` + mapping preview |
| Receipt attachment upload | partial | Schema has `receipt_path`; upload endpoint not added | `POST /api/accounting/expenses/:id/receipt` (multipart) → write to `data/attachments/expenses/<id>.<ext>` |
| Local backup / restore | ❌ deferred | HQ already runs on SQLite; `cp data/hq.db backup.db` works. A scheduled cron + restore endpoint would be a 2-hour add. | `data/backups/` directory + daily `cron` snapshot |
| Email invoices to customers | partial | `server/lib/email.js` exists and is used by `/api/invoices` send flow | The send flow needs a UI button + a `Cc` template. Existing route already does the SMTP work. |
| Customer fields (business name, billing address, shipping address, tax number) | partial | Existing `customers` table has `name, company, email, phone, notes` | Migration `032_customers_extend.sql` would add `billing_address`, `shipping_address`, `tax_number`, `status` |

## What's in this drop

```
server/db/migrations/031_accounting.sql   # 6 new tables
server/routes/accounting.js               # 20 new routes
server/routes/index.js                    # +1 register line
server/test/accounting.test.js            # 25 vitest cases (all green)
server/test/basic.test.js                 # +6 tables in schema list
docs/api.md                               # +accounting section
docs/schema.md                            # +6 table descriptions
docs/changelog.md                         # +entry
```

Full test suite: **210/210 passing** (was 184; this tick added 26 cases: 25
new + 1 updated).

## Why not just install QuickBooks self-hosted or Wave or GnuCash?

The brief says "I do not want to keep paying Intuit." Wave is free but
owned by H&R Block and data-exports are limited. GnuCash is double-entry
and powerful but the UX is 2008-era. The whole point of the build is a
*lightweight* accounting dashboard that fits inside GeekShop HQ, with the
same audit log, the same auth, the same deploy story.

This module is that, scoped to the 80% of features Byron actually uses day
to day. The remaining 20% (PDF, Stripe, QBO import) is on the explicit
follow-up list above, with the seam already in place.

## Verification

- `node db/migrate.js` — clean apply
- `npm test` — 210/210 green
- `node ... buildServer({dbPath: ...})` boots cleanly, `/api/accounting/status` returns 200
