---
title: "GeekShop HQ Gmail classifier backfill and tuning iteration"
date: 2026-06-16
category: docs/solutions/build-it
module: geekshop-hq
problem_type: bug_fix_plus_iteration
resolution_type: code_fix + new_feature
severity: medium
tags: [gmail, junk-classifier, bug-fix, browser-tested, settings, audit-trail]
---

# GeekShop HQ Gmail classifier backfill and tuning iteration

## Goal

Tighten the junk classifier (rule bug + new patterns + settings-backed tuning) and run a one-shot backfill on the 554 un-classified legacy rows.

## What shipped

### Bug fix — `isLikelyHuman` over-trigger

The old heuristic treated the email local part as a display name when `from_name` was empty, so senders like:

- `invoice+statements+acct_1HNrvlCJoPsRzQsd@stripe.com` (Stripe receipts)
- `catch@payments.interac.ca` (Interac e-Transfer alerts)
- `capitalone@notification.capitalone.com` (Capital One transaction alerts)

were being scored 0.0 (kept) when they were obviously transactional. Fix: only inspect the explicit `from_name` field, never synthesize a display name from the email.

### New always-keep list — security / account-recovery subjects

Subjects matching any of these are NEVER auto-dismissed, even if the sender is a `noreply@`:

- "security alert", "security notice", "security risk"
- "unauthorized", "verification", "verify your identity", "verify your account"
- "reactivate my account", "reactivate your account"
- "no longer recoverable", "recovery", "recovery code"
- "new (device) sign-in", "unrecognized (device|sign)"
- "password (reset|changed|expir)", "suspicious activity", "unauthorized (access|login|sign)"

### New signal patterns

- **Google ecosystem** — `*noreply@google.com`, `sc-noreply@google.com`, `workspace-noreply@google.com`, `comments-noreply@docs.google.com`, plus `accounts.google.com`, `docs.google.com`, `drive.google.com` → +0.4 score
- **Transactional/receipt subject patterns** — `receipt`, `payment posted`, `payment due`, `auto deposited`, `successfully deposited`, `was successfully deposited`, `has been deposited`, `e-?transfer`, `interac`, `has requested $N`, `transfer to`, `invoice has been generated`, `thank you for your payment` → +0.5 score
- **`m.shopifyemail.com`** added to ESP_DOMAINS

### Settings-backed overrides (no-code tuning)

Three new settings on the **Settings** page (under "Gmail moderation (junk classifier)"):

| Setting | Effect |
|---|---|
| `auto_dismiss_domains` | CSV exact-match domains. Each adds 0.6 to the score. |
| `auto_keep_subjects` | CSV substrings. Subjects matching ANY of these are NEVER auto-dismissed. |
| `agent_mailbox_from` | CSV from_email values. Used by the "Hide agent mail" UI toggle. |

All three are read by both `scoreEmail()` (during scans) and `backfillClassifyPendingEmails()` (during the catch-up pass). The classifier never reads the DB directly — `readModerationSettings()` is the single source of truth.

### Backfill route + UI

- `POST /api/inbox/pending/backfill-classify` — one-shot admin action. Body: `{ threshold?, status?, limit? }`. Returns `{ examined, classified, dismissed, threshold, samples }` and writes an audit-log row per dismiss + a summary row.
- `GET /api/inbox/moderation-settings` — read-only.
- **Classify legacy** button in the Inbox header (next to "Scan Gmail now"). Shows a banner with `examined N, classified N, auto-dismissed N` and a collapsible list of up to 25 dismissed examples for audit.

### Agent-mail toggle

A new **Hide agent mail** checkbox in the Inbox header. When on, rows whose from_email is in `agent_mailbox_from` are filtered client-side from the human-pending view. The data stays in the DB. Persists in `localStorage`. Header reports `(... agent mail hidden)` so the queue size doesn't lie. Bulk-select-all and bulk-dismiss are scoped to the visible list, so toggling the filter won't accidentally dismiss hidden agent mail.

## Verification evidence

### Test suite

```text
Test Files  9 passed (9)
Tests       144 passed (144)
```

Was 117/117 before this iteration. Added 27 new tests covering:

- isLikelyHuman over-trigger regression (4 tests)
- Security / always-keep subjects (3 tests)
- Google ecosystem signals (3 tests)
- Transactional subject patterns (3 tests)
- Settings-backed overrides (4 tests)
- `isAgentMail` helper (4 tests)
- `backfillClassifyPendingEmails()` (6 tests)

### Live backfill on Byron's actual queue

```text
$ curl -X POST http://127.0.0.1:5050/api/inbox/pending/backfill-classify \
    -H 'Content-Type: application/json' \
    -d '{"threshold":0.8,"status":"pending","limit":1000}'
{
    "ok": true,
    "examined": 554,
    "classified": 554,
    "dismissed": 62,
    "threshold": 0.8,
    ...
}
```

### Queue before/after

| | pending | dismissed | un-classified pending |
|---|---:|---:|---:|
| Before | 556 | 213 | 554 |
| After | 494 | 275 | 0 |

### What got auto-dismissed (highlights from the samples)

- `hello@news.railway.app` "Railway product update" (brand + automated + unsubscribe) → 0.90
- `newsletter@em.teepublic.com` "Shirtacular is LIVE!" → 0.90
- `hello@ollama.com` "Gemma 4 12B..." → 1.00
- `info@poshmark.com` "Red Hot Chili Peppers..." → 1.00
- `team@support.koho.ca` "Your money could be working harder" → 1.00
- `sales@scooteretti.com` / `sales@biktrix.com` (eBike promos) → 0.95
- `cargurus@mail.cargurus.com` "Nissan LEAF from $9,900" (when fromName='CarGurus') → 0.95
- `billing@greengeeks.com` "Thank you for your payment" (brand + transactional) → 1.00
- `no-reply@accounts.google.com` "Your Google Account is no longer recoverable" → **KEPT** (security_subject_keep override)
- `no-reply@accounts.google.com` "Security alert" → **KEPT**

### Browser verification

- Inbox renders with new toggles + Classify legacy button. Header shows `(250 of 490 pending)` after backfill (was `(250 of 546 pending)`).
- Toggling "Hide agent mail" re-renders to `(212 of 452 pending (38 agent mail hidden))` — the 38 agent mail rows are filtered out client-side; the DB is untouched.
- Settings page now has a "Gmail moderation (junk classifier)" section with three ListField inputs that match the API shape.
- Clicking "Classify legacy" twice is idempotent — the second call returns `examined 0, classified 0, auto-dismissed 0`.
- 0 JS errors in the browser console throughout.

### Security / data hygiene

- No secrets in code or commits.
- The agent mailbox setting is `johnn5wizbot@gmail.com` (a real, separate, app-mailbox-style identity — not Byron's personal Gmail). The toggle only hides mail from that account; it never affects the server data model.
- All 62 auto-dismisses have an audit_log row with `actor='auto'`, `action='pending_email.backfill_classify'`, and the per-row payload (from, subject, score, signals, threshold, reason). Plus a single summary row with `action='pending_email.backfill_classify.run'`.
- The settings overrides are private/admin-only — only the admin can read or modify them.

## What this does NOT do (and why)

- **It doesn't lower the threshold below 0.8 by default.** The backfill threshold is configurable, but the live scan threshold is hard-coded at 0.8 in `scoreEmail()`. Lower it deliberately via the API if you want more aggressive auto-dismiss; raise it via the rule weights if you want stricter.
- **It doesn't retroactively dismiss already-dismissed rows.** Those were dismissed by the previous rule set and their classification is informational only. Re-run with `status='all'` to re-classify them.
- **It doesn't touch the `johnn5wizbot` agent mail itself.** The toggle hides it from the UI, not the DB. If you want to auto-dismiss `[J5] *` mail entirely, add `johnn5wizbot@gmail.com` to `auto_dismiss_domains` in Settings.

## Next steps (recommended, not done)

- Run a scan with the new rules to confirm the live path works on fresh Gmail.
- Periodically re-run **Classify legacy** (it's idempotent) after rule tuning.
- When you spot a send-by-send miss, add it to `auto_dismiss_domains` (one entry) or `auto_keep_subjects` (one substring) — no code change needed.
- The plan is now visible: when you decide to do the QBO integration, this is the surface to extend with paid-service-aware scoring.
