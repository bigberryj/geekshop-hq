# T-F073BA — Phase 2 Customer 360 timeline evidence

## What shipped

Server endpoint `GET /api/customers/:id/timeline` returning a normalized,
newest-first event feed from eight existing tables. New
`client/src/components/CustomerTimeline.jsx` rendered as the default
Timeline tab on `/customers/:id`.

## Files added

- `client/src/components/CustomerTimeline.jsx` (246 lines)
- `server/test/customer-timeline.test.js` (11 tests)

## Files modified

- `server/routes/customers.js` (added timeline handler at line 188-513)
- `client/src/pages/CustomerDetail.jsx` (Timeline tab wired in, default tab)
- `docs/api.md` (Customer 360 timeline section)
- `docs/schema.md` (Derived views section)
- `docs/security.md` (Phase-2 projection-discipline line)
- `docs/changelog.md` (Phase-2 entry)
- `docs/plans/2026-06-29-geekshop-hq-accounting-roadmap.md` (Execution status)

## Verification

### Server tests — 11/11 customer-timeline tests pass

```
$ cd server && npm test -- customer-timeline
 ✓ test/customer-timeline.test.js (11 tests) 337ms
   Tests  11 passed (11)
```

Coverage:

1. 400 on non-integer customer id
2. 404 on unknown customer id
3. Full-activity happy path (all 8 kinds)
4. kinds= filter restricts results
5. from / to date filters clamp correctly
6. limit clamps response size
7. Secrets / Gmail headers / Stripe ids / body_html never leak
8. Invoice state expansion → 3 events for a paid invoice
9. Appointment email-fallback matches legacy customer_id=NULL bookings
10. Cross-customer isolation
11. Unknown kind names dropped from filter

### Full server suite — 289/295

The 6 pre-existing failures (basic/db-migrate, accounting tax-collected,
Stripe verifyWebhook, customer-search-benchmark, 2× google-contacts live)
predate this tick and live in earlier work; none touch the timeline code.

### Client build

```
$ cd client && node ./node_modules/vite/bin/vite.js build
✓ 1684 modules transformed.
✓ built in 3.88s
```

### Browser test (CustomerDetail / Powell River Computers)

- Page loads at `/customers/17` → Timeline tab is the default active tab
- Filter chips render with counts: All, Appointment (1), Invoice (1), Memory (1)
- Event rows: icon + title + summary + meta tail + timestamp
- Click Memory chip → timeline filters to memory only; click All → restores
- "Showing 3 events." footer renders correctly

### API status codes (live)

```
GET /api/customers/abc/timeline   → 400 invalid customer id
GET /api/customers/99999/timeline → 404 customer not found
GET /api/customers/17/timeline    → 200, 3 events
GET /api/customers/15/timeline    → 200, 10 events, all 6 kinds present
```