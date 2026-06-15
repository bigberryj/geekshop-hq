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

## Email actions

- `Email customer` sends a normal email and keeps the request open.
- `Reply & resolve` sends a normal email, marks the request resolved, and archives Gmail when source is email.
- Tests must not send real customer email without explicit confirmation.

## Dashboard cron status

Dashboard exposes only safe cron summaries: job name, enabled flag, last status, next run. It never exposes prompt bodies, scripts, or secrets.

## Output escaping

Printable invoice HTML escapes user/customer-controlled fields before rendering.
