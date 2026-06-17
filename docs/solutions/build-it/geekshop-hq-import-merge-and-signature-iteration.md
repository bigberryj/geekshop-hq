---
title: "Gmail reply sync, inline graphics, outbound signature, 30-min poll"
date: 2026-06-17
category: docs/solutions/build-it
plan: docs/plans/2026-06-17-gmail-import-merge-and-signature.md
module: gmail-integration, ticket-conversation, outbound-email
problem_type: integration, ui, security
root_cause: the import path and the ticket conversation were both half-wired — the matcher existed but only ran in the poller, the ticket page rendered plain text only, the outbound email had no signature, and the Gmail poll was set to a 5-minute cadence that hammered Gmail's rate limits.
resolution_type: new_feature
severity: medium
tags: [gmail, imapflow, ticket-thread, html-sanitization, signature, settings, poller, idempotency, migration]
---

# 2026-06-17 — Gmail reply sync, inline graphics, outbound signature, 30-min poll

## Plan

`docs/plans/2026-06-17-gmail-import-merge-and-signature.md`

## What happened

Built and verified the seven-item plan end-to-end. The previous context window left a half-built pile (replies matcher, `EmailBody` component, attachment storage, migrations 010–013). This iteration completed the integration points and added the missing pieces.

| Plan commitment | Built? | Where |
|---|---|---|
| Wire reply matcher into `importPendingEmail` | ✅ | `server/lib/pending-emails.js` lines ~272–316: try `matchReplyToTicket` before `findOrCreateCustomer`; if matched, flip pending row to `imported` pointing at the existing ticket, mark Gmail `\Seen`, return `merged_into_existing: true`. Handles `already_appended` as a no-op merge (no duplicate ticket). |
| Sanitize + cid-rewrite `body_html` on import | ✅ | `server/lib/pending-emails.js` after the attachment-insert loop: build cid→attachment-id map from `ticket_message_attachments`, run through `sanitizeEmailHtml`, UPDATE the row. |
| Render imported messages with `<EmailBody>` in the ticket page | ✅ | `client/src/pages/TicketDetail.jsx` line 245: replaced `<div className="text-sm whitespace-pre-wrap">{m.body}</div>` with `<EmailBody body={m.body} body_html={m.body_html} attachments={m.attachments \|\| []} />`. |
| Outbound email signature (migration + lib + UI + route wiring) | ✅ | `server/db/migrations/014_ticket_message_source_message_id.sql` (wait — the signature didn't actually need a new column; it stores under `settings.email_signature` key/value. Plan called for a column but the key/value `settings` table was sufficient. No migration needed.) `server/lib/signature.js` + `server/lib/text.js` (new modules). `server/routes/tickets.js` — `email-reply` and `resolve-with-reply` now call `appendSignature(app.db, body)` and pass `{text, html}` to `sendEmail`. Audit log records `had_signature`. `client/src/pages/Settings.jsx` — new "Outbound email signature" section with live preview. |
| Bump `BYRON_GMAIL_POLL_INTERVAL_MIN` to 30 | ✅ | `server/.env` and `server/.env.example`. Verified via `/api/inbox/status` → `"pollIntervalMin":30` after API restart with the new value (had to override the stale shell-exported `5` to see the new config take). |
| Mark Gmail message read on import (new ticket path) | ✅ | `server/lib/pending-emails.js` after the `UPDATE pending_emails SET status='imported'...` line. Fire-and-forget; never throws. |
| Fix `inbox-scan.test.js` 5s timeout | ✅ | `server/test/inbox-scan.test.js` — pass `autoDismissJunk: false` so the test doesn't await a real LLM call. Test now finishes in ~40ms; whole suite in 2.23s. |

**Plus one new migration that wasn't in the plan:** `014_ticket_message_source_message_id.sql`. The reply matcher's `appendReply` function did an `INSERT INTO ticket_messages (..., source_message_id, ...)` that required a column that didn't exist. The merge smoke test (a real DB round-trip, not a unit test) caught this before commit. Migration 014 was added, applied to both `data/hq.db` and `server/data/hq.db`, and the test passed.

## Verification evidence

### Tests

```
$ cd server && npm test

 ✓ test/tax.test.js (29 tests) 36ms
 ✓ test/style.test.js (13 tests) 43ms
 ✓ test/import-merge.test.js (4 tests) 38ms
 ✓ test/junk-classifier.test.js (42 tests) 110ms
 ✓ test/pending-emails.test.js (14 tests) 345ms
 ✓ test/basic.test.js (10 tests) 41ms
 ✓ test/inbox-scan.test.js (7 tests) 33ms
 ✓ test/signature.test.js (8 tests) 46ms
 ✓ test/smoke.test.js (12 tests) 326ms
 ✓ test/inbox-preview.test.js (3 tests) 251ms
 ✓ test/ai-park.test.js (1 test) 107ms
 ✓ test/queue-features.test.js (5 tests) 49ms
 ✓ test/time-entries.test.js (2 tests) 384ms
 ✓ test/tickets-filter.test.js (4 tests) 152ms
 ✓ test/google-contacts.test.js (12 tests) 1643ms

 Test Files  15 passed (15)
      Tests  166 passed (166)
   Duration  2.23s
```

Was: 153/154 + a 5s timeout. Net change: **+12 new tests, +1 fixed test, 0 regressions**.

### Live API: poller interval

```
$ curl -sS http://localhost:5050/api/inbox/status
{"hasCreds":true,"pollIntervalMin":30,"autoCreate":true,"moderation_mode":"pending_queue"}
```

`pollIntervalMin:30` (was 5). Had to restart the API process and override the stale shell-exported `BYRON_GMAIL_POLL_INTERVAL_MIN=5` to make `.env` (which says 30) take effect.

### Live browser: signature roundtrip

```
$ curl -sS http://localhost:5050/api/settings
…
"email_signature": "Byron Berry\nGeekShop Computers\nbyron@geekshop.ca · 250-555-0100"
```

The Settings page rendered the new "Outbound email signature" section with the textarea and live preview. After Save, the value persisted under `settings.email_signature`. Live preview (in the DOM via `data-testid="signature-preview"`):

```
Hi Linda — coming out tomorrow to assess the firewall. I have a 10am-11:30am slot open if that works.

--
Byron Berry
GeekShop Computers
byron@geekshop.ca · 250-555-0100
```

Newlines preserved via `white-space:pre-wrap`; HTML injection in the signature is escaped (`<script>alert(1)</script>` becomes `&lt;script&gt;…`).

### End-to-end merge smoke test

Seeded a pending email referencing an open ticket's customer + subject, ran `importPendingEmail` against the live `data/hq.db`:

```
open ticket with source_message_id: {
  id: 17, subject: 'Re: Re: Re: Volunteer Cowichan',
  customer_id: 11,
  source_message_id: 'test-thread-reply-1781690898318@local',
  status: 'open'
}
customer email: { email: 'jashanjot@mcpheetax.ca' }
seeded pending id: 822
messages on target ticket before: 1
import result: {
  merged_into_existing: true,
  already_imported: false,
  ticket_id: 17,
  subject: 'Re: Re: Re: Volunteer Cowichan',
  customer: null
}
messages on target ticket after: 2
delta: 1
pending row after import: { status: 'imported', imported_ticket_id: 17 }
```

**End-to-end merge confirmed in the real DB.** The reply matcher recognized the pending email as a reply to ticket 17, appended a new message to it (count went 1→2), flipped the pending row to `imported`, and returned `merged_into_existing: true`. No new ticket was created.

## Pivots from the plan

1. **Plan called for a new column on `settings` for the signature.** Used the existing key/value `settings` table instead (`settings.email_signature`). No migration needed. This is simpler and consistent with how every other tunable in the app is stored.
2. **Added migration 014 (`source_message_id` on `ticket_messages`)** that wasn't in the plan. The reply matcher's `appendReply` was already trying to insert into a column that didn't exist — caught by the merge smoke test before commit. Plan would have shipped with a SQL error on the first real customer reply.
3. **`already_appended` short-circuit in `importPendingEmail`** is more aggressive than the plan called for. The plan said "skip the new-ticket path." I implemented "flip pending row to `imported` AND skip the new-ticket path" — without that, the same message could create a brand-new ticket on a re-import even though it was already on the original ticket. Plan caught the right intent; the implementation is the conservative version of that intent.

## next_time

- The inline-graphics iframe path (`<EmailBody>` + `sanitizeEmailHtml` + cid→`/raw` rewrite) is wired up but **was not browser-verified in production data** because no existing ticket message has `body_html` populated. A real Gmail scan + import with a message that has inline images is the next verification step. The unit + integration tests cover the sanitizer and the cid-rewrite logic; the iframe rendering is the one thing I trusted the React code on without seeing it.
- Customer enrichment modal bug from the prior iteration (Contacts modal not appearing after import) is **still unfixed** — it was not in this plan's scope. Track separately.
- The outbound email is sent via `lib/email.js` with the existing SMTP transporter. If Byron wants a different `From:` header (e.g. `Byron <byron@geekshop.ca>` instead of `GeekShop HQ <byron@geekshop.ca>`), the `SMTP_FROM` env var is the hook. Currently defaulting.
- 30-min poll interval means up to 30 min delay before a customer reply shows up in the dashboard. The matcher's idempotency handles this safely — the eventual merge is correct regardless of how late it lands. If Gmail's rate limits turn out to be looser than expected, the interval is a one-line env change.
