---
title: "Gmail: merge replies into existing tickets on import, render inline graphics, add signature on outbound replies"
date: 2026-06-17
status: executed
category: docs/plans
slug: 2026-06-17-gmail-import-merge-and-signature
last_executed: 2026-06-17
final_commit: b9ac6064bde78fa55944f4dd19f06140a68e3ab5
solution_doc: docs/solutions/build-it/geekshop-hq-import-merge-and-signature-iteration.md
---

# Execution status

**Delivered.** 166/166 tests passing in 2.23s. End-to-end reply-merge confirmed in the live `data/hq.db` (pending id 822 → appended to ticket 17, no duplicate created). Outbound signature persists in `settings.email_signature` and renders in the live Settings preview. Poller now reads `BYRON_GMAIL_POLL_INTERVAL_MIN=30` (verified via `/api/inbox/status`).

| Plan commitment | Built? | Where |
|---|---|---|
| Migration 013 (`gmail_message_id`) | ✅ | `server/db/migrations/013_ticket_message_gmail_id.sql`, applied |
| `lib/replies.js` matcher | ✅ | `server/lib/replies.js` (already on disk at start) |
| Wire matcher into poller | ✅ | `server/index.js` lines 87–104 (already on disk at start) |
| Wire matcher into `importPendingEmail` | ✅ | `server/lib/pending-emails.js` |
| `body_html` sanitize + cid-rewrite on import | ✅ | `server/lib/pending-emails.js` after attachment insert |
| `<EmailBody>` in ticket page | ✅ | `client/src/pages/TicketDetail.jsx` line 245 |
| Outbound email signature | ✅ | `server/lib/signature.js`, `server/lib/text.js`, `server/routes/tickets.js`, `client/src/pages/Settings.jsx` |
| 30-min poll interval | ✅ | `server/.env`, `server/.env.example` |
| Mark read on import | ✅ | `server/lib/pending-emails.js` (both paths) |
| Fix `inbox-scan.test.js` timeout | ✅ | `server/test/inbox-scan.test.js` — `autoDismissJunk: false` |

**Pivots from the plan:**
- Signature was stored under the existing `settings` key/value table (no new column needed) — simpler and consistent.
- Added migration 014 (`source_message_id` on `ticket_messages`) that wasn't in the plan. The reply matcher's `appendReply` was already trying to insert into a column that didn't exist; the merge smoke test caught it before commit.

**Verification:** see `docs/solutions/build-it/geekshop-hq-import-merge-and-signature-iteration.md` for the full evidence (test output, live API + browser checks, end-to-end merge smoke test).

---

# Goal

When a customer replies to an email that's already a GeekShop ticket, the reply should land inside the **existing** ticket's conversation thread (not a brand-new ticket), and the email should render with its inline graphics and HTML formatting. Outbound replies from GeekShop HQ should carry Byron's Gmail signature. The Gmail poller should check every 30 minutes. Imports should mark the source message read in Gmail so the inbox stays in sync.

# Background (the honest current state)

The previous context window's summary claimed this work was already done. It is not. Verified on disk 2026-06-17:

- ✅ `server/lib/replies.js` exists and exports `matchReplyToTicket` and `markImportedRead`. Idempotent via `gmail_message_id` (migration 013).
- ✅ Poller in `server/index.js` calls `matchReplyToTicket` first, falls through to pending queue if no match.
- ❌ `importPendingEmail` (the manual "Import" button path) does **not** call `matchReplyToTicket`. Manually clicking Import on a customer reply still creates a new ticket.
- ❌ `importPendingEmail` does **not** run `sanitizeEmailHtml` on `full.html`. Even when Gmail returns HTML, the imported `ticket_messages.body_html` is the raw unsanitized HTML with `cid:` image refs that never resolve.
- ❌ `TicketDetail.jsx` imports `EmailBody` but never uses it (line 5 import, line 245 renders `{m.body}` as plain text). Inline graphics in imported messages never reach the user.
- ❌ No Gmail signature setting, no signature code path in `tickets.js`. Outbound emails are body-only.
- ❌ `.env` still says `BYRON_GMAIL_POLL_INTERVAL_MIN=5`. Should be 30.
- ❌ `test/inbox-scan.test.js` has a real timeout: the test calls `scanPendingEmails(db, {})` with default `autoDismissJunk: true`, which awaits `classifyEmail` (real LLM) for every message. 5s budget is too tight. Fix: pass `autoDismissJunk: false` in the test (correct behavior for batch reprocessing anyway).

# Proposed change

## 1. Wire reply matcher into the manual import path

**File:** `server/lib/pending-emails.js` (around line 270, just before `findOrCreateCustomer`)

After the `fetchByMessageId` block, before `const customer = findOrCreateCustomer(...)`, try the matcher:

```js
// Re-use the reply matcher so manual import + poller import behave
// identically: if this Gmail message is a reply to an existing open
// ticket, append it to that ticket and return. Skip the new-ticket path.
try {
  const { matchReplyToTicket, markImportedRead } = await import('./replies.js');
  // Build a minimal `msg` shape for the matcher from the pending row +
  // (optionally) the live re-pull.
  const matcherMsg = {
    messageId: row.message_id,
    fromEmail: row.from_email,
    from: row.from_name,
    subject: row.subject,
    body: body,
    html: bodyHtml,
    attachments: liveAttachments,
  };
  const matched = await matchReplyToTicket(app.db, matcherMsg);
  if (matched && !matched.already_appended) {
    // Mark Gmail message read. Best-effort, never throws.
    markImportedRead(row.message_id).catch(() => {});
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(matched.ticket_id);
    return { ticket, customer: null, already_imported: false, contactMatch: null, merged_into_existing: true };
  }
} catch (e) {
  console.warn('[inbox] reply matcher on import failed:', e.message);
  // fall through to normal new-ticket path
}
```

(Note: `pending-emails.js` is a library; the `markImportedRead` import is fine — it doesn't need a request context.)

## 2. Sanitize and persist `body_html` with cid→attachment rewrites on import

**File:** `server/lib/pending-emails.js` (same `importPendingEmail` function)

After `bodyHtml = full.html || null;` and after persisting attachments (so we have a fresh `content_id` → `id` map), build the cid map and run the HTML through `sanitizeEmailHtml`:

```js
// Build a cid → ticket_message_attachment.id map so inline <img src="cid:...">
// refs in the Gmail HTML point at our /api/attachments/:id/raw route.
const cidMap = new Map();
for (const a of (liveAttachments || [])) {
  if (a.contentId) cidMap.set(String(a.contentId).replace(/^<|>$/g, ''), null);
}
// We need DB-assigned ids; map by re-querying after the inserts.
const persisted = db.prepare(`
  SELECT id, content_id FROM ticket_message_attachments WHERE ticket_message_id = ?
`).all(messageId);
for (const row of persisted) {
  if (row.content_id) {
    cidMap.set(String(row.content_id).replace(/^<|>$/g, ''), row.id);
  }
}
if (bodyHtml) {
  bodyHtml = sanitizeEmailHtml(bodyHtml, (cid) => cidMap.get(cid) || null);
  // Re-write the row with the sanitized HTML so the ticket page can
  // render it directly without re-sanitizing at request time.
  db.prepare('UPDATE ticket_messages SET body_html = ? WHERE id = ?')
    .run(bodyHtml, messageId);
}
```

Add the import at top of file: `import { sanitizeEmailHtml, persistAttachment, deleteAttachment, readAttachmentBuffer } from './attachments.js';` (most of these are already imported — just add `sanitizeEmailHtml` if missing).

## 3. Render imported messages with `EmailBody` in the ticket page

**File:** `client/src/pages/TicketDetail.jsx` line 245

Replace:
```jsx
<div className="text-sm whitespace-pre-wrap">{m.body}</div>
```

With:
```jsx
<EmailBody body={m.body} body_html={m.body_html} attachments={m.attachments || []} />
```

(EmailBody already imported on line 5; this uses the import.)

## 4. Add Gmail signature to outbound replies

**Files:**
- `server/db/migrations/014_email_signature.sql` — new column on `settings`:
  ```sql
  ALTER TABLE settings ADD COLUMN email_signature_html TEXT;
  ```
- `server/lib/signature.js` (new) — exports `getEmailSignature(db)` and `appendSignature(body, signature)`. Returns `body + '\n\n' + signature` with the signature rendered as a `<div>`-wrapped block for HTML email.
- `server/routes/tickets.js` — in `emailReply` and `resolveWithReply`, fetch signature, append to `body` (or replace `body` with `{ text, html }` for HTML emails).
- `server/routes/settings.js` (or wherever settings GET/PUT lives) — add `email_signature_html` to the read/write payloads.
- `client/src/pages/Settings.jsx` — new "Outbound email signature" textarea (HTML allowed, monospace, large). Saves on blur like the existing minimum-charge field. Shows a live preview below.

**Body shape change:** outbound SMTP needs `{ text, html }`. The existing email-send path uses `lib/email.js` — extend it to accept an optional `html` field and append the signature as the HTML footer when present. The plain-text body gets a "—" separator followed by a plain-text version of the signature (HTML stripped).

## 5. Bump Gmail poll interval to 30 minutes

**File:** `server/.env` — change `BYRON_GMAIL_POLL_INTERVAL_MIN=5` to `30`. Document in `.env.example`.

## 6. Mark Gmail message read on import (already partial)

The poller path already calls `markImportedRead` after `matchReplyToTicket` appends. The import path needs the same call when an email is imported as a brand-new ticket (not merged). Add to `importPendingEmail` after the import succeeds:

```js
try {
  const { markImportedRead } = await import('./replies.js');
  markImportedRead(row.message_id).catch(() => {});
} catch {}
```

## 7. Fix the inbox-scan test timeout

**File:** `server/test/inbox-scan.test.js`

Change every `await scanPendingEmails(db, {})` to `await scanPendingEmails(db, { autoDismissJunk: false })`. This stops the test from awaiting a real LLM call, which is the actual cause of the 5s timeout. The intent of these tests is "options are forwarded to fetchUnread", not "junk classifier works end-to-end" — that's covered by `junk-classifier.test.js` already.

# Verification plan

1. **Unit tests** — `cd server && npm test` must show 154+/154+ passing (was 153/154 with the timeout; we should land 154/154 after the test fix and any new tests).
2. **New tests:**
   - `replies.test.js` — test `matchReplyToTicket` against an in-memory DB with a seeded customer + ticket. Cover: thread match by `source_message_id`, sender+subject match, idempotency, "no match" returns null.
   - `import-merge.test.js` — test that `importPendingEmail` on a customer's reply to an existing ticket returns `merged_into_existing: true` and does NOT create a new ticket.
3. **Browser verification (mandatory per the standing rule):**
   - Open the Tickets page; click into a ticket that has a real imported Gmail message with inline images (Linda's "your worse nightmare Mary" is a good candidate — has HTML body + screenshot). Confirm the rich HTML renders inside the iframe, with images visible.
   - Click "AI draft reply" → "Email customer". Open Byron's Gmail. Confirm the sent email contains the signature.
   - Open Settings → confirm the "Outbound email signature" textarea is present, accepts HTML, and persists.
   - Open the Inbox preview modal on a real pending email with HTML. Confirm the preview iframe renders the same way the ticket page will.
4. **Smoke test:** `curl -X POST http://localhost:5050/api/inbox/scan` returns `{ inserted: ..., auto_dismissed: ... }` without error.
5. **Build:** `cd client && npm run build` exits 0.

# Risk surface

- **Email HTML injection via signature.** A signature is admin-authored, but the body is the customer's, and we already strip `<script>` etc. in `sanitizeEmailHtml`. The signature should ALSO be sanitized on the way in. Mitigation: run `sanitizeEmailHtml` on the signature before persisting, OR restrict the signature field to plain text and convert to HTML at send time. **Decision: plain text only.** The signature is just text + a URL or two. If Byron needs bold/links later, we'll add a separate "rich signature" field with a proper sanitizer.
- **Mail sender identity.** The existing `lib/email.js` sends from a fixed `SMTP_USER`. If a customer's reply comes in to that address, it gets classified as agent mail and hidden. That stays the same — no change to the from-address.
- **Marking message read on import** could mask legitimate unreads if the import is silent. Mitigation: only mark read on successful import (status transitions to `imported`). The matcher path already does this correctly.
- **30-min poll interval** means a reply can sit in the Gmail inbox for up to 30 min before auto-appearing in the ticket. This is the user's explicit request. Document in the changelog.

# Rollback

This commit is purely additive on top of the previous committed state. To roll back: `git revert <sha>`. No destructive DB changes — migration 014 only adds a column, and adding columns is safe with SQLite. No data is deleted.

# Why now

Byron's "resume" message after the last context compaction asked for all four of these features in one batch. The previous execution got most of the way there (replies matcher, EmailBody component, attachment storage, migrations) but missed the integration points. Cleaning this up and shipping it as a single coherent build is the right move.
