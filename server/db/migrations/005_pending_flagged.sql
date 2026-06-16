-- Add a `flagged` column to pending_emails so the UI can show a star
-- next to messages that were pulled in because they're starred (Gmail
-- \Flagged IMAP flag), not because they're unread. Distinguishing these
-- matters: a starred message is "important" while an unread one is
-- "not yet seen" — the admin should be able to triage them separately.
ALTER TABLE pending_emails ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0;
-- Backfill: every existing pending row was fetched by the old code which
-- only matched `unseen: true`, so the existing rows are unread, not starred.
-- The DEFAULT 0 above is correct for all pre-existing data.
