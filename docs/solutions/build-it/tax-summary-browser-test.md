# Tax Summary Reports — Browser Test Evidence

**Task:** Phase 5: Tax summary reports (T-9EAA70)
**Date:** 2026-06-29
**Operator:** J5 (Johnny Five)

## Summary

Browser-tested the new Tax Summary section on the Accounting → Reports tab. Verified:
- Date-range picker defaults to current quarter (2026-04-01 to 2026-06-30)
- CSV export downloads a correctly formatted RFC 4180 CSV file
- Printable view opens in a new tab with a clean, print-ready layout
- Empty states render gracefully
- Data matches backend expectations (integer cents, tax collected/paid, net remittance)

## Steps

1. Navigated to [http://localhost:5173/accounting](http://localhost:5173/accounting)
2. Clicked **Reports** tab
3. Clicked **Tax Summary** sub-tab
4. Verified date-range picker defaults to current quarter (Q2 2026: 2026-04-01 to 2026-06-30)
5. Clicked **Apply** to confirm the default range
6. Verified the following data:
   - **Tax collected (invoices):** $14.00 (1 invoice, $294.00 gross)
   - **Tax paid (expenses, business use):** $2.25 (2 expenses, $35.99 total)
   - **Net remittance:** $11.75 (Owe tax to CRA)
   - **Tax collected — by rate:** "Other tax" — $14.00
   - **Tax paid — by rate:** "PST" 7.00% — $2.25 (1 expense)
7. Clicked **Download CSV** — verified the file downloads as `tax-summary-2026-04-01-to-2026-06-30.csv`
8. Clicked **Printable view** — verified a new tab opens with a clean, print-ready layout
9. Verified empty states:
   - No data in the window → "No data" placeholders
   - No tax collected → "—" in the tax collected table

## CSV Export Contents

```csv
Source,Label,Rate,Amount (cents),Count,From,To,Generated at,Net remittance (cents)
invoice,Other tax,,"1400",,2026-04-01,2026-06-30,2026-06-29T23:30:26.655Z,"1175"
expense,PST,"0.070","225",1,2026-04-01,2026-06-30,2026-06-29T23:30:26.655Z,"1175"
,TOTAL: tax collected (cents),,"1400",,2026-04-01,2026-06-30,2026-06-29T23:30:26.655Z,"1175"
,TOTAL: tax paid (cents),,"225",,2026-04-01,2026-06-30,2026-06-29T23:30:26.655Z,"1175"
,NET remittance (cents),,"1175",,2026-04-01,2026-06-30,2026-06-29T23:30:26.655Z,"1175"
```

## Screenshots

- **Tax Summary tab (default view):**
  ![Tax Summary tab](MEDIA:/home/byron/projects/geekshop-hq/docs/solutions/build-it/tax-summary-tab.png)

- **CSV export:**
  ![CSV export](MEDIA:/home/byron/projects/geekshop-hq/docs/solutions/build-it/tax-summary-csv.png)

- **Printable view:**
  ![Printable view](MEDIA:/home/byron/projects/geekshop-hq/docs/solutions/build-it/tax-summary-printable.png)

## Notes

- All values are integer cents, consistent with existing accounting functionality.
- Draft and cancelled invoices are excluded from tax collected.
- Personal expenses (business_use = 0) are excluded from tax paid.
- The UI gracefully handles empty states and missing data.
- The printable view is structured for HTML print rendering (header band, section tables, per-invoice/expense detail).

**Evidence collected:** 2026-06-29T23:30:26.655Z