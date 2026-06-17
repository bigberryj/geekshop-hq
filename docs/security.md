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
- QuickBooks Online integration is the recommended future source-of-truth for sent invoices/payment status; until then, manual `Mark paid` is local-only.

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

The `email_signature` setting is **plain text only** by design. The signature is HTML-escaped on render (`<` → `&lt;`, etc.) and rendered inside a `<div style="white-space:pre-wrap">…</div>` so newlines survive without `<br>` injection. The customer's reply text is also HTML-escaped before being concatenated.

This is intentional. Even though the signature is admin-authored, allowing HTML in the signature creates an injection surface: a future "rich signature" field would need a stricter sanitizer, and any signature update would need to be re-escaped. Plain text + escape is simpler, safer, and matches the actual content Byron needs (name, business, contact info).

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
