---
title: "GeekShop HQ Gmail moderation and billing iteration"
date: 2026-06-16
category: docs/solutions/build-it
module: geekshop-hq
problem_type: product_iteration
resolution_type: new_feature
severity: medium
tags: [gmail, billing, invoices, google-contacts, browser-tested]
---

# GeekShop HQ Gmail moderation and billing iteration

## Goal

Finish the in-progress GeekShop HQ work around Gmail queue moderation, Google Contacts enrichment, and private minimum-charge invoice drafts, then verify it through tests and the browser.

## What shipped

### Gmail moderation

- Added strict junk classification for Gmail scan entries.
- Added soft auto-dismiss metadata: `dismissed_by`, `dismissed_reason`, `classification`, `dismissed_at`.
- Added bulk-dismiss endpoint and UI.
- Added `Show dismissed` + restore flow.
- Kept the moderation model intentionally conservative: potential clients, existing customers, human-looking senders, replies, and ambiguous messages stay visible.

### Google Contacts enrichment

- Reuses the existing Google OAuth token at `~/.hermes/google_token.json`.
- Looks up a sender in Google Contacts after the admin imports a Gmail entry.
- Returns proposed blank-field updates only.
- UI modal requires explicit human **Apply selected** before customer fields are changed.
- Fixed the modal apply guard to check the returned contact candidate correctly.

### Billing minimum charge

- Added `minimum_charge_cents` as a settings-backed private invoice floor.
- Money page now opens an invoice draft preview modal instead of auto-creating immediately.
- The floor can be toggled/overridden per invoice.
- Customer invoices do not show a “minimum charge” line; labour lines are repriced to meet the floor.
- Invoice totals now use integer `total_cents` where present to avoid fractional-hour rounding drift.

## Verification evidence

### Backend tests

```text
Test Files  9 passed (9)
Tests       117 passed (117)
```

Full run command:

```bash
cd /home/byron/projects/geekshop-hq/server
npm test -- --run
```

### Frontend build

```text
✓ 1661 modules transformed.
dist/index.html                   0.43 kB │ gzip:   0.29 kB
dist/assets/index--uqR0k1w.css   21.25 kB │ gzip:   4.31 kB
dist/assets/index-aBJc11Ek.js   370.68 kB │ gzip: 113.89 kB
✓ built in 3.32s
```

Full run command:

```bash
cd /home/byron/projects/geekshop-hq/client
npm run build
```

### Browser checks

Verified with the live Vite frontend (`127.0.0.1:5173`) and API (`127.0.0.1:5050`):

- Inbox renders the Gmail review queue.
- Two synthetic pending email rows were selected via row checkboxes.
- **Dismiss 2 selected** appeared and soft-dismissed them.
- **Show dismissed** revealed dismissed rows with **Restore** buttons.
- One synthetic row was restored and DB state showed it returned to `pending`.
- Synthetic rows were deleted afterward.
- Settings renders the minimum-charge field (`$50.00` in the live local DB).
- Money renders the invoice draft modal.
- Zelda Hyrule preview showed the minimum charge applying: `$15.00` labour → `$50.00`, GST `$2.50`, PST `$3.50`, total `$56.00`.
- Browser console showed no JS errors.

### Security / data hygiene

- No secrets were committed.
- Google OAuth token remains outside the repo.
- Gmail import still requires an explicit **Import** click before customer/request creation.
- Contacts enrichment still requires an explicit **Apply selected** click.
- Bulk dismiss and auto-dismiss are soft state changes with restore, not hard deletes.

## Follow-up recommendation

Use QuickBooks Online as the invoice/payment source of truth. GeekShop HQ should prepare reviewed service records and push/sync them to QBO rather than becoming a separate accounting system. Stripe is useful if direct payment collection becomes the priority, but QBO should own invoicing/payment status because Byron already uses it for billing.
