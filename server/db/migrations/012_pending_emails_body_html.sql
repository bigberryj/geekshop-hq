-- Persist the Gmail HTML body on pending_emails so the Inbox preview
-- can show images/inline/formatting after the first on-demand fetch and
-- every subsequent preview stays instant (no IMAP round-trip).
ALTER TABLE pending_emails ADD COLUMN body_html TEXT;
ALTER TABLE pending_emails ADD COLUMN body_fetched_at TEXT;
