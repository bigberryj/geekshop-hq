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
