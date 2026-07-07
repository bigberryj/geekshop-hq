# Security Notes

## Customer-facing ID policy

Customers should not know GeekShop HQ is a ticket system.

- Do not include `ticket_uid` (`G-NNNNNN`) in email subject/body.
- Customer emails use `Re: <original subject>`.
- UI may show the internal UID only in admin-only views, subdued and with tooltips.
- Gmail Message-ID (`source_message_id`) is used for thread lookup/archive, not displayed to customers.

## Secrets

- No API keys in code or commits.
- `.env` files are git-ignored.
- MiniMax key is installed locally only.
- Google OAuth token for Contacts enrichment is reused from `~/.hermes/google_token.json`; it is never copied into this repo or exposed to the frontend.

## Email actions

- `Email customer` sends a normal email and keeps the request open.
- `Reply & resolve` sends a normal email, marks the request resolved, and archives Gmail when source is email.
- Tests must not send real customer email without explicit confirmation.

## Gmail review queue safety

- Gmail scans park entries in `pending_emails` only. They do **not** create customers or requests until the admin clicks **Import**.
- Junk classification is rules-first with an LLM fallback for ambiguous cases. The rules-first path is intentionally strict: existing customers, likely human senders, personal replies, and ambiguous messages stay pending.
- Auto-dismissed rows remain in the database with classification metadata and can be restored from **Show dismissed**.
- Bulk dismiss is a soft state change (`status='dismissed'`), not a hard delete.
- Google Contacts enrichment is preview-then-apply: the server may return suggested blank-field updates, but customer data is not changed until the admin clicks **Apply selected**.
- Security / account-recovery subjects ("Your Google Account is no longer recoverable", "Security alert", "Unrecognized device signed in", etc.) are NEVER auto-dismissed, even if the sender is a `noreply@`. Tested in `server/test/junk-classifier.test.js`.
- The classifier accepts three settings-backed overrides so tuning doesn't require code changes: `auto_dismiss_domains` (CSV exact-match domains, +0.6 score), `auto_keep_subjects` (CSV substring subjects, hard keep), and `agent_mailbox_from` (CSV from_email values used by the "Hide agent mail" UI toggle). All three are private/admin-only.

## Billing and invoices

- Minimum charge is private/admin-only. It is applied by repricing labour line items before invoice creation; no customer-visible “minimum charge” line is added.
- Invoice math uses integer cents. When `line_items[].total_cents` exists, it is the source of truth to avoid fractional-hour rounding drift.
- Printable invoice HTML escapes user/customer-controlled fields before rendering.
- QuickBooks Online sync/export is **not** the direction. GeekShop HQ is the source of truth for invoices, payments, expenses, taxes, and accountant handoff. QBO CSV import remains available as a one-shot data entry aid, but no outbound sync is implemented and none is planned.
- Revenue leakage endpoint (`/api/accounting/leakage`, Phase 1 of the 2026-06-29 roadmap) is admin-only (same `requireAdmin` gate as the rest of `/api/accounting/*`). It surfaces customer names, invoice amounts, and time-entry valuation — all already visible to admins in other parts of HQ — but in one consolidated view. No new PII is exposed. Running timers report `value_cents: 0` rather than guessing at unfinished billables, so the widget never manufactures revenue numbers.
- Customer 360 timeline endpoint (`GET /customers/:id/timeline`, Phase 2) is admin-only (same gate). It returns a unified event feed with strict projection discipline: `ticket_messages.body_html`, `ticket_messages.gmail_message_id`, `ticket_messages.source_message_id`, `payments.stripe_payment_intent_id`, and `payments.stripe_charge_id` are never named in any of the eight SELECTs. Bodies are truncated server-side at 240 chars before they leave the API. The client renders summaries as plain text (`whitespace-pre-wrap`) — no `dangerouslySetInnerHTML`, no `eval`, no HTML parsing. The endpoint is otherwise a pure read-aggregate and does not write any tables.
- Payments ledger (`/api/accounting/payments`, Phase 3 of the 2026-06-29 roadmap) is admin-only. All math runs in integer cents; `balance_cents`, `paid_cents`, `refunded_cents` are computed via `COALESCE(SUM(...), 0)` and only ever return integers. Status flips from `reconcileInvoiceStatus()` write a paired `audit_log` row (`invoice.status_auto`) with `from`/`to`/`paid_cents` so a paid → partial → paid flip has a clean trail. `payments.amount_cents` and `payments.invoice_id` are intentionally immutable in `PUT /payments/:id` — corrections must use a new row or a refund — so we never silently rewrite audit history. `payments.reconcile` is idempotent and bounded (`status NOT IN cancelled|paid|draft`); it never fires for terminal states.
- Expense + receipt capture (`/api/accounting/expenses`, Phase 4 of the 2026-06-29 roadmap) is admin-only. The same `requireAdmin` gate covers `GET / POST / PUT / DELETE` for the row and the `POST/GET/DELETE /receipt` attachment endpoints. **DB-level CHECK constraints** on `expenses` (migration `035_expense_amount_checks.sql`) reject `amount_cents < 0`, `tax_cents < 0`, and `tax_cents > amount_cents` — defense in depth in case a future import path bypasses the route's zod parse. **Receipt upload hardening:** allowlist is four types (`image/png`, `image/jpeg`, `image/webp`, `application/pdf`); the *declared* client mime AND a *sniffed* content signature from the actual bytes must both pass — a `text/html` payload declared as `image/png` is rejected as `TYPE_MISMATCH`, and random bytes are rejected as `CONTENT_UNKNOWN`. The 25 MB business cap (separate from the multipart plugin cap of 26 MB) returns `413` with the configured `max_bytes`; the actual payload size is *not* echoed back. Files land under `data/attachments/expenses/<id>/` (or `$GHQ_ATTACHMENT_ROOT` in tests), **never** under `/client`, `/public`, or any webroot. There is no static route serving attachments — receipts are streamed only by the admin-gated handler. Path-traversal on `GET /receipt` is blocked because the URL only takes an expense id; a forged `receipt_path` value in the DB is rejected by `resolveAttachmentPath()` (returns null → 404). `DELETE /api/accounting/expenses/:id` removes the row *and* the file (ENOENT-tolerant). Every upload / rejection / delete / download is recorded in `audit_log` with `action` and `target=<expense_id>`. The whole Phase 4 surface is verified by 24 vitest cases in `test/phase4-expenses.test.js`, including the spoof-mime and oversize-payload paths.
- Accountant export bundle (`/api/accounting/export/*`, Phase 6 of the 2026-06-29 roadmap) is the operator's QuickBooks-free handoff. It is gated by the same `requireAdmin` (in dev: trust-localhost; in prod: the `hq_sid` session cookie) as the rest of `/api/accounting/*`. **What is intentionally NOT in the export:** Stripe `payment_intent_id` / `charge_id` (internal ledger tokens), Gmail `message_id` / `body_html` / `source_message_id`, session / cookie / `password_*` fields, ticket text, and any row that would let the recipient pivot to a non-accounting dataset. **What IS in the export:** invoice `id` + `invoice_uid` (the customer-facing one, not internal-only), customer name + company + email + phone + notes, integer-cent money + derived decimal string, the same `generated_at` echoed on every row, the date range's `from` / `to`. `receipt_path` is the relative path under `$GHQ_ATTACHMENT_ROOT` so the accountant can request a specific receipt on demand; the absolute filesystem path is never emitted. **Money invariants:** every `*_cents` column is a non-negative integer; `subtotal_cents + tax_cents = total_cents` for invoices; `subtotal_cents = amount_cents - tax_cents` for expenses. **ZIP bundle:** built by the project's `lib/zip.js` (no new dependencies; stored-only because the CSVs are already plain ASCII). ZIP bytes are reproducible — same `from`/`to` produces a deterministic layout aside from the embedded `generated_at`. **Bad input handling:** `?from=NOTADATE` falls back to `1970-01-01` rather than 500ing — the accountant always gets the full historical ledger. **Audit:** every CSV, manifest, and bundle download writes a single `audit_log` row (`accounting.export.csv` / `.manifest` / `.bundle`) with the date range, `generated_at`, and either the filename or the row count + bytes. **Re-test path:** `test/phase6-export.test.js` ships a `forbidden[]` token list (`stripe_payment_intent_id`, `stripe_charge_id`, `password`, `password_hash`, `session_id`, `gmail_message_id`, `body_html`, `hashed_`) and asserts no entry's column header contains any of them — so a future careless `SELECT *` will break the suite instead of leaking tokens to a third party.

## Dashboard cron status

Dashboard exposes only safe cron summaries: job name, enabled flag, last status, next run. It never exposes prompt bodies, scripts, or secrets.

## Output escaping

Printable invoice HTML escapes user/customer-controlled fields before rendering.

## Email HTML safety

Imported Gmail HTML (`ticket_messages.body_html`) is sanitized on write by `sanitizeEmailHtml` in `server/lib/attachments.js`:

- Strips `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<base>`, `<form>`.
- Strips `on*` event-handler attributes (`onclick`, `onload`, `onerror`, …).
- Strips `javascript:` URLs from `href` and `src` (rewrites them to `#`).
- Adds `rel="noopener noreferrer"` to any `<a>` with `href` but no `rel`.
- Rewrites `cid:` image references to `/api/attachments/:id/raw` so inline images render through our raw-bytes endpoint, not by trusting third-party content URLs.

Output is rendered inside a sandboxed iframe in the React UI (`EmailBody` component) with `sandbox="allow-same-origin"` and no `allow-scripts` — script execution is impossible even if the sanitizer is bypassed. This is defense in depth: the sanitizer strips the obvious vectors, the sandbox catches the rest.

The sanitizer is small and intentional. It is **not** a replacement for DOMPurify; it is a fast deterministic scrubber for the admin-only Tailscale-protected surfaces (inbox preview + ticket page). The threat model is "a customer's email contains content the admin will see in a local browser," not "an untrusted remote origin." Do not relax either the sanitizer or the sandbox.

## Outbound email signature

The `email_signature` setting supports two formats, selected by `email_signature_format` (`plain` (default) | `html`):

- **Plain** (default, unchanged). The signature is plain text from `settings.email_signature`. The HTML form is generated by escaping + wrapping in `<div style="white-space:pre-wrap">…</div>` so newlines survive. The customer's reply text is also HTML-escaped before being concatenated.

- **Rich** (opt-in, new 2026-06-30). The signature is HTML from `settings.email_signature_html`. The admin opts in by setting `email_signature_format = 'html'`. The HTML goes through an allowlist sanitizer (`sanitizeRichSignature` in `server/lib/signature.js`) before being embedded in the outgoing email:

  - **Tag allowlist** — `a, b, strong, i, em, u, span, div, p, br, img, h1–h6, ul, ol, li, blockquote, hr, small, sub, sup, font, table/thead/tbody/tfoot/tr/th/td`. Anything not on the list is dropped (text content is preserved).
  - **Attribute allowlist per tag** — only `href`/`title`/`target`/`rel`/`style` on `<a>`, only `src`/`alt`/`title`/`width`/`height`/`style` on `<img>`, only `style` on `<span>`/`<div>`/`<p>`, only `color`/`face`/`size` on `<font>`, table-cell attributes (`colspan`/`rowspan`/`style`/`width`) on `tr/th/td`. Everything else is stripped.
  - **Strips dangerous elements entirely** — `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, `<link>`, `<meta>`, `<base>`, all `on*` event handlers, all `javascript:` / `data:` / `vbscript:` / `file:` URLs in `href`/`src` and inside `style=` values.
  - **Forces `rel="noopener noreferrer"`** on any `<a target="_blank">` link.
  - **Plain-text is derived** from the sanitized HTML by `htmlToText()` (block tags → `\n\n`, `<br>` → `\n`, all other tags stripped, common entities decoded) — so the text body always reflects the sanitized version, not the original admin input.

- **Default is unchanged.** `email_signature_format` defaults to `plain` for any deployment that hasn't explicitly opted in. The previous 2026-06-29 doc/code-drift fix (`Plain text only by design`) is now scoped to the plain mode; the rich mode is the new opt-in.

- **The customer's reply text is still escaped as before** (`<div style="white-space:pre-wrap">${escapeHtml(trimmed)}</div>`). Only the signature is allowed to be rich.

- **WYSIWYG editor (rich mode UI, 2026-06-30 second requeue + table/border iteration).** The rich-mode editor (`client/src/components/SignatureWysiwyg.jsx`) is a `contentEditable` region driven by `document.execCommand`. The editor runs a client-side mirror of `sanitizeRichSignature` (`sanitizeLocal` in the same file) on every save, so a stray paste of `<script>` or `javascript:` is scrubbed before the value is shipped to the API. **The server sanitizer is still authoritative** — the client scrub is defense in depth, not the primary gate. The toolbar exposes only commands that produce allowlisted HTML (`<b>`, `<i>`, `<u>`, `<h1>–<h6>`, `<p>`, `<ul>`/`<ol>`/`<li>`, `<a href="…">`, `<img src="…">`); even an admin who manages to inject disallowed HTML via paste will be re-scrubbed at the server boundary before the email is sent. The third iteration (T-F2D7BD, 2026-06-30) added an **Insert table** button (rows × cols prompt) and a **table-mode toolbar** that appears when the caret is inside a `<table>`: a Borders on/off toggle (sets `style="border:…"` on every `<td>` and the `<table>` itself), a color picker (8-color allowlist), and a width selector (none / 1–4 px). The color picker is a UX guardrail — admins can still hand-edit the HTML for any other color. Borders-off is represented by `style="border:0"` (not by removing the style attribute) so toggling back on reliably restores a uniform border without disturbing padding/width/background the admin may have added.

- **Threat model.** The table-mode toolbar only manipulates the `border` style declaration on the `<table>` and its `<td>`/`<th>` children; it never touches cell padding, width, background, or any other style the admin may have set. Even if an admin enters a malicious `<a>` or `<img>` inside a cell, the server's sanitizer scrubs `javascript:`/`data:`/`vbscript:` URLs and on* handlers before the value lands in an email. The intent is: admins should be able to express a normal contact signature (bold name, link to website, logo, address in a small table) without giving them a footgun.

## Contract Clients portal

The `contract-clients` module (migration `033_contract_clients.sql`) lets
office managers log in at `/portal` and view their scope only. Security
controls (enforced server-side; UI filtering is not security):

- **Separate cookie namespace.** The portal session cookie is `hq_csid`
  (admin uses `hq_sid`). There is no shared session table; admin cookies
  cannot authenticate to `/api/portal/*` and vice versa. `hq_csid` is
  `HttpOnly`, `SameSite=Lax`, `Secure` in prod, scoped to `/api/portal`.
- **Two scope types.** `client_manager` sees every location under the
  contract client; `location_manager` is restricted to a JSON list of
  location ids stored on the credential row. Cross-client queries always
  resolve to zero rows because the SQL scope fragment includes both
  `client_id = ?` and (where applicable) `location_id IN (...)`. Tests
  in `test/contract-clients.test.js` lock this in.
- **Disabled credentials cannot read or cancel.** `credentialCanSeeLocation`
  returns `false` for any credential with a non-null `disabled_at`, and
  `canCancel()` checks the same.
- **Cancellation is bounded.** `canCancel` denies cancellation if the
  request is terminal (`resolved | cancelled`) or if it has been picked
  up by staff (`assigned_to` set and not `open`). The submitting contact
  can still cancel an unassigned request; admins override.
- **Magic-link invites, no public write surface.** `/api/portal/redeem/:token`
  is the only portal endpoint that creates a credential, and only on a
  matching unconsumed, unexpired token. The token is 32 hex chars, 7-day
  expiry, single-use. Redeem never accepts an email/password from the URL.
- **Audit log is portal-specific.** `client_portal_audit` is separate
  from the admin audit log; admin tooling cannot read what a client
  user did without an explicit cross-tool query.
- **Editing requests is disabled in v1.** `contract_requests.editable_until`
  is reserved but always NULL; the `/api/portal/requests/:id` PATCH route
  returns 403 today. When editing ships, the column flips non-null on
  insert and the same scope rules apply — no schema change required.
- **No outbound email notifications by default.** `lib/contract-clients.js`
  intentionally does not call SMTP or any notification sink. Admin wires
  up email later in HQ settings if/when the toast layer (or equivalent)
  lands — there is no implicit side channel.

## Reply-merge + mark-read safety

The reply matcher (`lib/replies.js`) only matches open tickets for the **same customer** (matched by email). It does not move a message from one customer's ticket to another customer's ticket, even if subject lines collide. Matchers that conflate across customers would be a privacy / impersonation hazard; the current implementation prevents that.

The "mark read" call (`markImportedRead` → `imapflow` `\Seen`) is best-effort and never throws. It runs after a successful import (new or merged) so the Gmail inbox stays in sync with the dashboard. It does **not** archive, so the message remains in the customer's Gmail thread for their reference.

## Mission Control (agent task queue)

### Blast radius

The worker cron runs with the full Hermes agent toolset (terminal, file, browser, delegate_task, network). A task prompt that says "wipe X" or "deploy to prod without asking" can be acted on if it's literal. The safety boundary is:

1. **Byron-authorized source.** Tasks enter the queue through paths Byron owns: the HQ UI (he typed it), the Telegram chat (he said it), or the enqueue CLI (he ran it). The "agent_mailbox_from"-style auto-ingest from email is **not** wired in v1 — that would let an untrusted sender enqueue a task.
2. **Acceptance criteria are the contract.** The worker self-reviews against the criteria; if a criterion fails, the task goes to `blocked`, not `review`. Byron decides in the UI.
3. **Decision is recorded.** Every approve / requeue / cancel is on the row with `decided_by` and a `decision_note`. A task that ran but wasn't approved is visible in the history.
4. **Source-level authentication, not per-row.** The API doesn't auth individual tasks; it relies on the same network posture as the rest of HQ (loopback / LAN / Tailscale, UFW-restricted). This matches how every other HQ endpoint works.

### Input validation

- `prompt` is capped at 32 KiB and `title` at 240 chars. The DB won't accept more (the route returns 400 first).
- `source` is enum-checked server-side. `priority` and `max_attempts` are coerced to integers.
- `acceptance_criteria` items are sanitized to `{ req: string, kind?: string }`.

### What the worker cannot do

- It cannot enqueue new tasks. (The CLI exposes `claim` / `finish` / `heartbeat` / `stuck-requeue` — no `create` / `enqueue`.) A task that wants to spawn subtasks must come back to Byron for a new task.
- It cannot decide tasks. (No `approve` / `cancel` in the worker CLI; those are HQ-UI-only.) This prevents a worker from approving its own work and silently marking it done.
- It cannot run other cron jobs or modify cron state. The worker prompt explicitly forbids this and the prompt is the boundary.

### Stuck-task requeue

Tasks with no heartbeat for 10 minutes are requeued (or failed if they've hit `max_attempts`). This catches both "worker crashed" and "worker's process was killed mid-task." A requeued task has its `last_error` annotated with the stale timestamp; the next claim increments `attempts`.

### Dashboard projection

The dashboard's `agent_tasks` summary is just counts. No prompt bodies, no PII, no source_ref values. The same safe-projection discipline as the existing `cron_status` and `monitor_status` fields.

### Inline Telegram button callback token

`POST /api/agent-tasks/callback` accepts `action`, `id`, and `token` from
Telegram's button POST payload. The `token` is the task's `uid` — it's not
cryptographically secret (the uid is already exposed in every notification and
in the row), but it's a sanity check that the button was attached to *this*
specific task. A button for task #42 can't be re-pointed at task #50 by an
attacker who only knows Byron's task list, because `task.uid !== button.token`
returns `400 token mismatch`. The endpoint is treated as admin-only
(loopback / LAN / Tailscale) like the rest of the HQ API.

State guards on the callback path are the same as on `/decision`: only
`review` and `blocked` transition. `running`, `queued`, `done`, `cancelled`
all return `409`. This means a button tapped after the task already moved
on (e.g. another device approved it) fails safe rather than racing.

### Inline Telegram message content

Review-triggered Telegram pings carry the task title, uid, source, and a
short summary excerpt (≤300 chars) — never the raw `prompt`, never PII
payload, never the full checklist. Button `callback_data` values are only
`action=…&id=…&token=…` triples so the message stays short and under
Telegram's 64-byte callback-data cap.
