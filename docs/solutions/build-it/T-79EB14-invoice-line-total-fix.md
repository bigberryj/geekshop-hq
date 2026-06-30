# T-79EB14 — invoice line price missing from total when adding an hour service

**Date:** 2026-06-30
**Reported by:** Byron, via HQ Mission Control
**Status:** fixed

## Bug

> when i add a product/service to an invoice as a line item, its not showing the price in the total if i like add an hour service. not being added or totalled

In the Accounting → Invoices editor, when Byron added an "Hourly Service"
line from the Products & Services catalog (or typed a service line manually)
the live preview Total only showed the line price — the tax (BC: 5% GST +
7% PST) was missing, so a $100 service showed as **$100 total instead of
$112 total**.

## Root cause

`client/src/pages/Accounting.jsx::InvoiceEditor` used to compute the
preview Subtotal / Tax / Total **client-side** from `form.line_items`.
That local computation only summed `quantity * unit_price_cents` and never
asked the configured global tax model which taxes (if any) to apply to a
line that has no own `tax_rate_id`. So any catalog product that ships with
no default tax rate (or any manually-typed "hour service" line) previewed
with no tax at all, even though the saved invoice would carry the right
tax on the server.

The drift was invisible in the rendered invoice (server math was already
correct) but it made the Total in the editor lie about the future invoice.

## Fix

Added a pure-compute server endpoint that re-uses the exact totals path
the create/update handlers do, then made the editor's preview panel hit
that endpoint on every change.

**Server (`server/lib/tax.js`, `server/routes/invoices.js`)**

- New `normalizeLineItem(li)` / `normalizeLineItems(...)` — accepts both the
  legacy `qty / unit_price` shape (Money / draft-from-time) and the modern
  `quantity / unit_price_cents / taxable / tax_rate_id` shape (Accounting
  editor), canonicalises them, and writes BOTH key sets back onto each line
  so downstream renderers + SQL reports continue to read correctly.
- `computeInvoiceTotals(...)` — when called with `taxRates`, picks per-line
  tax for lines that carry their own `tax_rate_id`; falls back to the
  configured global model (default `gst_pst_bc`) for lines that don't,
  applied to the *taxable base* only (not the full subtotal — see regression
  test for the warranty / non-taxable guarantee).
- New endpoint `POST /api/invoices/preview` — pure compute, no DB writes,
  returns the same `{ subtotal_cents, tax_lines, tax_cents, total_cents,
  tax_model_key, tax_model_label }` shape as the create handler.
- `POST /api/invoices` and `PUT /api/invoices/:id` now normalise lines
  before persisting and store the derived `tax_lines` JSON alongside so
  print/PDF never has to re-derive.

**Client (`client/src/pages/Accounting.jsx::InvoiceEditor`)**

- Replaced the local client-side totals with a debounced (200 ms)
  `postJson('/invoices/preview', ...)` on every line-item change.
- Preview panel now displays the server's `tax_model_label` next to the
  Tax line so Byron can see exactly which model was applied
  ("Tax (BC: GST 5% + PST 7%)").

## Regression test

`server/test/invoice-preview-total.test.js` — pinned against `vitest`.
6 tests, including:

1. **hour service with no own tax_rate_id** → 100 + 5 + 7 = **112** ✓
2. preview totals match the totals persisted by `POST /api/invoices` byte-for-byte (no client/server drift)
3. non-taxable line ("warranty hour") contributes nothing to tax base
4. per-line `tax_rate_id` overrides the global model when set
5. empty `line_items` returns zero totals, no crash
6. non-array `line_items` returns HTTP 400

```
$ cd server && npx vitest run test/invoice-preview-total.test.js
 ✓ test/invoice-preview-total.test.js (6 tests) 223ms
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

## Verified live in the browser

With HQ running locally:

1. Open `/accounting` → Invoices → `+ New invoice`
2. Pick customer "Brian Chen"
3. Click `+ Add line`, set Description = `Hourly Service Test`,
   Qty = 1, Unit price = 100.00, Tax? checked, Tax rate = `— none —`
4. Live preview panel renders:
   - Subtotal **$100.00**
   - Tax (BC: GST 5% + PST 7%) **$12.00**
   - **Total $112.00** ✓

Screenshot in `docs/solutions/build-it/evidence/T-79EB14-modal-totals.png`.

## Files touched

```
server/lib/tax.js                            | 299 ++++++++++++++++++++--
server/routes/invoices.js                    | 233 +++++++++++++++++---
server/test/invoice-preview-total.test.js    | 163 ++++++++++++++++
3 files changed, 668 insertions(+), 27 deletions(-)
```
