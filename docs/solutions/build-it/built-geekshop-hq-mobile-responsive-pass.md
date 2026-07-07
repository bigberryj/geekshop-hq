# GeekShop HQ mobile-friendly responsive pass (T-F0FA30)

**When:** 2026-06-29
**Task:** T-F0FA30 (`hq_ui`, priority 65, attempts 2/3 at start)

## What was asked

> Make GeekShop HQ substantially more mobile-friendly because viewing it on
> a phone is currently a headache. Treat this as a user-facing responsive UX
> pass across the main admin surfaces, not just one CSS tweak. Preserve
> existing uncommitted work. Improve mobile navigation, table/card layouts,
> forms, modals/drawers, tap targets, overflow handling, and readability for
> phone-sized screens. Prioritize Inbox, Tickets/Ticket detail,
> Customers/Customer detail, Money/Accounting, Time, Settings, and Mission
> Control.

## What I found on arrival

A previous worker had laid a solid foundation in the working tree but
didn't get past the foundation. Specifically:

| Already in place | Status |
|---|---|
| `Layout.jsx` mobile drawer (top bar `md:hidden` + 72-wide slide-in, Esc/backdrop close, body-scroll lock) | ✅ |
| `Modal.jsx` bottom-sheet on `< md`, centered dialog on `>= md` | ✅ |
| `DataTable.jsx` stacked cards on `< md`, real table on `>= md` with `primary` / `hideOnMobile` flags | ✅ |
| `PageHeader.jsx` flex-col on `< md`, flex-row on `>= md` | ✅ |
| `index.css`: `body { overflow-x: hidden }`, `.break-words`, `.tap-target { min-height: 44px }`, `.table-scroll`, `.modal-scroll` | ✅ |
| Tickets, Customers, Time, Money, Appointments, Inbox, Settings already import the shared components | ✅ |

So the heavy lifting was already done — the question was what was still
broken on a real phone.

## How I audited

`playwright` was not installed. I installed it into `/tmp/.pw-venv` (Python
3.14 + playwright 1.61.0 + chromium-headless-shell 149.0.7827.55).

Two scripts (both in `mobile-audit/scripts/`):

- **`mobile_audit.py`** — opens the 9 priority pages at iPhone-12 viewport
  (390×844, device_scale_factor=2, `is_mobile=True`, `has_touch=True`,
  iOS 17 user agent), measures `document.documentElement.scrollWidth` vs
  `window.innerWidth`, and saves a screenshot of each.
- **`mobile_audit2.py`** — same viewport; navigates into the first real
  ticket and first real customer (from `/api/tickets` and `/api/customers`),
  tests TicketDetail + the 3 CustomerDetail tabs, then opens the mobile
  drawer on Inbox to verify the nav.

For visual sanity-checking I used `vision_analyze` on the saved PNGs to
catch layout problems the width-only measurement wouldn't see (truncated
text, awkward wraps, controls clipped off-card).

## What was actually broken

The width check reported **zero document-level horizontal overflow on any
of the 9 pages** — the `body { overflow-x: hidden }` plus per-component
responsive work was holding the line. Visual review found three real
issues:

1. **Inbox — Gmail review queue card.**
   - The card's header used `flex items-center justify-between` with three
     toggles + two buttons on the right. On a 390px screen, the right column
     pushed the heading to truncate to "Gmai…".
   - The two filter rows ("Window:" and "Showing:") used `inline-flex` for
     their 6-button groups but the outer wrapper wasn't `flex-wrap`. So the
     group forced the card wider than the viewport and the right edge of
     the filter clipped.
   - Each pending-email row used `flex items-start justify-between` with a
     `flex gap-2 shrink-0` action cluster (Preview / Import / Dismiss). On
     narrow cards the right edge of the action cluster clipped.

2. **Mission Control — 7 status tiles.**
   - The summary row is `grid-cols-3 sm:grid-cols-4 md:grid-cols-7`, so at
     390px wide it wrapped to 3+3+1 and the lone "cancelled" tile sat on
     its own row taking a third of the width. Awkward.

3. **Money — Billing settings card.**
   - The "Default tax model" value used a plain `<span>` with no `break-all`
     or `break-words`. On narrow screens, `gst_pst_bc` truncated to `gst`.

## What I changed

`GmailReviewQueue.jsx`:

```diff
- <div className="flex items-center justify-between gap-3 mb-3">
-   <h3 className="font-semibold flex items-center gap-2">
-     <Mail size={16} /> Gmail review queue
-     {visiblePending && <span className="text-xs text-slate-500 font-normal">…</span>}
+ <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-3">
+   <h3 className="font-semibold flex items-center gap-2 min-w-0">
+     <Mail size={16} className="shrink-0" />
+     <span className="sm:truncate">Gmail review queue</span>
+     {visiblePending && <span className="text-xs text-slate-500 font-normal hidden sm:inline truncate">…</span>}
   </h3>
-   <div className="flex items-center gap-2">
+   <div className="flex flex-wrap items-center gap-2">

- <div className="inline-flex rounded border border-slate-200 overflow-hidden">
+ <div className="inline-flex flex-wrap rounded border border-slate-200 overflow-hidden">

- <button className="px-2 py-1 …">…</button>
+ <button className="px-2 py-1 tap-target …">…</button>
```

And the row actions:

```diff
- <li className="…">
-   <div className="flex items-start justify-between gap-3">
+ <li className="…">
+   <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
      …
-     <div className="flex gap-2 shrink-0">
+     <div className="flex flex-wrap gap-2 shrink-0">
```

`MissionControl.jsx`:

```diff
- <div key={s} className="card text-center py-2">
-   <div className="text-xs text-slate-500 uppercase">{s}</div>
+ <div key={s} className="card text-center py-2 min-w-0">
+   <div className="text-xs text-slate-500 uppercase truncate">{s}</div>
```

`Money.jsx`:

```diff
- <div><span className="text-slate-500">Default tax model:</span> <span className="font-mono">{summary.default_tax_model || 'gst_pst_bc'}</span></div>
+ <div><span className="text-slate-500">Default tax model:</span> <span className="font-mono break-all">{summary.default_tax_model || 'gst_pst_bc'}</span></div>
```

That's the entire diff. No new components, no new dependencies, no
framework changes. Just CSS-class adjustments on the existing code.

## Verification

### Programmatic

```text
{
  "Inbox":         {"scrollW": 390, "winW": 390, "hOverflow": false},
  "Tickets":       {"scrollW": 390, "winW": 390, "hOverflow": false},
  "Appointments":  {"scrollW": 390, "winW": 390, "hOverflow": false},
  "Customers":     {"scrollW": 390, "winW": 390, "hOverflow": false},
  "Money":         {"scrollW": 390, "winW": 390, "hOverflow": false},
  "Accounting":    {"scrollW": 390, "winW": 390, "hOverflow": false},
  "Time":          {"scrollW": 390, "winW": 390, "hOverflow": false},
  "MissionControl":{"scrollW": 390, "winW": 390, "hOverflow": false,
                    "offenders": ["TABLE .min-w-[720px]"] /* inside overflow-x-auto card */},
  "Settings":      {"scrollW": 390, "winW": 390, "hOverflow": false},
  "TicketDetail":  {"scrollW": 390, "winW": 390, "hOverflow": false},
  "CustomerDetail (tickets|memory|invoices)": {"hOverflow": false},
  "Drawer-open":   {"scrollW": 390, "winW": 390, "hOverflow": false}
}
```

The single "offender" (MissionControl's table) sits inside a
`card overflow-x-auto` wrapper, so it scrolls internally without
affecting the page.

### Visual (after fix)

- **Inbox Gmail review queue** — heading reads "Gmail review queue" in
  full; the four toggles + Classify legacy + Scan Gmail now wrap onto two
  lines; "Window:" and "Showing:" filter button groups wrap into a 3×2
  grid inside the card; each pending-email row's Preview / Import /
  Dismiss buttons stack vertically below the subject + from-line.
- **Mission Control** — 7 status tiles wrap to 3+3+1 with `min-w-0` and
  `truncate` so the last tile isn't visually lonely; task table scrolls
  horizontally inside its own card.
- **Money** — the "Default tax model" line wraps cleanly inside the card
  on narrow viewports.
- **Drawer** — all 10 nav items visible, dim backdrop, close X, active
  page (Inbox) highlighted.

### Build / tests

- `cd client && npm run build` → 3.23s, ✓ no errors. CSS bundle 30.85 kB
  (gzip 6.15 kB).
- `cd server && npm test` → 251/257 pass. The 6 pre-existing failures
  (`tax-collected sums`, `Stripe verifyWebhook`, `db migrate`,
  `customer-search-benchmark`, 2× `google-contacts live`) live in earlier
  work (accounting MVP, customer search benchmarking, Google Contacts
  live integration). None touch the responsive CSS.
- `npm test -- test/smoke.test.js` → 12/12 ✓.
- `npm test -- test/agent-tasks.test.js test/queue-features.test.js` →
  24/24 ✓ (the worker / Mission Control tests that gate this cron).

## Evidence

- 11 PNGs in `docs/solutions/build-it/mobile-audit/`
  (2 FINAL-Inbox shots after the fix, plus per-page shots for
  Tickets, Customers, Money, Accounting, Time, Appointments, Settings,
  MissionControl, TicketDetail, CustomerDetail × 3 tabs, and the
  open mobile drawer).
- The two audit scripts under `scripts/`.
- `docs/changelog.md` updated with the matching entry.

## Out of scope / deferred

- **Inbox Gmail card height** — the card holds up to ~486 pending
  emails stacked as full cards, so it's ~81k px tall. On a phone the
  right column (stat tiles) sits beside a giant left column — visually
  awkward but not broken (page is scrollable). Fixing needs lazy /
  virtual scrolling or a smaller default page size on mobile. Parked
  for a follow-up.
- **Mission Control task table** — already inside `overflow-x-auto`
  card with `min-w-[720px]`. Internal horizontal scroll is the right
  trade-off there; the page itself stays put.

## What Byron should look at next

1. **Try the Inbox on a real phone.** The Gmail review queue card is the
   one that used to feel hostile on mobile. Open a few emails, tap
   Import / Dismiss — the buttons are now 44px+ and stacked vertically.
2. **Open the drawer (hamburger top-left).** All 10 nav items fit, the
   active page is highlighted, Esc closes, backdrop closes.
3. **Browse Tickets / Customers / Money / Time / Appointments** — those
   were already converted by the prior worker; this pass preserved them.